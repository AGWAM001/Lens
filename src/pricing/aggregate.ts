import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getFailedSources } from '../ingest/sourceFailures'

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
 * Aggregate price for a pair across sources (SDEX, AMM) weighted by volume.
 * Sources that deviate from the weighted average by more than the provided
 * threshold are excluded from the final composite price.
 *
 * @param pairKey The pair identifier (e.g., "XLM/USDC").
 * @param deviationThreshold Fractional threshold (e.g., 0.05 for 5%).
 * @param network The chain to read. `price_points` indexes `network` as the
 *   leading column of (network, pair_key, timestamp), and the same pair key
 *   exists on both chains — an unfiltered read blends two separate markets.
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
  const failed = new Set([...getFailedSources(network, pairKey), ...failedSources])

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

  const sources: AggregateSource[] = result.rows.map((row: any) => {
    const source = row.source as string
    const isFailed = failed.has(source)
    return {
      source,
      price: parseFloat(row.vwap ?? '0'),
      volume: parseFloat(row.volume ?? '0'),
      // #329: a source whose latest fetch failed is excluded outright. Its
      // rows in the window are from before it failed; letting them (or its
      // absence) weigh in would publish a price that looks normal and is not.
      excluded: isFailed,
      reason: isFailed ? 'source failed to fetch' : undefined,
    }
  })

  // Initial weighted average using every source that answered.
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
  const composite = includedVolume === 0 ? 0 : included.reduce((sum, s) => sum + s.price * s.volume, 0) / includedVolume

  return { composite, breakdown: sources, failedSources: [...failed].sort() }
}
