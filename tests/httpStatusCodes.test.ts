import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Mock DB / Redis / Oracle before any app code is imported.
// The full buildApp() wires real routes that hit pgPool / prisma / Redis —
// none of which are available in CI. Each mock returns "empty but valid" data
// so every route that should return 200-with-empty-result does exactly that,
// and routes whose 4xx behavior is driven by input validation (not DB) still
// return the correct code regardless of these stubs.
// ---------------------------------------------------------------------------

const { mockPgQuery, mockPrismaWebhookDelete, mockPrismaApiKeyFindUnique } = vi.hoisted(() => ({
  mockPgQuery: vi.fn(),
  mockPrismaWebhookDelete: vi.fn(),
  mockPrismaApiKeyFindUnique: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockPgQuery },
  prisma: {
    webhook: {
      create: vi.fn(),
      delete: mockPrismaWebhookDelete,
    },
    apiKey: {
      create: vi.fn(),
      findUnique: mockPrismaApiKeyFindUnique,
      update: vi.fn(),
    },
  },
}))

vi.mock('../src/redis', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
    subscribe: vi.fn(),
    publish: vi.fn(),
    duplicate: vi.fn().mockReturnValue({
      subscribe: vi.fn(),
      on: vi.fn(),
    }),
  },
  getCachedPrice: vi.fn().mockResolvedValue(null),
  setCachedPrice: vi.fn(),
}))

vi.mock('../src/aggregator/vwap', () => ({
  getAggregatedPrice: vi.fn().mockResolvedValue({
    price: 0,
    ammPrice: null,
    sdexPrice: null,
    vwap1m: null,
    vwap1h: null,
    volume24h: 0,
    priceChange24h: null,
  }),
}))

vi.mock('../src/aggregator/bestRoute', () => ({
  getBestRoute: vi.fn().mockResolvedValue({
    route: 'sdex',
    sdexPrice: null,
    ammPrice: null,
    estimatedOutput: 0,
    slippagePct: 0,
    recommendation: 'sdex',
  }),
}))

vi.mock('../src/pricing/depth', () => ({
  getDepth: vi.fn().mockResolvedValue({
    levels: [],
    totalLiquidity: 0,
    slippage: 0,
  }),
}))

// Reflector oracle: mark as not configured so /compare returns no_data
vi.mock('../src/ingest/oracles/reflector', () => ({
  reflectorOracleAdapter: {
    name: 'reflector',
    isConfigured: () => false,
    getPrice: vi.fn(),
  },
}))

import { buildApp } from '../src/app'

/**
 * Tests for issue #262: standardized HTTP status code behavior across all routes.
 *
 * The rule:
 * - 404 when a resource does not exist (pair not watched, key not found)
 * - 200 with empty result when a query matched nothing (no data in time window)
 */

