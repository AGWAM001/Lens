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
