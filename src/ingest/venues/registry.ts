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
}

/**
 * All known venue adapter registrations in the system.
 * To register an adapter in the system, add it to this list.
 */
export const registeredVenues: VenueRegistration[] = [
  {
    adapter: sdexAdapter,
    hasCredentials: () => true,
  },
  {
    adapter: ammAdapter,
    hasCredentials: () => true,
  },
  {
    adapter: soroswapAdapter,
    hasCredentials: () => true,
  },
  {
    adapter: aquariusAdapter,
    hasCredentials: () => true,
  },
  {
    adapter: defindexAdapter,
    hasCredentials: () => true,
  },
  {
    adapter: phoenixAdapter,
    hasCredentials: () => true,
  },
  {
    adapter: kucoinAdapter,
    hasCredentials: hasKuCoinCredentials,
  },
  {
    adapter: gateioAdapter,
    hasCredentials: hasGateioCredentials,
  },
]

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
