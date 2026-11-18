import type { FastifyInstance } from 'fastify'
import type { BazaarResource, Prisma } from '@prisma/client'
import { parseDiscoveryFilters, queryDiscoveryResources } from '../bazaar/catalog'
import { prisma } from '../db'
import { activeNetwork } from '../config'

export interface RankedSearchResult {
  id: string
  type: string
  network: string
  url: string
  serviceName: string | null
  description: string | null
  mimeType: string | null
  tags: string[]
  iconUrl: string | null
  payTo: string
  score: number
  relevanceScore: number
  qualityScore: number
  matchReasons: string[]
}

/**
 * Calculates quality score based on metadata completeness (0.0 to 1.0).
 */
export function calculateQualityScore(res: {
  serviceName?: string | null
  description?: string | null
  tags?: string[]
  iconUrl?: string | null
  bazaarSchema?: unknown
}): number {
  let score = 0.2 // baseline for existing
  if (res.serviceName && res.serviceName.length > 2) score += 0.2
  if (res.description && res.description.length > 10) score += 0.25
  if (res.tags && res.tags.length > 0) score += 0.15
  if (res.iconUrl) score += 0.1
  if (res.bazaarSchema) score += 0.1
  return Math.min(1.0, score)
}

/**
 * Calculates text relevance score against query terms.
 */
export function calculateRelevanceScore(
  query: string,
  res: {
    serviceName?: string | null
    description?: string | null
    url?: string
    tags?: string[]
  },
): { score: number; reasons: string[] } {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0)
  if (terms.length === 0) return { score: 1.0, reasons: ['empty_query_match'] }

  let score = 0
  const reasons: string[] = []
  const serviceName = (res.serviceName ?? '').toLowerCase()
  const desc = (res.description ?? '').toLowerCase()
  const url = (res.url ?? '').toLowerCase()
  const tags = (Array.isArray(res.tags) ? res.tags : []).map((t: string) => t.toLowerCase())

  for (const term of terms) {
    if (serviceName.includes(term)) {
      score += 0.4
      reasons.push(`service_name_match: "${term}"`)
    }
    if (tags.some((t: string) => t.includes(term))) {
      score += 0.3
      reasons.push(`tag_match: "${term}"`)
    }
    if (desc.includes(term)) {
      score += 0.2
      reasons.push(`description_match: "${term}"`)
    }
    if (url.includes(term)) {
      score += 0.1
      reasons.push(`url_match: "${term}"`)
    }
  }

  // Averaged across the terms before clamping. Each term can contribute at
  // most 1.0 (0.4 + 0.3 + 0.2 + 0.1), so summing and then clamping meant a
  // single term matching three fields already reached the ceiling — and every
  // better match scored 1.0 as well, which is where ranking stops ranking.
  // Averaging also makes a two-term query comparable to a one-term one rather
  // than scoring it twice as high for the same quality of match.
  return { score: Math.min(1.0, score / terms.length), reasons }
}

/**
 * Registers discovery routes for Bazaar:
 * - GET /discovery/resources — browsing
 * - GET /discovery/search — natural language search with ranking & quality evaluation (#129)
 */
export async function registerDiscoveryRoutes(app: FastifyInstance) {
  app.get('/discovery/resources', { config: { public: true } }, async (req) => {
    const filters = parseDiscoveryFilters(req.query as Record<string, unknown>)
    return queryDiscoveryResources(filters)
  })

  app.get<{
    Querystring: { q?: string; cursor?: string; limit?: string; type?: string; network?: string }
  }>('/discovery/search', { config: { public: true } }, async (req, reply) => {
    const query = req.query.q?.trim() ?? ''
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
    const networkFilter = req.query.network ?? activeNetwork
    const typeFilter = req.query.type

    const whereClause: Prisma.BazaarResourceWhereInput = {
      network: networkFilter,
      ...(typeFilter ? { type: typeFilter } : {}),
    }

    if (query.length > 0) {
      whereClause.OR = [
        { serviceName: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { url: { contains: query, mode: 'insensitive' } },
        { tags: { has: query } },
      ]
    }

    let resources: BazaarResource[]
    try {
      resources = await prisma.bazaarResource.findMany({
        where: whereClause,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: Math.min(limit * 5, 500),
      })
    } catch (err: unknown) {
      req.log.error({ err }, '[discovery] Database error during search')
      return reply.code(503).send({
        error: 'Service Unavailable',
        code: 'discovery_database_unavailable',
        message: 'Discovery search database query failed.',
      })
    }

    const scored: RankedSearchResult[] = []

    for (const res of resources) {
      const { score: relevanceScore, reasons } = calculateRelevanceScore(query, res)
      if (query.length > 0 && relevanceScore === 0) continue

      const qualityScore = calculateQualityScore(res)
      // Weighted ranking: 70% relevance, 30% quality
      const compositeScore = parseFloat((relevanceScore * 0.7 + qualityScore * 0.3).toFixed(4))

      scored.push({
        id: res.id,
        type: res.type,
        network: res.network,
        url: res.url,
        serviceName: res.serviceName,
        description: res.description,
        mimeType: res.mimeType,
        tags: res.tags,
        iconUrl: res.iconUrl,
        payTo: res.payTo,
        score: compositeScore,
        relevanceScore,
        qualityScore,
        matchReasons: reasons,
      })
    }

    // Rank highest score first
    scored.sort((a, b) => b.score - a.score)

    // Cursor pagination
    let startIndex = 0
    if (req.query.cursor) {
      const foundIdx = scored.findIndex(s => s.id === req.query.cursor)
      if (foundIdx >= 0) startIndex = foundIdx + 1
    }

    const items = scored.slice(startIndex, startIndex + limit)
    const nextCursor = items.length === limit ? items[items.length - 1].id : null

    return {
      query,
      network: networkFilter,
      totalMatched: scored.length,
      limit,
      nextCursor,
      items,
    }
  })
}
