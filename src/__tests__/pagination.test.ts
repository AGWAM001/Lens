import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetActivePairs } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetActivePairs: vi.fn(),
}))

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

vi.mock('../pairsRegistry', () => ({
  getActivePairs: mockGetActivePairs,
  hasPair: vi.fn(),
  registerPair: vi.fn(),
  persistPair: vi.fn(),
  parseAssetStr: vi.fn(),
  makePairKey: vi.fn(),
}))

import {
  parseLimit,
  encodeCursor,
  decodeCursor,
  slicePage,
  SCREENER_DEFAULT_LIMIT,
  SCREENER_MAX_LIMIT,
  POOLS_DEFAULT_LIMIT,
  POOLS_MAX_LIMIT,
} from '../pagination'
import { registerPoolsRoutes } from '../routes/pools'
import { registerPairsRoutes } from '../routes/pairs'

describe('parseLimit', () => {
  it('returns the default when the parameter is absent', () => {
    expect(parseLimit(undefined, 20, 100)).toEqual({ limit: 20 })
  })

  it('clamps out-of-range values into [1, max]', () => {
    expect(parseLimit('0', 20, 100)).toEqual({ limit: 1 })
    expect(parseLimit('-5', 20, 100)).toEqual({ limit: 1 })
    expect(parseLimit('1000', 20, 100)).toEqual({ limit: 100 })
  })

  it('accepts a limit inside the range', () => {
    expect(parseLimit('42', 20, 100)).toEqual({ limit: 42 })
    expect(parseLimit('1', 50, 200)).toEqual({ limit: 1 })
    expect(parseLimit('200', 50, 200)).toEqual({ limit: 200 })
  })

  it('rejects a non-integer limit with the screener error message', () => {
    expect(parseLimit('abc', 20, 100)).toEqual({ error: 'limit must be a valid integer' })
    expect(parseLimit('', 20, 100)).toEqual({ error: 'limit must be a valid integer' })
  })
})

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a [value, id] payload through base64 JSON', () => {
    const cursor = encodeCursor(20, 'B/X')
    expect(decodeCursor(cursor)).toEqual({ value: 20, id: 'B/X' })
  })

  it('is byte-identical to screener\'s historical cursor encoding', () => {
    expect(encodeCursor(20, 'B/X')).toBe(Buffer.from(JSON.stringify([20, 'B/X'])).toString('base64'))
  })

  it('returns null for malformed cursors so the route answers 400', () => {
    expect(decodeCursor('not-base64-json')).toBeNull()
    expect(decodeCursor(Buffer.from('null').toString('base64'))).toBeNull()
    expect(decodeCursor(Buffer.from('{"a":1}').toString('base64'))).toBeNull()
    expect(decodeCursor(Buffer.from('123').toString('base64'))).toBeNull()
  })

  it("returns 'skip' for a well-formed but degenerate cursor", () => {
    expect(decodeCursor(Buffer.from('[null, "B/X"]').toString('base64'))).toBe('skip')
    expect(decodeCursor(Buffer.from('[20, ""]').toString('base64'))).toBe('skip')
    expect(decodeCursor(Buffer.from('[1]').toString('base64'))).toBe('skip')
  })
})

describe('slicePage', () => {
  it('reports hasMore and trims the probe row', () => {
    expect(slicePage([1, 2, 3], 2)).toEqual({ data: [1, 2], hasMore: true })
  })

  it('keeps every row when the probe found no extra row', () => {
    expect(slicePage([1, 2], 2)).toEqual({ data: [1, 2], hasMore: false })
    expect(slicePage([], 2)).toEqual({ data: [], hasMore: false })
  })
})

/**
 * The mid-page-insert acceptance tests below run against the real route
 * handlers with a mutable fake table standing in for Postgres. The mock
 * honours the same contract the SQL does — keyset filter, ascending order,
 * LIMIT — so a row inserted between page fetches lands exactly where a real
 * insert would, and an offset implementation would demonstrably return a
 * duplicate.
 */

async function buildPoolsApp() {
  const app = Fastify({ logger: false })
  await registerPoolsRoutes(app)
  await app.ready()
  return app
}

