import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'

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
 * @returns Composite price and per‑source breakdown.
 */
export async function aggregatePrice(
  pairKey: string,
  deviationThreshold: number = 0.05,
  network: NetworkName = activeNetwork,
): Promise<{
  composite: number
  breakdown: Array<{
    source: string
    price: number
    volume: number
    excluded: boolean
    reason?: string
  }>
}> {
  // Fetch VWAP and volume per source for the last hour.
  const result = await pgPool.query(
    `SELECT
       source,
       COALESCE(SUM(price::numeric * base_volume::numeric), 0) / NULLIF(SUM(base_volume::numeric), 0) AS vwap,
       SUM(base_volume::numeric) AS volume
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '1 hour'
     GROUP BY source`,
    [pairKey, network]
  )

  const sources = result.rows.map((row: any) => ({
    source: row.source as string,
    price: parseFloat(row.vwap ?? '0'),
    volume: parseFloat(row.volume ?? '0'),
    excluded: false,
    reason: undefined as string | undefined,
  }))

  // Initial weighted average using all sources.
  const totalVolume = sources.reduce((sum, s) => sum + s.volume, 0)
  const initialWeightedAvg = totalVolume === 0 ? 0 : sources.reduce((sum, s) => sum + s.price * s.volume, 0) / totalVolume

  // Determine exclusions based on deviation.
  for (const s of sources) {
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

  return { composite, breakdown: sources }
}
