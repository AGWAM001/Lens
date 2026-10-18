import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const PAYMENT_ADDRESS = 'GPAYMENTADDRESS123456789012345678901234567890123456789012'

const {
  mockVerify,
  mockSettle,
  mockInitialize,
  MockResourceServer,
  MockFacilitatorClient,
  MockExactScheme,
} = vi.hoisted(() => {
  const mockVerify = vi.fn()
  const mockSettle = vi.fn().mockResolvedValue(undefined)
  const mockInitialize = vi.fn().mockResolvedValue(undefined)

  const instance = {
    initialize: mockInitialize,
    verify: mockVerify,
    settle: mockSettle,
    register: vi.fn(),
  }
  instance.register.mockReturnValue(instance)

  function MockResourceServer() { return instance }
  function MockFacilitatorClient() { return {} }
  function MockExactScheme() { return {} }

  return { mockVerify, mockSettle, mockInitialize, MockResourceServer, MockFacilitatorClient, MockExactScheme }
})

vi.mock('@x402/core/server', () => ({
  x402ResourceServer: MockResourceServer,
  HTTPFacilitatorClient: MockFacilitatorClient,
}))

vi.mock('@x402/stellar/exact/server', () => ({
  ExactStellarScheme: MockExactScheme,
}))

vi.mock('../x402/metering', () => ({
  checkQuota: vi.fn(),
  recordUsage: vi.fn(),
  parseCents: vi.fn((price: string) => {
    const match = price.match(/^\$(\d+(?:\.\d+)?)$/)
    return match ? Math.round(parseFloat(match[1]) * 100) : 0
  }),
  getQuotaConfig: vi.fn(),
}))

vi.mock('../redis', () => ({
  redis: { get: vi.fn(), multi: vi.fn().mockReturnThis(), on: vi.fn() },
}))

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
    },
  },
}))

import { registerX402 } from '../middleware/x402'
import { checkQuota, recordUsage, getQuotaConfig } from '../x402/metering'
import Fastify from 'fastify'

const mockCheckQuota = checkQuota as any
const mockRecordUsage = recordUsage as any
const mockGetQuotaConfig = getQuotaConfig as any

function makePaymentHeader(overrides: Record<string, unknown> = {}): string {
  const payload = { scheme: 'exact', amount: '$0.10', recipient: PAYMENT_ADDRESS, ...overrides }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockReset()
  mockSettle.mockReset().mockResolvedValue(undefined)
  mockInitialize.mockReset().mockResolvedValue(undefined)
})

const ENV_KEYS = ['ORACLE_PAYMENT_ADDRESS', 'STELLAR_NETWORK', 'REQUIRE_API_KEY'] as const
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key]
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

async function buildAppWithAuth() {
  process.env.ORACLE_PAYMENT_ADDRESS = PAYMENT_ADDRESS
  process.env.STELLAR_NETWORK = 'testnet'
  process.env.REQUIRE_API_KEY = 'false'
  const app = Fastify({ logger: false })
  // Simulate the auth layer (src/api/auth.ts) that decorates req.apiKey from the
  // Bearer token. It runs on onRequest — before x402's preHandler — so quota
  // enforcement (which is keyed off req.apiKey.id) is actually exercised here.
  app.decorateRequest('apiKey', undefined)
  app.addHook('onRequest', async (req) => {
    if (req.headers['authorization']) {
      ;(req as any).apiKey = { id: 'key-id' }
    }
  })
  await app.register(registerX402)
  app.get('/price/test', async () => ({ ok: true }))
  app.get('/public', async () => ({ ok: true }))
  await app.ready()
  return app
}

describe('x402 quota enforcement', () => {
  it('records usage after valid payment for requests with API key', async () => {
    mockCheckQuota.mockResolvedValue({ allowed: true })
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildAppWithAuth()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: {
        'x-payment': makePaymentHeader(),
        'authorization': 'Bearer test-key',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(mockRecordUsage).toHaveBeenCalledWith('key-id', 10)
  })

  it('allows request when quota is under limit', async () => {
    mockCheckQuota.mockResolvedValue({ allowed: true })
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildAppWithAuth()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: {
        'x-payment': makePaymentHeader(),
        'authorization': 'Bearer test-key',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(mockCheckQuota).toHaveBeenCalled()
  })

  it('blocks request when quota exceeded with block policy', async () => {
    mockCheckQuota.mockResolvedValue({ allowed: false, reason: 'block quota exceeded' })
    mockGetQuotaConfig.mockResolvedValue({
      monthlyQuotaCents: 1000,
      dailyQuotaCents: 500,
      overagePolicy: 'block',
    })
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildAppWithAuth()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: {
        'x-payment': makePaymentHeader(),
        'authorization': 'Bearer test-key',
      },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json().error).toBe('Quota exceeded')
    expect(res.json().policy).toBe('block')
  })

  it('allows overage usage with allow_overage policy', async () => {
    mockCheckQuota.mockResolvedValue({ allowed: false, reason: 'allow_overage quota exceeded' })
    mockGetQuotaConfig.mockResolvedValue({
      monthlyQuotaCents: 1000,
      dailyQuotaCents: 500,
      overagePolicy: 'allow_overage',
    })
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildAppWithAuth()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: {
        'x-payment': makePaymentHeader(),
        'authorization': 'Bearer test-key',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(mockRecordUsage).toHaveBeenCalledWith('key-id', 10)
  })

  it('requires additional payment with charge_402 policy', async () => {
    mockCheckQuota.mockResolvedValue({ allowed: false, reason: 'charge_402 quota exceeded' })
    mockGetQuotaConfig.mockResolvedValue({
      monthlyQuotaCents: 1000,
      dailyQuotaCents: 500,
      overagePolicy: 'charge_402',
    })
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildAppWithAuth()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: {
        'x-payment': makePaymentHeader(),
        'authorization': 'Bearer test-key',
      },
    })

    expect(res.statusCode).toBe(402)
    expect(res.json().error).toBe('Quota exceeded — additional payment required')
    expect(res.json().policy).toBe('charge_402')
  })

  it('does not enforce quota for requests without API key', async () => {
    mockVerify.mockResolvedValue({ isValid: true })
    const app = await buildAppWithAuth()

    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: {
        'x-payment': makePaymentHeader(),
      },
    })

    expect(res.statusCode).toBe(200)
    expect(mockCheckQuota).not.toHaveBeenCalled()
    expect(mockRecordUsage).not.toHaveBeenCalled()
  })
})