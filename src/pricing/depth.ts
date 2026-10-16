import { pgPool } from '../db'

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

export function calculateAMMOutput(reserveA: number, reserveB: number, amount: number, feeBp: number): number {
  const fee = 1 - feeBp / 10000
  const effectiveInput = amount * fee
  return (reserveB * effectiveInput) / (reserveA + effectiveInput)
}

export function calculateAMMPrice(reserveA: number, reserveB: number, amount: number, feeBp: number): number {
  const output = calculateAMMOutput(reserveA, reserveB, amount, feeBp)
  return output / amount
}

export function calculateAMMSpotPrice(reserveA: number, reserveB: number): number {
  return reserveA > 0 ? reserveB / reserveA : 0
}

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

  // Generate bids (buying asset A with B) — price is A per B, but we want B per A (inverse)
  for (let i = 1; i <= numLevels; i++) {
    const amountB = reserveB * stepSize * i
    const fee = 1 - feeBp / 10000
    const effectiveInput = amountB * fee
    const amountA = (reserveA * effectiveInput) / (reserveB + effectiveInput)
    // Price is amount of A we get per B → but we usually display bids as amount of B per A (inverse)
    // Wait no: actually for pair A/B, bids are orders to buy A with B, so the price is how much B you pay per A
    // So price = amountB / amountA
    const price = amountB / amountA
    bids.push({ price, size: amountA })
  }

  return { asks, bids }
}

export async function getAMMDepth(pairKey: string, amount: number): Promise<DepthResult | null> {
  const result = await pgPool.query(
    `SELECT DISTINCT ON (ps.pool_id) ps.reserve_a, ps.reserve_b, ps.fee_bp
     FROM pool_snapshots ps
     WHERE ps.pool_id IN (
       SELECT DISTINCT pool_id FROM price_points
       WHERE pair_key = $1 AND source = 'AMM' AND pool_id IS NOT NULL
     )
     ORDER BY ps.pool_id, ps.timestamp DESC
     LIMIT 1`,
    [pairKey]
  )
  if (!result.rows[0]) return null

  const { reserve_a, reserve_b, fee_bp } = result.rows[0]
  const rA = parseFloat(reserve_a)
  const rB = parseFloat(reserve_b)
  const feeBp = parseInt(fee_bp)

  const spotPrice = calculateAMMSpotPrice(rA, rB)
  const executionPrice = calculateAMMPrice(rA, rB, amount, feeBp)
  const slippagePct = spotPrice > 0 ? Math.abs((executionPrice - spotPrice) / spotPrice * 100) : 0
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

export async function getDepth(pairKey: string, amount: number): Promise<DepthResult> {
  const ammDepth = await getAMMDepth(pairKey, amount)
  
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
