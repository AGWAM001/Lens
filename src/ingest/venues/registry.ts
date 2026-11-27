/**
 * Configuration-Driven Venue Adapter Registry
 *
 * Central registry of all venue adapters (SDEX, AMM, Soroswap, Aquarius, KuCoin, Gate.io).
 * Automatically enables adapters based on environment credentials and configuration,
 * skipping unconfigured venues with a descriptive log line so that missing credentials
 * for one venue do not prevent other venues from running.
 *
 * Issue: #216
 */

import { sdexAdapter } from './sdex'
import { ammAdapter } from './amm'
import { soroswapAdapter } from './soroswap'
import { aquariusAdapter } from './aquarius'
import { defindexAdapter } from './defindex'
import { phoenixAdapter } from './phoenix'
import { kucoinAdapter, hasKuCoinCredentials } from './kucoin'
import { gateioAdapter, hasGateioCredentials } from './gateio'
import type { VenueAdapter } from './types'
import { createLogger } from '../../logger'

const log = createLogger('venues:registry')

export interface VenueRegistration {
  adapter: VenueAdapter
  hasCredentials: () => boolean
  /** Whether this registered venue is an on-chain execution venue (defaults to true for non-CEX). */
  onChain?: boolean
}

/**
 * All known venue adapter registrations in the system.
 * To register an adapter in the system, add it to this list.
 */
export const registeredVenues: VenueRegistration[] = [
  {
    adapter: sdexAdapter,
    hasCredentials: () => true,
    onChain: true,
  },
  {
    adapter: ammAdapter,
    hasCredentials: () => true,
    onChain: true,
  },
  {
    adapter: soroswapAdapter,
    hasCredentials: () => true,
    onChain: true,
  },
  {
    adapter: aquariusAdapter,
    hasCredentials: () => true,
    onChain: true,
  },
  {
    adapter: defindexAdapter,
    hasCredentials: () => true,
    onChain: true,
  },
  {
    adapter: phoenixAdapter,
    hasCredentials: () => true,
    onChain: true,
  },
  {
    adapter: kucoinAdapter,
    hasCredentials: hasKuCoinCredentials,
    onChain: false,
  },
  {
    adapter: gateioAdapter,
    hasCredentials: hasGateioCredentials,
    onChain: false,
  },
]

/**
 * Determines whether a venue adapter represents an on-chain execution venue.
 * Adapters default to not on-chain unless explicitly configured with onChain: true.
 */
export function isOnChainVenue(adapter: VenueAdapter): boolean {
  if (adapter.onChain !== undefined) return adapter.onChain
  return false
}

/**
 * Returns the distinct list of source names for on-chain venues that may
 * contribute to the on-chain price. Built dynamically from the venue registry
 * without requiring any duplicate hand-maintained lists.
 */
export function getOnChainSources(): string[] {
  const sources = new Set<string>()
  for (const reg of registeredVenues) {
    const onChain = reg.onChain !== undefined ? reg.onChain : isOnChainVenue(reg.adapter)
    if (onChain && reg.adapter.source) {
      sources.add(reg.adapter.source)
    }
  }
  return Array.from(sources).sort()
}

/**
 * Returns all adapters that have required credentials and configuration present.
 * Venues missing credentials are logged and skipped without throwing or blocking others.
 */
export function getEnabledAdapters(): VenueAdapter[] {
  const enabled: VenueAdapter[] = []
  for (const reg of registeredVenues) {
    if (!reg.hasCredentials()) {
      log.info(
        { venue: reg.adapter.name },
        'venue credentials missing in environment; adapter skipped'
      )
      continue
    }
    enabled.push(reg.adapter)
  }
  return enabled
}
