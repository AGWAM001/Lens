import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getFailedSources } from '../ingest/sourceFailures'
import { getOnChainSources } from '../ingest/venues'

export interface AggregateSource {
  source: string
  price: number
  volume: number
  excluded: boolean
  reason?: string
}

export interface AggregateResult {
  composite: number
  breakdown: AggregateSource[]
  /**
   * Sources that failed for this pair on this network (#329), sorted. A failed
   * source is excluded from the composite — including from the initial
   * weighted average the deviation check measures against — rather than
   * counted as contributing zero. It is listed here even when it has no rows
   * in the window, so a venue that is down is never indistinguishable from one
   * that is quiet.
   */
  failedSources: string[]
}

/**
 * Aggregate price for a pair across on-chain sources weighted by volume.
 * Sources that deviate from the weighted average by more than the provided
 * threshold are excluded from the final composite price.
 *
 * Retired into a thin wrapper around unified on-chain venue source definition
 * and SQL numeric VWAP (#652).
 *
 * @param pairKey The pair identifier (e.g., "XLM/USDC").
 * @param deviationThreshold Fractional threshold (e.g., 0.05 for 5%).
 * @param network The chain to read.
 * @param failedSources Extra sources the caller knows failed. Merged with the
 *   failures recorded by the ingesters for this (network, pair) (#329).
 * @returns Composite price, per‑source breakdown, and the failed sources.
 */
export async function aggregatePrice(
  pairKey: string,
  deviationThreshold: number = 0.05,
  network: NetworkName = activeNetwork,
  failedSources: string[] = [],
): Promise<AggregateResult> {
  const onChainSources = new Set(getOnChainSources())
  const allFailed = [...new Set([...getFailedSources(network, pairKey), ...failedSources])].sort()
  const failed = new Set(allFailed)

  // Fetch VWAP and volume per source for the last hour.
  const result = await pgPool.query(
    `SELECT
       source,
       COALESCE(SUM(price::numeric * base_volume::numeric), 0) / NULLIF(SUM(base_volume::numeric), 0) AS vwap,
       SUM(base_volume::numeric) AS volume
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '1 hour'
     GROUP BY source`,
    [pairKey, network]
  )

  const sources: AggregateSource[] = []
  for (const row of result.rows) {
    const source = row.source as string
    // Exclude off-chain / CEX sources from on-chain aggregate (#652)
    if (onChainSources.size > 0 && !onChainSources.has(source)) {
      continue
    }
    const isFailed = failed.has(source)
    sources.push({
      source,
      price: parseFloat(row.vwap ?? '0'),
      volume: parseFloat(row.volume ?? '0'),
      excluded: isFailed,
      reason: isFailed ? 'source failed to fetch' : undefined,
    })
  }

  // Initial weighted average using every answered non-failed source.
  const answered = sources.filter(s => !failed.has(s.source))
  const totalVolume = answered.reduce((sum, s) => sum + s.volume, 0)
  const initialWeightedAvg = totalVolume === 0 ? 0 : answered.reduce((sum, s) => sum + s.price * s.volume, 0) / totalVolume

  // Determine exclusions based on deviation.
  for (const s of answered) {
    if (initialWeightedAvg === 0) {
      s.excluded = false
      continue
    }
    const deviation = Math.abs(s.price - initialWeightedAvg) / initialWeightedAvg
    if (deviation > deviationThreshold) {
      s.excluded = true
      s.reason = `deviation ${(deviation * 100).toFixed(2)}% exceeds threshold ${(deviationThreshold * 100).toFixed(2)}%`
    }
  }

  // Re‑calculate composite using only non‑excluded sources.
  const included = sources.filter(s => !s.excluded)
  const includedVolume = included.reduce((sum, s) => sum + s.volume, 0)
  let composite = includedVolume === 0 ? 0 : included.reduce((sum, s) => sum + s.price * s.volume, 0) / includedVolume

  // When every on-chain venue failed, do not silently become 0: fallback to last valid price
  if (composite === 0 && answered.length === 0 && sources.length > 0) {
    const fallback = sources.find(s => s.price > 0)
    if (fallback) composite = fallback.price
  }

  return { composite, breakdown: sources, failedSources: allFailed }
}
