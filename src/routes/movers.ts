import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

import { apiError } from '../errors'
import { formatPrice, formatVolume } from '../pricing/precision'
import { resolveDecimalFormat } from '../utils/decimals'
import { parseLimit, MOVERS_DEFAULT_LIMIT, MOVERS_MAX_LIMIT } from '../pagination'
import { moversResponseSchema } from '../api/schemas'
// Supported windows -> lookback in hours.
const WINDOW_HOURS = {
  '1h': 1,
  '24h': 24,
  '7d': 24 * 7,
} as const

type MoversWindow = keyof typeof WINDOW_HOURS
const WINDOWS = Object.keys(WINDOW_HOURS) as MoversWindow[]

export interface MoverItem {
  pairKey: string
  assetA: string
  assetB: string
  priceChangePct: number | null
  startPrice: number | string | null
  endPrice: number | string | null
  currentVolume: number | string
  previousVolume: number | string
  volumeChangePct: number | null
  /**
   * False when the earlier window had no volume for this pair, in which case
   * `volumeChangePct` is null — there is no honest percentage for "grew from
   * nothing", and reporting 100 would make it indistinguishable from
   * "doubled".
   */
  hasPreviousVolume: boolean
  venues: string[]
  isSingleVenue: boolean
  sampleCount: number
  lastUpdated: string | null
}

export interface MoversResponse {
  network: NetworkName
  window: MoversWindow
  startTime: string
  endTime: string
  gainers: MoverItem[]
  losers: MoverItem[]
  volumeMovers: MoverItem[]
}

/**
 * Register GET /movers endpoint.
 *
 * GET /movers?window=1h|24h|7d&network=testnet|mainnet&limit=20
 *
 * Biggest gainers, biggest losers, biggest volume change, each with the venues behind the move.
 * A move seen on only one venue is labelled as such (isSingleVenue: true).
 * Each list is cut to `limit` entries (default 20, max 100).
 *
 * Aggregations stay in PostgreSQL `numeric` end to end; values are narrowed
 * once at the edge with the helpers in `src/pricing/precision.ts`, or carried
 * as exact strings when the caller negotiates the string decimal format
 * (see `src/utils/decimals.ts`).
 *
 * Pairs with no volume in the earlier window report `volumeChangePct: null`
 * and `hasPreviousVolume: false`. In `volumeMovers` they sort after every
 * pair with a computable percentage change — a pair that cannot be ranked by
 * percentage must not outrank one that can — ordered among themselves by
 * current volume descending, so the largest brand-new flow still surfaces
 * first within that group.
 */
