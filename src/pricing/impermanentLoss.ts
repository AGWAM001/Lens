/** Constant-product 50/50 LP divergence loss, as a percent of initial value. */
export function impermanentLossPct(startPrice: number, endPrice: number): number | null {
  if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice) || startPrice <= 0 || endPrice <= 0) {
    return null
  }
  const ratio = endPrice / startPrice
  return (2 * Math.sqrt(ratio) / (1 + ratio) - 1) * 100
}
