import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { getPoolFee, type PoolFeeOptions } from './pool-fee'

export interface DepthLevel {
  price: number
  size: number
}

export interface ExcludedPool {
  poolId: string
  reason: string
}

export interface DepthResult {
  status: 'ok'
  network: string
  pairKey: string
  spotPrice: number
  executionPrice: number
  slippagePct: number
  asks: DepthLevel[]
  bids: DepthLevel[]
  source: 'AMM'
  pool: {
    poolId: string
    feeBp: number
    feeReadAt: string
    reservesObservedAt: string
  }
  excludedPools: ExcludedPool[]
}

/**
 * No pool could price this pair: either none exists on this network, or every
 * candidate was excluded. Carries the reason and the exclusions rather than
 * zeros, so a caller can tell "no liquidity" from "a price of 0".
 */
export interface DepthUnavailable {
  status: 'unavailable'
  network: string
  pairKey: string
  reason: string
  excludedPools: ExcludedPool[]
}

/** What {@link getDepth} answers: a priced result, or a reasoned refusal. */
export type DepthOutcome = DepthResult | DepthUnavailable

export interface ImpactPoint {
  size: number
  output: number
  executionPrice: number
  slippagePct: number
}

export interface ImpactThreshold {
  thresholdPct: number
  crossed: boolean
  size: number | null
}

export interface ImpactResult {
  status: 'ok' | 'insufficient_liquidity'
  spotPrice: number
  availableLiquidity: number
  smallestSize: number
  ladder: ImpactPoint[]
  thresholds: ImpactThreshold[]
  source: 'AMM'
}

export interface ImpactOptions {
  sizes?: number[]
  thresholds?: number[]
  liquidityFraction?: number
}

/**
 * Calculates output amount for constant product AMM with fees:
 * dy = (y * dx * (1 - fee)) / (x + dx * (1 - fee))
 */
export function calculateAMMOutput(reserveA: number, reserveB: number, amount: number, feeBp: number): number {
  const fee = 1 - feeBp / 10000
  const effectiveInput = amount * fee
  return (reserveB * effectiveInput) / (reserveA + effectiveInput)
}

/**
 * Calculates execution price per unit of input:
 * executionPrice = dy / dx
 */
export function calculateAMMPrice(reserveA: number, reserveB: number, amount: number, feeBp: number): number {
  if (amount <= 0) return 0
  const output = calculateAMMOutput(reserveA, reserveB, amount, feeBp)
  return output / amount
}

/**
 * Calculates spot price from reserves:
 * spotPrice = reserveB / reserveA
 */
export function calculateAMMSpotPrice(reserveA: number, reserveB: number): number {
  return reserveA > 0 ? reserveB / reserveA : 0
}

/**
 * Build an adaptive impact curve for selling asset A into an AMM.
 *
 * The standard sizes are retained for easy comparison between pairs, while the
 * final point follows the pool's usable liquidity. We use half the A reserve
 * as the usable cap: the remaining reserve is deliberately left as a safety
 * margin because the constant-product curve becomes very steep near depletion.
 */
