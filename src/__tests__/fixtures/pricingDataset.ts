import type { NetworkName } from '../../config'

/**
 * Hand-sized deterministic market fixture shared by pricing regression tests.
 * Times are fixed so expected OHLC/TWAP values do not depend on wall-clock time.
 */
export const PRICING_PAIR = 'XLM/USDC'
export const PRICING_START = new Date('2026-01-01T00:00:00.000Z')

export interface FixturePricePoint {
  network: NetworkName
  pairKey: string
  source: 'SDEX' | 'AMM'
  price: number
  baseVolume: number
  timestamp: Date
}

export const PRICING_POINTS: FixturePricePoint[] = [
  // Testnet intentionally has a two-minute gap between 00:01 and 00:03.
  { network: 'testnet', pairKey: PRICING_PAIR, source: 'SDEX', price: 10, baseVolume: 2, timestamp: new Date(PRICING_START) },
  { network: 'testnet', pairKey: PRICING_PAIR, source: 'SDEX', price: 12, baseVolume: 3, timestamp: new Date(PRICING_START.getTime() + 60_000) },
  { network: 'testnet', pairKey: PRICING_PAIR, source: 'AMM', price: 8, baseVolume: 5, timestamp: new Date(PRICING_START.getTime() + 180_000) },
  { network: 'mainnet', pairKey: PRICING_PAIR, source: 'SDEX', price: 20, baseVolume: 1, timestamp: new Date(PRICING_START) },
  { network: 'mainnet', pairKey: PRICING_PAIR, source: 'AMM', price: 22, baseVolume: 1, timestamp: new Date(PRICING_START.getTime() + 60_000) },
  { network: 'mainnet', pairKey: PRICING_PAIR, source: 'AMM', price: 24, baseVolume: 2, timestamp: new Date(PRICING_START.getTime() + 180_000) },
]

export const PRICING_EDGE_CASES = {
  singleSample: [{ price: '15', timestamp: PRICING_START }],
  zeroVolume: [
    { price: '10', volume: '0', timestamp: PRICING_START },
    { price: '12', volume: '0', timestamp: new Date(PRICING_START.getTime() + 60_000) },
  ],
}

export const DEPTH_FIXTURE = { reserveA: 100, reserveB: 200, feeBp: 30, levels: 1, stepSize: 0.1 }
