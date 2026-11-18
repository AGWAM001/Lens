import { pgPool } from '../db'

// Lens has no circulating-supply data, so a market cap cannot be computed. It
// used to be reported as a copy of `liquidity`; a caller who sorts or filters on
// it must be told it is gone rather than have the parameter silently ignored.
// Both the REST route and the GraphQL `screener` query reject it with this
// exact explanation.
export const MARKET_CAP_UNSUPPORTED =
  'market_cap is not supported: Lens has no circulating supply data to compute it from. Use liquidity instead'

/** Machine-readable code for the market_cap filter rejection (not a validation error). */
export const MARKET_CAP_CODE = 'UNSUPPORTED_PARAMETER'

export const ALLOWED_SORT_FIELDS = ['volume', 'change_24h', 'price', 'liquidity'] as const

export const SCREENER_DEFAULT_LIMIT = 20
export const SCREENER_MAX_LIMIT = 100

export type ScreenerSortField = (typeof ALLOWED_SORT_FIELDS)[number]
export type ScreenerOrder = 'asc' | 'desc'

/**
 * Numeric filters, one per REST query parameter. Each is a lower bound unless
 * the name says otherwise; omitted fields do not filter.
 */
export interface ScreenerFilters {
  volume?: number
  change_24h_min?: number
  change_24h_max?: number
  price_min?: number
  price_max?: number
  liquidity?: number
}

/** One screener row as produced by the SQL (snake_case, straight from the DB). */
export interface ScreenerRow {
  pair_key: string
  volume: number
  price: number
  change_24h: number
  liquidity: number
}

export interface ScreenerPage {
  network: string
  data: Array<ScreenerRow & { liquidity_unit: string }>
  nextCursor: string | null
  hasMore: boolean
  total: null
}

/**
 * The cursor is not decodable base64 JSON. Each surface maps this to its own
 * error shape: the REST route answers 400, the GraphQL resolver raises
 * INVALID_INPUT — both with the same message.
 */
export class ScreenerCursorError extends Error {
  readonly code = 'VALIDATION_ERROR' as const
  constructor() {
    super('Invalid cursor format')
    this.name = 'ScreenerCursorError'
  }
}

/**
 * Raised at the SQL boundary when sortBy/order are not in the allowlist.
 * Both callers validate these earlier and produce a friendlier 4xx; this class
 * exists so an unvalidated value can never be interpolated into SQL.
 */
export class ScreenerSortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScreenerSortError'
  }
}

/**
 * Liquidity Definition for the screener (REST GET /screener and GraphQL
 * `screener`):
 * - Sources/Venues: Stellar AMM liquidity pools (source = 'AMM' in price_points,
 *   mapped to pool_snapshots for the pair).
 * - Valuation & Formula: Summed across all active AMM pools for the pair of
 *   `(reserve_a * spot_price + reserve_b)`. Since spot_price is quoted in
 *   `asset_b` per unit of `asset_a` (i.e. reserve_b / reserve_a), `reserve_a * spot_price`
 *   evaluates to the value of reserve_a denominated in asset_b.
 * - Unit: Denominated in the quote asset (counter asset, `asset_b`, the second asset
 *   in `pair_key` "BASE/QUOTE"). Named explicitly as `liquidity_unit` in each row.
 * - Prices: Spot price from the latest snapshot of each liquidity pool on the requested network.
 */

/**
 * The one screener query implementation, shared by REST and GraphQL.
 *
 * `limit` is clamped to [1, SCREENER_MAX_LIMIT], never rejected — historical
 * REST behaviour (`?limit=500` returns 100 rows, `limit=0` behaves as 1) that
 * GraphQL inherits. `sortBy` and `order` are allowlisted here as the last line
 * of defence before SQL interpolation; callers validate them earlier to give
 * callers a proper 4xx.
 */
export async function runScreener(opts: {
  network: string
  filters?: ScreenerFilters
  sortBy?: string
  order?: string
  cursor?: string | null
  limit?: number
}): Promise<ScreenerPage> {
  const { network, filters, cursor } = opts
  const limit = Math.min(SCREENER_MAX_LIMIT, Math.max(1, opts.limit ?? SCREENER_DEFAULT_LIMIT))
  const sortBy = opts.sortBy ?? 'volume'
  if (!(ALLOWED_SORT_FIELDS as readonly string[]).includes(sortBy)) {
    throw new ScreenerSortError(`sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(', ')}`)
  }
  const order = (opts.order ?? 'desc').toLowerCase()
  if (order !== 'asc' && order !== 'desc') {
    throw new ScreenerSortError('order must be one of: asc, desc')
  }

  // Build query parameters and WHERE conditions
  const conditions: string[] = []
  // Every CTE below is scoped to one network: testnet and mainnet rows share
  // these tables, and pooling them would rank a pair on the other chain's data.
  const params: any[] = [network]
  let paramIdx = 2

  if (filters?.volume !== undefined) {
    conditions.push(`volume >= $${paramIdx++}`)
    params.push(filters.volume)
  }
  if (filters?.change_24h_min !== undefined) {
    conditions.push(`change_24h >= $${paramIdx++}`)
    params.push(filters.change_24h_min)
  }
  if (filters?.change_24h_max !== undefined) {
    conditions.push(`change_24h <= $${paramIdx++}`)
    params.push(filters.change_24h_max)
  }
  if (filters?.price_min !== undefined) {
    conditions.push(`price >= $${paramIdx++}`)
    params.push(filters.price_min)
  }
  if (filters?.price_max !== undefined) {
    conditions.push(`price <= $${paramIdx++}`)
    params.push(filters.price_max)
  }
  if (filters?.liquidity !== undefined) {
    conditions.push(`liquidity >= $${paramIdx++}`)
    params.push(filters.liquidity)
  }

  // Cursor decoding and pagination condition
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf-8')
      const [lastVal, lastId] = JSON.parse(decoded)

      if (lastVal !== null && lastVal !== undefined && lastId) {
        const op = order === 'desc' ? '<' : '>'
        conditions.push(`(${sortBy}, pair_key) ${op} ($${paramIdx++}, $${paramIdx++})`)
        params.push(lastVal, lastId)
      }
    } catch {
      throw new ScreenerCursorError()
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // Construct the full SQL query using CTEs
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

  // Execute query
  params.push(limit + 1) // Fetch one extra to determine hasMore
  const result = await pgPool.query(sql, params)
  const rows = result.rows as ScreenerRow[]

  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows

  // Generate nextCursor
  let nextCursor = null
  if (hasMore && data.length > 0) {
    const lastRecord = data[data.length - 1]
    const cursorPayload = JSON.stringify([lastRecord[sortBy as ScreenerSortField], lastRecord.pair_key])
    nextCursor = Buffer.from(cursorPayload).toString('base64')
  }

  return {
    network,
    data: data.map((row) => ({
      ...row,
      liquidity_unit: row.pair_key.split('/')[1] ?? 'quote',
    })),
    nextCursor,
    hasMore,
    total: null,
  }
}