export function calculateImpact(
  reserveA: number,
  reserveB: number,
  feeBp: number,
  options: ImpactOptions = {},
): ImpactResult {
  const standardSizes = options.sizes ?? [100, 1_000, 10_000]
  const thresholds = [...new Set(options.thresholds ?? [1, 5, 10])].sort((a, b) => a - b)
  const liquidityFraction = options.liquidityFraction ?? 0.5
  const availableLiquidity = Math.max(0, reserveA * liquidityFraction)
  const smallestSize = standardSizes[0] ?? 0
  const spotPrice = calculateAMMSpotPrice(reserveA, reserveB)

  if (reserveA <= 0 || reserveB <= 0 || availableLiquidity < smallestSize) {
    return {
      status: 'insufficient_liquidity',
      spotPrice,
      availableLiquidity,
      smallestSize,
      ladder: [],
      thresholds: thresholds.map(thresholdPct => ({ thresholdPct, crossed: false, size: null })),
      source: 'AMM',
    }
  }

  const sizes = [...standardSizes.filter(size => size > 0 && size <= availableLiquidity)]
  if (!sizes.includes(availableLiquidity)) sizes.push(availableLiquidity)
  sizes.sort((a, b) => a - b)

  const ladder = sizes.map(size => {
    const output = calculateAMMOutput(reserveA, reserveB, size, feeBp)
    const executionPrice = output / size
    const slippagePct = spotPrice > 0 ? Math.max(0, (spotPrice - executionPrice) / spotPrice * 100) : 0
    return { size, output, executionPrice, slippagePct }
  })

  const slippageAt = (size: number) => {
    const executionPrice = calculateAMMPrice(reserveA, reserveB, size, feeBp)
    return spotPrice > 0 ? Math.max(0, (spotPrice - executionPrice) / spotPrice * 100) : 0
  }
  const thresholdResults = thresholds.map(thresholdPct => {
    if (slippageAt(availableLiquidity) < thresholdPct) {
      return { thresholdPct, crossed: false, size: null }
    }
    let low = 0
    let high = availableLiquidity
    for (let i = 0; i < 60; i++) {
      const middle = (low + high) / 2
      if (slippageAt(middle) >= thresholdPct) high = middle
      else low = middle
    }
    return { thresholdPct, crossed: true, size: high }
  })

  return { status: 'ok', spotPrice, availableLiquidity, smallestSize, ladder, thresholds: thresholdResults, source: 'AMM' }
}

export async function getAMMReserves(pairKey: string, network: NetworkName = activeNetwork): Promise<{ reserveA: number; reserveB: number; feeBp: number } | null> {
  const result = await pgPool.query(
    `SELECT DISTINCT ON (ps.pool_id) ps.reserve_a, ps.reserve_b, ps.fee_bp
     FROM pool_snapshots ps
     WHERE ps.network = $2 AND ps.pool_id IN (
       SELECT DISTINCT pool_id FROM price_points
       WHERE pair_key = $1 AND network = $2 AND source = 'AMM' AND pool_id IS NOT NULL
     )
     ORDER BY ps.pool_id, ps.timestamp DESC
     LIMIT 1`,
    [pairKey, network]
  )
  if (!result.rows[0]) return null
  return {
    reserveA: parseFloat(result.rows[0].reserve_a),
    reserveB: parseFloat(result.rows[0].reserve_b),
    feeBp: parseInt(result.rows[0].fee_bp),
  }
}

export async function getImpact(pairKey: string, options: ImpactOptions = {}, network: NetworkName = activeNetwork): Promise<ImpactResult | null> {
  const reserves = await getAMMReserves(pairKey, network)
  if (!reserves) return null
  return calculateImpact(reserves.reserveA, reserves.reserveB, reserves.feeBp, options)
}

/**
 * Calculates percentage slippage between spot price and execution price:
 * slippagePct = |executionPrice - spotPrice| / spotPrice * 100
 */
export function calculateSlippage(spotPrice: number, executionPrice: number): number {
  if (spotPrice <= 0) return 0
  return Math.abs((executionPrice - spotPrice) / spotPrice) * 100
}

/**
 * Generates discrete depth levels for constant-product pool order book simulation.
 */
export function generateAMMDepthLevels(
  reserveA: number,
  reserveB: number,
  feeBp: number,
  numLevels: number = 10,
  stepSize: number = 0.01,
): { asks: DepthLevel[]; bids: DepthLevel[] } {
  const asks: DepthLevel[] = []
  const bids: DepthLevel[] = []

  // Asks: selling asset A for B. Price is B per A.
  for (let i = 1; i <= numLevels; i++) {
    const amountA = reserveA * stepSize * i
    const price = calculateAMMPrice(reserveA, reserveB, amountA, feeBp)
    asks.push({ price, size: amountA })
  }

  // Bids: buying asset A with B. Price is B paid per A received.
  for (let i = 1; i <= numLevels; i++) {
    const amountB = reserveB * stepSize * i
    const fee = 1 - feeBp / 10000
    const effectiveInput = amountB * fee
    const amountA = (reserveA * effectiveInput) / (reserveB + effectiveInput)
    const price = amountB / amountA
    bids.push({ price, size: amountA })
  }

  return { asks, bids }
}

