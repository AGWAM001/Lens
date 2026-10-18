import { Asset } from '@stellar/stellar-sdk'
import { activeNetwork, type NetworkName } from '../config'
import { getHorizonServer, resetNetworkClients } from '../network/clients'
import type { AssetId, RouteInfo } from '../types'
import { pgPool } from '../db'
import { calculateAMMSpotPrice } from '../pricing/depth'

function assetIdToStellar(asset: AssetId) {
  if (!asset.issuer) return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

// AMM pricing is per-network on both legs of the lookup: the pool_snapshots
// scan and the price_points subquery that names which pools hold this pair.
// Pool ids are only unique within a network, so filtering just the outer scan
// would happily price a mainnet pair off a testnet pool's reserves.
async function getAMMPrice(
  pairKey: string,
  amount: number,
  network: NetworkName
): Promise<{ price: number; spotPrice: number }> {
  // Get latest pool snapshot via pool_id (pairKey indexes price_points correctly)
  const result = await pgPool.query(
    `SELECT DISTINCT ON (ps.pool_id) ps.reserve_a, ps.reserve_b, ps.fee_bp
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
  if (!result.rows[0]) return { price: 0, spotPrice: 0 }

  const { reserve_a, reserve_b, fee_bp } = result.rows[0]
  const rA = parseFloat(reserve_a)
  const rB = parseFloat(reserve_b)
  const fee = 1 - (parseInt(fee_bp) / 10000)

  // Constant product formula: output = (reserveB * amount * fee) / (reserveA + amount * fee)
  const effectiveInput = amount * fee
  const output = (rB * effectiveInput) / (rA + effectiveInput)
  // spotPrice is the reserve-ratio marginal price (no size, no fee); price is
  // the average execution price for `amount` on the constant-product curve.
  return { price: output / amount, spotPrice: calculateAMMSpotPrice(rA, rB) }
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
): Promise<number> {
  try {
    const stellarAssetA = assetIdToStellar(assetA)
    const stellarAssetB = assetIdToStellar(assetB)
    const paths = await getHorizonServer(network)
      .strictSendPaths(stellarAssetA, amount.toString(), [stellarAssetB])
      .call()
    if (paths.records.length === 0) return 0
    const best = paths.records[0]
    return parseFloat(best.destination_amount) / amount
  } catch (err) {
    return 0
  }
}

export async function getBestRoute(
  assetA: AssetId,
  assetB: AssetId,
  pairKey: string,
  amount: number = 1000,
  network: NetworkName = activeNetwork
): Promise<RouteInfo> {
  const [sdexPrice, amm] = await Promise.all([
    getSDEXPrice(assetA, assetB, amount, network),
    getAMMPrice(pairKey, amount, network),
  ])
  const ammPrice = amm.price

  let route: RouteInfo['route'] = 'UNKNOWN'
  let estimatedOutput = 0
  let recommendation = 'Insufficient liquidity data'

  if (sdexPrice === 0 && ammPrice === 0) {
    throw new Error("No pricing data available")
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

  // Slippage is the shortfall of the execution price against the spot of the
  // venue actually being traded on. For an AMM route that is the pool's
  // reserve-ratio price, which does not depend on trade size (the old code
  // compared the execution price with itself, so it was always 0). SDEX and
  // SPLIT routes have no size-independent reference, so they report 0 — the
  // AMM's spot is a different venue and would turn a cross-venue spread into
  // a made-up slippage figure. An execution price at or above spot is not
  // slippage, hence the clamp.
  const spotPrice = route === 'AMM' ? amm.spotPrice : 0
  const executionPrice = amount > 0 ? estimatedOutput / amount : 0
  const slippagePct =
    spotPrice > 0 ? Math.max(0, ((spotPrice - executionPrice) / spotPrice) * 100) : 0

  return { route, sdexPrice, ammPrice, estimatedOutput, slippagePct, recommendation }
}
