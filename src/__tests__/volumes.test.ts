import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import { activeNetwork } from '../config'
import { registerVolumeRoutes } from '../routes/volumes'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerVolumeRoutes(app)
  await app.ready()
  return app
}

describe('GET /volumes/:asset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the cross-venue sum and a per-venue breakdown', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          total_volume: '150',
          by_venue: { SDEX: 100.5, AMM: 49.5 },
          venues: ['AMM', 'SDEX'],
          trade_count: 5,
          observed_sample_count: 5,
          median_trade_size: '25',
          top_trade_volume_share: '0.5',
          volume_concentration: '0.3',
          latest_trade_at: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asset).toBe('XLM')
    expect(body.network).toBe(activeNetwork)
    expect(body.window).toBe('24h')
    expect(body.byVenue).toEqual({ SDEX: 100.5, AMM: 49.5 })
    expect(body.totalVolume).toBeCloseTo(150)
    expect(body.venues.sort()).toEqual(['AMM', 'SDEX'])
    expect(body.tradeCount).toBe(5)
    expect(body.medianTradeSize).toBe(25)
    expect(body.topTradeVolumeShare).toBe(0.5)
    expect(body.volumeConcentration).toBe(0.3)
    expect(body.concentrationMeasure).toBe('hhi')
    expect(body.status).toBe('ok')
    expect(body.provenance).toMatchObject({
      venues: ['AMM', 'SDEX'],
      sampleCount: 5,
      observedSampleCount: 5,
      latestTradeAt: '2026-01-01T00:00:00.000Z',
    })
    expect(body.provenance.dataAgeSeconds).toBeGreaterThan(0)
    await app.close()
  })

  it('distinguishes one large trade from many small trades at equal volume', async () => {
    const makeAggregate = (sizes: number[]) => {
      const total = sizes.reduce((sum, size) => sum + size, 0)
      const ordered = [...sizes].sort((a, b) => a - b)
      const middle = Math.floor(ordered.length / 2)
      const median = ordered.length % 2 === 0
        ? (ordered[middle - 1] + ordered[middle]) / 2
        : ordered[middle]
      return {
        total_volume: String(total),
        by_venue: { SDEX: total },
        venues: ['SDEX'],
        trade_count: sizes.length,
        observed_sample_count: sizes.length,
        median_trade_size: String(median),
        top_trade_volume_share: String(Math.max(...sizes) / total),
        volume_concentration: String(sizes.reduce((sum, size) => sum + (size / total) ** 2, 0)),
        latest_trade_at: new Date('2026-01-01T00:00:00.000Z'),
      }
    }

    const app = await buildApp()
    mockQuery.mockResolvedValueOnce({ rows: [makeAggregate([1000])] })
    const oneTrade = (await app.inject({ method: 'GET', url: '/volumes/XLM?network=testnet' })).json()
    mockQuery.mockResolvedValueOnce({ rows: [makeAggregate(Array(1000).fill(1))] })
    const manyTrades = (await app.inject({ method: 'GET', url: '/volumes/XLM?network=testnet' })).json()

    expect(oneTrade.totalVolume).toBe(manyTrades.totalVolume)
    expect(oneTrade.tradeCount).toBe(1)
    expect(oneTrade.medianTradeSize).toBe(1000)
    expect(oneTrade.topTradeVolumeShare).toBe(1)
    expect(oneTrade.volumeConcentration).toBe(1)
    expect(manyTrades.tradeCount).toBe(1000)
    expect(manyTrades.medianTradeSize).toBe(1)
    expect(manyTrades.topTradeVolumeShare).toBe(0.001)
    expect(manyTrades.volumeConcentration).toBeCloseTo(0.001)
    const aggregateSql = mockQuery.mock.calls[0][0] as string
    expect(aggregateSql).toMatch(/percentile_cont\(0\.5\).*WITHIN GROUP/s)
    expect(aggregateSql).toContain('MAX(volume) FILTER (WHERE volume > 0)')
    expect(aggregateSql).toContain('SUM(volume * volume) FILTER (WHERE volume > 0)')
    await app.close()
  })

  it('defaults to the 24h window', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM' })
    expect(res.statusCode).toBe(200)
    expect(res.json().window).toBe('24h')
    await app.close()
  })

  it.each(['24h', '7d', '30d'])('supports the %s window', async (window) => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/volumes/XLM?window=${window}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().window).toBe(window)
    // The query receives the asset and a Date cutoff.
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['XLM', activeNetwork, expect.any(Date)])
    await app.close()
  })

  it('uses a wider lookback for longer windows', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })
    const start24h = (mockQuery.mock.calls[0][1] as [string, string, Date])[2].getTime()
    mockQuery.mockClear()
    await app.inject({ method: 'GET', url: '/volumes/XLM?window=30d' })
    const start30d = (mockQuery.mock.calls[0][1] as [string, string, Date])[2].getTime()

    expect(start30d).toBeLessThan(start24h)
    await app.close()
  })

  it('rejects an invalid window with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=12h' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/window must be one of/)
    await app.close()
  })

  it('returns zero volume when there are no trades', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=7d' })
    const body = res.json()
    expect(body.totalVolume).toBe(0)
    expect(body.byVenue).toEqual({})
    expect(body.tradeCount).toBe(0)
    expect(body.medianTradeSize).toBeNull()
    expect(body.topTradeVolumeShare).toBeNull()
    expect(body.volumeConcentration).toBeNull()
    expect(body.status).toBe('no_trades')
    await app.close()
  })

  it('reports samples without positive volume as unavailable metrics', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        total_volume: '0',
        by_venue: {},
        venues: [],
        trade_count: 0,
        observed_sample_count: 3,
        median_trade_size: null,
        top_trade_volume_share: null,
        volume_concentration: null,
        latest_trade_at: null,
      }],
    })
    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })).json()
    expect(body.status).toBe('no_positive_volume')
    expect(body.medianTradeSize).toBeNull()
    expect(body.volumeConcentration).toBeNull()
    expect(body.provenance).toMatchObject({ sampleCount: 0, observedSampleCount: 3 })
    await app.close()
  })

  it('returns 500 when the query fails', async () => {
    mockQuery.mockRejectedValue(new Error('db down'))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({
      code: 'internal_error',
      message: 'An internal server error occurred.',
      correlationId: expect.any(String),
    })
    expect(res.body).not.toMatch(/db down/)
    await app.close()
  })

  describe('network scoping', () => {
    // Simulates a price_points table holding both networks: the mocked query
    // honours the network predicate the route passes ($2), as Postgres would.
    const table = [
      { network: 'testnet', volume: 100, trades: 2 },
      { network: 'mainnet', volume: 900, trades: 7 },
    ]
    beforeEach(() => {
      mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
        expect(sql).toMatch(/AND network = \$2/)
        const row = table.find((r) => r.network === params[1])!
        return { rows: [{
          total_volume: String(row.volume),
          by_venue: { SDEX: row.volume },
          venues: ['SDEX'],
          trade_count: row.trades,
          observed_sample_count: row.trades,
          median_trade_size: String(row.volume / row.trades),
          top_trade_volume_share: '0.5',
          volume_concentration: '0.5',
          latest_trade_at: new Date('2026-01-01T00:00:00.000Z'),
        }] }
      })
    })

    it('does not pool testnet and mainnet volume', async () => {
      const app = await buildApp()
      const t = (await app.inject({ method: 'GET', url: '/volumes/XLM?network=testnet' })).json()
      const m = (await app.inject({ method: 'GET', url: '/volumes/XLM?network=mainnet' })).json()
      expect(t.totalVolume).toBe(100)
      expect(t.tradeCount).toBe(2)
      expect(m.totalVolume).toBe(900)
      expect(m.tradeCount).toBe(7)
      await app.close()
    })

    it('echoes the resolved network in the response', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/volumes/XLM?network=mainnet' })
      expect(res.json().network).toBe('mainnet')
      await app.close()
    })

    it('defaults to the active network and reports it', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/volumes/XLM' })
      expect(res.json().network).toBe(activeNetwork)
      expect(mockQuery.mock.calls[0][1][1]).toBe(activeNetwork)
      await app.close()
    })

    it('treats an empty network parameter as the active network', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/volumes/XLM?network=' })
      expect(res.statusCode).toBe(200)
      expect(res.json().network).toBe(activeNetwork)
      expect(mockQuery.mock.calls[0][1][1]).toBe(activeNetwork)
      await app.close()
    })

    it('rejects an unknown network with 400 and issues no query', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/volumes/XLM?network=futurenet' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/network must be one of/)
      expect(mockQuery).not.toHaveBeenCalled()
      await app.close()
    })
  })
})
