import type { NetworkName } from '../config'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { pgPool } from '../db'

export type OracleSourceStatus = 'not_configured' | 'available' | 'unreachable' | 'empty'
export type DeviationStatus = 'aligned' | 'minor_deviation' | 'major_deviation' | 'partial'

export interface OracleSourceComparison {
  name: string
  price: number | null
  timestamp: string | null
  deviationPct: number | null
  status: OracleSourceStatus
  ageSeconds: number | null
}

export interface OracleComparison {
  asset: string
  network: NetworkName
  lens: number | null
  reflector: number | null
  deviationPct: number | null
  status: DeviationStatus
  fetchedAt: string
  oracles: OracleSourceComparison[]
}

export interface LensPriceResult {
  price: number | null
  venues: string[]
  sampleCount: number
  lastSeen: string | null
}

export interface OracleComparisonRecord {
  network: NetworkName
  asset: string
  oracle: string
  lensPrice: number | null
  oraclePrice: number | null
  deviationPct: number | null
  status: string
  venues: string[]
  sampleCount: number
  oracleTimestamp: Date | null
  ageSeconds: number | null
  timestamp: Date
}

export interface OracleHistoryPoint {
  id?: string
  timestamp: string
  oracle: string
  lensPrice: number | null
  oraclePrice: number | null
  deviationPct: number | null
  status: string
  venues: string[]
  sampleCount: number
  oracleTimestamp: string | null
  ageSeconds: number | null
}

export interface OracleSummaryStatistic {
  oracle: string
  meanDeviationPct: number | null
  worstDeviationPct: number | null
  timeOutsideBandSeconds: number | null
  outsideBandSeconds: number | null
  outsideBandPct: number | null
  bandPct: number
  samples: number
  venues: string[]
  freshestComparison: string | null
  oldestComparison: string | null
  status: string
}

export interface QueryHistoryOptions {
  asset: string
  network: NetworkName
  oracle?: string
  from: Date
  to: Date
  limit?: number
}

export const ORACLE_HISTORY_WINDOWS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const

export type OracleHistoryWindow = keyof typeof ORACLE_HISTORY_WINDOWS

export interface CompareOraclesOptions {
  persist?: boolean
}

export function deviationPct(lens: number | null, oracle: number | null): number | null {
  if (lens === null || oracle === null || oracle === 0) return null
  return parseFloat((Math.abs(oracle - lens) / Math.abs(oracle) * 100).toFixed(4))
}

export function deviationStatus(deviation: number | null): DeviationStatus {
  if (deviation === null) return 'partial'
  return deviation < 1 ? 'aligned' : deviation < 5 ? 'minor_deviation' : 'major_deviation'
}

async function fetchLensPrice(assetCode: string, network: NetworkName): Promise<LensPriceResult> {
  const result = await pgPool.query(
    `SELECT
       COALESCE(SUM(price::numeric * base_volume::numeric), 0)
         / NULLIF(SUM(base_volume::numeric), 0) AS vwap,
       array_remove(array_agg(DISTINCT source), NULL) AS venues,
       COUNT(*)::int AS sample_count,
       MAX(timestamp) AS last_seen
     FROM price_points
     WHERE (asset_a = $1 OR asset_b = $1)
       AND network = $2
       AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '5 minutes'
     GROUP BY pair_key
     LIMIT 1`,
    [assetCode, network]
  )
  const row = result.rows[0]
  if (!row) {
    return { price: null, venues: [], sampleCount: 0, lastSeen: null }
  }
  const vwap = row.vwap !== null && row.vwap !== undefined ? parseFloat(row.vwap) : null
  const venues = Array.isArray(row.venues) ? row.venues : []
  const sampleCount = Number(row.sample_count) || 0
  const lastSeen = row.last_seen ? new Date(row.last_seen).toISOString() : null
  return {
    price: Number.isFinite(vwap) ? vwap : null,
    venues,
    sampleCount,
    lastSeen,
  }
}

type SourceResult =
  | { name: string; status: 'not_configured' | 'unreachable' | 'empty'; quote: null }
  | { name: string; status: 'available'; quote: { price: number; timestamp: number } }

async function fetchSource(adapter: OracleAdapter, assetCode: string, network: NetworkName): Promise<SourceResult> {
  if (!adapter.isConfigured(network)) {
    return { name: adapter.name, status: 'not_configured', quote: null }
  }
  try {
    const quote = await adapter.getPrice(assetCode, network)
    // A configured oracle that answers with nothing is different from one we
    // could not reach, so the two are reported separately.
    return quote
      ? { name: adapter.name, status: 'available', quote }
      : { name: adapter.name, status: 'empty', quote: null }
  } catch {
    // A failed oracle stays visible in the response instead of being dropped.
    return { name: adapter.name, status: 'unreachable', quote: null }
  }
}

