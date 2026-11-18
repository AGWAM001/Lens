import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery }, prisma: {} }))
vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({ config: { pairs: [] }, activeNetwork: 'testnet' }))

import { registerGraphQL } from '../api/graphql'
import { MARKET_CAP_UNSUPPORTED } from '../services/screener'

const SCREENER_QUERY = `query Screener(
  $filters: ScreenerFilters
  $sortBy: String
  $order: ScreenerSortOrder
  $cursor: String
  $limit: Int
) {
  screener(filters: $filters, sortBy: $sortBy, order: $order, cursor: $cursor, limit: $limit) {
    network
    hasMore
    nextCursor
    rows {
      pairKey
      volume
      price
      change24h
      liquidity
      liquidityUnit
    }
  }
}`

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

async function screener(app: FastifyInstance, variables: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query: SCREENER_QUERY, variables },
  })
  return res.json()
}

describe('GraphQL screener query', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
    app = Fastify({ logger: false })
    await registerGraphQL(app)
    await app.ready()
  })

  it('turns a filter into a bound WHERE condition, like the REST route', async () => {
    mockQuery.mockResolvedValue({ rows: [makeRow()] })
    const json = await screener(app, { filters: { volume: 500 } })

    expect(json.errors).toBeUndefined()
    const { sql, params } = lastCall()
    expect(sql).toMatch(/volume >= \$2/)
    // $1 is the network; the filter follows; the page size (+1 probe row) is last.
    expect(params[0]).toBe('testnet')
    expect(params[1]).toBe(500)
    expect(params.at(-1)).toBe(21)

    const page = json.data.screener
    expect(page.network).toBe('testnet')
    expect(page.rows).toEqual([
      {
        pairKey: 'XLM/USDC',
        volume: 1000,
        price: 0.12,
        change24h: 1.5,
        liquidity: 50000,
        liquidityUnit: 'USDC',
      },
    ])
  })

  it('sorts by the requested field and direction', async () => {
    const json = await screener(app, { sortBy: 'liquidity', order: 'ASC' })

    expect(json.errors).toBeUndefined()
    expect(lastCall().sql).toMatch(/ORDER BY liquidity ASC, pair_key ASC/)
  })

  it('defaults to sorting by volume descending', async () => {
    const json = await screener(app)

    expect(json.errors).toBeUndefined()
    expect(lastCall().sql).toMatch(/ORDER BY volume DESC, pair_key DESC/)
  })

  it('clamps limit to 100 instead of rejecting it', async () => {
    const json = await screener(app, { limit: 500 })

    expect(json.errors).toBeUndefined()
    expect(lastCall().params.at(-1)).toBe(101)
  })

  it('hits the page boundary: keeps limit rows, reports hasMore and a cursor for the last kept row', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        makeRow({ pair_key: 'A/X', volume: 30 }),
        makeRow({ pair_key: 'B/X', volume: 20 }),
        makeRow({ pair_key: 'C/X', volume: 10 }),
      ],
    })
    const json = await screener(app, { limit: 2 })

    expect(json.errors).toBeUndefined()
    const page = json.data.screener
    expect(page.rows.map((r: { pairKey: string }) => r.pairKey)).toEqual(['A/X', 'B/X'])
    expect(page.hasMore).toBe(true)
    expect(JSON.parse(Buffer.from(page.nextCursor, 'base64').toString())).toEqual([20, 'B/X'])
    expect(lastCall().params.at(-1)).toBe(3)
  })

  it('applies a cursor as a keyset condition on the sort field', async () => {
    const cursor = Buffer.from(JSON.stringify([20, 'B/X'])).toString('base64')
    const json = await screener(app, { cursor })

    expect(json.errors).toBeUndefined()
    const { sql, params } = lastCall()
    expect(sql).toMatch(/\(volume, pair_key\) < \(\$2, \$3\)/)
    expect(params.slice(1, 3)).toEqual([20, 'B/X'])
  })

  it('rejects a malformed cursor', async () => {
    const json = await screener(app, { cursor: 'not-base64-json' })

    expect(json.errors).toHaveLength(1)
    expect(json.errors[0].message).toBe('Invalid cursor format')
    expect(json.errors[0].extensions.code).toBe('INVALID_INPUT')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects the marketCap filter with the same explanation REST gives', async () => {
    const json = await screener(app, { filters: { marketCap: 1000000 } })

    expect(json.errors).toHaveLength(1)
    // Same constant the REST route rejects with — not a silent null.
    expect(json.errors[0].message).toBe(MARKET_CAP_UNSUPPORTED)
    expect(json.errors[0].extensions.code).toBe('UNSUPPORTED_PARAMETER')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects sortBy: "market_cap" with the same explanation', async () => {
    const json = await screener(app, { sortBy: 'market_cap' })

    expect(json.errors).toHaveLength(1)
    expect(json.errors[0].message).toBe(MARKET_CAP_UNSUPPORTED)
    expect(json.errors[0].extensions.code).toBe('INVALID_INPUT')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects an unknown sortBy', async () => {
    const json = await screener(app, { sortBy: 'price;DROP' })

    expect(json.errors).toHaveLength(1)
    expect(json.errors[0].message).toMatch(/sortBy must be one of/)
    expect(json.errors[0].extensions.code).toBe('INVALID_INPUT')
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
