import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import {
  DISCOVERY_SEARCH_CANDIDATE_CAP,
  calculateQualityScore,
  calculateRelevanceScore,
  registerDiscoveryRoutes,
} from '../routes/discovery'
import { registerNetworkSelector } from '../middleware/network'
import { decodeCursor, encodeCursor } from '../pagination'

// The mock is deliberately closure-only (`findMany: (...args) => mock...`), so
// the factory can run before these consts are initialised.
const mockFindMany = vi.fn()
const mockCount = vi.fn()

vi.mock('../db', () => ({
  prisma: {
    bazaarResource: {
      findMany: (...args: any[]) => mockFindMany(...args),
      count: (...args: any[]) => mockCount(...args),
    },
  },
  pgPool: { query: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Every ranking test starts from "the database matched exactly what the
  // handler was given"; tests that care about the where clause assert on it.
  mockCount.mockImplementation(async () => 0)
})

async function buildApp() {
  const app = Fastify({ logger: false })
  // The search route answers for `req.network`, which only exists once the
  // network selector has run — same as the real server. Without it a request
  // that named its network in `x-network` would be tested against a route the
  // production app never actually builds.
  await app.register(registerNetworkSelector)
  await registerDiscoveryRoutes(app)
  return app
}

let clock = 0
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    type: 'http',
    network: 'testnet',
    url: 'https://example.test',
    serviceName: 'Example',
    description: 'An example resource.',
    mimeType: 'application/json',
    tags: [] as string[],
    iconUrl: null,
    payTo: 'G' + 'A'.repeat(55),
    bazaarSchema: {},
    createdAt: new Date(Date.UTC(2026, 0, 1) + (clock += 1_000)),
    ...overrides,
  }
}

/** Days before the fixture epoch, so "old" and "new" are the row's own age. */
function daysAgo(days: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + 30 * 12) - days * 86_400_000)
}

