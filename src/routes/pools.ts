import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { poolsResponseSchema } from '../api/schemas'
import { POOLS_DEFAULT_LIMIT, POOLS_MAX_LIMIT, decodeCursor, encodeCursor, parseLimit, slicePage } from '../pagination'
import { formatDecimal, resolveDecimalFormat } from '../utils/decimals'
import { estimatedLpReturns } from '../pricing/lpReturns'
import { apiError } from '../errors'
import '../middleware/network' // declares req.network on the FastifyRequest type

/**
 * One pool's newest snapshot, straight from the DB. `numeric` columns arrive as
 * strings — that is what lets `?decimalFormat=string` hand back the exact value
 * the ledger stored rather than a float-rounded one — so callers decide how to
 * present them via {@link formatDecimal}.
 */
export interface PoolSnapshotRow {
  pool_id: string
  asset_a: string
  asset_b: string
  reserve_a: string | null
  reserve_b: string | null
  spot_price: string | null
  fee_bp: number | null
  timestamp: Date
  /** Oldest spot price inside the 24h window, for the divergence estimate. */
  window_start_price: string | null
  /** Counter-asset AMM volume over the same window, for the fee estimate. */
  window_counter_volume: string | null
}

export interface ListPoolsPage {
  /** Requested page size, clamped into [1, POOLS_MAX_LIMIT] the way the route does. */
  limit?: number
  /** Opaque cursor from a previous `nextCursor`. */
  cursor?: string
}

export type ListPoolsOutcome =
  | { ok: true; pools: PoolSnapshotRow[]; limit: number; nextCursor: string | null; hasMore: boolean }
  | { ok: false; error: string }

/**
 * The pools listing behind GET /pools and the `lens_get_pools` MCP tool.
 *
 * Latest snapshot per pool for one network, without reading history. The pool
 * ids are discovered with a recursive "skip scan" over the
 * (network, pool_id, timestamp DESC) index (jump to the next distinct pool_id
 * each step), then one LIMIT 1 index probe per pool fetches its newest row.
 * Cost is O(pools x log n); the old DISTINCT ON sorted every row of every
 * network. A quiet pool is kept with its real `timestamp`, never dropped.
 *
 * Paginated keyset-style on pool_id ASC (default limit 50, max 200): the cursor
 * carries the last page's pool_id and the skip scan's seed resumes strictly
 * after it, so a pool inserted mid-paging cannot shift a page boundary the way
 * an offset would. `limit` in the outcome is the page size actually honoured —
 * the MCP tool echoes it so an agent that asked for 500 knows it got 200.
 */
export async function listPools(network: NetworkName, page: ListPoolsPage = {}): Promise<ListPoolsOutcome> {
  const limit = Math.min(Math.max(page.limit ?? POOLS_DEFAULT_LIMIT, 1), POOLS_MAX_LIMIT)

  const params: unknown[] = [network]
  let seedFilter = ''
  if (page.cursor !== undefined) {
    const decoded = decodeCursor(page.cursor)
    // 'skip' is a well-formed but degenerate cursor: serve the first page rather
    // than punish a caller who cannot know they produced one.
    if (decoded === null) return { ok: false, error: 'Invalid cursor format' }
    if (decoded !== 'skip') {
      params.push(decoded.value)
      seedFilter = ` AND pool_id > $${params.length}`
    }
  }
  params.push(limit + 1) // Fetch one extra to determine hasMore

  const result = await pgPool.query(
    `WITH RECURSIVE ids AS (
       (SELECT pool_id FROM pool_snapshots WHERE network = $1${seedFilter} ORDER BY pool_id LIMIT 1)
       UNION ALL
       SELECT (SELECT s.pool_id FROM pool_snapshots s
                WHERE s.network = $1 AND s.pool_id > ids.pool_id
                ORDER BY s.pool_id LIMIT 1)
         FROM ids
        WHERE ids.pool_id IS NOT NULL
     )
     SELECT l.pool_id, l.asset_a, l.asset_b,
            l.reserve_a::numeric, l.reserve_b::numeric, l.spot_price::numeric, l.fee_bp, l.timestamp,
            opening.spot_price::numeric AS window_start_price,
            activity.counter_volume::numeric AS window_counter_volume
       FROM ids
      CROSS JOIN LATERAL (
            SELECT * FROM pool_snapshots s
             WHERE s.network = $1 AND s.pool_id = ids.pool_id
             ORDER BY s.timestamp DESC
             LIMIT 1
           ) l
      -- LEFT, not CROSS: a pool with no snapshot and no trade inside the window
      -- still belongs in the listing, with its estimates reported as null
      -- rather than the pool disappearing from the page.
      LEFT JOIN LATERAL (
            SELECT s.spot_price FROM pool_snapshots s
             WHERE s.network = $1 AND s.pool_id = ids.pool_id
               AND s.timestamp >= NOW() - INTERVAL '24 hours'
             ORDER BY s.timestamp ASC LIMIT 1
           ) opening ON true
      LEFT JOIN LATERAL (
            SELECT SUM(p.counter_volume) AS counter_volume FROM price_points p
             WHERE p.network = $1 AND p.pool_id = ids.pool_id AND p.source = 'AMM'
               AND p.timestamp >= NOW() - INTERVAL '24 hours'
           ) activity ON true
      WHERE ids.pool_id IS NOT NULL
      ORDER BY l.pool_id ASC
      LIMIT $${params.length}`,
    params
  )

  const { data, hasMore } = slicePage(result.rows as PoolSnapshotRow[], limit)
  const last = data[data.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.pool_id, last.pool_id) : null
  return { ok: true, pools: data, limit, nextCursor, hasMore }
}

export async function registerPoolsRoutes(app: FastifyInstance) {
  // GET /pools?cursor=&limit= — the listing above, rendered with the caller's
  // chosen decimal format.
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/pools',
    {
      config: { scope: 'read:prices' },
      schema: {
        response: {
          200: poolsResponseSchema,
          400: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, code: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const network = req.network ?? activeNetwork
      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      const parsedLimit = parseLimit(req.query.limit, POOLS_DEFAULT_LIMIT, POOLS_MAX_LIMIT)
      if ('error' in parsedLimit) {
        return reply.status(400).send(apiError('invalid_parameter', parsedLimit.error))
      }

      const outcome = await listPools(network, { limit: parsedLimit.limit, cursor: req.query.cursor })
      if (!outcome.ok) return reply.status(400).send(apiError('invalid_parameter', outcome.error))

      return {
        pools: outcome.pools.map(r => ({
          pool_id: r.pool_id,
          asset_a: r.asset_a,
          asset_b: r.asset_b,
          reserve_a: formatDecimal(r.reserve_a, decimalFormat),
          reserve_b: formatDecimal(r.reserve_b, decimalFormat),
          spot_price: formatDecimal(r.spot_price, decimalFormat),
          fee_bp: r.fee_bp !== null && r.fee_bp !== undefined ? parseInt(String(r.fee_bp), 10) : null,
          timestamp: r.timestamp,
          ...estimatedLpReturns(r),
        })),
        nextCursor: outcome.nextCursor,
        hasMore: outcome.hasMore,
      }
    }
  )
}