export async function registerMoversRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { window?: string; network?: string; limit?: string }
  }>(
    '/movers',
    { schema: { response: { 200: moversResponseSchema } } },
    async (req, reply) => {
    const rawWindow = req.query.window ?? '24h'
    if (!(rawWindow in WINDOW_HOURS)) {
      return reply
        .status(400)
        .send(apiError('bad_window', `window must be one of: ${WINDOWS.join(', ')}`))
    }
    const window = rawWindow as MoversWindow

    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
    }
    const network: NetworkName = req.network ?? (requested as NetworkName) ?? activeNetwork

    const parsedLimit = parseLimit(req.query.limit, MOVERS_DEFAULT_LIMIT, MOVERS_MAX_LIMIT)
    if ('error' in parsedLimit) {
      return reply.status(400).send(apiError('invalid_parameter', parsedLimit.error))
    }
    const limit = parsedLimit.limit

    const decimalFormat = resolveDecimalFormat(req)
    if (decimalFormat === 'string') {
      reply.header('x-decimal-format', 'string')
    }

    const hours = WINDOW_HOURS[window]
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)
    const prevStartTime = new Date(startTime.getTime() - hours * 60 * 60 * 1000)

    try {
      const sql = `
        WITH current_window AS (
          SELECT
            pair_key,
            (array_agg(asset_a))[1] AS asset_a,
            (array_agg(asset_b))[1] AS asset_b,
            (array_agg(price ORDER BY timestamp ASC))[1] AS start_price,
            (array_agg(price ORDER BY timestamp DESC))[1] AS end_price,
            SUM(base_volume) AS current_volume,
            array_agg(DISTINCT source) AS venues,
            COUNT(*)::int AS sample_count,
            MAX(timestamp) AS last_updated
          FROM price_points
          WHERE network = $1
            AND timestamp >= $2
            AND timestamp <= $3
          GROUP BY pair_key
        ),
        prev_window AS (
          SELECT
            pair_key,
            SUM(base_volume) AS prev_volume
          FROM price_points
          WHERE network = $1
            AND timestamp >= $4
            AND timestamp < $2
          GROUP BY pair_key
        )
        SELECT
          c.pair_key,
          c.asset_a,
          c.asset_b,
          c.start_price,
          c.end_price,
          c.current_volume,
          COALESCE(p.prev_volume, 0) AS prev_volume,
          c.venues,
          c.sample_count,
          c.last_updated
        FROM current_window c
        LEFT JOIN prev_window p ON p.pair_key = c.pair_key
      `

      const { rows } = await pgPool.query(sql, [network, startTime, endTime, prevStartTime])

      const allItems: MoverItem[] = rows.map((r: any) => {
        // Raw values arrive as `numeric` strings from pg. They are narrowed
        // once, here at the edge — never inside the aggregation above.
        const startPriceRaw = r.start_price != null ? String(r.start_price) : null
        const endPriceRaw = r.end_price != null ? String(r.end_price) : null
        const currentVolumeRaw = r.current_volume != null ? String(r.current_volume) : null
        const previousVolumeRaw = r.prev_volume != null ? String(r.prev_volume) : null

        // Percentage changes are derived ratios, not prices or amounts; they
        // are computed from the raw values and stay plain numbers.
        const startPriceNum = startPriceRaw != null ? Number(startPriceRaw) : null
        const endPriceNum = endPriceRaw != null ? Number(endPriceRaw) : null
        const currentVolumeNum = currentVolumeRaw != null ? Number(currentVolumeRaw) || 0 : 0
        const previousVolumeNum = previousVolumeRaw != null ? Number(previousVolumeRaw) || 0 : 0

        let priceChangePct: number | null = null
        if (startPriceNum != null && endPriceNum != null && startPriceNum > 0) {
          priceChangePct = ((endPriceNum - startPriceNum) / startPriceNum) * 100
        }

        const hasPreviousVolume = previousVolumeNum > 0
        let volumeChangePct: number | null = null
        if (hasPreviousVolume) {
          volumeChangePct = ((currentVolumeNum - previousVolumeNum) / previousVolumeNum) * 100
        }

        const venues: string[] = Array.isArray(r.venues) ? r.venues.filter(Boolean) : []
        const isSingleVenue = venues.length === 1

        return {
          pairKey: r.pair_key,
          assetA: r.asset_a,
          assetB: r.asset_b,
          priceChangePct,
          startPrice:
            decimalFormat === 'string' ? startPriceRaw : formatPrice(startPriceRaw),
          endPrice: decimalFormat === 'string' ? endPriceRaw : formatPrice(endPriceRaw),
          currentVolume:
            decimalFormat === 'string' ? (currentVolumeRaw ?? '0') : formatVolume(currentVolumeRaw),
          previousVolume:
            decimalFormat === 'string'
              ? (previousVolumeRaw ?? '0')
              : formatVolume(previousVolumeRaw),
          volumeChangePct,
          hasPreviousVolume,
          venues,
          isSingleVenue,
          sampleCount: Number(r.sample_count) || 0,
          lastUpdated: r.last_updated ? new Date(r.last_updated).toISOString() : null,
        }
      })

      // Price gainers: positive price change, descending
      const gainers = allItems
        .filter((i) => i.priceChangePct !== null && i.priceChangePct > 0)
        .sort((a, b) => (b.priceChangePct ?? 0) - (a.priceChangePct ?? 0))
        .slice(0, limit)

      // Price losers: negative price change, ascending (biggest drop first)
      const losers = allItems
        .filter((i) => i.priceChangePct !== null && i.priceChangePct < 0)
        .sort((a, b) => (a.priceChangePct ?? 0) - (b.priceChangePct ?? 0))
        .slice(0, limit)

      // Volume movers: ranked by absolute volume change. Pairs with no
      // earlier volume have no percentage to rank by, so they sort after
      // every ranked pair, by current volume descending among themselves.
      const volumeMovers = allItems
        .filter((i) => i.volumeChangePct !== null || Number(i.currentVolume) > 0)
        .sort((a, b) => {
          if (a.volumeChangePct === null && b.volumeChangePct === null) {
            return Number(b.currentVolume) - Number(a.currentVolume)
          }
          if (a.volumeChangePct === null) return 1
          if (b.volumeChangePct === null) return -1
          return Math.abs(b.volumeChangePct) - Math.abs(a.volumeChangePct)
        })
        .slice(0, limit)

      const response: MoversResponse = {
        network,
        window,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        gainers,
        losers,
        volumeMovers,
      }

      return response
    } catch (err) {
      req.log.error(err, '[movers] Movers aggregation failed')
      return reply.status(500).send(apiError('internal_error', 'Internal server error'))
    }
    }
  )
}