describe('Bazaar Discovery Search & Ranking (#129)', () => {
  it('calculates quality score based on metadata completeness', () => {
    const poor = { serviceName: 'a' }
    const rich = {
      serviceName: 'Lens Stellar Oracle',
      description: 'Real-time multi-venue price discovery for Stellar and Soroban assets.',
      tags: ['oracle', 'defi', 'stellar'],
      iconUrl: 'https://lens.stellar/icon.png',
      bazaarSchema: { input: {} },
    }

    expect(calculateQualityScore(poor)).toBeLessThan(0.5)
    expect(calculateQualityScore(rich)).toBeGreaterThanOrEqual(0.9)
  })

  it('calculates relevance score matching query terms in serviceName, tags, and description', () => {
    const resource = {
      serviceName: 'Phoenix DEX Swaps',
      description: 'Automated market maker protocol on Soroban.',
      tags: ['dex', 'amm', 'phoenix'],
      url: 'https://phoenix.fi',
    }

    const matchName = calculateRelevanceScore('Phoenix', resource)
    expect(matchName.score).toBeGreaterThan(0)
    expect(matchName.reasons.some(r => r.includes('service_name_match'))).toBe(true)

    const matchTag = calculateRelevanceScore('amm', resource)
    expect(matchTag.score).toBeGreaterThan(0)
    expect(matchTag.reasons.some(r => r.includes('tag_match'))).toBe(true)

    const noMatch = calculateRelevanceScore('bitcoin lightning', resource)
    expect(noMatch.score).toBe(0)
  })

  it('pushes ILIKE term filtering into Prisma database where clause with deterministic ordering', async () => {
    mockFindMany.mockResolvedValueOnce([
      row({
        id: 'res-1',
        url: 'https://oracle.stellar.org',
        serviceName: 'Stellar Price Oracle',
        description: 'Multi-venue oracle feed',
        tags: ['oracle', 'price'],
      }),
    ])
    mockCount.mockResolvedValueOnce(1)

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle' })

    expect(res.statusCode).toBe(200)
    expect(mockFindMany).toHaveBeenCalledTimes(1)
    const callArgs = mockFindMany.mock.calls[0][0]
    expect(callArgs.where.OR).toBeDefined()
    expect(callArgs.where.OR).toContainEqual({ serviceName: { contains: 'oracle', mode: 'insensitive' } })
    expect(callArgs.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }])
    // One row past the cap is read on purpose: its presence is what tells the
    // route that the query has matches it is not going to rank.
    expect(callArgs.take).toBe(DISCOVERY_SEARCH_CANDIDATE_CAP + 1)

    const body = res.json()
    expect(body.totalMatched).toBe(1)
    expect(body.truncated).toBe(false)
    expect(body.items[0].id).toBe('res-1')
  })

  it('filters each query term separately, including against tags (#676)', async () => {
    mockFindMany.mockResolvedValueOnce([])
    mockCount.mockResolvedValueOnce(0)

    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/discovery/search?q=oracle%20price' })

    const or = mockFindMany.mock.calls[0][0].where.OR
    // `q=oracle price` used to ask Postgres for a tag literally equal to the
    // whole string, which no tag ever is, and for one description containing
    // the two words in that order.
    expect(or).toContainEqual({ serviceName: { contains: 'oracle', mode: 'insensitive' } })
    expect(or).toContainEqual({ serviceName: { contains: 'price', mode: 'insensitive' } })
    expect(or).toContainEqual({ description: { contains: 'price', mode: 'insensitive' } })
    expect(or).toContainEqual({ tags: { hasSome: ['oracle', 'price'] } })
  })

  it('answers for the x-network header instead of only the query parameter (#676)', async () => {
    mockFindMany.mockResolvedValueOnce([])
    mockCount.mockResolvedValueOnce(0)

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/discovery/search?q=oracle',
      headers: { 'x-network': 'mainnet' },
    })

    expect(res.statusCode).toBe(200)
    expect(mockFindMany.mock.calls[0][0].where.network).toBe('mainnet')
    expect(res.json().network).toBe('mainnet')
  })

  it('rejects an unrecognised network with 400 rather than searching the wrong one', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle&network=fictional' })

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('bad_network')
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('returns HTTP 503 when the database query fails', async () => {
    mockFindMany.mockRejectedValueOnce(new Error('Postgres connection terminated'))
    mockCount.mockRejectedValueOnce(new Error('Postgres connection terminated'))

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/discovery/search?q=oracle',
    })

    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error).toBe('Service Unavailable')
    expect(body.code).toBe('discovery_database_unavailable')
  })

  describe('ranking and paging (#676)', () => {
    const five = () =>
      [1, 2, 3, 4, 5].map(i =>
        row({
          id: `res-${i}`,
          // Distinct relevance: res-5 matches the term in three fields, res-1
          // in one, so the ranking order is fixed and known up front.
          serviceName: 'oracle'.repeat(i),
          description: i >= 4 ? 'a feed of oracle prices' : 'something else entirely',
          tags: i === 5 ? ['oracle'] : [],
        })
      )

    it('reaches every ranked row by following nextCursor, with no repeats and no gaps', async () => {
      mockFindMany.mockResolvedValue(five())
      mockCount.mockResolvedValue(5)
      const app = await buildApp()

      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0

      for (;;) {
        const url = new URL('/discovery/search?limit=2&q=oracle', 'http://localhost')
        if (cursor) url.searchParams.set('cursor', cursor)
        const res = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        pages += 1

        expect(body.items.length).toBeLessThanOrEqual(2)
        for (const item of body.items) {
          expect(seen).not.toContain(item.id)
          seen.push(item.id)
        }

        cursor = body.nextCursor
        if (!cursor) break
        expect(pages).toBeLessThan(10)
      }

      // Five rows at two per page is three pages, and the walk found all five.
      expect(pages).toBe(3)
      expect(seen).toHaveLength(5)
      expect(new Set(seen).size).toBe(5)
    })

    it('returns no nextCursor on the last page, even when the page is full', async () => {
      mockFindMany.mockResolvedValue(five().slice(0, 2))
      mockCount.mockResolvedValue(2)
      const app = await buildApp()

      const res = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle&limit=2' })
      const body = res.json()
      // A page that happens to be exactly `limit` long is not a page with more
      // after it; the old code decided by length and handed out a cursor that
      // walked back to the first page forever.
      expect(body.items).toHaveLength(2)
      expect(body.nextCursor).toBeNull()
    })

    it('ranks an old strong match above a new weak one', async () => {
      const oldStrong = row({
        id: 'res-old',
        createdAt: daysAgo(400),
        serviceName: 'Oracle Price Feed',
        description: 'Authorised oracle prices for every Stellar asset, updated each ledger.',
        tags: ['oracle', 'price'],
        iconUrl: 'https://oracle.example/icon.png',
      })
      const newWeak = row({
        id: 'res-new',
        createdAt: daysAgo(0),
        serviceName: 'Something',
        description: 'Mentions an oracle once.',
      })

      // The database returns candidates newest-first; ranking must not inherit
      // that order.
      mockFindMany.mockResolvedValue([newWeak, oldStrong])
      mockCount.mockResolvedValue(2)

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle&limit=2' })
      const body = res.json()

      expect(body.items.map((i: any) => i.id)).toEqual(['res-old', 'res-new'])
      expect(body.items[0].score).toBeGreaterThan(body.items[1].score)
    })

    it('reports the database match count, not the length of one page', async () => {
      mockFindMany.mockResolvedValue(five())
      mockCount.mockResolvedValue(4117)

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle&limit=2' })
      const body = res.json()

      expect(mockCount).toHaveBeenCalledTimes(1)
      expect(body.totalMatched).toBe(4117)
      expect(body.rankedCount).toBe(5)
      expect(body.items).toHaveLength(2)
      // The count went to the same where clause the rows came from, so the
      // number describes the same query the items do.
      expect(mockCount.mock.calls[0][0].where).toEqual(mockFindMany.mock.calls[0][0].where)
    })

    it('says so when the query matches more rows than one search ranks', async () => {
      const many = Array.from({ length: DISCOVERY_SEARCH_CANDIDATE_CAP + 1 }, (_, i) =>
        row({ id: `res-${i}`, serviceName: 'oracle' })
      )
      mockFindMany.mockResolvedValue(many)
      mockCount.mockResolvedValue(900)

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle' })
      const body = res.json()

      expect(body.truncated).toBe(true)
      expect(body.rankedCount).toBe(DISCOVERY_SEARCH_CANDIDATE_CAP)
      expect(body.totalMatched).toBe(900)
      expect(body.limit).toBe(20)
    })

    it.each([
      ['not base64 json at all', 'not-a-cursor'],
      ['base64 of something not destructurable', Buffer.from('5').toString('base64')],
    ])('rejects a malformed cursor (%s) with 400', async (_label, cursor) => {
      mockFindMany.mockResolvedValue(five())
      mockCount.mockResolvedValue(5)
      const app = await buildApp()

      const res = await app.inject({
        method: 'GET',
        url: `/discovery/search?q=oracle&cursor=${encodeURIComponent(cursor)}`,
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('invalid_parameter')
    })

    it('rejects a well-formed cursor that is not a position in this result with 400', async () => {
      mockFindMany.mockResolvedValue(five())
      mockCount.mockResolvedValue(5)
      const app = await buildApp()

      const res = await app.inject({
        method: 'GET',
        url: `/discovery/search?q=oracle&cursor=${encodeURIComponent(encodeCursor(0.9876, 'res-does-not-exist'))}`,
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('invalid_parameter')
    })

    it('carries the ranking position in the cursor, not a row id', async () => {
      mockFindMany.mockResolvedValue(five())
      mockCount.mockResolvedValue(5)
      const app = await buildApp()

      const first = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle&limit=1' })
      const decoded = decodeCursor(first.json().nextCursor)
      expect(decoded).not.toBeNull()
      expect(decoded).not.toBe('skip')
      const { value, id } = decoded as { value: unknown; id: unknown }

      expect(typeof value).toBe('number')
      expect(id).toBe(first.json().items[0].id)
      expect(value).toBe(first.json().items[0].score)
    })

    it('treats a degenerate cursor as the first page, like every other paged route', async () => {
      mockFindMany.mockResolvedValue(five())
      mockCount.mockResolvedValue(5)
      const app = await buildApp()

      const res = await app.inject({
        method: 'GET',
        url: `/discovery/search?q=oracle&limit=2&cursor=${encodeURIComponent(
          Buffer.from(JSON.stringify([null, null])).toString('base64')
        )}`,
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().items).toHaveLength(2)
    })

    it('rejects a non-numeric limit with 400 instead of a 503 (#676)', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle&limit=abc' })

      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('invalid_parameter')
      expect(mockFindMany).not.toHaveBeenCalled()
    })

    it('clamps the limit into its documented range', async () => {
      mockFindMany.mockResolvedValue(five())
      mockCount.mockResolvedValue(5)
      const app = await buildApp()

      const res = await app.inject({ method: 'GET', url: '/discovery/search?q=oracle&limit=5000' })
      expect(res.json().limit).toBe(100)
    })
  })
})
