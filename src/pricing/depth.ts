import { pgPool } from '../db'
import { activeNetwork, NetworkName } from '../config'

export interface DepthLevel {
  price: number
  size: number
}

export interface DepthResult {
  spotPrice: number
  executionPrice: number
  slippagePct: number
  asks: DepthLevel[]
  bids: DepthLevel[]
  source: 'AMM' | 'SDEX' | 'BOTH'
}

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
  stepSize: number = 0.01
): { asks: DepthLevel[]; bids: DepthLevel[] } {
  const asks: DepthLevel[] = []
  const bids: DepthLevel[] = []

  // Generate asks (selling asset A for B) — price is B per A
  for (let i = 1; i <= numLevels; i++) {
    const amountA = reserveA * stepSize * i
    const price = calculateAMMPrice(reserveA, reserveB, amountA, feeBp)
    asks.push({ price, size: amountA })
  }

  // Generate bids (buying asset A with B)
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

export async function getAMMDepth(
  pairKey: string,
  amount: number,
  network: NetworkName = activeNetwork
): Promise<DepthResult | null> {
  // Always network-scoped. `network` defaults to `activeNetwork`, so there is
  // no caller that can ask for an unscoped read — which is the point: these
  // tables carry rows for every network the process indexes, and an unfiltered
  // read mixed testnet reserves into a mainnet depth answer.
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

  const { reserve_a, reserve_b, fee_bp } = result.rows[0]
  const rA = parseFloat(reserve_a)
  const rB = parseFloat(reserve_b)
  const feeBp = parseInt(fee_bp ?? '30', 10)

  const spotPrice = calculateAMMSpotPrice(rA, rB)
  const executionPrice = calculateAMMPrice(rA, rB, amount, feeBp)
  const slippagePct = calculateSlippage(spotPrice, executionPrice)
  const { asks, bids } = generateAMMDepthLevels(rA, rB, feeBp)

  return {
    spotPrice,
    executionPrice,
    slippagePct,
    asks,
    bids,
    source: 'AMM',
  }
}

export async function getDepth(
  pairKey: string,
  amount: number,
  network: NetworkName = activeNetwork
): Promise<DepthResult> {
  const ammDepth = await getAMMDepth(pairKey, amount, network)
  
  if (ammDepth) {
    return ammDepth
  }

  return {
    spotPrice: 0,
    executionPrice: 0,
    slippagePct: 0,
    asks: [],
    bids: [],
    source: 'AMM',
  }
}
