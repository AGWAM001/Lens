import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import {
  calculateQualityScore,
  calculateRelevanceScore,
  registerDiscoveryRoutes,
} from '../routes/discovery'

const mockFindMany = vi.fn()

vi.mock('../db', () => ({
  prisma: {
    bazaarResource: { findMany: (...args: any[]) => mockFindMany(...args) },
  },
  pgPool: { query: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerDiscoveryRoutes(app)
  return app
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
      {
        id: 'res-1',
        type: 'service',
        network: 'testnet',
        url: 'https://oracle.stellar.org',
        serviceName: 'Stellar Price Oracle',
        description: 'Multi-venue oracle feed',
        mimeType: 'application/json',
        tags: ['oracle', 'price'],
        iconUrl: null,
        payTo: 'G' + 'A'.repeat(55),
        createdAt: new Date(),
      },
    ])

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/discovery/search?q=oracle',
    })

    expect(res.statusCode).toBe(200)
    expect(mockFindMany).toHaveBeenCalledTimes(1)
    const callArgs = mockFindMany.mock.calls[0][0]
    expect(callArgs.where.OR).toBeDefined()
    expect(callArgs.where.OR).toContainEqual({ serviceName: { contains: 'oracle', mode: 'insensitive' } })
    expect(callArgs.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }])

    const body = res.json()
    expect(body.totalMatched).toBe(1)
    expect(body.items[0].id).toBe('res-1')
  })

  it('returns HTTP 503 when the database query fails', async () => {
    mockFindMany.mockRejectedValueOnce(new Error('Postgres connection terminated'))

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
})
