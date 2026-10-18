export interface RawBookLevel {
  price: number
  size: number
  venue: string
  synthetic: boolean
}

export interface BookLevel {
  price: number
  size: number
  cumulativeSize: number
  venues: string[]
  synthetic: boolean
  sampleCount: number
}

export interface AmmBookPool {
  poolId: string
  reserveA: number
  reserveB: number
  feeBp: number
}

/**
 * Build marginal price rungs for a constant-product AMM, where prices are
 * units of asset B per asset A. `depth` is a fraction around the reference
 * spot and `step` is a fraction of the relevant input reserve per rung.
 */
export function generateAmmBookLevels(
  pool: AmmBookPool,
  depth: number,
  step: number,
  spotPrice: number,
): { asks: RawBookLevel[]; bids: RawBookLevel[] } {
  const { poolId, reserveA, reserveB, feeBp } = pool
  if (
    reserveA <= 0 || reserveB <= 0 || spotPrice <= 0 ||
    !Number.isFinite(feeBp) || feeBp < 0 || feeBp >= 10_000
  ) {
    return { asks: [], bids: [] }
  }

  const feeFactor = 1 - feeBp / 10_000
  const asks: RawBookLevel[] = []
  const bids: RawBookLevel[] = []
  const maxLevels = Math.min(4096, Math.ceil(depth / step) * 4 + 16)
  const askLimit = spotPrice * (1 + depth)
  const bidLimit = spotPrice * (1 - depth)
  const venue = `AMM:${poolId}`

  // Buying A from the pool means putting B in. Each rung reports the average
  // price of the incremental output for that input step.
  let previousAOut = 0
  for (let i = 1; i <= maxLevels; i++) {
    const quoteInput = reserveB * step * i
    const effectiveInput = quoteInput * feeFactor
    const cumulativeAOut = reserveA * effectiveInput / (reserveB + effectiveInput)
    const size = cumulativeAOut - previousAOut
    if (size <= 0) break
    const price = reserveB * step / size
    if (price > askLimit) break
    asks.push({ price, size, venue, synthetic: true })
    previousAOut = cumulativeAOut
  }

  // Selling A into the pool means putting A in and taking B out.
  let previousBOut = 0
  for (let i = 1; i <= maxLevels; i++) {
    const baseInput = reserveA * step * i
    const effectiveInput = baseInput * feeFactor
    const cumulativeBOut = reserveB * effectiveInput / (reserveA + effectiveInput)
    const size = baseInput
    const price = (cumulativeBOut - previousBOut) / size
    if (price < bidLimit) break
    bids.push({ price, size, venue, synthetic: true })
    previousBOut = cumulativeBOut
  }

  return { asks, bids }
}

/**
 * Combine same-price levels of the same kind, then sort and calculate
 * cumulative base-asset size independently for asks and bids.
 */
export function aggregateBookLevels(raw: RawBookLevel[], side: 'asks' | 'bids'): BookLevel[] {
  const groups = new Map<string, Omit<BookLevel, 'cumulativeSize'>>()

  for (const level of raw) {
    if (!Number.isFinite(level.price) || level.price <= 0 || !Number.isFinite(level.size) || level.size <= 0) {
      continue
    }
    // Stellar prices have far fewer meaningful decimal places than this. The
    // key lets equivalent venue prices aggregate without changing their scale.
    const key = `${level.synthetic}:${level.price.toPrecision(12)}`
    const existing = groups.get(key)
    if (existing) {
      existing.size += level.size
      existing.sampleCount += 1
      if (!existing.venues.includes(level.venue)) existing.venues.push(level.venue)
    } else {
      groups.set(key, {
        price: level.price,
        size: level.size,
        venues: [level.venue],
        synthetic: level.synthetic,
        sampleCount: 1,
      })
    }
  }

  const sorted = [...groups.values()].sort((a, b) =>
    side === 'asks' ? a.price - b.price : b.price - a.price,
  )
  let cumulativeSize = 0
  return sorted.map(level => {
    cumulativeSize += level.size
    return { ...level, venues: level.venues.sort(), cumulativeSize }
  })
}
