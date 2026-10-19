import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pgPool } from '../db'
import { activeNetwork } from '../config'
import { formatValidationError, VALIDATION_ERROR_CODE } from '../validation'
import '../middleware/network' // declares req.network on the FastifyRequest type

// Lens has no circulating-supply data, so a market cap cannot be computed. It
// used to be reported as a copy of `liquidity`; a caller who sorts or filters on
// it must be told it is gone rather than have the parameter silently ignored.
const MARKET_CAP_UNSUPPORTED =
  'market_cap is not supported: Lens has no circulating supply data to compute it from. Use liquidity instead'

/** Machine-readable code for the market_cap rejection (not a validation error). */
const MARKET_CAP_CODE = 'UNSUPPORTED_PARAMETER'

const ALLOWED_SORT_FIELDS = ['volume', 'change_24h', 'price', 'liquidity'] as const

const numFilter = (name: string) =>
  z.coerce.number({ error: `${name} must be a valid number` }).optional()

export const SCREENER_DEFAULT_LIMIT = 20
export const SCREENER_MAX_LIMIT = 100

const ScreenerQuerySchema = z
  .object({
    // Historical behavior: limit is clamped to [1, 100], never rejected.
    // `GET /screener?limit=500` returns 100 rows, `limit=0` behaves as 1.
    limit: z.coerce
      .number({ error: 'limit must be a valid integer' })
      .int({ error: 'limit must be a valid integer' })
      .default(SCREENER_DEFAULT_LIMIT)
      .transform((v) => Math.min(SCREENER_MAX_LIMIT, Math.max(1, v))),
    sortBy: z.string().default('volume'),
    order: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.toLowerCase() : v),
        z.enum(['asc', 'desc'])
      )
      .default('desc'),
    volume: numFilter('volume'),
    change_24h_min: numFilter('change_24h_min'),
    change_24h_max: numFilter('change_24h_max'),
    price_min: numFilter('price_min'),
    price_max: numFilter('price_max'),
    liquidity: numFilter('liquidity'),
    cursor: z.string().optional(),
    // market_cap is declared only so the rejection below goes through the
    // shared error formatter like every other rejection.
    market_cap: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.market_cap !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['market_cap'],
        message: MARKET_CAP_UNSUPPORTED,
      })
    }
    if (data.sortBy === 'market_cap') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sortBy'],
        message: MARKET_CAP_UNSUPPORTED,
      })
    } else if (!(ALLOWED_SORT_FIELDS as readonly string[]).includes(data.sortBy)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sortBy'],
        message: `sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(', ')}`,
      })
    }
  })

