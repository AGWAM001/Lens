import { sdexAdapter } from './sdex'
import { ammAdapter } from './amm'
import { soroswapAdapter } from './soroswap'
import { aquariusAdapter } from './aquarius'
import { defindexAdapter } from './defindex'
import { phoenixAdapter } from './phoenix'
import { kucoinAdapter, startKuCoinIngester } from './kucoin'
import { gateioAdapter, startGateioIngester } from './gateio'
import type { VenueAdapter } from './types'

export * from './types'
export * from './runner'
export * from './registry'
export { sdexAdapter, startSDEXIngester } from './sdex'
export { ammAdapter, startAMMIngester } from './amm'
export { soroswapAdapter, startSoroswapIngester } from './soroswap'
export { aquariusAdapter, startAquariusIngester } from './aquarius'
export { blendAdapter, startBlendIngester } from './blend'
export { defindexAdapter, startDeFindexIngester } from './defindex'
export { phoenixAdapter, startPhoenixIngester } from './phoenix'
export { kucoinAdapter, startKuCoinIngester } from './kucoin'
export { gateioAdapter, startGateioIngester } from './gateio'

/**
 * Registry of default baseline venue adapters.
 * Retained for backward compatibility with existing tests and route queries.
 */
export const venueAdapters: VenueAdapter[] = [
  sdexAdapter,
  ammAdapter,
  soroswapAdapter,
  aquariusAdapter,
  defindexAdapter,
  phoenixAdapter,
]

export interface VenueClassificationInfo {
  name: string
  source: string
  classification: import('./types').VenueClassification
  reasoning: string
}

/**
 * Canonical registry of venue classifications and technical reasoning.
 *
 * Every venue ingested into Lens is classified as either:
 * - 'primary': An original, independent execution venue holding its own resting
 *   liquidity (e.g. orderbook or isolated AMM pool reserves).
 * - 'aggregator': A routing or wrapper venue that executes trades against underlying
 *   primary markets (such as classic SDEX orderbooks or native AMM pools). Counting
 *   aggregator volume alongside primary venue volume double-counts the same underlying trades.
 */
export const VENUE_CLASSIFICATIONS: Record<string, VenueClassificationInfo> = {
  SDEX: {
    name: 'SDEX',
    source: 'SDEX',
    classification: 'primary',
    reasoning:
      "Stellar's native protocol-level Central Limit Order Book (CLOB). Resting limit offers match natively on the ledger, establishing independent liquidity and primary price discovery.",
  },
  AMM: {
    name: 'AMM',
    source: 'AMM',
    classification: 'primary',
    reasoning:
      'Stellar native on-chain liquidity pools (CAP-0038). Liquidity providers deposit assets directly into on-chain pools, and trades execute against constant-product pool reserves.',
  },
  soroswap_amm: {
    name: 'Soroswap',
    source: 'soroswap_amm',
    classification: 'primary',
    reasoning:
      'Automated market maker smart contracts on Soroban. Pairs hold independent pool reserves deposited directly into Soroban contract instances.',
  },
  Soroswap: {
    name: 'Soroswap',
    source: 'soroswap_amm',
    classification: 'primary',
    reasoning:
      'Automated market maker smart contracts on Soroban. Pairs hold independent pool reserves deposited directly into Soroban contract instances.',
  },
  aquarius_amm: {
    name: 'Aquarius',
    source: 'aquarius_amm',
    classification: 'aggregator',
    reasoning:
      'Aquarius operates as an aggregator/liquidity layer on Stellar, quoting and routing through underlying Stellar native AMM pools and SDEX orderbooks. Counting its trades alongside primary venues double-counts the same underlying trade executions.',
  },
  Aquarius: {
    name: 'Aquarius',
    source: 'aquarius_amm',
    classification: 'aggregator',
    reasoning:
      'Aquarius operates as an aggregator/liquidity layer on Stellar, quoting and routing through underlying Stellar native AMM pools and SDEX orderbooks. Counting its trades alongside primary venues double-counts the same underlying trade executions.',
  },
  phoenix_amm: {
    name: 'Phoenix',
    source: 'phoenix_amm',
    classification: 'primary',
    reasoning:
      'Constant-product AMM pools on Soroban. Each pool contract holds its own reserves, so trades against it are independent executions.',
  },
  Phoenix: {
    name: 'Phoenix',
    source: 'phoenix_amm',
    classification: 'primary',
    reasoning:
      'Constant-product AMM pools on Soroban. Each pool contract holds its own reserves, so trades against it are independent executions.',
  },
  defindex_vault: {
    name: 'DeFindex',
    source: 'defindex_vault',
    classification: 'aggregator',
    reasoning:
      'Yield vaults on Soroban that hold no market of their own: deposits are allocated to underlying strategies (e.g. lending pools) and the vault is priced per share. Any activity it reports is activity of the venues underneath, so it is never counted toward net volume.',
  },
  blend: {
    name: 'Blend',
    source: 'blend',
    classification: 'primary',
    reasoning:
      'Lending pools on Soroban holding their own supplied reserves. It is the venue a yield vault allocates into, not one that re-reports another venue trades. It emits no price points at all — rates go to lending_rates — so it contributes nothing to the volume totals and this classification is informational.',
  },
  Blend: {
    name: 'Blend',
    source: 'blend',
    classification: 'primary',
    reasoning:
      'Lending pools on Soroban holding their own supplied reserves. It is the venue a yield vault allocates into, not one that re-reports another venue trades. It emits no price points at all — rates go to lending_rates — so it contributes nothing to the volume totals and this classification is informational.',
  },
  DeFindex: {
    name: 'DeFindex',
    source: 'defindex_vault',
    classification: 'aggregator',
    reasoning:
      'Yield vaults on Soroban that hold no market of their own: deposits are allocated to underlying strategies (e.g. lending pools) and the vault is priced per share. Any activity it reports is activity of the venues underneath, so it is never counted toward net volume.',
  },
  KuCoin: {
    name: 'KuCoin',
    source: 'KuCoin',
    classification: 'primary',
    reasoning:
      'Centralized spot exchange order book. Independent order matching establishing external market reference prices.',
  },
  'Gate.io': {
    name: 'Gate.io',
    source: 'Gate.io',
    classification: 'primary',
    reasoning:
      'Centralized spot exchange order book. Independent order matching establishing external market reference prices.',
  },
}

