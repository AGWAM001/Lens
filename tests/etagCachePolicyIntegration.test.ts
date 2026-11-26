import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAYMENT_ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const { mockPgQuery, mockPrisma, mockVerify, mockSettle, mockInitialize } = vi.hoisted(() => ({
  mockPgQuery: vi.fn(async (sql: string) => {
    if (sql.includes('DISTINCT ON') || sql.includes('FROM pool_snapshots')) {
      return { rows: [] }
    }
    return { rows: [] }
  }),
  mockPrisma: {
    pairConfig: { findMany: vi.fn(async () => []) },
    pricePoint: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    ingestionGap: { findMany: vi.fn(async () => []) },
    poolSnapshot: { findMany: vi.fn(async () => []) },
    apiKey: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
  },
  mockVerify: vi.fn(async () => ({ isValid: true })),
  mockSettle: vi.fn(async () => ({ success: true, transaction: 'tx-mock' })),
  mockInitialize: vi.fn(async () => undefined),
}))

vi.mock('../src/db', () => ({
  prisma: mockPrisma,
  pgPool: { query: mockPgQuery, on: vi.fn(), totalCount: 0, idleCount: 0, waitingCount: 0 },
  buildDatabaseUrl: (url: string) => url,
  upsertPricePoints: vi.fn(async () => 0),
  getIndexerState: vi.fn(async () => ({ cursor: null, ledger: null })),
  setIndexerCursor: vi.fn(async () => undefined),
  updatePoolMetrics: vi.fn(),
  isPoolExhaustionError: vi.fn(() => false),
  recordPoolExhaustion: vi.fn(),
}))

vi.mock('@x402/core/server', () => {
  function MockResourceServer() {
    const instance = {
      initialize: mockInitialize,
      verify: mockVerify,
      settle: mockSettle,
      register: vi.fn(),
    }
    instance.register.mockReturnValue(instance)
    return instance
  }
  function MockFacilitatorClient() {
    return {}
  }
  return {
    x402ResourceServer: MockResourceServer,
    HTTPFacilitatorClient: MockFacilitatorClient,
  }
})

vi.mock('@x402/stellar/exact/server', () => {
  function MockExactScheme() {
    return {}
  }
  return { ExactStellarScheme: MockExactScheme }
})

import { buildApp } from '../src/app'
import { _resetX402ResourceServers } from '../src/x402/network'

describe('ETag + Cache-Control integration in buildApp (#660)', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetX402ResourceServers()
    ;(globalThis as any).__lens_prisma = mockPrisma
    ;(globalThis as any).__lens_pgPool = {
      query: mockPgQuery,
      on: vi.fn(),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    }
    process.env.REQUIRE_API_KEY = 'false'
    delete process.env.ORACLE_PAYMENT_ADDRESS
    delete process.env.ORACLE_PAYMENT_ADDRESS_TESTNET
    delete process.env.ORACLE_PAYMENT_ADDRESS_MAINNET
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('returns ETag, Cache-Control: public, max-age=300, and Vary: x-network on GET /pairs and preserves them on 304', async () => {
    const app = await buildApp()
    try {
      const res200 = await app.inject({ method: 'GET', url: '/pairs' })
      expect(res200.statusCode).toBe(200)
      expect(res200.headers.etag).toMatch(/^"[0-9a-f]{64}"$/)
      expect(res200.headers['cache-control']).toBe('public, max-age=300')
      expect(String(res200.headers.vary)).toContain('x-network')

      const res304 = await app.inject({
        method: 'GET',
        url: '/pairs',
        headers: { 'if-none-match': String(res200.headers.etag) },
      })
      expect(res304.statusCode).toBe(304)
      expect(res304.body).toBe('')
      expect(res304.headers.etag).toBe(res200.headers.etag)
      expect(res304.headers['cache-control']).toBe(res200.headers['cache-control'])
      expect(String(res304.headers.vary)).toContain('x-network')
    } finally {
      await app.close()
    }
  })

  it('applies cachePolicyFor on candles ETag route and status non-ETag route', async () => {
    const app = await buildApp()
    try {
      const candlesRes = await app.inject({
        method: 'GET',
        url: '/candles/XLM/USDC?interval=1h&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
      })
      expect(candlesRes.statusCode).toBe(200)
      expect(candlesRes.headers.etag).toMatch(/^"[0-9a-f]{64}"$/)
      expect(candlesRes.headers['cache-control']).toBe(
        'public, max-age=3600, stale-while-revalidate=86400'
      )
      expect(String(candlesRes.headers.vary)).toContain('x-network')

      const statusRes = await app.inject({ method: 'GET', url: '/status' })
      expect(statusRes.statusCode).toBe(200)
      expect(statusRes.headers.etag).toBeUndefined()
      expect(statusRes.headers['cache-control']).toBe('public, max-age=15')
      expect(String(statusRes.headers.vary)).toContain('x-network')
    } finally {
      await app.close()
    }
  })

  it('downgrades paid ETag routes to private cache policy when x402 is active', async () => {
    process.env.ORACLE_PAYMENT_ADDRESS = PAYMENT_ADDRESS
    const validPaymentHeader = JSON.stringify({ scheme: 'exact', payload: 'mock' })
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/candles/XLM/USDC?interval=1h&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
        headers: { 'x-payment': validPaymentHeader },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/)
      expect(res.headers['cache-control']).toBe(
        'private, max-age=3600, stale-while-revalidate=86400'
      )
      expect(String(res.headers.vary ?? '')).not.toContain('x-network')

      const res304 = await app.inject({
        method: 'GET',
        url: '/candles/XLM/USDC?interval=1h&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
        headers: {
          'x-payment': validPaymentHeader,
          'if-none-match': String(res.headers.etag),
        },
      })
      expect(res304.statusCode).toBe(304)
      expect(res304.headers.etag).toBe(res.headers.etag)
      expect(res304.headers['cache-control']).toBe(
        'private, max-age=3600, stale-while-revalidate=86400'
      )
    } finally {
      await app.close()
    }
  })
})
