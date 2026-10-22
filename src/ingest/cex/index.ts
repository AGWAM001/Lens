/**
 * CEX Adapter Interface
 *
 * Defines the contract every centralized-exchange adapter must satisfy.
 * Concrete adapters (Coinbase, Binance, Kraken, …) implement CexAdapter and
 * are registered via createCexAdapter so callers stay exchange-agnostic.
 *
 * Issue: #99
 */

import { CoinbaseAdapter, type CoinbaseAdapterOptions } from './coinbase'

export { CoinbaseAdapter, type CoinbaseAdapterOptions } from './coinbase'

/** Best bid/ask + last-trade snapshot for a single trading pair. */
export interface CexTicker {
  /** Exchange-normalized pair identifier, e.g. "XLM/USDC". */
  pair: string
  bid: number
  ask: number
  /** Price of the most recent trade. */
  last: number
  /** 24 h base-asset volume. */
  baseVolume: number
  /** 24 h quote-asset volume. */
  quoteVolume: number
  timestamp: Date
}

/** Single resting order in the order book. */
export interface CexOrderBookLevel {
  price: number
  quantity: number
}

/** Aggregated order book snapshot. */
export interface CexOrderBook {
  pair: string
  bids: CexOrderBookLevel[]
  asks: CexOrderBookLevel[]
  timestamp: Date
}

/**
 * Every CEX adapter must implement this interface.
 *
 * Adapters are stateless fetch wrappers — they must not cache or store data
 * themselves; caching is the caller's responsibility.
 */
export interface CexAdapter {
  /** Human-readable exchange identifier used in logs and metrics labels. */
  readonly name: string

  /**
   * Distinct `source` tag written on any price derived from this exchange, so
   * a CEX number is never blended with — or mistaken for — an on-chain one
   * (SDEX, AMM, oracle). Adapters that produce price rows must set this; it is
   * deliberately separate from `name` (a label) so the persisted lineage string
   * can stay stable even if display names change.
   */
  readonly source?: string

  /**
   * Fetch the latest ticker for a trading pair.
   * Returns null when the pair is unknown or the exchange is unreachable.
   */
  fetchTicker(base: string, quote: string): Promise<CexTicker | null>

  /**
   * Fetch an order book snapshot.
   * Optional — adapters that do not expose an order book may omit this method.
   *
   * @param depth Maximum number of levels on each side (default 20).
   */
  fetchOrderBook?(base: string, quote: string, depth?: number): Promise<CexOrderBook | null>
}

/**
 * Registry of all registered adapters, keyed by name.
 * Populated via registerCexAdapter; consumed via getCexAdapter / getAllCexAdapters.
 */
const _registry = new Map<string, CexAdapter>()

/** Register a CEX adapter so it can be retrieved by name. */
export function registerCexAdapter(adapter: CexAdapter): void {
  _registry.set(adapter.name, adapter)
}

/** Retrieve a registered adapter by exchange name, or undefined if not found. */
export function getCexAdapter(name: string): CexAdapter | undefined {
  return _registry.get(name)
}

/** Return every registered adapter. */
export function getAllCexAdapters(): CexAdapter[] {
  return [..._registry.values()]
}

/**
 * Construction options accepted by a CEX adapter factory. Concrete adapters
 * narrow this to their own option type; callers pass an opaque bag so
 * `createCexAdapter` stays exchange-agnostic.
 */
export type CexAdapterOptions = Record<string, unknown>

/** Builds an adapter instance from an options bag. */
export type CexAdapterFactory = (options?: CexAdapterOptions) => CexAdapter

/**
 * Factories keyed by lowercase exchange name. Populated via
 * registerCexAdapterFactory; consumed via createCexAdapter. Separating the
 * factory from the instance lets callers construct-and-register an adapter
 * without importing the concrete exchange module.
 */
const _factories = new Map<string, CexAdapterFactory>()

/** Register a constructor for an exchange so createCexAdapter can build it. */
export function registerCexAdapterFactory(name: string, factory: CexAdapterFactory): void {
  _factories.set(name.toLowerCase(), factory)
}

/**
 * Build the adapter for `name`, register it, and return it. This is the
 * exchange-agnostic entry point referenced in the module header: callers ask
 * for an exchange by name and receive a live, registered CexAdapter without
 * importing any concrete adapter.
 *
 * @throws when no factory is registered for the requested exchange.
 */
export function createCexAdapter(name: string, options?: CexAdapterOptions): CexAdapter {
  const factory = _factories.get(name.toLowerCase())
  if (!factory) {
    throw new Error(`No CEX adapter registered for exchange "${name}"`)
  }
  const adapter = factory(options)
  registerCexAdapter(adapter)
  return adapter
}

// The Coinbase adapter is the reference concrete implementation. Importing it
// here registers its factory as a side effect, so createCexAdapter('coinbase')
// works for any caller that imports this module. New exchanges follow the same
// pattern: export the class, then registerCexAdapterFactory it above.
registerCexAdapterFactory('coinbase', (options) => new CoinbaseAdapter(options as CoinbaseAdapterOptions))

