import { EventEmitter } from 'events'
import type { NetworkName } from './config'

export const priceEmitter = new EventEmitter()

/**
 * Emitted by every ingester after it records a new price for a pair. This is
 * the feed that backs the GraphQL `priceUpdated` subscription. It is kept
 * deliberately minimal — `{ pair, price, ts }` — so it is cheap to publish on
 * the ingester hot path and the GraphQL layer can filter purely on `pair`.
 */
export const PRICE_PUBLISHED = 'price:published'

export interface PricePublishedEvent {
  /** pairKey, e.g. "XLM:native/USDC:GA5..." */
  pair: string
  price: number
  /** ISO-8601 timestamp of when the price was recorded */
  ts: string
  /**
   * Which chain this price came from.
   *
   * Load-bearing since #117: every enabled network runs its own ingester loop
   * and they all publish to this one emitter. Without a discriminator a
   * subscriber to XLM/USDC receives testnet and mainnet prices interleaved,
   * indistinguishable, on the same stream — a chart that looks noisy rather
   * than wrong, which is the harder kind to notice.
   */
  network: NetworkName
}

/**
 * Publish a new price to all live subscribers (GraphQL `priceUpdated`).
 * Fire-and-forget: emitting is synchronous and never throws, so ingesters can
 * call it without a try/catch on their hot path.
 */
export function publishPriceUpdate(event: PricePublishedEvent): void {
  priceEmitter.emit(PRICE_PUBLISHED, event)
}
