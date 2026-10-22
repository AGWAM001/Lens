import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

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
  startPrice: number | null
  endPrice: number | null
  currentVolume: number
  previousVolume: number
  volumeChangePct: number | null
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
 * GET /movers?window=1h|24h|7d&network=testnet|mainnet
 *
 * Biggest gainers, biggest losers, biggest volume change, each with the venues behind the move.
 * A move seen on only one venue is labelled as such (isSingleVenue: true).
 */
export async function registerMoversRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { window?: string; network?: string }
  }>('/movers', async (req, reply) => {
    const rawWindow = req.query.window ?? '24h'
    if (!(rawWindow in WINDOW_HOURS)) {
      return reply
        .status(400)
        .send({ error: `window must be one of: ${WINDOWS.join(', ')}` })
    }
    const window = rawWindow as MoversWindow

    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = req.network ?? (requested as NetworkName) ?? activeNetwork

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
            (array_agg(price::float ORDER BY timestamp ASC))[1] AS start_price,
            (array_agg(price::float ORDER BY timestamp DESC))[1] AS end_price,
            SUM(base_volume::float) AS current_volume,
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
            SUM(base_volume::float) AS prev_volume
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
        const startPrice = r.start_price != null ? Number(r.start_price) : null
        const endPrice = r.end_price != null ? Number(r.end_price) : null
        const currentVolume = Number(r.current_volume) || 0
        const previousVolume = Number(r.prev_volume) || 0

        let priceChangePct: number | null = null
        if (startPrice != null && endPrice != null && startPrice > 0) {
          priceChangePct = ((endPrice - startPrice) / startPrice) * 100
        }

        let volumeChangePct: number | null = null
        if (previousVolume > 0) {
          volumeChangePct = ((currentVolume - previousVolume) / previousVolume) * 100
        } else if (currentVolume > 0) {
          // Grew from 0 previous volume in prior window
          volumeChangePct = 100
        }

        const venues: string[] = Array.isArray(r.venues) ? r.venues.filter(Boolean) : []
        const isSingleVenue = venues.length === 1

        return {
          pairKey: r.pair_key,
          assetA: r.asset_a,
          assetB: r.asset_b,
          priceChangePct,
          startPrice,
          endPrice,
          currentVolume,
          previousVolume,
          volumeChangePct,
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
        .slice(0, 20)

      // Price losers: negative price change, ascending (biggest drop first)
      const losers = allItems
        .filter((i) => i.priceChangePct !== null && i.priceChangePct < 0)
        .sort((a, b) => (a.priceChangePct ?? 0) - (b.priceChangePct ?? 0))
        .slice(0, 20)

      // Volume movers: ranked by absolute volume change or volume growth
      const volumeMovers = allItems
        .filter((i) => i.volumeChangePct !== null)
        .sort((a, b) => Math.abs(b.volumeChangePct ?? 0) - Math.abs(a.volumeChangePct ?? 0))
        .slice(0, 20)

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
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}
