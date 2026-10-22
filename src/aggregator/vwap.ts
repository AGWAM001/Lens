import { pgPool } from '../db'
import type { NetworkName } from '../config'

export const STALENESS_THRESHOLD_SECONDS = 300
export const HIGH_CONFIDENCE_MAX_AGE_SECONDS = 30
export const MEDIUM_CONFIDENCE_MAX_AGE_SECONDS = 300

/**
 * Every query in this module filters on `network`.
 *
 * `price_points` and `pool_snapshots` both carry a `network` column and index
 * it as the leading column of `(network, pair_key, timestamp)`, and the same
 * pair key exists on both chains. An unfiltered read therefore does not return
 * "the" price for a pair — it returns a volume-weighted blend of two separate
 * markets, which is a number no one traded at on either chain.
 *
 * That is why `network` is a required argument rather than an optional
 * refinement: there is no default that is correct by accident, and a caller
 * that doesn't know which chain it is quoting should refuse rather than guess.
 */
export async function calculateVWAP(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName,
  source?: 'SDEX' | 'AMM'
): Promise<number> {
  const sourceFilter = source ? `AND source = $4` : ''
  const params: (string | number)[] = [pairKey, network, windowMinutes]
  if (source) params.push(source)

  const result = await pgPool.query(
    `SELECT
       COALESCE(
         SUM(price::numeric * base_volume::numeric) / NULLIF(SUM(base_volume::numeric), 0),
         0
       ) AS vwap
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - ($3 || ' minutes')::interval
       ${sourceFilter}`,
    params
  )
  return parseFloat(result.rows[0]?.vwap ?? '0')
}

export async function calculateOHLCV(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName
): Promise<{
  open: number; high: number; low: number; close: number
  volume: number; tradeCount: number
}> {
  const result = await pgPool.query(
    `SELECT
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND network = $2
          AND timestamp > NOW() - ($3 || ' minutes')::interval
        ORDER BY timestamp ASC LIMIT 1) AS open,
       MAX(price::numeric) AS high,
       MIN(price::numeric) AS low,
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND network = $2
          AND timestamp > NOW() - ($3 || ' minutes')::interval
        ORDER BY timestamp DESC LIMIT 1) AS close,
       SUM(base_volume::numeric) AS volume,
       COUNT(*) AS trade_count
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - ($3 || ' minutes')::interval`,
    [pairKey, network, windowMinutes]
  )
  const row = result.rows[0]
  return {
    open: parseFloat(row?.open ?? '0'),
    high: parseFloat(row?.high ?? '0'),
    low: parseFloat(row?.low ?? '0'),
    close: parseFloat(row?.close ?? '0'),
    volume: parseFloat(row?.volume ?? '0'),
    tradeCount: parseInt(row?.trade_count ?? '0', 10),
  }
}

export async function getPriceChange24h(pairKey: string, network: NetworkName): Promise<number> {
  const result = await pgPool.query(
    `SELECT
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND network = $2
          AND timestamp > NOW() - INTERVAL '24 hours'
        ORDER BY timestamp ASC LIMIT 1) AS price_24h_ago,
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND network = $2
          AND timestamp > NOW() - INTERVAL '24 hours'
        ORDER BY timestamp DESC LIMIT 1) AS price_now`,
    [pairKey, network]
  )
  const row = result.rows[0]
  const ago = parseFloat(row?.price_24h_ago ?? '0')
  const now = parseFloat(row?.price_now ?? '0')
  if (ago === 0) return 0
  return ((now - ago) / ago) * 100
}

export async function getAggregatedPrice(pairKey: string, network: NetworkName): Promise<{
  price: number; sdexPrice: number; ammPrice: number
  volume24h: number; sdexVolume24h: number; ammVolume24h: number
  vwap1m: number; vwap5m: number; vwap1h: number; vwap24h: number
  priceChange24h: number; sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
  stale: boolean
}> {
  const [vwap1m, vwap5m, vwap1h, vwap24h, sdexVwap24h, priceChange24h, ammSpotResult, lastTradeResult] = await Promise.all([
    calculateVWAP(pairKey, 1, network),
    calculateVWAP(pairKey, 5, network),
    calculateVWAP(pairKey, 60, network),
    calculateVWAP(pairKey, 1440, network),
    calculateVWAP(pairKey, 1440, network, 'SDEX'),
    getPriceChange24h(pairKey, network),
    // AMM price: latest spot_price averaged across pools for this pair, on this
    // network only. Both halves of the lookup are network-filtered: the outer
    // scan of pool_snapshots, and the price_points subquery that decides which
    // pool ids count as this pair. Filtering only the outer scan would still let
    // a same-named pool on the other chain contribute its price.
    pgPool.query(
      `SELECT AVG(spot_price::numeric) AS amm_price
       FROM (
         SELECT DISTINCT ON (ps.pool_id) ps.spot_price
         FROM pool_snapshots ps
         WHERE ps.network = $2
           AND ps.pool_id IN (
             SELECT DISTINCT pool_id FROM price_points
             WHERE pair_key = $1 AND network = $2 AND source = 'AMM' AND pool_id IS NOT NULL
           )
         ORDER BY ps.pool_id, ps.timestamp DESC
       ) latest`,
      [pairKey, network]
    ),
    // Last trade timestamp
    pgPool.query(
      `SELECT MAX(timestamp) as last_trade FROM price_points
       WHERE pair_key = $1 AND network = $2`,
      [pairKey, network]
    ),
  ])

  const volResult = await pgPool.query(
    `SELECT
       source,
       SUM(base_volume::numeric) AS vol
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '24 hours'
     GROUP BY source`,
    [pairKey, network]
  )

  let sdexVolume24h = 0
  let ammVolume24h = 0
  for (const row of volResult.rows) {
    if (row.source === 'SDEX') sdexVolume24h = parseFloat(row.vol)
    else if (row.source === 'AMM') ammVolume24h = parseFloat(row.vol)
  }

  const sourcesResult = await pgPool.query(
    `SELECT COUNT(DISTINCT COALESCE(pool_id, 'sdex')) AS sources
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '1 hour'`,
    [pairKey, network]
  )

  const ammPrice = parseFloat(ammSpotResult.rows[0]?.amm_price ?? '0')
  const lastTrade = lastTradeResult.rows[0]?.last_trade
  const lastTradeAgeSeconds = lastTrade ? Math.floor((Date.now() - new Date(lastTrade).getTime()) / 1000) : null
  const sources = parseInt(sourcesResult.rows[0]?.sources ?? '0', 10)
  const volume24h = sdexVolume24h + ammVolume24h


  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'unknown'
  if (lastTradeAgeSeconds === null) {
    confidence = 'unknown'
  } else if (lastTradeAgeSeconds < HIGH_CONFIDENCE_MAX_AGE_SECONDS && sources > 1 && volume24h > 0) {
    confidence = 'high'
  } else if (lastTradeAgeSeconds < MEDIUM_CONFIDENCE_MAX_AGE_SECONDS) {
    confidence = 'medium'
  } else {
    confidence = 'low'
  }

  const stale = lastTradeAgeSeconds !== null && lastTradeAgeSeconds >= STALENESS_THRESHOLD_SECONDS

  return {
    price: vwap1h || vwap24h || ammPrice || 0,
    sdexPrice: sdexVwap24h,
    ammPrice,
    volume24h,
    sdexVolume24h,
    ammVolume24h,
    vwap1m,
    vwap5m,
    vwap1h,
    vwap24h,
    priceChange24h,
    sources,
    confidence,
    lastTradeAgeSeconds,
    stale,
  }
}
