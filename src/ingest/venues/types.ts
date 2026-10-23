import type { NetworkName } from '../../config'
import type { WatchedPair } from '../../types'

export interface VenuePricePoint {
  assetA: string
  assetB: string
  pairKey: string
  source: string
  poolId?: string
  price: number
  baseVolume: number
  counterVolume: number
  ledger: number
  timestamp: Date
  eventId?: string
}

/**
 * Universal interface for all venue adapters (SDEX, Stellar AMM, Soroswap, Aquarius, Phoenix, etc.).
 *
 * Covers:
 * - discovery: enumerate active pools, orderbooks, or tokens for a pair
 * - read: fetch raw reserves, orderbook state, or trade history from API / RPC / Horizon
 * - derive: compute spot price from invariant or calculate trade execution price
 * - write: persist price points, update indexer cursors, and dispatch events/webhooks
 */
export type VenueKind = 'orderbook' | 'amm' | 'oracle' | 'unknown'

export interface VenueAdapter<TTarget = any, TRaw = any> {
  readonly name: string
  readonly source: string
  /** Kind is descriptive metadata used by API projections, not the runner. */
  readonly kind?: VenueKind

  /**
   * Whether this venue adapter is enabled on the given network.
   */
  isEnabled(network: NetworkName): boolean

  /**
   * Polling interval in milliseconds for this venue on the given network.
   */
  getPollIntervalMs(network: NetworkName): number

  /**
   * Discovers targets (e.g. pools, market pairs) for a given watched pair.
   */
  discover(pair: WatchedPair, network: NetworkName): Promise<TTarget[]>

  /**
   * Reads raw state (reserves, trades, etc.) for a discovered target.
   */
  read(target: TTarget, pair: WatchedPair, network: NetworkName): Promise<TRaw | null>

  /**
   * Derives price points from raw data.
   */
  derive(raw: TRaw, target: TTarget, pair: WatchedPair, network: NetworkName): Promise<VenuePricePoint[]> | VenuePricePoint[]

  /**
   * Persists derived price points, updates cursors/metrics, and dispatches updates.
   */
  write(points: VenuePricePoint[], target: TTarget, pair: WatchedPair, network: NetworkName): Promise<void>

  /**
   * Optional full cycle override for a pair, if the adapter handles compound execution.
   */
  ingestPair(pair: WatchedPair, network: NetworkName): Promise<void>

  /**
   * Resets internal in-memory state (such as last-price cache) for testing.
   */
  _resetLastPrice?(): void

  /**
   * Gets the last seen price for threshold/webhook tracking.
   */
  _getLastPrice?(network: NetworkName, pairKey: string): number | undefined
}