/**
 * Returns the classification ('primary' | 'aggregator') for a venue by source or name.
 *
 * **The adapter is the authority, not the map above.** `classification` is a
 * required field on `VenueAdapter`, so the compiler makes a venue author state
 * it; `VENUE_CLASSIFICATIONS` is hand-maintained prose that carries the
 * reasoning. If the two ever disagree, the declaration a venue cannot be
 * written without is the one to believe — and
 * `venueAdapters.test.ts` fails the build when they do, so the disagreement is
 * caught rather than resolved silently at runtime.
 *
 * Unknown venues default to 'primary'. `price_points.source` carries values
 * with no adapter behind them (CEX feeds, for instance), and those are real
 * independent markets. The risk this leaves is a *new aggregator* nobody
 * registered being counted toward net volume; the drift test is what closes it,
 * because an aggregator must have an adapter to be ingested at all.
 */
export function getVenueClassification(sourceOrName: string): import('./types').VenueClassification {
  if (!sourceOrName) return 'primary'

  const lower = sourceOrName.toLowerCase()
  const adapter = venueAdapters.find(
    (a) => a.source.toLowerCase() === lower || a.name.toLowerCase() === lower,
  )
  if (adapter) return adapter.classification

  const match = VENUE_CLASSIFICATIONS[sourceOrName]
  if (match) return match.classification

  for (const [key, info] of Object.entries(VENUE_CLASSIFICATIONS)) {
    if (key.toLowerCase() === lower || info.name.toLowerCase() === lower || info.source.toLowerCase() === lower) {
      return info.classification
    }
  }

  return 'primary'
}

/**
 * Determines whether a venue is a primary market.
 */
export function isPrimaryVenue(sourceOrName: string): boolean {
  return getVenueClassification(sourceOrName) === 'primary'
}

/**
 * Determines whether a venue is an aggregator.
 */
export function isAggregatorVenue(sourceOrName: string): boolean {
  return getVenueClassification(sourceOrName) === 'aggregator'
}

/**
 * Retrieves the documented classification reasoning for a given venue.
 */
export function getVenueReasoning(sourceOrName: string): string | undefined {
  if (!sourceOrName) return undefined
  const match = VENUE_CLASSIFICATIONS[sourceOrName]
  if (match) return match.reasoning

  const lower = sourceOrName.toLowerCase()
  for (const [key, info] of Object.entries(VENUE_CLASSIFICATIONS)) {
    if (key.toLowerCase() === lower || info.name.toLowerCase() === lower || info.source.toLowerCase() === lower) {
      return info.reasoning
    }
  }
  return undefined
}