describe('GET /pools cursor pagination', () => {
  let table: { pool_id: string }[]

  beforeEach(() => {
    table = [{ pool_id: 'A' }, { pool_id: 'B' }, { pool_id: 'C' }]
    // Contract of the route's SQL: params are [network, (cursor pool_id)?,
    // limit + 1]; rows come back ordered by pool_id with the keyset applied.
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      const limitPlus1 = params[params.length - 1] as number
      const after = params.length === 3 ? (params[1] as string) : null
      let rows = table.map(r => ({ ...r, asset_a: 'X', asset_b: 'Y', reserve_a: 1, reserve_b: 2, spot_price: 2, fee_bp: 30, timestamp: new Date('2025-01-01T00:00:00Z') }))
      if (after) rows = rows.filter(r => r.pool_id > after)
      rows.sort((a, b) => (a.pool_id < b.pool_id ? -1 : 1))
      return { rows: rows.slice(0, limitPlus1) }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('pages without duplicates or skips when a pool is inserted mid-page', async () => {
    const app = await buildPoolsApp()

    // Page 1: default limit 50 would swallow everything, so ask for 2.
    const page1 = await app.inject({ method: 'GET', url: '/pools?limit=2' })
    expect(page1.statusCode).toBe(200)
    const body1 = page1.json()
    expect(body1.pools.map((p: { pool_id: string }) => p.pool_id)).toEqual(['A', 'B'])
    expect(body1.hasMore).toBe(true)
    expect(body1.nextCursor).toBeTruthy()

    // A pool sorts into the range page 1 already covered. An OFFSET-based
    // page 2 would now return B again (and skip C); the keyset cursor must not.
    table.push({ pool_id: 'A2' })

    const page2 = await app.inject({
      method: 'GET',
      url: `/pools?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
    })
    expect(page2.statusCode).toBe(200)
    const body2 = page2.json()
    expect(body2.pools.map((p: { pool_id: string }) => p.pool_id)).toEqual(['C'])
    expect(body2.hasMore).toBe(false)
    expect(body2.nextCursor).toBeNull()
    await app.close()
  })

  it('returns the first page and hasMore=false when everything fits', async () => {
    const app = await buildPoolsApp()
    const res = await app.inject({ method: 'GET', url: '/pools' })
    const body = res.json()
    expect(body.pools).toHaveLength(3)
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
    await app.close()
  })

  it('rejects a malformed cursor and an invalid limit with 400', async () => {
    const app = await buildPoolsApp()
    const badCursor = await app.inject({ method: 'GET', url: '/pools?cursor=@@@' })
    expect(badCursor.statusCode).toBe(400)
    const badLimit = await app.inject({ method: 'GET', url: '/pools?limit=abc' })
    expect(badLimit.statusCode).toBe(400)
    await app.close()
  })

  it('uses the documented default and maximum limits', () => {
    expect(SCREENER_DEFAULT_LIMIT).toBe(20)
    expect(SCREENER_MAX_LIMIT).toBe(100)
    expect(POOLS_DEFAULT_LIMIT).toBe(50)
    expect(POOLS_MAX_LIMIT).toBe(200)
  })
})

describe('GET /pairs cursor pagination', () => {
  const pair = (pairKey: string) => ({
    pairKey,
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USDC', issuer: 'GTEST' },
  })

  let watched: string[]

  beforeEach(() => {
    watched = ['B/C', 'A/B', 'C/D']
    mockGetActivePairs.mockImplementation(() => watched.map(pair))
    mockQuery.mockResolvedValue({ rows: [] })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  async function buildPairsApp() {
    const app = Fastify({ logger: false })
    await registerPairsRoutes(app)
    await app.ready()
    return app
  }

  it('pages without duplicates or skips when a pair is registered mid-page', async () => {
    const app = await buildPairsApp()

    const page1 = await app.inject({ method: 'GET', url: '/pairs?limit=2' })
    expect(page1.statusCode).toBe(200)
    const body1 = page1.json()
    // Sorted by pairKey regardless of registry order.
    expect(body1.pairs.map((p: { pairKey: string }) => p.pairKey)).toEqual(['A/B', 'B/C'])
    expect(body1.hasMore).toBe(true)

    // Insert a pair that sorts into page 1's range mid-paging.
    watched.push('A2/X')

    const page2 = await app.inject({
      method: 'GET',
      url: `/pairs?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
    })
    expect(page2.statusCode).toBe(200)
    const body2 = page2.json()
    // Keyset: everything strictly after B/C — no duplicate B/C, no skipped C/D.
    // (A2/X sorts before B/C, so it belongs to page 1 and is not repeated.)
    expect(body2.pairs.map((p: { pairKey: string }) => p.pairKey)).toEqual(['C/D'])
    expect(body2.hasMore).toBe(false)
    expect(body2.nextCursor).toBeNull()
    await app.close()
  })

  it('rejects a malformed cursor with 400', async () => {
    const app = await buildPairsApp()
    const res = await app.inject({ method: 'GET', url: '/pairs?cursor=@@@' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
