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
import { apiError, sendInternalError } from '../errors'
import {
  findPegMeasuringPair,
  computePegStatus,
  getNoReferenceReason,
  type PegStatus,
} from '../pricing/pegRules'

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
  status: PegStatus
  reason: string | null
  window: string
  provenance: PegProvenance
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
      let queriesAttempted = 0
      let queriesFailed = 0
      let lastQueryError: unknown = null

      for (const pegged of peggedConfigs) {
        const fullAsset = pegged.asset.issuer ? `${pegged.asset.code}:${pegged.asset.issuer}` : pegged.asset.code
        const match = findPegMeasuringPair(pegged, watchedPairs, peggedConfigs)

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
            status: 'no_reference',
            reason: `no watched pair configured for ${pegged.asset.code}`,
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

        if (!match.isReference) {
          reports.push({
            asset: fullAsset,
            code: pegged.asset.code,
            issuer: pegged.asset.issuer,
            target: pegged.target,
            targetPrice: pegged.targetPrice,
            pairKey: match.pair.pairKey,
            currentPrice: null,
            currentDeviationBps: null,
            worstDeviationBps: null,
            status: 'no_reference',
            reason: getNoReferenceReason(match.quote.code, pegged.target),
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

        queriesAttempted++

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
          const evalResult = computePegStatus(latestPrice, targetPrice, DEFAULT_PEG_TOLERANCE_BPS)

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
            currentDeviationBps: evalResult.deviationBp,
            worstDeviationBps,
            status: evalResult.status,
            reason: evalResult.reason,
            window: `${windowHours}h`,
            provenance: {
              venues,
              sampleCount,
              freshnessSeconds,
              lastSampleTimestamp: lastTs ? lastTs.toISOString() : null,
            },
          })
        } catch (err) {
          queriesFailed++
          lastQueryError = err
          req.log.error({ err, pairKey: pair.pairKey, asset: fullAsset }, 'Failed to query peg metrics')

          // Say when computation cannot be performed for this asset due to query failure
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
            status: 'error',
            reason: 'query failed',
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

      if (queriesAttempted > 0 && queriesFailed === queriesAttempted) {
        return sendInternalError(reply, req, lastQueryError, 'Failed to query peg data')
      }

      return {
        network,
        pegs: reports,
      }
    }
  )
}
