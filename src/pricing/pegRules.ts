import { DEFAULT_PEG_TOLERANCE_BPS, type PeggedAssetConfig } from '../config'
import type { WatchedPair, AssetId } from '../types'

/**
 * Valid peg status values reported by /snapshot and /pegs.
 */
export type PegStatus = 'on_peg' | 'off_peg' | 'no_reference' | 'no_data' | 'error'

/**
 * A pair of assets whose value is meant to hold at 1:1 against a fiat target.
 * Several issuers exist per code on Stellar; the *code* is what a peg is
 * defined against, so the check is keyed on the code and the full asset id is
 * still reported back for the entry. Anything not listed here gets
 * `no_reference` — the system never guesses that an asset is a stablecoin.
 */
export const PEGGED_ASSETS: Readonly<Record<string, string>> = {
  USDC: 'USD',
  USDT: 'USD',
  DAI: 'USD',
  USDP: 'USD',
  PYUSD: 'USD',
  TUSD: 'USD',
  USDY: 'USD',
  EURC: 'EUR',
  EURT: 'EUR',
  EUROC: 'EUR',
}

/**
 * Match an asset against network-configured pegged assets.
 */
export function matchConfiguredPeg(
  asset: { code: string; issuer?: string | null },
  configuredPegs: readonly PeggedAssetConfig[] = []
): PeggedAssetConfig | undefined {
  const normCode = asset.code.toUpperCase()
  return configuredPegs.find(
    p =>
      p.asset.code.toUpperCase() === normCode &&
      (!p.asset.issuer || !asset.issuer || p.asset.issuer === asset.issuer)
  )
}

/**
 * Determine the target currency/asset code for a given asset.
 */
export function getAssetTarget(
  asset: { code: string; issuer?: string | null },
  configuredPegs: readonly PeggedAssetConfig[] = []
): string | undefined {
  const configured = matchConfiguredPeg(asset, configuredPegs)
  return configured?.target ?? PEGGED_ASSETS[asset.code.toUpperCase()]
}

/**
 * Check whether a quote asset is a valid reference for measuring deviation from target.
 * The quote asset is a reference if:
 * 1. Its code matches the target code itself (e.g. "USD"), OR
 * 2. It is another stablecoin with target == target and targetPrice == 1 (either configured or in PEGGED_ASSETS).
 */
export function isQuoteReference(
  quote: { code: string; issuer?: string | null },
  target: string,
  configuredPegs: readonly PeggedAssetConfig[] = []
): boolean {
  const normTarget = target.toUpperCase()
  if (quote.code.toUpperCase() === normTarget) {
    return true
  }

  const quoteConfiguredPeg = matchConfiguredPeg(quote, configuredPegs)
  const quoteSiblingTarget =
    quoteConfiguredPeg && quoteConfiguredPeg.targetPrice === 1
      ? quoteConfiguredPeg.target
      : PEGGED_ASSETS[quote.code.toUpperCase()]

  return quoteSiblingTarget?.toUpperCase() === normTarget
}

/**
 * Format the standard reason when quote is not a valid reference for the target.
 */
export function getNoReferenceReason(quoteCode: string, target: string): string {
  return `quoted in ${quoteCode}, which is not ${target} or a ${target} stablecoin; deviation from ${target} is not measurable here`
}

/**
 * Compute deviation in basis points and peg status from a price reading.
 */
export function computePegStatus(
  reading: number | null,
  targetPrice: number,
  toleranceBps: number = DEFAULT_PEG_TOLERANCE_BPS
): { deviationBp: number | null; status: 'on_peg' | 'off_peg' | 'no_data'; reason: string | null } {
  if (reading == null || !Number.isFinite(reading)) {
    return {
      deviationBp: null,
      status: 'no_data',
      reason: 'no price observed for this pair',
    }
  }

  const effectiveTarget = targetPrice > 0 ? targetPrice : 1.0
  const deviationBp = ((reading - effectiveTarget) / effectiveTarget) * 10_000
  const status: 'on_peg' | 'off_peg' = Math.abs(deviationBp) <= toleranceBps ? 'on_peg' : 'off_peg'

  return {
    deviationBp,
    status,
    reason: null,
  }
}

export interface PegPairMatch {
  pair: WatchedPair
  isAssetA: boolean
  quote: AssetId
  isReference: boolean
}

/**
 * Find a watched pair suitable for measuring the pegged asset against its target.
 * Prefers pairs whose quote asset is a valid reference.
 */
export function findPegMeasuringPair(
  pegged: PeggedAssetConfig,
  pairs: readonly WatchedPair[],
  configuredPegs: readonly PeggedAssetConfig[] = []
): PegPairMatch | null {
  const normAssetCode = pegged.asset.code.toUpperCase()
  const candidates: PegPairMatch[] = []

  for (const pair of pairs) {
    const pACode = pair.assetA.code.toUpperCase()
    const pBCode = pair.assetB.code.toUpperCase()

    const matchesA =
      pACode === normAssetCode &&
      (!pegged.asset.issuer || !pair.assetA.issuer || pegged.asset.issuer === pair.assetA.issuer)

    const matchesB =
      pBCode === normAssetCode &&
      (!pegged.asset.issuer || !pair.assetB.issuer || pegged.asset.issuer === pair.assetB.issuer)

    if (matchesA) {
      const quote = pair.assetB
      const isRef = isQuoteReference(quote, pegged.target, configuredPegs)
      if (isRef) {
        return { pair, isAssetA: true, quote, isReference: true }
      }
      candidates.push({ pair, isAssetA: true, quote, isReference: false })
    } else if (matchesB) {
      const quote = pair.assetA
      const isRef = isQuoteReference(quote, pegged.target, configuredPegs)
      if (isRef) {
        return { pair, isAssetA: false, quote, isReference: true }
      }
      candidates.push({ pair, isAssetA: false, quote, isReference: false })
    }
  }

  if (candidates.length > 0) {
    return candidates[0]
  }

  return null
}
