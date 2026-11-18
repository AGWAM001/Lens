import type { NetworkName } from '../../config'
import type { WatchedPair } from '../../types'

export type SourceTimeSemantic = 'ledger_close' | 'exchange_timestamp' | 'contract_timestamp'

export type SourceTimeCapability =
  | { readonly status: 'provided'; readonly semantic: SourceTimeSemantic }
  | { readonly status: 'unavailable'; readonly semantic?: never }

export interface VenuePricePoint {
  network?: string
  assetA: string
  assetB: string
  pairKey: string
  source: string
  poolId?: string
  price: number
  baseVolume: number
  counterVolume: number
  ledger: number
  observedAt: Date
  sourceTime: Date | null
  /** @deprecated use observedAt or sourceTime */
  timestamp?: Date
  eventId?: string
}

export type VenueClassification = 'primary' | 'aggregator'

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
  readonly sourceTimeCapability: SourceTimeCapability
  readonly classification: VenueClassification
  /** Kind is descriptive metadata used by API projections, not the runner. */
  readonly kind?: VenueKind

  /**
   * How this venue is described in the README's generated venue table (#229):
   * `type` is the market structure ('Order Book', 'Liquidity Pool', ...) and
   * `description` is the one-line explanation a reader needs.
   *
   * Both are **required**, which is the point. The table used to be hand-written
   * and was already out of date; generating it from the registry only fixes that
   * if a new adapter cannot be registered without describing itself. Optional
   * fields with a fallback would grow a row that reads as documented and says
   * nothing - the same drift in a new place.
   */
  readonly type: string
  readonly description: string

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
   *
   * `signal` is the cycle deadline's AbortSignal (issue #351): adapters check
   * it at their checkpoints — before starting a unit's writes, and via
   * `fetchWithTimeout({ signal })` for outbound HTTP — so an abandoned cycle
   * stops at a unit boundary and its writes are never torn. It is optional to
   * stay compatible with adapters (and tests) that have no I/O to cancel.
   */
  ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void>

  /**
   * Resets internal in-memory state (such as last-price cache) for testing.
   */
  _resetLastPrice?(): void

  /**
   * Gets the last seen price for threshold/webhook tracking.
   */
  _getLastPrice?(network: NetworkName, pairKey: string): number | undefined
}
