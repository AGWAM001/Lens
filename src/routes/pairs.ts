import type { FastifyInstance } from 'fastify'
import { getActivePairs, parseAssetStr, makePairKey, registerPair, persistPair, hasPair } from '../pairsRegistry'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import type { AssetId, WatchedPair } from '../types'
import {
  PAIRS_DEFAULT_LIMIT,
  PAIRS_MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  parseLimit,
  slicePage,
} from '../pagination'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { admin_auth_failures_total } from '../metrics'

import { apiError } from '../errors'
export interface PairWithLatest {
  pairKey: string
  assetA: AssetId
  assetB: AssetId
  latestPrice: number | null
  lastUpdated: Date | null
  sourceTime: Date | null
}

export interface ListPairsPage {
  /** Requested page size, clamped into [1, PAIRS_MAX_LIMIT] the way the route does. */
  limit?: number
  /** Opaque cursor from a previous `nextCursor`. */
  cursor?: string
}

export type ListPairsOutcome =
  | { ok: true; pairs: PairWithLatest[]; limit: number; nextCursor: string | null; hasMore: boolean }
  | { ok: false; error: string }

/**
 * The pairs listing behind GET /pairs and the `lens_list_pairs` MCP tool.
 *
 * One index probe per watched pair on (network, pair_key, timestamp DESC):
 * `ORDER BY timestamp DESC LIMIT 1` reads a single index entry, so the cost is
 * O(pairs x log n) and no longer grows with the size of the price history.
 * (This used to be DISTINCT ON over the whole table, every network included.)
 *
 * A pair that has gone quiet is deliberately NOT dropped and NOT bounded away:
 * the probe still finds its last print, and the response carries that print's
 * real `lastUpdated`, so a caller can see it is old. A pair with no rows on
 * this network at all comes back with null price and timestamp.
 *
 * Paginated keyset-style on pairKey ASC (default limit 50, max 200). The rows
 * are assembled in memory from the registry, so the keyset filter and the
 * limit+1 probe are applied to the merged list; the cursor carries the last
 * page's pairKey, so a pair registered mid-paging cannot shift a page boundary
 * the way an offset would. `limit` in the outcome is the page size actually
 * honoured, which is what lets the MCP tool tell an agent it asked for 500 and
 * got 200 rather than silently answering less.
 *
 * `watched` defaults to the process-wide runtime registry, which is what the REST
 * route has always listed. A caller naming a network other than this process's
 * own must pass that network's declared pairs instead, or a mainnet request
 * would be answered with the pairs this testnet process watches — the same
 * mistake `lens_get_price` documents in ./priceQueries.ts.
 */
export async function listPairs(
  network: NetworkName,
  page: ListPairsPage = {},
  watched: readonly WatchedPair[] = getActivePairs()
): Promise<ListPairsOutcome> {
  const activePairs = watched
  const limit = Math.min(Math.max(page.limit ?? PAIRS_DEFAULT_LIMIT, 1), PAIRS_MAX_LIMIT)

  let afterKey: string | null = null
  if (page.cursor !== undefined) {
    const decoded = decodeCursor(page.cursor)
    // 'skip' is a well-formed but degenerate cursor: serve the first page rather
    // than punish a caller who cannot know they produced one.
    if (decoded === null) return { ok: false, error: 'Invalid cursor format' }
    if (decoded !== 'skip') afterKey = String(decoded.value)
  }

  const result = await pgPool.query(
    `SELECT p.pair_key, l.price, l.observed_at, l.source_time, l.timestamp
       FROM unnest($2::text[]) AS p(pair_key)
      CROSS JOIN LATERAL (
            SELECT price, COALESCE(observed_at, timestamp) AS observed_at, source_time, timestamp
              FROM price_points
             WHERE network = $1
               AND pair_key = p.pair_key
             ORDER BY COALESCE(observed_at, timestamp) DESC
             LIMIT 1
           ) l`,
    [network, activePairs.map(p => p.pairKey)]
  )

  const latestPrices = new Map<string, { price: number; observedAt: Date; sourceTime: Date | null }>()
  result.rows.forEach(row => {
    latestPrices.set(row.pair_key, {
      price: parseFloat(row.price),
      observedAt: row.observed_at ?? row.timestamp,
      sourceTime: row.source_time ? new Date(row.source_time) : null,
    })
  })

  const rows = activePairs
    .map(p => {
      const latest = latestPrices.get(p.pairKey)
      return {
        pairKey: p.pairKey,
        assetA: p.assetA,
        assetB: p.assetB,
        latestPrice: latest?.price ?? null,
        lastUpdated: latest?.observedAt ?? null,
        sourceTime: latest?.sourceTime ?? null,
      }
    })
    .sort((a, b) => (a.pairKey < b.pairKey ? -1 : a.pairKey > b.pairKey ? 1 : 0))

  const pageSource = afterKey ? rows.filter(r => r.pairKey > afterKey) : rows
  const { data, hasMore } = slicePage(pageSource, limit)
  const last = data[data.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.pairKey, last.pairKey) : null
  return { ok: true, pairs: data, limit, nextCursor, hasMore }
}