export async function loadLatestAmmPools(
  network: string,
  pairKey: string,
): Promise<Array<{ poolId: string; reserveA: number; reserveB: number; observedAt: Date }>> {
  // Both halves of the lookup are network-scoped: the pool_snapshots scan and
  // the price_points subquery that names which pools hold this pair. Pool ids
  // are only unique within a network, so filtering just the outer scan would
  // happily price a mainnet pair off a testnet pool's reserves.
  const result = await pgPool.query(
    `SELECT DISTINCT ON (ps.pool_id) ps.pool_id, ps.timestamp, ps.reserve_a, ps.reserve_b, ps.fee_bp
     FROM pool_snapshots ps
     WHERE ps.network = $2
       AND ps.pool_id IN (
         SELECT DISTINCT pool_id FROM price_points
         WHERE pair_key = $1 AND network = $2 AND source = 'AMM' AND pool_id IS NOT NULL
       )
     ORDER BY ps.pool_id, ps.timestamp DESC`,
    [pairKey, network],
  )
  return result.rows
    .map((r: { pool_id: string; reserve_a: string; reserve_b: string; timestamp: Date }) => ({
      poolId: r.pool_id,
      reserveA: parseFloat(r.reserve_a),
      reserveB: parseFloat(r.reserve_b),
      observedAt: r.timestamp,
    }))
    .sort((a, b) => (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0))
}

/**
 * Prices an AMM swap using each pool's own fee, read from the venue.
 *
 * Pools whose fee cannot be read, or whose reserves are empty, are excluded and
 * listed with the reason. If no pool survives, the result is "unavailable" with
 * no numbers, never zeros.
 */
export async function getDepth(
  network: string,
  pairKey: string,
  amount: number,
  feeOpts: PoolFeeOptions,
): Promise<DepthOutcome> {
  if (!(amount > 0)) {
    throw new RangeError('amount must be greater than 0')
  }

  const pools = await loadLatestAmmPools(network, pairKey)
  const excludedPools: ExcludedPool[] = []

  if (pools.length === 0) {
    return {
      status: 'unavailable',
      network,
      pairKey,
      reason: 'no AMM pool snapshots for this pair on this network',
      excludedPools,
    }
  }

  let chosen: DepthResult | null = null

  for (const pool of pools) {
    const feeRes = await getPoolFee(network, pool.poolId, feeOpts)
    if (!feeRes.ok) {
      excludedPools.push({ poolId: pool.poolId, reason: feeRes.reason })
      continue
    }
    if (!(pool.reserveA > 0 && pool.reserveB > 0)) {
      excludedPools.push({ poolId: pool.poolId, reason: 'pool has no reserves in its latest snapshot' })
      continue
    }
    if (chosen) continue // keep checking fees so every excluded pool is reported

    const { feeBp, feeReadAt } = feeRes.fee
    const spotPrice = calculateAMMSpotPrice(pool.reserveA, pool.reserveB)
    const executionPrice = calculateAMMPrice(pool.reserveA, pool.reserveB, amount, feeBp)
    const slippagePct =
      spotPrice > 0 ? Math.abs(((executionPrice - spotPrice) / spotPrice) * 100) : 0
    const { asks, bids } = generateAMMDepthLevels(pool.reserveA, pool.reserveB, feeBp)

    chosen = {
      status: 'ok',
      network,
      pairKey,
      spotPrice,
      executionPrice,
      slippagePct,
      asks,
      bids,
      source: 'AMM',
      pool: {
        poolId: pool.poolId,
        feeBp,
        feeReadAt,
        reservesObservedAt: pool.observedAt.toISOString(),
      },
      excludedPools,
    }
  }

  if (chosen) {
    chosen.excludedPools = excludedPools
    return chosen
  }

  return {
    status: 'unavailable',
    network,
    pairKey,
    reason: 'every AMM pool for this pair was excluded',
    excludedPools,
  }
}
