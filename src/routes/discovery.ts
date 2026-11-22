import type { FastifyInstance } from 'fastify'
import type { BazaarResource, Prisma } from '@prisma/client'
import { parseDiscoveryFilters, queryDiscoveryResources } from '../bazaar/catalog'
import { prisma } from '../db'
import { apiError } from '../errors'
import { decodeCursor, encodeCursor, parseLimit } from '../pagination'

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
 * Page size bounds for GET /discovery/search.
 *
 * `limit` is the caller's page size; the candidate cap below is the work bound
 * the server takes on per request. They are deliberately different numbers:
 * ranking is done in process over every candidate the database returns, so the
 * cap is what bounds the CPU and memory of one search, not what the caller sees.
 */
export const DISCOVERY_SEARCH_DEFAULT_LIMIT = 20
export const DISCOVERY_SEARCH_MAX_LIMIT = 100

/**
 * How many matching rows one search reads, scores, and ranks (#676).
 *
 * The bound has to be explicit because it is observable: a query that matches
 * more rows than this is answered from the newest `DISCOVERY_SEARCH_CANDIDATE_CAP`
 * of them, and says so with `truncated: true` instead of pretending the older
 * matches do not exist. `totalMatched` still counts every match, so a caller can
 * tell the difference between "there are 3 results" and "there are 4,000
 * matches and I ranked the newest 500 of them".
 */
export const DISCOVERY_SEARCH_CANDIDATE_CAP = 500

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
 * The SQL `where` for a search (#676).
 *
 * Filtering happens in the database — a text match per query term over
 * `serviceName`, `description` and `url`, plus an exact tag match — and the
 * ranking happens here. Two consequences worth stating plainly:
 *
 *   - A tag matches when it is *equal to* a query term, because that is what a
 *     Postgres array can ask for in Prisma (`has`). `calculateRelevanceScore`
 *     is more forgiving (substring), so a resource tagged `price-feeds` still
 *     wins a `tag_match` once any term brings it into the candidate set.
 *   - Splitting the query into terms matters: `q=oracle price` used to look for
 *     a tag literally equal to "oracle price", which no tag ever is.
 */
export function buildSearchWhere(
  terms: string[],
  network: string,
  type: string | undefined
): Prisma.BazaarResourceWhereInput {
  const where: Prisma.BazaarResourceWhereInput = {
    network,
    ...(type ? { type } : {}),
  }

  if (terms.length === 0) return where

  where.OR = [
    ...terms.flatMap(term => [
      { serviceName: { contains: term, mode: 'insensitive' as const } },
      { description: { contains: term, mode: 'insensitive' as const } },
      { url: { contains: term, mode: 'insensitive' as const } },
    ]),
    { tags: { hasSome: terms } },
  ]

  return where
}

/** Lowercased query terms, in the order the caller wrote them. */
function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(term => term.length > 0)
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
    const limitResult = parseLimit(req.query.limit, DISCOVERY_SEARCH_DEFAULT_LIMIT, DISCOVERY_SEARCH_MAX_LIMIT)
    if ('error' in limitResult) {
      return reply.code(400).send(apiError('invalid_parameter', limitResult.error))
    }
    const limit = limitResult.limit

    // `req.network` is resolved by the network selector from the `network`
    // query parameter *or* the `x-network` header, and a value neither of which
    // is a known network is already a 400 before this handler ran. Reading
    // `req.query.network` here instead meant a request that named its network
    // the standard way — in the header — silently searched the wrong one.
    const networkFilter = req.network
    const typeFilter = req.query.type

    const where = buildSearchWhere(termsOf(query), networkFilter, typeFilter)

    let rows: BazaarResource[]
    let totalMatched: number
    try {
      // One row past the cap is fetched on purpose: it is what tells this
      // request that the query has matches it is not going to rank, so the
      // answer can say so instead of quietly returning a shorter list.
      const [found, total] = await Promise.all([
        prisma.bazaarResource.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: DISCOVERY_SEARCH_CANDIDATE_CAP + 1,
        }),
        prisma.bazaarResource.count({ where }),
      ])
      rows = found
      totalMatched = total
    } catch (err: unknown) {
      req.log.error({ err }, '[discovery] Database error during search')
      return reply.code(503).send({
        error: 'Service Unavailable',
        code: 'discovery_database_unavailable',
        message: 'Discovery search database query failed.',
      })
    }

    const truncated = rows.length > DISCOVERY_SEARCH_CANDIDATE_CAP
    const candidates = truncated ? rows.slice(0, DISCOVERY_SEARCH_CANDIDATE_CAP) : rows

    const scored: RankedSearchResult[] = []

    for (const res of candidates) {
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

    // Rank highest score first; ties break on the id, ascending, so the order
    // is total and a page boundary always falls in the same place.
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    // Keyset paging over the ranking: the cursor is (score, id) of the last
    // result the caller saw, and the next page is everything that sorts after
    // it. Not an offset, and not "the row with this id" — an inserted or
    // re-priced row moves a position, but never a (score, id) pair, so pages
    // neither repeat nor skip.
    let ranked = scored
    if (req.query.cursor !== undefined && req.query.cursor !== '') {
      const decoded = decodeCursor(req.query.cursor)
      if (decoded === null) {
        return reply.code(400).send(apiError('invalid_parameter', 'Invalid cursor format'))
      }
      if (decoded !== 'skip') {
        const at = scored.findIndex(result => result.score === decoded.value && result.id === decoded.id)
        if (at === -1) {
          return reply
            .code(400)
            .send(apiError('invalid_parameter', 'cursor does not point at a result in this search'))
        }
        ranked = scored.slice(at + 1)
      }
    }

    const items = ranked.slice(0, limit)
    const last = items[items.length - 1]
    const nextCursor = ranked.length > limit && last ? encodeCursor(last.score, last.id) : null

    return {
      query,
      network: networkFilter,
      // Every row the database matched, whether or not this request ranked it.
      totalMatched,
      // How many of those this request scored and can page through.
      rankedCount: scored.length,
      // True when totalMatched exceeds the candidate cap: the ranking covers
      // the newest cap rows, and older matches are not in it.
      truncated,
      limit,
      nextCursor,
      items,
    }
  })
}
