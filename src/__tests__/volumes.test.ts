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
        { source: 'SDEX', volume: '100.5', trade_count: 3 },
        { source: 'AMM', volume: '49.5', trade_count: 2 },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asset).toBe('XLM')
    expect(body.window).toBe('24h')
    expect(body.byVenue).toEqual({ SDEX: 100.5, AMM: 49.5 })
    expect(body.totalVolume).toBeCloseTo(150)
    expect(body.venues.sort()).toEqual(['AMM', 'SDEX'])
    expect(body.tradeCount).toBe(5)
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
    await app.close()
  })

  it('returns 500 when the query fails', async () => {
    mockQuery.mockRejectedValue(new Error('db down'))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/volumes/XLM?window=24h' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toMatch(/Volume aggregation failed/)
    await app.close()
  })

  describe('network scoping', () => {
    // Simulates a price_points table holding both networks: the mocked query
    // honours the network predicate the route passes ($2), as Postgres would.
    const table = [
      { network: 'testnet', source: 'SDEX', volume: 100, trades: 2 },
      { network: 'mainnet', source: 'SDEX', volume: 900, trades: 7 },
    ]
    beforeEach(() => {
      mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
        expect(sql).toMatch(/AND network = \$2/)
        return {
          rows: table
            .filter((r) => r.network === params[1])
            .map((r) => ({ source: r.source, volume: String(r.volume), trade_count: r.trades })),
        }
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
