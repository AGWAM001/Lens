import { Asset } from '@stellar/stellar-sdk'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { getHorizonServer, resetNetworkClients } from '../network/clients'
import type { AssetId, RouteInfo, RouteHop, RouteOption, RouteProvenance } from '../types'
import { pgPool } from '../db'
import { calculateAMMSpotPrice } from '../pricing/depth'

function assetIdToStellar(asset: AssetId) {
  if (!asset.issuer) return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

export function assetEquals(a: AssetId, b: AssetId): boolean {
  if (a.code.toUpperCase() !== b.code.toUpperCase()) return false
  const aIss = a.issuer ?? null
  const bIss = b.issuer ?? null
  return aIss === bIss
}

export function makePairKey(a: AssetId, b: AssetId): string {
  const aStr = a.issuer ? `${a.code}:${a.issuer}` : a.code
  const bStr = b.issuer ? `${b.code}:${b.issuer}` : b.code
  return [aStr, bStr].sort().join('/')
}

interface AMMPoolInfo {
  poolId: string
  reserveA: number
  reserveB: number
  feeBp: number
  timestamp?: Date
}

// AMM pricing is per-network on both legs of the lookup: the pool_snapshots
// scan and the price_points subquery that names which pools hold this pair.
// Pool ids are only unique within a network, so filtering just the outer scan
// would happily price a mainnet pair off a testnet pool's reserves.
async function getAMMPool(
  pairKey: string,
  network: NetworkName
): Promise<AMMPoolInfo | null> {
  const result = await pgPool.query(
    `SELECT DISTINCT ON (ps.pool_id) ps.pool_id, ps.reserve_a, ps.reserve_b, ps.fee_bp, ps.timestamp
     FROM pool_snapshots ps
     WHERE ps.network = $2
       AND ps.pool_id IN (
         SELECT DISTINCT pool_id FROM price_points
         WHERE pair_key = $1 AND network = $2 AND source = 'AMM' AND pool_id IS NOT NULL
       )
     ORDER BY ps.pool_id, ps.timestamp DESC
     LIMIT 1`,
    [pairKey, network]
  )
  if (!result.rows[0]) return null

  const { pool_id, reserve_a, reserve_b, fee_bp, timestamp } = result.rows[0]
  return {
    poolId: pool_id,
    reserveA: parseFloat(reserve_a),
    reserveB: parseFloat(reserve_b),
    feeBp: parseInt(fee_bp, 10),
    timestamp: timestamp ? new Date(timestamp) : undefined,
  }
}

async function getAMMPrice(
  pairKey: string,
  amount: number,
  network: NetworkName
): Promise<{ price: number; spotPrice: number; output: number; poolId?: string; timestamp?: Date }> {
  const pool = await getAMMPool(pairKey, network)
  if (!pool || amount <= 0) return { price: 0, spotPrice: 0, output: 0 }

  const fee = 1 - pool.feeBp / 10000
  // Constant product formula: output = (reserveB * amount * fee) / (reserveA + amount * fee)
  const effectiveInput = amount * fee
  const output = (pool.reserveB * effectiveInput) / (pool.reserveA + effectiveInput)
  const price = output / amount
  const spotPrice = calculateAMMSpotPrice(pool.reserveA, pool.reserveB)

  return { price, spotPrice, output, poolId: pool.poolId, timestamp: pool.timestamp }
}

/**
 * Test-only: clears the memoised per-network Horizon clients between cases.
 * Kept as a re-export so existing tests keep their import path; the clients
 * themselves now live in network/clients.ts.
 */
export function _resetHorizonServers(): void {
  resetNetworkClients()
}

async function getSDEXPrice(
  assetA: AssetId,
  assetB: AssetId,
  amount: number,
  network: NetworkName
): Promise<{ price: number; output: number; recordCount: number }> {
  try {
    const stellarAssetA = assetIdToStellar(assetA)
    const stellarAssetB = assetIdToStellar(assetB)
    const paths = await getHorizonServer(network)
      .strictSendPaths(stellarAssetA, amount.toString(), [stellarAssetB])
      .call()
    if (!paths.records || paths.records.length === 0) return { price: 0, output: 0, recordCount: 0 }
    const best = paths.records[0]
    const destAmount = parseFloat(best.destination_amount)
    return {
      price: destAmount / amount,
      output: destAmount,
      recordCount: paths.records.length,
    }
  } catch (err) {
    return { price: 0, output: 0, recordCount: 0 }
  }
}

export interface DirectRouteResult {
  route: 'SDEX' | 'AMM' | 'SPLIT' | 'UNKNOWN'
  sdexPrice: number
  ammPrice: number
  estimatedOutput: number
  slippagePct: number
  recommendation: string
}

function computeDirectRoute(
  sdexPrice: number,
  amm: { price: number; spotPrice: number },
  amount: number
): DirectRouteResult {
  const ammPrice = amm.price
  let route: DirectRouteResult['route'] = 'UNKNOWN'
  let estimatedOutput = 0
  let recommendation = 'Insufficient liquidity data'

  if (sdexPrice === 0 && ammPrice === 0) {
    route = 'UNKNOWN'
    estimatedOutput = 0
    recommendation = 'Insufficient liquidity data'
  } else if (sdexPrice === 0) {
    route = 'AMM'
    estimatedOutput = ammPrice * amount
    recommendation = 'Only AMM liquidity available'
  } else if (ammPrice === 0) {
    route = 'SDEX'
    estimatedOutput = sdexPrice * amount
    recommendation = 'Only SDEX liquidity available'
  } else {
    const diff = Math.abs(sdexPrice - ammPrice) / Math.max(sdexPrice, ammPrice)
    if (diff < 0.001) {
      // Within 0.1% — suggest split for large orders
      route = amount > 10000 ? 'SPLIT' : (sdexPrice >= ammPrice ? 'SDEX' : 'AMM')
      estimatedOutput = Math.max(sdexPrice, ammPrice) * amount
      recommendation = 'Prices within 0.1% — either route suitable'
    } else if (sdexPrice > ammPrice) {
      route = 'SDEX'
      estimatedOutput = sdexPrice * amount
      recommendation = `SDEX offers ${((sdexPrice - ammPrice) / ammPrice * 100).toFixed(2)}% better rate`
    } else {
      route = 'AMM'
      estimatedOutput = ammPrice * amount
      recommendation = `AMM offers ${((ammPrice - sdexPrice) / sdexPrice * 100).toFixed(2)}% better rate`
    }
  }

  const spotPrice = route === 'AMM' ? amm.spotPrice : 0
  const executionPrice = amount > 0 ? estimatedOutput / amount : 0
  const slippagePct =
    spotPrice > 0 ? Math.max(0, ((spotPrice - executionPrice) / spotPrice) * 100) : 0

  return { route, sdexPrice, ammPrice, estimatedOutput, slippagePct, recommendation }
}

async function simulateHop(
  assetIn: AssetId,
  assetOut: AssetId,
  inputAmount: number,
  network: NetworkName
): Promise<{ hop: RouteHop; poolTimestamp?: Date; sdexSampleCount: number; ammSampleCount: number } | null> {
  const pairKey = makePairKey(assetIn, assetOut)
  const [sdex, amm] = await Promise.all([
    getSDEXPrice(assetIn, assetOut, inputAmount, network),
    getAMMPrice(pairKey, inputAmount, network),
  ])

  const sdexOutput = sdex.output
  const ammOutput = amm.output

  if (sdexOutput === 0 && ammOutput === 0) {
    return null
  }

  let venue: 'SDEX' | 'AMM'
  let outputAmount: number
  let price: number
  let spotPrice: number
  let slippagePct: number
  let poolId: string | undefined

  if (ammOutput > sdexOutput) {
    venue = 'AMM'
    outputAmount = ammOutput
    price = amm.price
    spotPrice = amm.spotPrice
    slippagePct = spotPrice > 0 ? Math.max(0, ((spotPrice - price) / spotPrice) * 100) : 0
    poolId = amm.poolId
  } else {
    venue = 'SDEX'
    outputAmount = sdexOutput
    price = sdex.price
    spotPrice = 0
    slippagePct = 0
  }

  return {
    hop: {
      assetIn,
      assetOut,
      venue,
      poolId,
      inputAmount,
      outputAmount,
      price,
      spotPrice,
      slippagePct,
    },
    poolTimestamp: amm.timestamp,
    sdexSampleCount: sdex.recordCount,
    ammSampleCount: amm.poolId ? 1 : 0,
  }
}

export interface RouteOptionsConfig {
  maxHops?: number
  intermediates?: AssetId[]
}

export async function getBestRoute(
  assetA: AssetId,
  assetB: AssetId,
  pairKey: string,
  amount: number = 1000,
  network: NetworkName = activeNetwork,
  routingOverrides?: RouteOptionsConfig
): Promise<RouteInfo> {
  const startTime = new Date()
  const netConfig = getNetworkConfig(network)
  const maxHops = Math.max(1, routingOverrides?.maxHops ?? netConfig.routing?.maxHops ?? 3)
  const configuredIntermediates = routingOverrides?.intermediates ?? netConfig.routing?.intermediates ?? []

  // Filter intermediates: exclude start asset and destination asset, and deduplicate
  const intermediates: AssetId[] = []
  for (const intermediate of configuredIntermediates) {
    if (!assetEquals(intermediate, assetA) && !assetEquals(intermediate, assetB)) {
      if (!intermediates.some(existing => assetEquals(existing, intermediate))) {
        intermediates.push(intermediate)
      }
    }
  }

  // 1. Direct path
  const [directSdex, directAmm] = await Promise.all([
    getSDEXPrice(assetA, assetB, amount, network),
    getAMMPrice(pairKey, amount, network),
  ])

  const directResult = computeDirectRoute(
    directSdex.price,
    { price: directAmm.price, spotPrice: directAmm.spotPrice },
    amount
  )

  let totalSampleCount = directSdex.recordCount + (directAmm.poolId ? 1 : 0)
  let latestPoolTimestamp: Date | undefined = directAmm.timestamp

  // 2. Multi-hop search up to maxHops (bounded depth >= 2)
  let bestMultiHop: RouteOption | null = null

  if (maxHops >= 2 && intermediates.length > 0) {
    interface PathState {
      currentAsset: AssetId
      currentAmount: number
      hops: RouteHop[]
      visited: AssetId[]
    }

    const queue: PathState[] = [
      {
        currentAsset: assetA,
        currentAmount: amount,
        hops: [],
        visited: [assetA],
      },
    ]

    while (queue.length > 0) {
      const state = queue.shift()!
      const currentHopDepth = state.hops.length

      if (currentHopDepth >= maxHops) continue

      // For the next hop, consider:
      // a) hopping directly to destination assetB if currentHopDepth + 1 >= 2
      // b) hopping to an intermediate if currentHopDepth + 1 < maxHops

      // Candidate next assets:
      const nextCandidates: AssetId[] = []

      // If we've made at least 1 hop, we can finish at assetB
      if (currentHopDepth >= 1) {
        nextCandidates.push(assetB)
      }

      // If we can still hop further, we can also visit remaining unvisited intermediates
      if (currentHopDepth + 1 < maxHops) {
        for (const inter of intermediates) {
          if (!state.visited.some(v => assetEquals(v, inter))) {
            nextCandidates.push(inter)
          }
        }
      }

      // Simulate hops to all candidates in parallel
      const hopSimulations = await Promise.all(
        nextCandidates.map(nextAsset =>
          simulateHop(state.currentAsset, nextAsset, state.currentAmount, network)
        )
      )

      for (let i = 0; i < nextCandidates.length; i++) {
        const nextAsset = nextCandidates[i]
        const sim = hopSimulations[i]
        if (!sim) continue

        totalSampleCount += sim.sdexSampleCount + sim.ammSampleCount
        if (sim.poolTimestamp) {
          if (!latestPoolTimestamp || sim.poolTimestamp > latestPoolTimestamp) {
            latestPoolTimestamp = sim.poolTimestamp
          }
        }

        const newHops = [...state.hops, sim.hop]

        if (assetEquals(nextAsset, assetB)) {
          // Completed path to destination
          const output = sim.hop.outputAmount
          const effectivePrice = output / amount
          // Overall slippage compounded across hops
          const overallSlippagePct =
            (1 - newHops.reduce((acc, h) => acc * (1 - h.slippagePct / 100), 1)) * 100

          const option: RouteOption = {
            hops: newHops,
            hopCount: newHops.length,
            estimatedOutput: output,
            effectivePrice,
            slippagePct: Math.max(0, overallSlippagePct),
          }

          if (!bestMultiHop || option.estimatedOutput > bestMultiHop.estimatedOutput) {
            bestMultiHop = option
          }
        } else {
          // Intermediate step
          queue.push({
            currentAsset: nextAsset,
            currentAmount: sim.hop.outputAmount,
            hops: newHops,
            visited: [...state.visited, nextAsset],
          })
        }
      }
    }
  }

  // 3. Compare direct and multi-hop
  const hasDirectLiquidity = directResult.route !== 'UNKNOWN' && directResult.estimatedOutput > 0
  const hasMultiHopLiquidity = bestMultiHop !== null && bestMultiHop.estimatedOutput > 0

  if (!hasDirectLiquidity && !hasMultiHopLiquidity) {
    throw new Error('No pricing data available')
  }

  const comparison = {
    direct: {
      route: directResult.route,
      sdexPrice: directResult.sdexPrice,
      ammPrice: directResult.ammPrice,
      estimatedOutput: directResult.estimatedOutput,
      slippagePct: directResult.slippagePct,
    },
    multiHop: bestMultiHop,
  }

  const now = new Date()
  const freshnessSeconds = latestPoolTimestamp
    ? Math.max(0, Math.round((now.getTime() - latestPoolTimestamp.getTime()) / 1000))
    : null

  const provenance: RouteProvenance = {
    sampledAt: now.toISOString(),
    network,
    venuesQueried: ['SDEX', 'AMM'],
    sampleCount: totalSampleCount,
    freshnessSeconds,
  }

  // Does multi-hop beat direct?
  if (bestMultiHop && (!hasDirectLiquidity || bestMultiHop.estimatedOutput > directResult.estimatedOutput)) {
    const hopSummary = bestMultiHop.hops
      .map(h => `${h.assetIn.code}→${h.assetOut.code} via ${h.venue} (${h.slippagePct.toFixed(2)}% slip)`)
      .join(', ')

    let rec: string
    if (hasDirectLiquidity && directResult.estimatedOutput > 0) {
      const advantagePct =
        ((bestMultiHop.estimatedOutput - directResult.estimatedOutput) / directResult.estimatedOutput) * 100
      rec = `${bestMultiHop.hopCount}-hop route (${hopSummary}) is ${advantagePct.toFixed(2)}% better than direct`
    } else {
      rec = `${bestMultiHop.hopCount}-hop route (${hopSummary}) available (no direct liquidity)`
    }

    return {
      route: 'MULTI_HOP',
      sdexPrice: directResult.sdexPrice,
      ammPrice: directResult.ammPrice,
      estimatedOutput: bestMultiHop.estimatedOutput,
      slippagePct: bestMultiHop.slippagePct,
      recommendation: rec,
      network,
      hops: bestMultiHop.hops,
      comparison,
      provenance,
    }
  }

  // Direct route wins
  const directHops: RouteHop[] = []
  if (directResult.route === 'AMM' || directResult.route === 'SDEX') {
    directHops.push({
      assetIn: assetA,
      assetOut: assetB,
      venue: directResult.route,
      poolId: directAmm.poolId,
      inputAmount: amount,
      outputAmount: directResult.estimatedOutput,
      price: directResult.estimatedOutput / amount,
      spotPrice: directResult.route === 'AMM' ? directAmm.spotPrice : 0,
      slippagePct: directResult.slippagePct,
    })
  }

  let finalRecommendation = directResult.recommendation
  if (bestMultiHop && bestMultiHop.estimatedOutput > 0 && directResult.estimatedOutput > 0) {
    const diffPct =
      ((directResult.estimatedOutput - bestMultiHop.estimatedOutput) / bestMultiHop.estimatedOutput) * 100
    finalRecommendation = `${directResult.recommendation} (direct route is ${diffPct.toFixed(2)}% better than ${bestMultiHop.hopCount}-hop)`
  }

  return {
    route: directResult.route,
    sdexPrice: directResult.sdexPrice,
    ammPrice: directResult.ammPrice,
    estimatedOutput: directResult.estimatedOutput,
    slippagePct: directResult.slippagePct,
    recommendation: finalRecommendation,
    network,
    hops: directHops,
    comparison,
    provenance,
  }
}
