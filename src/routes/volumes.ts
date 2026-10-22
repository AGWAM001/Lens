import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { sendInternalError } from '../errors'

// Supported windows → lookback in hours.
const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

type VolumeWindow = keyof typeof WINDOW_HOURS

const WINDOWS = Object.keys(WINDOW_HOURS) as VolumeWindow[]

/**
 * Register the aggregated cross-venue volume endpoint.
 *
 * GET /volumes/:asset?window=24h|7d|30d&network=testnet|mainnet
 *
 * Sums traded volume for `asset` across every pair it appears in and across all
 * venues (SDEX, AMM, …) over the requested window. Volume is measured in the
 * asset's own units: when it is the base asset of a pair we count `base_volume`,
 * when it is the counter asset we count `counter_volume`. The response breaks the
 * total down per venue and also returns the cross-venue sum.
 *
 * Only one network's rows are summed: testnet and mainnet volume added together
 * is not a volume of anything. `network` defaults to this process's own network,
 * an unrecognised value is a 400, and the network answered for is echoed back.
 */
export async function registerVolumeRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string; network?: string }
  }>('/volumes/:asset', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const { asset } = req.params
    const window = req.query.window ?? '24h'

    if (!(window in WINDOW_HOURS)) {
      return reply
        .status(400)
        .send({ error: `window must be one of: ${WINDOWS.join(', ')}` })
    }

    const rawRequested: unknown = req.query.network
    const requested = typeof rawRequested === 'string' ? rawRequested.trim().toLowerCase() : rawRequested
    if (requested !== undefined && requested !== '' && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = req.network
      ?? (requested ? requested as NetworkName : activeNetwork)

    const hours = WINDOW_HOURS[window as VolumeWindow]
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)

    try {
      // The CTE gives each observation its volume in the requested asset's own
      // units. Statistics are aggregated in Postgres so a long window does not
      // require sending every trade to the API process.
      const { rows } = await pgPool.query(
        `WITH asset_trades AS (
           SELECT source,
                  timestamp,
                  (CASE
                    WHEN asset_a = $1 THEN base_volume
                    WHEN asset_b = $1 THEN counter_volume
                  END)::numeric AS volume
             FROM price_points
            WHERE (asset_a = $1 OR asset_b = $1)
              AND network = $2
              AND timestamp >= $3
         ),
         venue_totals AS (
           SELECT source, SUM(volume)::float8 AS volume
             FROM asset_trades
            GROUP BY source
         ),
         trade_stats AS (
           SELECT (COUNT(*) FILTER (WHERE volume > 0))::int AS trade_count,
                  COUNT(*)::int AS observed_sample_count,
                  SUM(volume)::float8 AS total_volume,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY volume::float8)
                    FILTER (WHERE volume > 0) AS median_trade_size,
                  (MAX(volume) FILTER (WHERE volume > 0))::float8
                    / NULLIF((SUM(volume) FILTER (WHERE volume > 0))::float8, 0) AS top_trade_volume_share,
                  (SUM(volume * volume) FILTER (WHERE volume > 0))::float8
                    / NULLIF(POWER((SUM(volume) FILTER (WHERE volume > 0))::float8, 2), 0) AS volume_concentration,
                  MAX(timestamp) FILTER (WHERE volume > 0) AS latest_trade_at
             FROM asset_trades
         ),
         venue_summary AS (
           SELECT COALESCE(jsonb_object_agg(source, volume) FILTER (WHERE volume > 0), '{}'::jsonb) AS by_venue,
                  COALESCE(jsonb_agg(source ORDER BY source) FILTER (WHERE volume > 0), '[]'::jsonb) AS venues
             FROM venue_totals
         )
         SELECT trade_stats.*, venue_summary.by_venue, venue_summary.venues
           FROM trade_stats CROSS JOIN venue_summary`,
        [asset, network, startTime],
      )

      const row = rows[0] ?? {}
      const tradeCount = Number(row.trade_count) || 0
      const observedSampleCount = Number(row.observed_sample_count) || 0
      const totalVolume = Number(row.total_volume) || 0
      const latestTradeAt = row.latest_trade_at == null
        ? null
        : new Date(row.latest_trade_at as string | Date).toISOString()
      const dataAgeSeconds = latestTradeAt === null
        ? null
        : Math.max(0, Math.floor((endTime.getTime() - new Date(latestTradeAt).getTime()) / 1000))
      const status = observedSampleCount === 0
        ? 'no_trades'
        : tradeCount === 0 || totalVolume <= 0
          ? 'no_positive_volume'
          : 'ok'

      return {
        asset,
        network,
        window,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        totalVolume,
        byVenue: row.by_venue ?? {},
        venues: row.venues ?? [],
        tradeCount,
        medianTradeSize: row.median_trade_size == null ? null : Number(row.median_trade_size),
        topTradeVolumeShare: row.top_trade_volume_share == null ? null : Number(row.top_trade_volume_share),
        volumeConcentration: row.volume_concentration == null ? null : Number(row.volume_concentration),
        concentrationMeasure: 'hhi',
        status,
        provenance: {
          venues: row.venues ?? [],
          sampleCount: tradeCount,
          observedSampleCount,
          latestTradeAt,
          dataAgeSeconds,
        },
      }
    } catch (err) {
      return sendInternalError(reply, req, err, 'Volume aggregation failed')
    }
  })
}
