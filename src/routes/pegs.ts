import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import {
  getNetworkConfig,
  activeNetwork,
  DEFAULT_PEG_TOLERANCE_BPS,
  type NetworkName,
  type PeggedAssetConfig,
} from '../config'
import { pegsResponseSchema } from '../api/schemas'
import type { WatchedPair } from '../types'
import '../middleware/network'

import { apiError } from '../errors'
/**
 * Default deviation band in basis points (100 bps = 1.0%), aligned with
 * GET /snapshot (PEG_TOLERANCE_BPS = 100) and the peg-deviation alerting
 * engine (#322, default band = 0.01 = 100 bps).
 */
export const PEG_TOLERANCE_BPS = DEFAULT_PEG_TOLERANCE_BPS ?? 100

export interface PegProvenance {
  venues: string[]
  sampleCount: number
  freshnessSeconds: number | null
  lastSampleTimestamp: string | null
}

export interface PegReport {
  asset: string
  code: string
  issuer: string | null
  target: string
  targetPrice: number
  pairKey: string | null
  currentPrice: number | null
  currentDeviationBps: number | null
  worstDeviationBps: number | null
  window: string
  provenance: PegProvenance
}

/**
 * Match a pegged asset and target against configured watched pairs.
 */
function findWatchedPair(
  pegged: PeggedAssetConfig,
  pairs: readonly WatchedPair[]
): { pair: WatchedPair; isAssetA: boolean } | null {
  const normAssetCode = pegged.asset.code.toUpperCase()
  const normTargetCode = pegged.target.toUpperCase()

  for (const pair of pairs) {
    const pACode = pair.assetA.code.toUpperCase()
    const pBCode = pair.assetB.code.toUpperCase()

    // Case 1: pair is (pegged.asset, target)
    if (pACode === normAssetCode && pBCode === normTargetCode) {
      if (!pegged.asset.issuer || !pair.assetA.issuer || pegged.asset.issuer === pair.assetA.issuer) {
        return { pair, isAssetA: true }
      }
    }

    // Case 2: pair is (target, pegged.asset)
    if (pBCode === normAssetCode && pACode === normTargetCode) {
      if (!pegged.asset.issuer || !pair.assetB.issuer || pegged.asset.issuer === pair.assetB.issuer) {
        return { pair, isAssetA: false }
      }
    }
  }

  return null
}

/**
 * Register GET /pegs route.
 */
export async function registerPegsRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { network?: string }
  }>(
    '/pegs',
    { config: { scope: 'read:prices' }, schema: { response: { 200: pegsResponseSchema } } },
    async (req, reply) => {
      const requested = req.query.network
      if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
        return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
      }
      const network: NetworkName = req.network ?? (requested as NetworkName) ?? activeNetwork

      const networkConfig = getNetworkConfig(network)
      const peggedConfigs = networkConfig.pegged ?? []
      const watchedPairs = networkConfig.pairs ?? []

      const reports: PegReport[] = []

      for (const pegged of peggedConfigs) {
        const fullAsset = pegged.asset.issuer ? `${pegged.asset.code}:${pegged.asset.issuer}` : pegged.asset.code
        const match = findWatchedPair(pegged, watchedPairs)

        if (!match) {
          // Say when you cannot answer: watched pair not found / unquoted
          reports.push({
            asset: fullAsset,
            code: pegged.asset.code,
            issuer: pegged.asset.issuer,
            target: pegged.target,
            targetPrice: pegged.targetPrice,
            pairKey: null,
            currentPrice: null,
            currentDeviationBps: null,
            worstDeviationBps: null,
            window: `${pegged.windowHours ?? 24}h`,
            provenance: {
              venues: [],
              sampleCount: 0,
              freshnessSeconds: null,
              lastSampleTimestamp: null,
            },
          })
          continue
        }

        const { pair, isAssetA } = match
        const priceExpr = isAssetA ? 'price::numeric' : '1.0 / NULLIF(price::numeric, 0)'
        const targetPrice = pegged.targetPrice > 0 ? pegged.targetPrice : 1.0
        const windowHours = pegged.windowHours ?? 24

        // Compute latest price, window worst deviation, and provenance (venues, sampleCount, freshness)
        // Query both latest observation (without window restriction) and window stats
        const query = `
          WITH latest_obs AS (
            SELECT
              ${priceExpr} AS latest_price,
              timestamp AS latest_ts,
              source AS latest_source
            FROM price_points
            WHERE pair_key = $1 AND network = $2
            ORDER BY timestamp DESC
            LIMIT 1
          ),
          window_stats AS (
            SELECT
              MAX(ABS(${priceExpr} - $3::numeric)) / $3::numeric * 10000 AS worst_deviation_bps,
              COUNT(*)::int AS sample_count,
              ARRAY_AGG(DISTINCT source) FILTER (WHERE source IS NOT NULL) AS venues,
              MAX(timestamp) AS window_last_ts
            FROM price_points
            WHERE pair_key = $1
              AND network = $2
              AND timestamp > NOW() - ($4 || ' hours')::interval
          )
          SELECT
            l.latest_price,
            l.latest_ts,
            l.latest_source,
            w.worst_deviation_bps,
            w.sample_count,
            w.venues,
            w.window_last_ts
          FROM latest_obs l
          FULL OUTER JOIN window_stats w ON TRUE
        `

        try {
          const result = await pgPool.query(query, [pair.pairKey, network, targetPrice, windowHours])
          const row = result.rows[0]

          const latestPriceRaw = row?.latest_price
          const latestPrice = latestPriceRaw !== null && latestPriceRaw !== undefined ? parseFloat(latestPriceRaw) : null
          const currentDeviationBps =
            latestPrice !== null ? ((latestPrice - targetPrice) / targetPrice) * 10000 : null

          const worstDevRaw = row?.worst_deviation_bps
          const worstDeviationBps = worstDevRaw !== null && worstDevRaw !== undefined ? parseFloat(worstDevRaw) : null

          const sampleCount = Number(row?.sample_count) || 0
          const venues: string[] = Array.isArray(row?.venues)
            ? row.venues
            : row?.latest_source
              ? [row.latest_source]
              : []

          const lastTs: Date | null = row?.latest_ts ? new Date(row.latest_ts) : null
          const freshnessSeconds = lastTs ? Math.max(0, Math.floor((Date.now() - lastTs.getTime()) / 1000)) : null

          reports.push({
            asset: fullAsset,
            code: pegged.asset.code,
            issuer: pegged.asset.issuer,
            target: pegged.target,
            targetPrice,
            pairKey: pair.pairKey,
            currentPrice: latestPrice,
            currentDeviationBps,
            worstDeviationBps,
            window: `${windowHours}h`,
            provenance: {
              venues,
              sampleCount,
              freshnessSeconds,
              lastSampleTimestamp: lastTs ? lastTs.toISOString() : null,
            },
          })
        } catch (err) {
          // Say when computation cannot be performed for this asset
          reports.push({
            asset: fullAsset,
            code: pegged.asset.code,
            issuer: pegged.asset.issuer,
            target: pegged.target,
            targetPrice,
            pairKey: pair.pairKey,
            currentPrice: null,
            currentDeviationBps: null,
            worstDeviationBps: null,
            window: `${windowHours}h`,
            provenance: {
              venues: [],
              sampleCount: 0,
              freshnessSeconds: null,
              lastSampleTimestamp: null,
            },
          })
        }
      }

      return {
        network,
        pegs: reports,
      }
    }
  )
}