export async function registerScreenerRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      volume?: string
      change_24h_min?: string
      change_24h_max?: string
      market_cap?: string // rejected with a 400, see MARKET_CAP_UNSUPPORTED
      price_min?: string
      price_max?: string
      liquidity?: string
      sortBy?: string
      order?: string
      cursor?: string
      limit?: string
    }
  }>('/screener', async (req, reply) => {
    const log = req.log.child({ component: 'route:screener' })
    try {
      const q = req.query

      const parsed = ScreenerQuerySchema.safeParse(q)
      if (!parsed.success) {
        // market_cap is not a validation error but an unsupported parameter;
        // it keeps its own machine-readable code while using the shared shape.
        const marketCapRejected = parsed.error.issues.some(
          (issue) => issue.path[0] === 'market_cap'
        )
        return reply
          .status(400)
          .send(
            formatValidationError(
              parsed.error,
              marketCapRejected ? MARKET_CAP_CODE : VALIDATION_ERROR_CODE
            )
          )
      }
      const { limit, sortBy, order, cursor } = parsed.data
      const filters = {
        volume: parsed.data.volume,
        change_24h_min: parsed.data.change_24h_min,
        change_24h_max: parsed.data.change_24h_max,
        price_min: parsed.data.price_min,
        price_max: parsed.data.price_max,
        liquidity: parsed.data.liquidity,
      }

      // 3. Build query parameters and WHERE conditions
      const conditions: string[] = []
      // Every CTE below is scoped to one network: testnet and mainnet rows share
      // these tables, and pooling them would rank a pair on the other chain's data.
      const params: any[] = [req.network ?? activeNetwork]
      let paramIdx = 2

      if (filters.volume !== undefined) {
        conditions.push(`volume >= $${paramIdx++}`)
        params.push(filters.volume)
      }
      if (filters.change_24h_min !== undefined) {
        conditions.push(`change_24h >= $${paramIdx++}`)
        params.push(filters.change_24h_min)
      }
      if (filters.change_24h_max !== undefined) {
        conditions.push(`change_24h <= $${paramIdx++}`)
        params.push(filters.change_24h_max)
      }
      if (filters.price_min !== undefined) {
        conditions.push(`price >= $${paramIdx++}`)
        params.push(filters.price_min)
      }
      if (filters.price_max !== undefined) {
        conditions.push(`price <= $${paramIdx++}`)
        params.push(filters.price_max)
      }
      if (filters.liquidity !== undefined) {
        conditions.push(`liquidity >= $${paramIdx++}`)
        params.push(filters.liquidity)
      }

      // 4. Cursor decoding and pagination condition
      if (cursor) {
        try {
          const decoded = Buffer.from(cursor, 'base64').toString('utf-8')
          const [lastVal, lastId] = JSON.parse(decoded)

          if (lastVal !== null && lastVal !== undefined && lastId) {
            const op = order === 'desc' ? '<' : '>'
            conditions.push(`(${sortBy}, pair_key) ${op} ($${paramIdx++}, $${paramIdx++})`)
            params.push(lastVal, lastId)
          }
        } catch (e) {
          return reply.status(400).send({ error: 'Invalid cursor format', code: 'VALIDATION_ERROR' })
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // 5. Construct the full SQL query using CTEs
      const sql = `
        WITH pair_pools AS (
          SELECT DISTINCT pair_key, pool_id 
          FROM price_points 
          WHERE network = $1 AND source = 'AMM' AND pool_id IS NOT NULL
        ),
        latest_snapshots AS (
          SELECT DISTINCT ON (ps.pool_id) 
            ps.pool_id, 
            (ps.reserve_a * ps.spot_price + ps.reserve_b) AS pool_liq
          FROM pool_snapshots ps
          WHERE ps.network = $1
          ORDER BY ps.pool_id, ps.timestamp DESC
        ),
        pair_liquidity AS (
          SELECT pp.pair_key, SUM(ls.pool_liq) AS liquidity
          FROM pair_pools pp
          JOIN latest_snapshots ls ON ls.pool_id = pp.pool_id
          GROUP BY pp.pair_key
        ),
        latest_aggregates AS (
          SELECT DISTINCT ON (pair_key)
            pair_key,
            COALESCE(volume::float, 0) AS volume,
            COALESCE(close_price::float, 0) AS price,
            CASE 
              WHEN open_price > 0 THEN ((close_price::float - open_price::float) / open_price::float) * 100 
              ELSE 0 
            END AS change_24h
          FROM price_aggregates
          WHERE network = $1 AND window = '24h'
          ORDER BY pair_key, bucket DESC
        ),
        screener_data AS (
          SELECT 
            la.pair_key,
            la.volume,
            la.price,
            la.change_24h,
            COALESCE(pl.liquidity::float, 0) AS liquidity
          FROM latest_aggregates la
          LEFT JOIN pair_liquidity pl ON pl.pair_key = la.pair_key
        )
        SELECT * FROM screener_data
        ${whereClause}
        ORDER BY ${sortBy} ${order.toUpperCase()}, pair_key ${order.toUpperCase()}
        LIMIT $${paramIdx}
      `

      // 6. Execute query
      params.push(limit + 1) // Fetch one extra to determine hasMore
      const result = await pgPool.query(sql, params)
      const rows = result.rows

      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows

      // 7. Generate nextCursor
      let nextCursor = null
      if (hasMore && data.length > 0) {
        const lastRecord = data[data.length - 1]
        const cursorPayload = JSON.stringify([lastRecord[sortBy], lastRecord.pair_key])
        nextCursor = Buffer.from(cursorPayload).toString('base64')
      }

      return {
        data,
        nextCursor,
        hasMore,
        total: null,
      }
    } catch (error) {
      log.error({ err: error }, 'screener query failed')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}