/**
 * Persists comparison records to oracle_comparisons table.
 */
export async function persistComparisons(records: OracleComparisonRecord[]): Promise<void> {
  if (records.length === 0) return
  for (const r of records) {
    await pgPool.query(
      `INSERT INTO oracle_comparisons (
         network, asset, oracle, lens_price, oracle_price, deviation_pct,
         status, venues, sample_count, oracle_timestamp, age_seconds, timestamp
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        r.network,
        r.asset,
        r.oracle,
        r.lensPrice,
        r.oraclePrice,
        r.deviationPct,
        r.status,
        r.venues,
        r.sampleCount,
        r.oracleTimestamp,
        r.ageSeconds,
        r.timestamp,
      ]
    )
  }
}

/**
 * Compares the Lens VWAP for an asset against every configured oracle.
 * Returns null when there is neither a Lens price nor a configured oracle,
 * which callers map to their own "not found" response.
 *
 * Persists comparison observations to oracle_comparisons for historical tracking.
 */
export async function compareOracles(
  assetCode: string,
  network: NetworkName,
  adapters: OracleAdapter[],
  options: CompareOraclesOptions = { persist: true }
): Promise<OracleComparison | null> {
  const [lensResult, sources] = await Promise.all([
    fetchLensPrice(assetCode, network),
    Promise.all(adapters.map(adapter => fetchSource(adapter, assetCode, network))),
  ])

  const lensPrice = lensResult.price
  if (lensPrice === null && !sources.some(source => source.status !== 'not_configured')) {
    return null
  }

  const now = Date.now()
  const oracles = sources.map(source => ({
    name: source.name,
    price: source.quote?.price ?? null,
    timestamp: source.quote ? new Date(source.quote.timestamp * 1000).toISOString() : null,
    deviationPct: deviationPct(lensPrice, source.quote?.price ?? null),
    status: source.status,
    ageSeconds: source.quote ? Math.max(0, Math.floor(now / 1000 - source.quote.timestamp)) : null,
  }))
  const reflector = sources.find(source => source.name === 'reflector')
  const reflectorPrice = reflector?.quote?.price ?? null
  const reflectorDeviation = deviationPct(lensPrice, reflectorPrice)

  if (options.persist !== false) {
    const recordsToPersist: OracleComparisonRecord[] = oracles.map(o => ({
      network,
      asset: assetCode,
      oracle: o.name,
      lensPrice,
      oraclePrice: o.price,
      deviationPct: o.deviationPct,
      status: o.status,
      venues: lensResult.venues,
      sampleCount: lensResult.sampleCount,
      oracleTimestamp: o.timestamp ? new Date(o.timestamp) : null,
      ageSeconds: o.ageSeconds,
      timestamp: new Date(now),
    }))
    try {
      await persistComparisons(recordsToPersist)
    } catch {
      // Persistence failure must not fail the live comparison read
    }
  }

  return {
    asset: assetCode,
    network,
    lens: lensPrice,
    // Keep the original fields while clients migrate to the multi-oracle list.
    reflector: reflectorPrice,
    deviationPct: reflectorDeviation,
    status: deviationStatus(reflectorDeviation),
    fetchedAt: new Date(now).toISOString(),
    oracles,
  }
}

/**
 * Queries historical comparisons from oracle_comparisons table.
 */
export async function queryOracleComparisonHistory(
  options: QueryHistoryOptions
): Promise<OracleHistoryPoint[]> {
  const { asset, network, oracle, from, to, limit = 1000 } = options
  const params: unknown[] = [network, asset, from, to]
  let sql = `
    SELECT
      id,
      network,
      asset,
      oracle,
      lens_price::float AS lens_price,
      oracle_price::float AS oracle_price,
      deviation_pct::float AS deviation_pct,
      status,
      venues,
      sample_count,
      oracle_timestamp,
      age_seconds,
      timestamp
    FROM oracle_comparisons
    WHERE network = $1
      AND asset = $2
      AND timestamp >= $3
      AND timestamp <= $4
  `
  if (oracle) {
    params.push(oracle)
    sql += ` AND oracle = $${params.length}`
  }
  params.push(limit)
  sql += ` ORDER BY timestamp ASC LIMIT $${params.length}`

  const result = await pgPool.query(sql, params)
  return result.rows.map(row => ({
    id: row.id,
    timestamp: new Date(row.timestamp).toISOString(),
    oracle: row.oracle,
    lensPrice: row.lens_price !== null && row.lens_price !== undefined ? Number(row.lens_price) : null,
    oraclePrice: row.oracle_price !== null && row.oracle_price !== undefined ? Number(row.oracle_price) : null,
    deviationPct: row.deviation_pct !== null && row.deviation_pct !== undefined ? Number(row.deviation_pct) : null,
    status: row.status,
    venues: Array.isArray(row.venues) ? row.venues : [],
    sampleCount: Number(row.sample_count) || 0,
    oracleTimestamp: row.oracle_timestamp ? new Date(row.oracle_timestamp).toISOString() : null,
    ageSeconds: row.age_seconds !== null && row.age_seconds !== undefined ? Number(row.age_seconds) : null,
  }))
}

/**
 * Computes window summary statistics per oracle over a set of historical comparison points.
 */
export function computeOracleSummaryStatistics(
  points: OracleHistoryPoint[],
  bandPct: number,
  windowStart: Date,
  windowEnd: Date
): OracleSummaryStatistic[] {
  const byOracle = new Map<string, OracleHistoryPoint[]>()
  for (const p of points) {
    const list = byOracle.get(p.oracle) ?? []
    list.push(p)
    byOracle.set(p.oracle, list)
  }

  const results: OracleSummaryStatistic[] = []
  for (const [oracle, oraclePoints] of byOracle.entries()) {
    oraclePoints.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    const validDeviations = oraclePoints
      .map(p => p.deviationPct)
      .filter((d): d is number => d !== null && Number.isFinite(d))

    const allVenues = Array.from(new Set(oraclePoints.flatMap(p => p.venues)))
    const oldest = oraclePoints.length > 0 ? oraclePoints[0].timestamp : null
    const freshest = oraclePoints.length > 0 ? oraclePoints[oraclePoints.length - 1].timestamp : null

    if (validDeviations.length === 0) {
      results.push({
        oracle,
        meanDeviationPct: null,
        worstDeviationPct: null,
        timeOutsideBandSeconds: null,
        outsideBandSeconds: null,
        outsideBandPct: null,
        bandPct,
        samples: oraclePoints.length,
        venues: allVenues,
        freshestComparison: freshest,
        oldestComparison: oldest,
        status: oraclePoints.some(p => p.status === 'unreachable') ? 'unreachable' : 'insufficient_data',
      })
      continue
    }

    const mean = validDeviations.reduce((sum, v) => sum + v, 0) / validDeviations.length
    const meanDeviationPct = parseFloat(mean.toFixed(4))
    const worstDeviationPct = parseFloat(Math.max(...validDeviations).toFixed(4))

    let outsideSeconds = 0
    for (let i = 0; i < oraclePoints.length; i++) {
      const p = oraclePoints[i]
      const dev = p.deviationPct
      const isOutside = dev !== null && dev > bandPct
      if (isOutside) {
        const ptTime = new Date(p.timestamp).getTime()
        let nextTime: number
        if (i < oraclePoints.length - 1) {
          nextTime = new Date(oraclePoints[i + 1].timestamp).getTime()
        } else {
          nextTime = Math.min(Date.now(), windowEnd.getTime())
        }
        const durationSec = Math.max(0, Math.floor((nextTime - ptTime) / 1000))
        outsideSeconds += durationSec
      }
    }

    const totalWindowSeconds = Math.max(1, Math.floor((windowEnd.getTime() - windowStart.getTime()) / 1000))
    const outsideBandPct = parseFloat(Math.min(100, (outsideSeconds / totalWindowSeconds) * 100).toFixed(2))

    const latestPoint = oraclePoints[oraclePoints.length - 1]
    const currentStatus =
      latestPoint.status === 'unreachable' || latestPoint.status === 'empty'
        ? latestPoint.status
        : deviationStatus(latestPoint.deviationPct)

    results.push({
      oracle,
      meanDeviationPct,
      worstDeviationPct,
      timeOutsideBandSeconds: outsideSeconds,
      outsideBandSeconds: outsideSeconds,
      outsideBandPct,
      bandPct,
      samples: oraclePoints.length,
      venues: allVenues,
      freshestComparison: freshest,
      oldestComparison: oldest,
      status: currentStatus,
    })
  }

  return results
}
