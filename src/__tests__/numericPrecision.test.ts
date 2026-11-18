import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: vi.fn(),
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: vi.fn(),
}))

import { registerCandleRoutes } from '../routes/candles'
import { registerVolumeRoutes } from '../routes/volumes'
import { registerHistoryRoutes } from '../api/history'
import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerCandleRoutes(app)
  await registerVolumeRoutes(app)
  await registerHistoryRoutes(app)
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

describe('Issue #230: numeric precision across aggregations and edge serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /candles/:assetA/:assetB', () => {
    it('aggregates without ::float inside aggregate expressions and serializes exact volume', async () => {
      let capturedSql = ''
      mockQuery.mockImplementation(async (sql: string) => {
        capturedSql = sql
        // In PostgreSQL, SUM(numeric) of 0.1 and 0.2 produces exact decimal '0.3000000',
        // whereas SUM(float) produces 0.30000000000000004.
        return {
          rows: [
            {
              time: new Date('2025-01-01T00:00:00Z'),
              open: '0.000000100000000001',
              high: '0.000000100000000002',
              low: '0.000000100000000001',
              close: '0.000000100000000002',
              volume: '0.3000000',
            },
          ],
        }
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h' })

      expect(res.statusCode).toBe(200)
      const body = res.json()

      // 1. Acceptance criteria: No ::float cast remains inside an aggregate expression
      expect(capturedSql).not.toMatch(/(SUM|MAX|MIN|array_agg)\([^)]*::float/i)

      // 2. Acceptance criteria: Output precision is exact rather than float accumulation noise
      const candle = body.candles[0]
      expect(candle.volume).toBe(0.3)
      expect(candle.open).toBe(1.00000000001e-7)
      expect(candle.close).toBe(1.00000000002e-7)
      await app.close()
    })
  })

  describe('GET /volumes/:asset', () => {
    it('sums multi-venue volume without accumulating floating-point representation error', async () => {
      let capturedSql = ''
      mockQuery.mockImplementation(async (sql: string) => {
        capturedSql = sql
        return {
          rows: [
            {
              total_volume: '0.3000000',
              by_venue: { SDEX: 0.1, AMM: 0.2 },
              venues: ['AMM', 'SDEX'],
              trade_count: 2,
              observed_sample_count: 2,
              trade_count_by_venue: { SDEX: 1, AMM: 1 },
              median_trade_size: '0.15',
              top_trade_volume_share: '0.6666666666666666',
              volume_concentration: '0.5555555555555556',
              latest_trade_at: new Date('2026-01-01T00:00:00.000Z'),
            },
          ],
        }
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })

      expect(res.statusCode).toBe(200)
      const body = res.json()

      // Acceptance criteria: No ::float cast inside aggregate expression
      expect(capturedSql).not.toMatch(/(SUM|MAX|MIN|array_agg)\([^)]*::float/i)

      // In float arithmetic: 0.1 + 0.2 = 0.30000000000000004
      // In documented 7-decimal volume precision: totalVolume = 0.3 exactly
      expect(body.byVenue.SDEX).toBe(0.1)
      expect(body.byVenue.AMM).toBe(0.2)
      expect(body.totalVolume).toBe(0.3)
      await app.close()
    })
  })

  describe('GET /prices/history', () => {
    it('queries price_snapshots without ::float inside aggregates and preserves exact volume', async () => {
      let capturedSql = ''
      mockQuery.mockImplementation(async (sql: string) => {
        capturedSql = sql
        return {
          rows: [
            {
              bucket: new Date('2025-01-01T00:00:00Z'),
              price: '0.000000100000000001',
              volume: '0.3000000',
            },
          ],
        }
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&interval=1m' })

      expect(res.statusCode).toBe(200)
      const body = res.json()

      // Acceptance criteria: No ::float cast remains inside an aggregate expression
      expect(capturedSql).not.toMatch(/(SUM|MAX|MIN|array_agg)\([^)]*::float/i)

      expect(body.points[0].volume).toBe(0.3)
      expect(body.points[0].price).toBe(1.00000000001e-7)
      await app.close()
    })
  })

  describe('GET /price/:assetA/:assetB/history', () => {
    it('reads price_aggregates without ::float casts and formats values at the edge', async () => {
      let capturedSql = ''
      mockQuery.mockImplementation(async (sql: string) => {
        capturedSql = sql
        return {
          rows: [
            {
              bucket: new Date('2025-01-01T00:00:00Z'),
              window: '1h',
              vwap: '0.000000100000000001',
              sdex_vwap: '0.000000100000000001',
              amm_vwap: null,
              volume: '0.3000000',
              trade_count: 5,
              open_price: '0.000000100000000001',
              close_price: '0.000000100000000002',
              high_price: '0.000000100000000002',
              low_price: '0.000000100000000001',
            },
          ],
        }
      })

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/history?window=1h' })

      expect(res.statusCode).toBe(200)
      const body = res.json()

      // Acceptance criteria: No ::float cast in the query
      expect(capturedSql).not.toMatch(/::float/)

      const bucket = body.buckets[0]
      expect(bucket.volume).toBe(0.3)
      expect(bucket.vwap).toBe(1.00000000001e-7)
      expect(bucket.open).toBe(1.00000000001e-7)
      expect(bucket.close).toBe(1.00000000002e-7)
      await app.close()
    })
  })
})
