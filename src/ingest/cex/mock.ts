/**
 * Mock CEX Adapter
 *
 * In-memory implementation of CexAdapter for unit tests and local development.
 * Returns deterministic, configurable data — no HTTP calls are made.
 *
 * Issue: #99
 */

import type { CexAdapter, CexOrderBook, CexTicker } from './index'

export interface MockTickerSeed {
  bid: number
  ask: number
  last: number
  baseVolume: number
  quoteVolume: number
}

const DEFAULT_SEED: MockTickerSeed = {
  bid: 0.098,
  ask: 0.102,
  last: 0.100,
  baseVolume: 1_000_000,
  quoteVolume: 100_000,
}

/**
 * MockCexAdapter satisfies CexAdapter with fully controllable responses.
 *
 * Seed data can be overridden per-pair so tests can exercise edge cases
 * (stale prices, missing pairs, order book depth limits) without touching
 * real exchange APIs.
 */
export class MockCexAdapter implements CexAdapter {
  readonly name: string
  readonly sourceTimeCapability = { status: 'provided', semantic: 'exchange_timestamp' } as const

  private readonly seeds = new Map<string, MockTickerSeed>()
  private readonly unknownPairs = new Set<string>()

  constructor(name = 'mock') {
    this.name = name
  }

  /** Override the seed data for a specific pair key (e.g. "XLM/USDC"). */
  setSeed(pair: string, seed: Partial<MockTickerSeed>): void {
    this.seeds.set(pair, { ...DEFAULT_SEED, ...seed })
  }

  /** Mark a pair as unknown so fetchTicker returns null for it. */
  markUnknown(pair: string): void {
    this.unknownPairs.add(pair)
  }

  async fetchTicker(base: string, quote: string): Promise<CexTicker | null> {
    const pair = `${base.toUpperCase()}/${quote.toUpperCase()}`
    if (this.unknownPairs.has(pair)) return null

    const seed = this.seeds.get(pair) ?? DEFAULT_SEED
    return {
      pair,
      bid: seed.bid,
      ask: seed.ask,
      last: seed.last,
      baseVolume: seed.baseVolume,
      quoteVolume: seed.quoteVolume,
      timestamp: new Date(),
    }
  }

  async fetchOrderBook(base: string, quote: string, depth = 20): Promise<CexOrderBook | null> {
    const pair = `${base.toUpperCase()}/${quote.toUpperCase()}`
    if (this.unknownPairs.has(pair)) return null

    const seed = this.seeds.get(pair) ?? DEFAULT_SEED
    const mid = (seed.bid + seed.ask) / 2

    const bids = Array.from({ length: depth }, (_, i) => ({
      price: parseFloat((seed.bid - i * 0.001).toFixed(6)),
      quantity: parseFloat(((i + 1) * 1000).toFixed(2)),
    }))

    const asks = Array.from({ length: depth }, (_, i) => ({
      price: parseFloat((seed.ask + i * 0.001).toFixed(6)),
      quantity: parseFloat(((i + 1) * 1000).toFixed(2)),
    }))

    void mid
    return { pair, bids, asks, timestamp: new Date() }
  }
}
