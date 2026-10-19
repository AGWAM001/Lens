import { pgPool } from '../db'
import type { NetworkName } from '../config'
import type { DecimalFormat } from '../utils/decimals'

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
export async function calculateVWAPDetailed(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName,
  source?: 'SDEX' | 'AMM'
): Promise<{ num: number; raw: string }> {
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
  const raw = String(result.rows[0]?.vwap ?? '0')
  return { num: parseFloat(raw), raw }
}

export async function calculateVWAP(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName,
  source?: 'SDEX' | 'AMM'
): Promise<number> {
  const detailed = await calculateVWAPDetailed(pairKey, windowMinutes, network, source)
  return detailed.num
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

export async function getAggregatedPrice(
  pairKey: string,
  network: NetworkName,
  options?: { decimalFormat?: DecimalFormat }
): Promise<{
  price: number | string
  sdexPrice: number | string
  ammPrice: number | string
  volume24h: number | string
  sdexVolume24h: number | string
  ammVolume24h: number | string
  vwap1m: number | string
  vwap5m: number | string
  vwap1h: number | string
  vwap24h: number | string
  priceChange24h: number | string
  sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
  stale: boolean
}> {
  const [vwap1m, vwap5m, vwap1h, vwap24h, sdexVwap24h, priceChange24h, ammSpotResult, lastTradeResult] = await Promise.all([
    calculateVWAPDetailed(pairKey, 1, network),
    calculateVWAPDetailed(pairKey, 5, network),
    calculateVWAPDetailed(pairKey, 60, network),
    calculateVWAPDetailed(pairKey, 1440, network),
    calculateVWAPDetailed(pairKey, 1440, network, 'SDEX'),
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

  let sdexVolume24hRaw = '0'
  let ammVolume24hRaw = '0'
  let sdexVolume24h = 0
  let ammVolume24h = 0
  for (const row of volResult.rows) {
    if (row.source === 'SDEX') {
      sdexVolume24hRaw = String(row.vol ?? '0')
      sdexVolume24h = parseFloat(sdexVolume24hRaw)
    } else if (row.source === 'AMM') {
      ammVolume24hRaw = String(row.vol ?? '0')
      ammVolume24h = parseFloat(ammVolume24hRaw)
    }
  }

  const sourcesResult = await pgPool.query(
    `SELECT COUNT(DISTINCT COALESCE(pool_id, 'sdex')) AS sources
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND timestamp > NOW() - INTERVAL '1 hour'`,
    [pairKey, network]
  )

  const ammPriceRaw = String(ammSpotResult.rows[0]?.amm_price ?? '0')
  const ammPrice = parseFloat(ammPriceRaw)
  const lastTrade = lastTradeResult.rows[0]?.last_trade
  const lastTradeAgeSeconds = lastTrade ? Math.floor((Date.now() - new Date(lastTrade).getTime()) / 1000) : null
  const sources = parseInt(sourcesResult.rows[0]?.sources ?? '0', 10)
  const volume24h = sdexVolume24h + ammVolume24h

  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'unknown'
  if (lastTradeAgeSeconds === null) {
    confidence = 'unknown'
  } else if (lastTradeAgeSeconds < 30 && sources > 1 && volume24h > 0) {
    confidence = 'high'
  } else if (lastTradeAgeSeconds < 300) {
    confidence = 'medium'
  } else {
    confidence = 'low'
  }

  const stale = lastTradeAgeSeconds !== null && lastTradeAgeSeconds >= 300

  const isString = options?.decimalFormat === 'string'

  if (isString) {
    const stringPrice = (vwap1h.num > 0 ? vwap1h.raw : null)
      ?? (vwap24h.num > 0 ? vwap24h.raw : null)
      ?? (ammPrice > 0 ? ammPriceRaw : null)
      ?? '0'

    return {
      price: stringPrice,
      sdexPrice: sdexVwap24h.raw,
      ammPrice: ammPriceRaw,
      volume24h: String(volume24h),
      sdexVolume24h: sdexVolume24hRaw,
      ammVolume24h: ammVolume24hRaw,
      vwap1m: vwap1m.raw,
      vwap5m: vwap5m.raw,
      vwap1h: vwap1h.raw,
      vwap24h: vwap24h.raw,
      priceChange24h: String(priceChange24h),
      sources,
      confidence,
      lastTradeAgeSeconds,
      stale,
    }
  }

  return {
    price: vwap1h.num || vwap24h.num || ammPrice || 0,
    sdexPrice: sdexVwap24h.num,
    ammPrice,
    volume24h,
    sdexVolume24h,
    ammVolume24h,
    vwap1m: vwap1m.num,
    vwap5m: vwap5m.num,
    vwap1h: vwap1h.num,
    vwap24h: vwap24h.num,
    priceChange24h,
    sources,
    confidence,
    lastTradeAgeSeconds,
    stale,
  }
}
