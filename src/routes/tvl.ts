import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'

export interface ValuationPriceSource {
  price: number
  source: string
  timestamp: string
}

export interface PoolTvlBreakdown {
  poolId: string
  venue: string
  pairKey: string
  assetA: string
  assetB: string
  reserveA: number
  reserveB: number
  priced: boolean
  tvlUsd: number | null
  valuationSources: {
    assetA: ValuationPriceSource | null
    assetB: ValuationPriceSource | null
  }
}

export interface TvlResponse {
  network: NetworkName
  totalTvlUsd: number
  unpricedPoolsCount: number
  pricedPoolsCount: number
  venues: Record<
    string,
    {
      tvlUsd: number
      poolCount: number
      pricedPoolCount: number
      unpricedPoolCount: number
    }
  >
  byAsset: Record<
    string,
    {
      amount: number
      priceUsd: number | null
      priceSource: string | null
      tvlUsd: number | null
      priced: boolean
    }
  >
  pools: PoolTvlBreakdown[]
  computedAt: string
}

export interface TvlHistoryPoint {
  bucket: string
  tvlUsd: number
  pricedPoolsCount: number
  unpricedPoolsCount: number
}

export interface TvlHistoryResponse {
  network: NetworkName
  window: string
  interval: string
  points: TvlHistoryPoint[]
}

/**
 * Normalizes an asset identifier for pricing and grouping.
 * Maps native and variants of XLM to 'XLM'.
 */
export function normalizeAssetCode(asset: string): string {
  const code = asset.includes(':') ? asset.split(':')[0] : asset
  if (code.toLowerCase() === 'native' || code.toUpperCase() === 'XLM') {
    return 'XLM'
  }
  return code.toUpperCase()
}

/**
 * Fetches latest prices in USD for known assets on the specified network.
 * If an asset is USDC or USD, it is pegged at 1.0 with source 'STABLECOIN_PEG'.
 * Otherwise, resolves the latest price point where the asset is traded against USDC or USD.
 */
export async function getAssetUsdPrices(
  network: NetworkName
): Promise<Map<string, ValuationPriceSource>> {
  const priceMap = new Map<string, ValuationPriceSource>()

  // Native stables default to 1.0
  const nowIso = new Date().toISOString()
  priceMap.set('USDC', { price: 1.0, source: 'STABLECOIN_PEG', timestamp: nowIso })
  priceMap.set('USD', { price: 1.0, source: 'STABLECOIN_PEG', timestamp: nowIso })

  const { rows } = await pgPool.query<{
    asset_a: string
    asset_b: string
    price: string
    source: string
    timestamp: Date | string
  }>(
    `SELECT DISTINCT ON (pair_key, source)
            asset_a, asset_b, price, source, timestamp
       FROM price_points
      WHERE network = $1
      ORDER BY pair_key, source, timestamp DESC`,
    [network]
  )

  for (const row of rows) {
    const rawPrice = parseFloat(row.price)
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) continue

    const codeA = normalizeAssetCode(row.asset_a)
    const codeB = normalizeAssetCode(row.asset_b)
    const tsIso = new Date(row.timestamp).toISOString()

    // If paired with USDC or USD
    if (codeB === 'USDC' || codeB === 'USD') {
      if (!priceMap.has(codeA)) {
        priceMap.set(codeA, { price: rawPrice, source: row.source, timestamp: tsIso })
      }
    } else if (codeA === 'USDC' || codeA === 'USD') {
      if (!priceMap.has(codeB)) {
        priceMap.set(codeB, { price: 1.0 / rawPrice, source: row.source, timestamp: tsIso })
      }
    }
  }

  // Second pass: if XLM is priced, price assets paired with XLM
  const xlmPriceObj = priceMap.get('XLM')
  if (xlmPriceObj) {
    for (const row of rows) {
      const rawPrice = parseFloat(row.price)
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) continue

      const codeA = normalizeAssetCode(row.asset_a)
      const codeB = normalizeAssetCode(row.asset_b)
      const tsIso = new Date(row.timestamp).toISOString()

      if (codeB === 'XLM' && !priceMap.has(codeA)) {
        priceMap.set(codeA, {
          price: rawPrice * xlmPriceObj.price,
          source: `${row.source}->XLM`,
          timestamp: tsIso,
        })
      } else if (codeA === 'XLM' && !priceMap.has(codeB)) {
        priceMap.set(codeB, {
          price: (1.0 / rawPrice) * xlmPriceObj.price,
          source: `${row.source}->XLM`,
          timestamp: tsIso,
        })
      }
    }
  }

  return priceMap
}

