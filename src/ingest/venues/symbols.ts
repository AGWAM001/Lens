/**
 * Venue Symbol Registry (#755).
 *
 * Canonical mapping and resolution from stored `price_points.source` values to
 * legal on-chain Soroban symbols for SEP-40 oracle reports.
 *
 * Soroban symbols are strictly alphanumeric + underscore (`^[A-Za-z0-9_]+$`)
 * with a maximum length of 32 characters.
 */

export const VENUE_SOURCE_TO_SYMBOL: Record<string, string> = {
  SDEX: 'SDEX',
  AMM: 'AMM',
  soroswap_amm: 'soroswap_amm',
  aquarius_amm: 'aquarius_amm',
  blend: 'blend',
  defindex_vault: 'defindex_vault',
  phoenix_amm: 'phoenix_amm',
  KuCoin: 'KuCoin',
  'Gate.io': 'Gate_io',
}

/**
 * Resolves the canonical on-chain Soroban symbol for a venue source or adapter.
 * Maps 'Gate.io' -> 'Gate_io'.
 * If unknown, accepts valid alphanumeric/underscore symbols or returns null.
 */
export function resolveVenueSymbol(sourceOrName: string): string | null {
  if (!sourceOrName) return null
  if (sourceOrName in VENUE_SOURCE_TO_SYMBOL) {
    return VENUE_SOURCE_TO_SYMBOL[sourceOrName]
  }
  // If unknown, accept if it already satisfies Soroban symbol rules
  if (/^[A-Za-z0-9_]+$/.test(sourceOrName)) {
    return sourceOrName
  }
  return null
}
