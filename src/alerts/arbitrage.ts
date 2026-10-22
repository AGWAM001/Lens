export interface CrossVenueArbitrageOptions {
  /** Size of the trade evaluated to close the opportunity (defaults to 0 or target trade size) */
  size?: number
  /** SDEX fee rate as a fraction (e.g., 0 for no fee, 0.001 for 10 bps). Default: 0 */
  sdexFeeRate?: number
  /** AMM fee rate as a fraction (e.g., 0.003 for 30 bps pool fee). Default: 0.003 (30 bps) */
  ammFeeRate?: number
  /** Direct override for total fees across both legs as a fraction */
  fees?: number
  /** Slippage rate / price impact slope per unit size (default: 0.0001, or 1 bp per 100 units). */
  slippageRate?: number
  /** Direct override for total slippage incurred at the given size as a fraction */
  slippage?: number
  /** Liquidity depth used to calculate slippage rate as 1 / liquidity */
  liquidity?: number
}

export interface CrossVenueAlertPayload {
  sdexPrice: number
  ammPrice: number
  diffPct: number
  grossSpread: number
  netSpread: number
  sdexFee: number
  ammFee: number
  fees: number
  slippage: number
  breakEvenSize: number
  size: number
}

export interface CrossVenueArbitrageResult {
  grossSpread: number
  netSpread: number
  sdexFee: number
  ammFee: number
  fees: number
  slippage: number
  breakEvenSize: number
  size: number
  isNetPositive: boolean
}

export function calculateCrossVenueArbitrage(
  sdexPrice: number,
  ammPrice: number,
  options: CrossVenueArbitrageOptions = {}
): CrossVenueArbitrageResult | null {
  if (!Number.isFinite(sdexPrice) || !Number.isFinite(ammPrice)) return null
  if (sdexPrice <= 0 || ammPrice <= 0) return null

  const grossSpread = Math.abs(sdexPrice - ammPrice) / Math.max(sdexPrice, ammPrice)

  const sdexFee = options.sdexFeeRate ?? 0
  const ammFee = options.ammFeeRate ?? 0.003
  const fees = options.fees !== undefined ? options.fees : (sdexFee + ammFee)

  const size = options.size ?? 0
  const slippageRate =
    options.slippageRate ?? (options.liquidity && options.liquidity > 0 ? 1 / options.liquidity : 0.0001)

  const slippage = options.slippage !== undefined ? options.slippage : size * slippageRate
  const netSpread = grossSpread - fees - slippage

  let breakEvenSize: number
  if (grossSpread <= fees) {
    breakEvenSize = 0
  } else {
    const effectiveSlippageRate =
      options.slippage !== undefined && size > 0 ? options.slippage / size : slippageRate

    if (effectiveSlippageRate > 0) {
      breakEvenSize = (grossSpread - fees) / effectiveSlippageRate
    } else {
      breakEvenSize = Infinity
    }
  }

  return {
    grossSpread,
    netSpread,
    sdexFee,
    ammFee,
    fees,
    slippage,
    breakEvenSize,
    size,
    isNetPositive: netSpread > 0,
  }
}

export function checkCrossVenueDivergence(
  sdexPrice: number,
  ammPrice: number,
  threshold: number = 0.05,
  onAlert: (payload: CrossVenueAlertPayload) => void = () => {},
  options: CrossVenueArbitrageOptions = {}
): boolean {
  const result = calculateCrossVenueArbitrage(sdexPrice, ammPrice, options)
  if (!result) return false

  const effectiveThreshold = threshold > 0 ? threshold : 0
  if (result.netSpread > effectiveThreshold) {
    onAlert({
      sdexPrice,
      ammPrice,
      diffPct: result.grossSpread,
      grossSpread: result.grossSpread,
      netSpread: result.netSpread,
      sdexFee: result.sdexFee,
      ammFee: result.ammFee,
      fees: result.fees,
      slippage: result.slippage,
      breakEvenSize: result.breakEvenSize,
      size: result.size,
    })
    return true
  }

  return false
}
