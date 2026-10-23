import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))
vi.mock('../config', () => ({ activeNetwork: 'testnet' }))

import { registerRateRoutes } from '../routes/rates'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerRateRoutes(app)
  await app.ready()
  return app
}

/** One (venue, pool) latest observation, as the DISTINCT ON query returns it. */
function row(
  venue: string,
  poolId: string,
  supply: string,
  borrow: string,
  opts: { source?: string; poolName?: string | null } = {},
) {
  return {
    venue,
    source: opts.source ?? `${venue}_lending`,
    pool_id: poolId,
    pool_name: opts.poolName ?? null,
    supply_rate: supply,
    borrow_rate: borrow,
    ledger: 5000,
    timestamp: new Date('2026-09-01T12:00:00.000Z'),
  }
}

describe('GET /rates/:asset', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('names each venue and the pool its rate came from', async () => {
    mockQuery.mockResolvedValue({
      rows: [row('blend', 'CANDDYMUSDCPOOL', '0.05', '0.07', { poolName: 'Blend USDC' })],
    })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/rates/USDC' })
    const body = res.json()

    expect(res.statusCode).toBe(200)
    expect(body.asset).toBe('USDC')
    expect(body.venues).toHaveLength(1)
    expect(body.venues[0].venue).toBe('blend')
    expect(body.venues[0].source).toBe('blend_lending')
    expect(body.venues[0].pool).toBe('CANDDYMUSDCPOOL')
    expect(body.venues[0].poolName).toBe('Blend USDC')
    expect(body.venues[0].supplyRate).toBeCloseTo(0.05, 8)
    expect(body.venues[0].borrowRate).toBeCloseTo(0.07, 8)
    expect(body.best.venue).toBe('blend')
    expect(body.count).toBe(1)
  })

  it('answers an asset quoted on several venues, best yield first', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        row('blend', 'POOL-A', '0.03', '0.05'),
        row('marginal', 'POOL-B', '0.09', '0.12'),
        row('other', 'POOL-C', '0.06', '0.08'),
      ],
    })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/rates/USDC' })).json()

    expect(body.venues.map((v: any) => v.venue)).toEqual(['marginal', 'other', 'blend'])
    expect(body.best.venue).toBe('marginal')
    expect(body.count).toBe(3)
  })

  it('reduces a venue running several pools to its richest market', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        row('blend', 'POOL-LOW', '0.02', '0.04'),
        row('blend', 'POOL-HIGH', '0.08', '0.10'),
      ],
    })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/rates/USDC' })).json()

    expect(body.venues).toHaveLength(1)
    expect(body.venues[0].pool).toBe('POOL-HIGH')
    expect(body.venues[0].supplyRate).toBeCloseTo(0.08, 8)
  })

  it('returns an empty list and a 200 (not a 404) for an asset with no market', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/rates/NOPE' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.venues).toEqual([])
    expect(body.best).toBeNull()
    expect(body.count).toBe(0)
  })

  it('scopes the query to one network, so two chains are never pooled', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/rates/USDC?network=mainnet' })

    expect(mockQuery.mock.calls[0][0]).toMatch(/network = \$2/)
    expect(mockQuery.mock.calls[0][1][1]).toBe('mainnet')
  })

  it('defaults to the active network rather than querying across both', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    const body = (await app.inject({ method: 'GET', url: '/rates/USDC' })).json()

    expect(body.network).toBe('testnet')
    expect(mockQuery.mock.calls[0][1][1]).toBe('testnet')
  })

  it('rejects an unknown network instead of silently falling back', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/rates/USDC?network=futurenet' })

    expect(res.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('answers 500 with a message rather than throwing when the query fails', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/rates/USDC' })

    expect(res.statusCode).toBe(500)
    expect(res.json().error).toMatch(/connection refused/)
  })
})
