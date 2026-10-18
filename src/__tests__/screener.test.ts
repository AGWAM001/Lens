import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import { registerScreenerRoutes } from '../routes/screener'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerScreenerRoutes(app)
  await app.ready()
  return app
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    pair_key: 'XLM/USDC',
    volume: 1000,
    price: 0.12,
    change_24h: 1.5,
    liquidity: 50000,
    ...overrides,
  }
}

function lastCall() {
  const [sql, params] = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as [string, unknown[]]
  return { sql, params }
}

describe('GET /screener', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it('returns rows without a market_cap field', async () => {
    mockQuery.mockResolvedValue({ rows: [makeRow()] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).not.toHaveProperty('market_cap')
    expect(body.data[0].liquidity).toBe(50000)
    expect(lastCall().sql).not.toMatch(/market_cap/)
    await app.close()
  })

  it('rejects market_cap as a filter instead of silently ignoring it', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener?market_cap=1000000' })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid market_cap: market_cap is not supported/)
    expect(body.code).toBe('UNSUPPORTED_PARAMETER')
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects sortBy=market_cap', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener?sortBy=market_cap' })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid sortBy: market_cap is not supported/)
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('sorts by the requested field and direction', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener?sortBy=liquidity&order=asc' })

    expect(res.statusCode).toBe(200)
    expect(lastCall().sql).toMatch(/ORDER BY liquidity ASC, pair_key ASC/)
    await app.close()
  })

  it('defaults to sorting by volume descending', async () => {
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/screener' })
    expect(lastCall().sql).toMatch(/ORDER BY volume DESC, pair_key DESC/)
    await app.close()
  })

  it('rejects an unknown sortBy and a bad order', async () => {
    const app = await buildApp()
    const badSort = await app.inject({ method: 'GET', url: '/screener?sortBy=price;DROP' })
    const badOrder = await app.inject({ method: 'GET', url: '/screener?order=sideways' })

    expect(badSort.statusCode).toBe(400)
    expect(badOrder.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('turns numeric filters into bound WHERE conditions', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/screener?volume=500&liquidity=10000&price_min=0.1&price_max=2&change_24h_min=-5&change_24h_max=5',
    })

    expect(res.statusCode).toBe(200)
    const { sql, params } = lastCall()
    expect(sql).toMatch(/volume >= \$2/)
    expect(sql).toMatch(/change_24h >= \$3/)
    expect(sql).toMatch(/change_24h <= \$4/)
    expect(sql).toMatch(/price >= \$5/)
    expect(sql).toMatch(/price <= \$6/)
    expect(sql).toMatch(/liquidity >= \$7/)
    // $1 is the network; the filters follow in order, the page size comes last.
    expect(params.slice(1)).toEqual([500, -5, 5, 0.1, 2, 10000, 21])
    await app.close()
  })

  it('rejects a filter that is not a number', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener?volume=lots' })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid volume: volume must be a valid number/)
    expect(body.code).toBe('VALIDATION_ERROR')
    await app.close()
  })

  it('clamps limit to 100 instead of rejecting it', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener?limit=500' })

    expect(res.statusCode).toBe(200)
    // limit=500 is clamped to 100; the query fetches limit+1 rows to detect hasMore
    expect(lastCall().params.at(-1)).toBe(101)
    await app.close()
  })

  it('clamps limit below 1 up to 1', async () => {
    const app = await buildApp()
    const zero = await app.inject({ method: 'GET', url: '/screener?limit=0' })
    expect(zero.statusCode).toBe(200)
    expect(lastCall().params.at(-1)).toBe(2)

    const negative = await app.inject({ method: 'GET', url: '/screener?limit=-5' })
    expect(negative.statusCode).toBe(200)
    expect(lastCall().params.at(-1)).toBe(2)
    await app.close()
  })

  it('rejects a non-numeric or fractional limit', async () => {
    const app = await buildApp()
    const bad = await app.inject({ method: 'GET', url: '/screener?limit=abc' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('VALIDATION_ERROR')

    const fractional = await app.inject({ method: 'GET', url: '/screener?limit=2.5' })
    expect(fractional.statusCode).toBe(400)
    expect(fractional.json().code).toBe('VALIDATION_ERROR')
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('paginates: fetches one extra row and returns a cursor for the last kept row', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        makeRow({ pair_key: 'A/X', volume: 30 }),
        makeRow({ pair_key: 'B/X', volume: 20 }),
        makeRow({ pair_key: 'C/X', volume: 10 }),
      ],
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener?limit=2' })

    const body = res.json()
    expect(body.hasMore).toBe(true)
    expect(body.data.map((r: { pair_key: string }) => r.pair_key)).toEqual(['A/X', 'B/X'])
    expect(JSON.parse(Buffer.from(body.nextCursor, 'base64').toString())).toEqual([20, 'B/X'])
    expect(lastCall().params.at(-1)).toBe(3)
    await app.close()
  })

  it('applies a cursor as a keyset condition on the sort field', async () => {
    const cursor = Buffer.from(JSON.stringify([20, 'B/X'])).toString('base64')
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/screener?cursor=${cursor}` })

    expect(res.statusCode).toBe(200)
    const { sql, params } = lastCall()
    expect(sql).toMatch(/\(volume, pair_key\) < \(\$2, \$3\)/)
    expect(params.slice(1, 3)).toEqual([20, 'B/X'])
    await app.close()
  })

  it('rejects a malformed cursor', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener?cursor=not-base64-json' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  describe('network scoping', () => {
    it('scopes all three CTEs to one network', async () => {
      const app = await buildApp()
      await app.inject({ method: 'GET', url: '/screener?network=mainnet' })

      const { sql, params } = lastCall()
      expect(params[0]).toBe('mainnet')
      expect(sql).toMatch(/FROM price_points\s+WHERE network = \$1/)
      expect(sql).toMatch(/FROM pool_snapshots ps\s+WHERE ps\.network = \$1/)
      expect(sql).toMatch(/FROM price_aggregates\s+WHERE network = \$1/)
      await app.close()
    })

    it('honours the x-network header', async () => {
      const app = await buildApp()
      await app.inject({ method: 'GET', url: '/screener', headers: { 'x-network': 'testnet' } })
      expect(lastCall().params[0]).toBe('testnet')
      await app.close()
    })

    it('rejects an unknown network before querying', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/screener?network=devnet' })
      expect(res.statusCode).toBe(400)
      expect(mockQuery).not.toHaveBeenCalled()
      await app.close()
    })
  })

  it('returns 500 without leaking the error when the query fails', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused postgres://user:secret@host'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/screener' })

    expect(res.statusCode).toBe(500)
    expect(res.body).not.toMatch(/secret/)
    spy.mockRestore()
    await app.close()
  })
})
