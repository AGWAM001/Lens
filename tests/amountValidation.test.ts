import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.REQUIRE_API_KEY = 'false'

const { mockQuery, mockGetBestRoute, mockGetDepth, mockGetImpact } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetBestRoute: vi.fn(),
  mockGetDepth: vi.fn(),
  mockGetImpact: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
  prisma: {},
}))

vi.mock('../src/redis', () => ({
  getCachedPrice: vi.fn(),
  setCachedPrice: vi.fn(),
}))

vi.mock('../src/aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

vi.mock('../src/pricing/depth', () => ({
  getDepth: mockGetDepth,
  getImpact: mockGetImpact,
}))

vi.mock('../src/config', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config')>()
  return {
    ...actual,
    activeNetwork: 'testnet',
    getNetworkConfig: (network?: string) => ({
      ...actual.getNetworkConfig((network ?? 'testnet') as never),
      pairs: [
        {
          pairKey: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM',
          assetA: { code: 'XLM', issuer: null },
          assetB: {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        },
      ],
    }),
  }
})

import { parsePositiveAmount } from '../src/utils/amounts'
import { registerRESTRoutes } from '../src/api/rest'
import { registerNetworkSelector } from '../src/middleware/network'

describe('parsePositiveAmount', () => {
  it('accepts valid positive finite decimals and defaults undefined to 1000', () => {
    expect(parsePositiveAmount(undefined)).toEqual({ value: 1000 })
    expect(parsePositiveAmount('100')).toEqual({ value: 100 })
    expect(parsePositiveAmount('250.5')).toEqual({ value: 250.5 })
    expect(parsePositiveAmount('.5')).toEqual({ value: 0.5 })
    expect(parsePositiveAmount('1e3')).toEqual({ value: 1000 })
  })

  it.each([
    '100abc',
    '1e3xyz',
    'Infinity',
    '-Infinity',
    'NaN',
    '1e999',
    '0',
    '-1',
    '',
    '0x10',
  ])('rejects invalid amount %s', raw => {
    expect(parsePositiveAmount(raw)).toEqual({ error: 'amount must be a positive number' })
  })
})

describe('GET /price/:assetA/:assetB/route, /depth, and /impact amount validation (#665)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerRESTRoutes(app)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBestRoute.mockResolvedValue({
      route: 'SDEX',
      sdexPrice: 0.12,
      ammPrice: 0.119,
      estimatedOutput: 120,
      slippagePct: 0.1,
      recommendation: 'Use SDEX',
    })
    mockGetDepth.mockResolvedValue({
      status: 'ok',
      pairKey: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM',
      network: 'testnet',
      spotPrice: 0.12,
      executionPrice: 0.12,
      slippagePct: 0.1,
      source: 'AMM',
      asks: [],
      bids: [],
    })
    mockGetImpact.mockResolvedValue({
      levels: [],
      thresholds: [],
    })
  })

  const invalidAmounts = ['100abc', '1e3xyz', 'Infinity', '1e999', '0', '-1']

  it.each(invalidAmounts)(
    'returns 400 invalid_parameter for amount=%s on both /route and /depth',
    async bad => {
      const routeRes = await app.inject({
        method: 'GET',
        url: `/price/XLM/USDC/route?amount=${encodeURIComponent(bad)}`,
      })
      expect(routeRes.statusCode).toBe(400)
      expect(routeRes.json()).toMatchObject({ code: 'invalid_parameter' })
      expect(mockGetBestRoute).not.toHaveBeenCalled()

      const depthRes = await app.inject({
        method: 'GET',
        url: `/price/XLM/USDC/depth?amount=${encodeURIComponent(bad)}`,
      })
      expect(depthRes.statusCode).toBe(400)
      expect(depthRes.json()).toMatchObject({ code: 'invalid_parameter' })
      expect(mockGetDepth).not.toHaveBeenCalled()
    }
  )

  it('validates amount before pair lookup (400 even on unwatched pair) on both /route and /depth', async () => {
    const routeRes = await app.inject({
      method: 'GET',
      url: '/price/FOO/BAR/route?amount=100abc',
    })
    expect(routeRes.statusCode).toBe(400)
    expect(routeRes.json()).toMatchObject({ code: 'invalid_parameter' })

    const depthRes = await app.inject({
      method: 'GET',
      url: '/price/FOO/BAR/depth?amount=100abc',
    })
    expect(depthRes.statusCode).toBe(400)
    expect(depthRes.json()).toMatchObject({ code: 'invalid_parameter' })
  })

  it('rejects malformed or non-finite thresholds and liquidityFraction on /impact', async () => {
    const badThreshold = await app.inject({
      method: 'GET',
      url: '/impact/FOO/BAR?thresholds=1,10abc',
    })
    expect(badThreshold.statusCode).toBe(400)
    expect(badThreshold.json()).toMatchObject({ code: 'invalid_parameter' })

    const badInfThreshold = await app.inject({
      method: 'GET',
      url: '/impact/XLM/USDC?thresholds=1e999',
    })
    expect(badInfThreshold.statusCode).toBe(400)
    expect(badInfThreshold.json()).toMatchObject({ code: 'invalid_parameter' })

    const badFraction = await app.inject({
      method: 'GET',
      url: '/impact/XLM/USDC?liquidityFraction=0.5abc',
    })
    expect(badFraction.statusCode).toBe(400)
    expect(badFraction.json()).toMatchObject({ code: 'invalid_parameter' })
    expect(mockGetImpact).not.toHaveBeenCalled()
  })

  it('accepts valid amount on /route and /depth and returns expected response body', async () => {
    const routeRes = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/route?amount=250.5',
    })
    expect(routeRes.statusCode).toBe(200)
    expect(mockGetBestRoute).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'XLM' }),
      expect.objectContaining({ code: 'USDC' }),
      'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM',
      250.5,
      'testnet'
    )

    const depthRes = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/depth?amount=250',
    })
    expect(depthRes.statusCode).toBe(200)
    expect(mockGetDepth).toHaveBeenCalledWith(
      'testnet',
      'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM',
      250,
      expect.any(Object)
    )
  })
})
