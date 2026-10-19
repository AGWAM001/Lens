import { describe, it, expect, vi } from 'vitest'
import {
  calculateQualityScore,
  calculateRelevanceScore,
} from '../routes/discovery'

vi.mock('../db', () => ({
  prisma: {
    bazaarResource: { findMany: vi.fn() },
  },
  pgPool: { query: vi.fn() },
}))

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
})
