import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import type { DecimalFormat } from '../utils/decimals'

// ─── TWAP — Time-Weighted Average Price ───────────────────────────────────────
// Computed by averaging the midpoints of successive price points weighted by
// the time interval between them. This gives more weight to prices that prevailed
// for longer, reducing the impact of brief manipulation spikes.

export interface TWAPResult {
  twap: number | string
  startTime: Date
  endTime: Date
  sampleCount: number
  outlierRejected: number
  filterMethod: string
  network: NetworkName
}

export interface VWAPResult {
  vwap: number | string
  startTime: Date
  endTime: Date
  sampleCount: number
  volumeTotal: number | string
  outlierRejected: number
  filterMethod: string
  network: NetworkName
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ─── TWAP Computation ─────────────────────────────────────────────────────────

/**
 * Compute Time-Weighted Average Price over a configurable window.
 * Uses IQR outlier rejection by default.
 *
 * TWAP = Σ(price_i * Δt_i) / Σ(Δt_i)  where Δt_i is the time to the next sample.
 *
 * Price points are fetched from the price_points table at a regular sample
 * interval. If no trades occur within a sub-interval, the last known price
 * is carried forward (prevents stale gap manipulation).
 */
export async function computeTWAP(
  pairKey: string,
  windowMinutes: number,
  options?: {
    sampleIntervalSeconds?: number
    outlierMethod?: 'iqr' | 'modified_zscore'
    network?: NetworkName
    decimalFormat?: DecimalFormat
  }
): Promise<TWAPResult> {
  const sampleIntervalSeconds = options?.sampleIntervalSeconds ?? 60
  const outlierMethod = options?.outlierMethod ?? 'iqr'
  const network = options?.network ?? activeNetwork
  const isString = options?.decimalFormat === 'string'

  // Fetch price points within the window for the specific network, ordered by timestamp
  const result = await pgPool.query(
    `SELECT price::numeric as price, timestamp
     FROM price_points
     WHERE pair_key = $1
       AND network = $3
       AND timestamp > NOW() - ($2 || ' minutes')::interval
     ORDER BY timestamp ASC`,
    [pairKey, windowMinutes, network]
  )

  const rows = result.rows
  if (rows.length === 0) {
    return {
      twap: isString ? '0' : 0,
      startTime: new Date(Date.now() - windowMinutes * 60_000),
      endTime: new Date(),
      sampleCount: 0,
      outlierRejected: 0,
      filterMethod: outlierMethod,
      network,
    }
  }

  // Extract raw prices for outlier rejection
  const rawPrices = rows.map((r: any) => parseFloat(r.price))

  // Reject outliers by original index so timestamps and prices stay paired.
  const { rejectedIndices: statisticalOutliers } = outlierMethod === 'iqr'
    ? rejectOutliersWithIndices(rawPrices)
    : rejectOutliersModifiedZScoreWithIndices(rawPrices)
  const rejectedIndices = new Set(statisticalOutliers)
  rawPrices.forEach((price, i) => {
    if (!Number.isFinite(price)) rejectedIndices.add(i)
  })
  const rejected = rejectedIndices.size

  const validPoints = rows
    .map((r: any, i: number) => ({
      ts: new Date(r.timestamp).getTime(),
      price: rawPrices[i],
      rejected: rejectedIndices.has(i),
    }))
    .filter((point: any) => !point.rejected)
    .map(({ ts, price }: any) => ({ ts, price }))
    .sort((a: any, b: any) => a.ts - b.ts)

  if (validPoints.length === 0) {
    return {
      twap: isString ? '0' : 0,
      startTime: rows[0].timestamp,
      endTime: rows[rows.length - 1].timestamp,
      sampleCount: rawPrices.length,
      outlierRejected: rejected,
      filterMethod: outlierMethod,
      network,
    }
  }

  // Build equi-spaced time grid and interpolate price at each sample point
  const startTime = new Date(rows[0].timestamp).getTime()
  const endTime = new Date(rows[rows.length - 1].timestamp).getTime()
  const totalDurationMs = endTime - startTime

  if (totalDurationMs <= 0) {
    // Single data point — use its price
    return {
      twap: isString ? String(rows[0].price) : validPoints[0].price,
      startTime: rows[0].timestamp,
      endTime: rows[rows.length - 1].timestamp,
      sampleCount: rawPrices.length,
      outlierRejected: rejected,
      filterMethod: outlierMethod,
      network,
    }
  }

  const sampleIntervalMs = sampleIntervalSeconds * 1000
  const sampleCount = Math.max(1, Math.floor(totalDurationMs / sampleIntervalMs))
  const interpolatedPrices: { price: number; weight: number }[] = []

  for (let i = 0; i <= sampleCount; i++) {
    const sampleTs = startTime + i * sampleIntervalMs
    if (sampleTs > endTime) break

    // Find the closest price at or before this sample time (last observation carry forward)
    let interpolatedPrice = validPoints[0].price
    for (let j = 0; j < validPoints.length; j++) {
      if (validPoints[j].ts <= sampleTs) {
        interpolatedPrice = validPoints[j].price
      } else {
        break
      }
    }

    // Weight: time to next sample or to end
    const nextSampleTs = Math.min(startTime + (i + 1) * sampleIntervalMs, endTime)
    const weight = (nextSampleTs - sampleTs) / totalDurationMs
    interpolatedPrices.push({ price: interpolatedPrice, weight })
  }

  // Compute TWAP as weighted average
  const twap = interpolatedPrices.reduce((sum, p) => sum + p.price * p.weight, 0)

  return {
    twap: isString ? String(twap) : twap,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    sampleCount: rawPrices.length,
    outlierRejected: rejected,
    filterMethod: outlierMethod,
    network,
  }
}

// ─── VWAP Computation ─────────────────────────────────────────────────────────

/**
 * Compute Volume-Weighted Average Price over a configurable window.
 * Uses IQR outlier rejection by default.
 *
 * VWAP = Σ(price_i * volume_i) / Σ(volume_i)
 *
 * Volume is base_volume. Only trades within the window contribute —
 * no interpolation needed since each trade is naturally volume-weighted.
 */
export async function computeVWAP(
  pairKey: string,
  windowMinutes: number,
  options?: {
    source?: 'SDEX' | 'AMM'
    outlierMethod?: 'iqr' | 'modified_zscore'
    network?: NetworkName
    decimalFormat?: DecimalFormat
  }
): Promise<VWAPResult> {
  const outlierMethod = options?.outlierMethod ?? 'iqr'
  const network = options?.network ?? activeNetwork
  const isString = options?.decimalFormat === 'string'

  let query: string
  let params: any[]

  if (options?.source) {
    query = `SELECT price::numeric as price, base_volume::numeric as volume, timestamp
             FROM price_points
             WHERE pair_key = $1
               AND network = $4
               AND source = $3
               AND timestamp > NOW() - ($2 || ' minutes')::interval
             ORDER BY timestamp ASC`
    params = [pairKey, windowMinutes, options.source, network]
  } else {
    query = `SELECT price::numeric as price, base_volume::numeric as volume, timestamp
             FROM price_points
             WHERE pair_key = $1
               AND network = $3
               AND timestamp > NOW() - ($2 || ' minutes')::interval
             ORDER BY timestamp ASC`
    params = [pairKey, windowMinutes, network]
  }

  const result = await pgPool.query(query, params)
  const rows = result.rows

  if (rows.length === 0) {
    return {
      vwap: isString ? '0' : 0,
      startTime: new Date(Date.now() - windowMinutes * 60_000),
      endTime: new Date(),
      sampleCount: 0,
      volumeTotal: isString ? '0' : 0,
      outlierRejected: 0,
      filterMethod: outlierMethod,
      network,
    }
  }

  // For VWAP, outlier rejection considers the price dimension only
  // (volume dimension is not subject to manipulation in the same way)
  const rawPrices = rows.map((r: any) => parseFloat(r.price))

  // Reject outliers on prices
  const { rejectedIndices } = outlierMethod === 'iqr'
    ? rejectOutliersWithIndices(rawPrices)
    : rejectOutliersModifiedZScoreWithIndices(rawPrices)

  // Filter out outlier rows
  const validRows = rows.filter((_: any, i: number) => !rejectedIndices.has(i))

  if (validRows.length === 0) {
    return {
      vwap: isString ? '0' : 0,
      startTime: rows[0].timestamp,
      endTime: rows[rows.length - 1].timestamp,
      sampleCount: rawPrices.length,
      volumeTotal: isString ? '0' : 0,
      outlierRejected: rejectedIndices.size,
      filterMethod: outlierMethod,
      network,
    }
  }

  if (validRows.length === 1) {
    const singleVol = parseFloat(validRows[0].volume)
    return {
      vwap: isString ? String(validRows[0].price) : parseFloat(validRows[0].price),
      startTime: rows[0].timestamp,
      endTime: rows[rows.length - 1].timestamp,
      sampleCount: rawPrices.length,
      volumeTotal: isString ? String(validRows[0].volume) : singleVol,
      outlierRejected: rejectedIndices.size,
      filterMethod: outlierMethod,
      network,
    }
  }

  let totalVolume = 0
  let weightedPriceSum = 0

  for (const row of validRows) {
    const price = parseFloat(row.price)
    const volume = parseFloat(row.volume)
    weightedPriceSum += price * volume
    totalVolume += volume
  }

  const vwap = totalVolume > 0 ? weightedPriceSum / totalVolume : 0

  return {
    vwap: isString ? String(vwap) : vwap,
    startTime: rows[0].timestamp,
    endTime: rows[rows.length - 1].timestamp,
    sampleCount: rawPrices.length,
    volumeTotal: isString ? String(totalVolume) : totalVolume,
    outlierRejected: rejectedIndices.size,
    filterMethod: outlierMethod,
    network,
  }
}

// ─── Helper: Outlier rejection returning rejected indices ─────────────────────

export const MIN_OUTLIER_SAMPLES = 4
export const IQR_MULTIPLIER = 1.5
export const MODIFIED_Z_SCORE_THRESHOLD = 3.5
export const MODIFIED_Z_SCORE_FACTOR = 0.6745

function rejectOutliersWithIndices(prices: number[]): { rejectedIndices: Set<number> } {
  if (prices.length < MIN_OUTLIER_SAMPLES) return { rejectedIndices: new Set() }

  const sorted = [...prices].sort((a, b) => a - b)
  const n = sorted.length

  const lowerHalf = sorted.slice(0, Math.floor(n / 2))
  const upperHalf = sorted.slice(Math.ceil(n / 2))

  const q1 = median(lowerHalf)
  const q3 = median(upperHalf)
  const iqr = q3 - q1

  const lowerBound = q1 - IQR_MULTIPLIER * iqr
  const upperBound = q3 + IQR_MULTIPLIER * iqr

  const rejectedIndices = new Set<number>()
  prices.forEach((p, i) => {
    if (p < lowerBound || p > upperBound) rejectedIndices.add(i)
  })

  return { rejectedIndices }
}

function rejectOutliersModifiedZScoreWithIndices(prices: number[]): { rejectedIndices: Set<number> } {
  if (prices.length < MIN_OUTLIER_SAMPLES) return { rejectedIndices: new Set() }

  const sorted = [...prices].sort((a, b) => a - b)
  const med = median(sorted)
  const mad = median(sorted.map(v => Math.abs(v - med)))

  if (mad === 0) return { rejectedIndices: new Set() }

  const threshold = MODIFIED_Z_SCORE_THRESHOLD
  const rejectedIndices = new Set<number>()
  prices.forEach((p, i) => {
    const zScore = MODIFIED_Z_SCORE_FACTOR * (p - med) / mad
    if (Math.abs(zScore) > threshold) rejectedIndices.add(i)
  })

  return { rejectedIndices }
}