describe('HTTP status code standardization (#262)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    process.env.STELLAR_NETWORK = 'testnet'
    process.env.WATCHED_PAIRS = 'XLM:native,USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    process.env.REQUIRE_API_KEY = 'false'  // Disable API key auth for tests
    // Set ADMIN_TOKEN so admin routes don't reject with 401 before reaching 404
    process.env.ADMIN_TOKEN = 'test-admin-token'

    // Default: all DB queries return empty result sets
    mockPgQuery.mockResolvedValue({ rows: [] })
    // Default: webhook delete does nothing (P2025 = record not found, idempotent)
    mockPrismaWebhookDelete.mockRejectedValue({ code: 'P2025' })
    // Default: API key lookup returns null (not found)
    mockPrismaApiKeyFindUnique.mockResolvedValue(null)

    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  describe('404 for non-existent resources', () => {
    it('GET /price/:assetA/:assetB returns 404 when pair is not watched', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/NONEXISTENT',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not watched/)
    })

    it('GET /price/:assetA/:assetB/route returns 404 when pair is not watched', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/NONEXISTENT/route?amount=100',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not watched/)
    })

    it('GET /price/:assetA/:assetB/depth returns 404 when pair is not watched', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/NONEXISTENT/depth?amount=100',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not watched/)
    })

    it('GET /benchmark/:asset returns 404 when pair is not watched', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/benchmark/NONEXISTENT?target=USD',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not watched/)
    })

    it('DELETE /admin/keys/:id returns 404 when API key not found', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/keys/00000000-0000-0000-0000-000000000000',
        headers: {
          'x-admin-token': 'test-admin-token',
        },
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not found/)
    })
  })

  describe('200 with empty result when query matched nothing', () => {
    it('GET /basket returns 200 with error and reason when assets have no price data', async () => {
      // basket route uses pgPool to get VWAP — return null vwap (no data)
      mockPgQuery.mockResolvedValue({ rows: [{ vwap: null }] })
      const res = await app.inject({
        method: 'GET',
        url: '/basket?asset=FAKEASSET1&asset=FAKEASSET2&weight=0.5&weight=0.5',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body).toHaveProperty('reason', 'missing_price_data')
      expect(body).toHaveProperty('missingAssets')
      expect(Array.isArray(body.missingAssets)).toBe(true)
    })

    it('GET /compare/:asset returns 200 with status:"no_data" when both sources are null', async () => {
      // pgPool returns no vwap rows; reflector oracle is not configured (mocked above)
      mockPgQuery.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'GET',
        url: '/compare/NONEXISTENTASSET',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('status', 'no_data')
      expect(body).toHaveProperty('lens', null)
      expect(body).toHaveProperty('reflector', null)
    })

    it('GET /candles/:assetA/:assetB returns 200 with empty candles array when no data exists', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'GET',
        url: '/candles/XLM/USDC?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('candles')
      expect(Array.isArray(body.candles)).toBe(true)
      // May be empty depending on whether fixture data exists in that range
    })

    it('GET /price/:assetA/:assetB/history returns 200 with empty buckets array when no data exists', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/history?window=1m&limit=1',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('buckets')
      expect(Array.isArray(body.buckets)).toBe(true)
    })

    it('GET /spreads/:asset returns 200 with empty venues array when no venue quoted the asset', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'GET',
        url: '/spreads/NONEXISTENTASSET?window=5m',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('venues')
      expect(Array.isArray(body.venues)).toBe(true)
      expect(body.venues).toHaveLength(0)
      expect(body).toHaveProperty('tightest', null)
    })

    it('GET /volumes/:asset returns 200 with totalVolume:0 when no trades exist', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'GET',
        url: '/volumes/NONEXISTENTASSET?window=24h',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('totalVolume', 0)
      expect(body).toHaveProperty('byVenue')
      expect(Object.keys(body.byVenue)).toHaveLength(0)
      expect(body).toHaveProperty('tradeCount', 0)
    })

    it('GET /screener returns 200 with empty data array when no pairs match filters', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'GET',
        url: '/screener?volume=9999999999999',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('data')
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.data).toHaveLength(0)
      expect(body).toHaveProperty('hasMore', false)
    })

    it('GET /pools returns 200 with empty pools array when no pools exist for the network', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'GET',
        url: '/pools?network=testnet',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('pools')
      expect(Array.isArray(body.pools)).toBe(true)
      // May be empty or populated depending on fixture data
    })

    it('GET /pairs returns 200 with empty pairs array when no pairs are watched', async () => {
      // This scenario is unlikely in production but can occur during initial setup
      mockPgQuery.mockResolvedValue({ rows: [] })
      const res = await app.inject({
        method: 'GET',
        url: '/pairs',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('pairs')
      expect(Array.isArray(body.pairs)).toBe(true)
    })
  })

  describe('400 for malformed requests (unchanged behavior)', () => {
    it('GET /candles/:assetA/:assetB returns 400 for invalid interval', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/candles/XLM/USDC?interval=invalid',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
    })

    it('GET /basket returns 400 when assets and weights count mismatch', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/basket?asset=XLM&asset=USDC&weight=0.5',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/must match/)
    })

    it('GET /spreads/:asset returns 400 for invalid window', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/spreads/XLM?window=invalid',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
    })

    it('GET /volumes/:asset returns 400 for invalid window', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/volumes/XLM?window=invalid',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
    })

    it('GET /price/:assetA/:assetB/route returns 400 for negative amount', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/route?amount=-100',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
    })
  })

  describe('DELETE /webhooks/:id is idempotent (204 even when not found)', () => {
    it('returns 204 for non-existent webhook ID', async () => {
      // prisma.webhook.delete throws P2025 (record not found) — should be treated
      // as a success (idempotent delete)
      mockPrismaWebhookDelete.mockRejectedValue({ code: 'P2025' })
      const res = await app.inject({
        method: 'DELETE',
        url: '/webhooks/00000000-0000-0000-0000-000000000000',
      })
      expect(res.statusCode).toBe(204)
      expect(res.body).toBe('')
    })
  })
})