export async function computeCurrentTvl(network: NetworkName): Promise<TvlResponse> {
  const prices = await getAssetUsdPrices(network)

  // 1. Fetch latest snapshot per pool in pool_snapshots (Stellar Classic AMM)
  const ammResult = await pgPool.query<{
    pool_id: string
    asset_a: string
    asset_b: string
    reserve_a: string | number
    reserve_b: string | number
    timestamp: Date | string
  }>(
    `SELECT DISTINCT ON (ps.pool_id)
            ps.pool_id, ps.asset_a, ps.asset_b,
            ps.reserve_a, ps.reserve_b, ps.timestamp
       FROM pool_snapshots ps
      WHERE ps.network = $1
      ORDER BY ps.pool_id, ps.timestamp DESC`,
    [network]
  )

  // 2. Fetch distinct pools from price_points for Soroswap and Aquarius (which tag pool_id)
  const externalPoolsResult = await pgPool.query<{
    pool_id: string
    pair_key: string
    asset_a: string
    asset_b: string
    source: string
    timestamp: Date | string
  }>(
    `SELECT DISTINCT ON (pool_id)
            pool_id, pair_key, asset_a, asset_b, source, timestamp
       FROM price_points
      WHERE network = $1
        AND source IN ('soroswap_amm', 'aquarius_amm')
        AND pool_id IS NOT NULL
      ORDER BY pool_id, timestamp DESC`,
    [network]
  )

  const poolBreakdowns: PoolTvlBreakdown[] = []

  // Add AMM pools
  for (const row of ammResult.rows) {
    const reserveA = parseFloat(String(row.reserve_a)) || 0
    const reserveB = parseFloat(String(row.reserve_b)) || 0
    const codeA = normalizeAssetCode(row.asset_a)
    const codeB = normalizeAssetCode(row.asset_b)

    const priceA = prices.get(codeA) ?? null
    const priceB = prices.get(codeB) ?? null

    const priced = priceA !== null && priceB !== null
    const tvlUsd = priced ? reserveA * priceA.price + reserveB * priceB.price : null

    poolBreakdowns.push({
      poolId: row.pool_id,
      venue: 'Stellar Classic AMM',
      pairKey: `${row.asset_a}/${row.asset_b}`,
      assetA: row.asset_a,
      assetB: row.asset_b,
      reserveA,
      reserveB,
      priced,
      tvlUsd: priced && tvlUsd !== null ? parseFloat(tvlUsd.toFixed(2)) : null,
      valuationSources: {
        assetA: priceA,
        assetB: priceB,
      },
    })
  }

  // Add Soroswap and Aquarius pools that are not in pool_snapshots
  const existingPoolIds = new Set(poolBreakdowns.map((p) => p.poolId))
  for (const row of externalPoolsResult.rows) {
    if (existingPoolIds.has(row.pool_id)) continue

    const venue = row.source === 'soroswap_amm' ? 'Soroswap' : 'Aquarius'
    const codeA = normalizeAssetCode(row.asset_a)
    const codeB = normalizeAssetCode(row.asset_b)

    const priceA = prices.get(codeA) ?? null
    const priceB = prices.get(codeB) ?? null

    // For external AMM pools without reserves snapshot, report unpriced / 0 reserve
    poolBreakdowns.push({
      poolId: row.pool_id,
      venue,
      pairKey: row.pair_key,
      assetA: row.asset_a,
      assetB: row.asset_b,
      reserveA: 0,
      reserveB: 0,
      priced: false,
      tvlUsd: null,
      valuationSources: {
        assetA: priceA,
        assetB: priceB,
      },
    })
  }

  // Aggregations
  let totalTvlUsd = 0
  let pricedPoolsCount = 0
  let unpricedPoolsCount = 0

  const venues: TvlResponse['venues'] = {}
  const byAsset: TvlResponse['byAsset'] = {}

  for (const p of poolBreakdowns) {
    if (!venues[p.venue]) {
      venues[p.venue] = {
        tvlUsd: 0,
        poolCount: 0,
        pricedPoolCount: 0,
        unpricedPoolCount: 0,
      }
    }
    venues[p.venue].poolCount++

    if (p.priced && p.tvlUsd !== null) {
      totalTvlUsd += p.tvlUsd
      pricedPoolsCount++
      venues[p.venue].tvlUsd = parseFloat((venues[p.venue].tvlUsd + p.tvlUsd).toFixed(2))
      venues[p.venue].pricedPoolCount++
    } else {
      unpricedPoolsCount++
      venues[p.venue].unpricedPoolCount++
    }

    // Asset breakdowns
    const codeA = normalizeAssetCode(p.assetA)
    const codeB = normalizeAssetCode(p.assetB)

    if (!byAsset[codeA]) {
      const srcA = prices.get(codeA)
      byAsset[codeA] = {
        amount: 0,
        priceUsd: srcA?.price ?? null,
        priceSource: srcA?.source ?? null,
        tvlUsd: null,
        priced: srcA !== undefined,
      }
    }
    byAsset[codeA].amount += p.reserveA

    if (!byAsset[codeB]) {
      const srcB = prices.get(codeB)
      byAsset[codeB] = {
        amount: 0,
        priceUsd: srcB?.price ?? null,
        priceSource: srcB?.source ?? null,
        tvlUsd: null,
        priced: srcB !== undefined,
      }
    }
    byAsset[codeB].amount += p.reserveB
  }

  // Compute final asset tvlUsd
  for (const code of Object.keys(byAsset)) {
    const item = byAsset[code]
    item.amount = parseFloat(item.amount.toFixed(7))
    if (item.priceUsd !== null) {
      item.tvlUsd = parseFloat((item.amount * item.priceUsd).toFixed(2))
    }
  }

  return {
    network,
    totalTvlUsd: parseFloat(totalTvlUsd.toFixed(2)),
    pricedPoolsCount,
    unpricedPoolsCount,
    venues,
    byAsset,
    pools: poolBreakdowns,
    computedAt: new Date().toISOString(),
  }
}

