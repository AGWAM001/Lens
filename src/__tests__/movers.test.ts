import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import { registerMoversRoutes } from '../routes/movers'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerMoversRoutes(app)
  await app.ready()
  return app
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    pair_key: 'XLM/USDC',
    asset_a: 'XLM',
    asset_b: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    start_price: '0.10',
    end_price: '0.12',
    current_volume: '1000',
    prev_volume: '500',
    venues: ['SDEX', 'AMM'],
    sample_count: 42,
    last_updated: new Date('2026-10-16T12:00:00Z'),
    ...overrides,
  }
}

function lastCall() {
  const [sql, params] = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as [string, unknown[]]
  return { sql, params }
}

describe('GET /movers', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it('returns gainers, losers, and volume movers in one response', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        makeRow({
          pair_key: 'GAINER/XLM',
          start_price: '1.0',
          end_price: '1.5', // +50%
          current_volume: '1000',
          prev_volume: '500',
        }),
        makeRow({
          pair_key: 'LOSER/XLM',
          start_price: '2.0',
          end_price: '1.0', // -50%
          current_volume: '800',
          prev_volume: '400',
        }),
        makeRow({
          pair_key: 'VOLMOVER/XLM',
          start_price: '1.0',
          end_price: '1.01', // +1%
          current_volume: '10000',
          prev_volume: '100', // +9900% volume
        }),
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers?window=24h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.window).toBe('24h')
    expect(body.network).toBe('testnet')
    expect(body.gainers).toBeDefined()
    expect(body.losers).toBeDefined()
    expect(body.volumeMovers).toBeDefined()

    expect(body.gainers[0].pairKey).toBe('GAINER/XLM')
    expect(body.gainers[0].priceChangePct).toBeCloseTo(50)

    expect(body.losers[0].pairKey).toBe('LOSER/XLM')
    expect(body.losers[0].priceChangePct).toBeCloseTo(-50)

    expect(body.volumeMovers[0].pairKey).toBe('VOLMOVER/XLM')
    expect(body.volumeMovers[0].volumeChangePct).toBeCloseTo(9900)

    await app.close()
  })

  it('labels single-venue moves as isSingleVenue: true and multi-venue as false', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        makeRow({
          pair_key: 'SINGLE/XLM',
          venues: ['AMM'],
        }),
        makeRow({
          pair_key: 'MULTI/XLM',
          venues: ['AMM', 'SDEX'],
        }),
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers' })

    expect(res.statusCode).toBe(200)
    const body = res.json()

    const single = body.gainers.find((g: any) => g.pairKey === 'SINGLE/XLM')
    const multi = body.gainers.find((g: any) => g.pairKey === 'MULTI/XLM')

    expect(single.isSingleVenue).toBe(true)
    expect(single.venues).toEqual(['AMM'])

    expect(multi.isSingleVenue).toBe(false)
    expect(multi.venues).toEqual(['AMM', 'SDEX'])

    await app.close()
  })

  it.each(['1h', '24h', '7d'])('supports window %s', async (window) => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/movers?window=${window}` })

    expect(res.statusCode).toBe(200)
    expect(res.json().window).toBe(window)

    const { params } = lastCall()
    const startTime = params[1] as Date
    const endTime = params[2] as Date
    const prevStartTime = params[3] as Date

    // Verify window intervals
    const durationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60)
    const prevDurationHours = (startTime.getTime() - prevStartTime.getTime()) / (1000 * 60 * 60)

    const expectedHours = window === '1h' ? 1 : window === '24h' ? 24 : 24 * 7
    expect(Math.round(durationHours)).toBe(expectedHours)
    expect(Math.round(prevDurationHours)).toBe(expectedHours)

    await app.close()
  })

  it('rejects an unsupported window with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers?window=30d' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/window must be one of: 1h, 24h, 7d/)
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('defaults to 24h window when omitted', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers' })

    expect(res.statusCode).toBe(200)
    expect(res.json().window).toBe('24h')
    await app.close()
  })

  it('honours and echoes ?network= parameter and scopes query to that network', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers?network=mainnet' })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe('mainnet')

    const { params } = lastCall()
    expect(params[0]).toBe('mainnet')
    await app.close()
  })

  it('honours x-network header when query param is absent', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers', headers: { 'x-network': 'mainnet' } })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe('mainnet')

    const { params } = lastCall()
    expect(params[0]).toBe('mainnet')
    await app.close()
  })

  it('rejects invalid network with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers?network=devnet' })

    expect(res.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('includes provenance: venues, sampleCount, startPrice, endPrice, currentVolume, previousVolume, lastUpdated', async () => {
    const lastUpdated = new Date('2026-10-16T15:30:00.000Z')
    mockQuery.mockResolvedValue({
      rows: [
        makeRow({
          pair_key: 'XLM/USDC',
          asset_a: 'XLM',
          asset_b: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          start_price: '0.10',
          end_price: '0.15',
          current_volume: '5000',
          prev_volume: '2500',
          venues: ['SDEX'],
          sample_count: 120,
          last_updated: lastUpdated,
        }),
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers' })

    expect(res.statusCode).toBe(200)
    const item = res.json().gainers[0]

    expect(item.pairKey).toBe('XLM/USDC')
    expect(item.assetA).toBe('XLM')
    expect(item.assetB).toBe('USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
    expect(item.venues).toEqual(['SDEX'])
    expect(item.isSingleVenue).toBe(true)
    expect(item.sampleCount).toBe(120)
    expect(item.startPrice).toBe(0.10)
    expect(item.endPrice).toBe(0.15)
    expect(item.currentVolume).toBe(5000)
    expect(item.previousVolume).toBe(2500)
    expect(item.lastUpdated).toBe(lastUpdated.toISOString())

    await app.close()
  })

  it('handles pairs with no previous volume cleanly without divide-by-zero errors', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        makeRow({
          pair_key: 'NEW/XLM',
          start_price: '1.0',
          end_price: '1.2',
          current_volume: '500',
          prev_volume: '0',
        }),
      ],
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers' })

    expect(res.statusCode).toBe(200)
    const item = res.json().volumeMovers[0]
    expect(item.volumeChangePct).toBe(100)
    expect(item.previousVolume).toBe(0)
    expect(item.currentVolume).toBe(500)

    await app.close()
  })

  it('returns 500 when query fails without leaking DB credentials', async () => {
    mockQuery.mockRejectedValue(new Error('connection failed to postgres://user:secret@localhost:5432/lens'))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/movers' })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'Internal server error' })
    expect(res.body).not.toMatch(/secret/)

    await app.close()
  })
})