export async function registerPairsRoutes(app: FastifyInstance) {
  // GET /pairs?cursor=&limit= — list active pairs with their latest price.
  //
  // The listing itself is listPairs(), which the `lens_list_pairs` MCP tool also
  // runs, so a page over MCP is the same rows and the same cursor as a page over
  // HTTP. This handler only turns a query string into a page request and the
  // page back into a reply: a non-numeric limit is the route's own 400, exactly
  // as /screener answers one.
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/pairs',
    { config: { scope: 'read:prices' } },
    async (req, reply) => {
      const parsedLimit = parseLimit(req.query.limit, PAIRS_DEFAULT_LIMIT, PAIRS_MAX_LIMIT)
      if ('error' in parsedLimit) {
        return reply.status(400).send(apiError('invalid_parameter', parsedLimit.error))
      }

      const outcome = await listPairs(req.network ?? activeNetwork, {
        limit: parsedLimit.limit,
        cursor: req.query.cursor,
      })
      if (!outcome.ok) return reply.status(400).send(apiError('invalid_parameter', outcome.error))
      return { pairs: outcome.pairs, nextCursor: outcome.nextCursor, hasMore: outcome.hasMore }
    }
  )

  // POST /pairs — add a new trading pair at runtime
  app.post<{
    Body: { assetA?: string; assetB?: string }
  }>('/pairs', async (req, reply) => {
    const log = req.log.child({ component: 'route:pairs' })
    // Auth check — read at request time so env can be set after module load
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY
    const key = req.headers['x-admin-key'] ?? req.headers['authorization']?.replace(/^Bearer /, '')
    if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
      admin_auth_failures_total.inc()
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'admin_unauthorized',
        message: 'Provide valid admin authentication.',
      })
    }

    const { assetA: assetAStr, assetB: assetBStr } = req.body ?? {}

    if (!assetAStr || !assetBStr) {
      return reply.status(400).send(apiError('missing_parameter', 'assetA and assetB are required'))
    }

    const assetA = parseAssetStr(assetAStr)
    if (!assetA) {
      return reply.status(400).send({
        ...apiError('invalid_parameter', `Invalid assetA format "${assetAStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`),
      })
    }

    const assetB = parseAssetStr(assetBStr)
    if (!assetB) {
      return reply.status(400).send({
        ...apiError('invalid_parameter', `Invalid assetB format "${assetBStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`),
      })
    }

    const pairKey = makePairKey(assetA, assetB)

    if (hasPair(pairKey)) {
      return reply.status(409).send(apiError('pair_already_watched', `Pair ${pairKey} is already being watched`))
    }

    const pair = { assetA, assetB, pairKey }
    registerPair(pair)
    await persistPair(pair)

    log.info({ pair: pairKey }, 'added runtime pair')
    return reply.status(201).send({ pairKey, assetA, assetB })
  })
}