export async function computeTvlHistory(
  network: NetworkName,
  windowHours: number = 24,
  intervalMinutes: number = 60
): Promise<TvlHistoryResponse> {
  const prices = await getAssetUsdPrices(network)

  const { rows } = await pgPool.query<{
    bucket: Date | string
    pool_id: string
    asset_a: string
    asset_b: string
    reserve_a: string | number
    reserve_b: string | number
  }>(
    `SELECT date_trunc('hour', ps.timestamp) AS bucket,
            ps.pool_id, ps.asset_a, ps.asset_b,
            AVG(ps.reserve_a::numeric) AS reserve_a,
            AVG(ps.reserve_b::numeric) AS reserve_b
       FROM pool_snapshots ps
      WHERE ps.network = $1
        AND ps.timestamp >= NOW() - ($2 || ' hours')::interval
      GROUP BY date_trunc('hour', ps.timestamp), ps.pool_id, ps.asset_a, ps.asset_b
      ORDER BY bucket ASC`,
    [network, windowHours.toString()]
  )

  const bucketsMap = new Map<
    string,
    { tvlUsd: number; pricedCount: number; unpricedCount: number }
  >()

  for (const row of rows) {
    const bKey = new Date(row.bucket).toISOString()
    if (!bucketsMap.has(bKey)) {
      bucketsMap.set(bKey, { tvlUsd: 0, pricedCount: 0, unpricedCount: 0 })
    }
    const b = bucketsMap.get(bKey)!

    const codeA = normalizeAssetCode(row.asset_a)
    const codeB = normalizeAssetCode(row.asset_b)
    const priceA = prices.get(codeA)
    const priceB = prices.get(codeB)

    const reserveA = parseFloat(String(row.reserve_a)) || 0
    const reserveB = parseFloat(String(row.reserve_b)) || 0

    if (priceA && priceB) {
      b.tvlUsd += reserveA * priceA.price + reserveB * priceB.price
      b.pricedCount++
    } else {
      b.unpricedCount++
    }
  }

  const points: TvlHistoryPoint[] = []
  for (const [bucket, data] of bucketsMap.entries()) {
    points.push({
      bucket,
      tvlUsd: parseFloat(data.tvlUsd.toFixed(2)),
      pricedPoolsCount: data.pricedCount,
      unpricedPoolsCount: data.unpricedCount,
    })
  }

  return {
    network,
    window: `${windowHours}h`,
    interval: `${intervalMinutes}m`,
    points,
  }
}

export async function registerTvlRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { network?: string; history?: string; window?: string }
  }>('/tvl', { config: { public: true } }, async (req, reply) => {
    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send({ error: 'network must be one of: testnet, mainnet' })
    }
    const network: NetworkName = (requested as NetworkName) ?? req.network ?? activeNetwork

    const isHistory = req.query.history === 'true'
    if (isHistory) {
      const windowHours = parseInt(req.query.window ?? '24', 10) || 24
      const history = await computeTvlHistory(network, windowHours)
      return reply.send(history)
    }

    const tvl = await computeCurrentTvl(network)
    return reply.send(tvl)
  })
}
