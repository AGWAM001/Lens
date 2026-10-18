import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRICING_EDGE_CASES, PRICING_PAIR, PRICING_POINTS, PRICING_START, DEPTH_FIXTURE } from './fixtures/pricingDataset'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))

import { calculateOHLCV, calculateVWAP } from '../aggregator/vwap'
import { computeTWAP, computeVWAP } from '../pricing/twap'
import { calculateAMMSpotPrice, generateAMMDepthLevels } from '../pricing/depth'

function pointsFor(network: string) {
  return PRICING_POINTS.filter(point => point.network === network)
}

function installFixtureQuery() {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const network = String(params[1] ?? 'testnet')
    const rows = pointsFor(network)

    if (sql.includes('AS high')) {
      const sorted = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      const prices = sorted.map(row => row.price)
      return { rows: [{
        open: prices[0], high: Math.max(...prices), low: Math.min(...prices), close: prices[prices.length - 1],
        volume: String(sorted.reduce((sum, row) => sum + row.baseVolume, 0)), trade_count: String(sorted.length),
      }] }
    }

    if (sql.includes('SUM(price::numeric * base_volume::numeric)')) {
      const source = sql.includes('AND source = $4') ? String(params[3]) : undefined
      const selected = rows.filter(row => source === undefined || row.source === source)
      const volume = selected.reduce((sum, row) => sum + row.baseVolume, 0)
      const weightedPrice = selected.reduce((sum, row) => sum + row.price * row.baseVolume, 0)
      return { rows: [{ vwap: String(volume === 0 ? 0 : weightedPrice / volume) }] }
    }

    if (sql.includes('SELECT price::numeric as price, base_volume::numeric as volume')) {
      return { rows: PRICING_EDGE_CASES.zeroVolume }
    }

    if (sql.includes('SELECT price::numeric as price, timestamp')) {
      return { rows: PRICING_POINTS.filter(point => point.network === 'testnet').map(point => ({ price: String(point.price), timestamp: point.timestamp })) }
    }

    throw new Error(`Unexpected fixture query: ${sql}`)
  })
}

describe('documented deterministic pricing fixture', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    installFixtureQuery()
  })

  it('computes the hand-calculated VWAP independently on both networks', async () => {
    // testnet: (10*2 + 12*3 + 8*5) / (2+3+5) = 9.6
    // mainnet: (20*1 + 22*1 + 24*2) / (1+1+2) = 22.5
    expect(await calculateVWAP(PRICING_PAIR, 10, 'testnet')).toBe(9.6)
    expect(await calculateVWAP(PRICING_PAIR, 10, 'mainnet')).toBe(22.5)
  })

  it('computes OHLCV for the same pair without mixing networks', async () => {
    // The 00:00 / 00:01 / 00:03 testnet samples make the gap explicit.
    expect(await calculateOHLCV(PRICING_PAIR, 10, 'testnet')).toEqual({
      open: 10, high: 12, low: 8, close: 8, volume: 10, tradeCount: 3,
    })
    expect(await calculateOHLCV(PRICING_PAIR, 10, 'mainnet')).toEqual({
      open: 20, high: 24, low: 20, close: 24, volume: 4, tradeCount: 3,
    })
  })

  it('carries the last price across the two-minute gap for TWAP', async () => {
    const result = await computeTWAP(PRICING_PAIR, 10, { sampleIntervalSeconds: 60, outlierMethod: 'iqr' })
    // Samples at 00:00, 00:01 and 00:02 have prices 10, 12 and carried 12.
    // (10 + 12 + 12) / 3 = 34/3. The 00:03 endpoint has zero duration weight.
    expect(result.twap).toBeCloseTo(34 / 3, 12)
    expect(result.sampleCount).toBe(3)
  })

  it('uses the only price for a single-sample TWAP and returns zero for zero-volume VWAP', async () => {
    mockQuery.mockResolvedValueOnce({ rows: PRICING_EDGE_CASES.singleSample })
    const twap = await computeTWAP(PRICING_PAIR, 10)
    expect(twap.twap).toBe(15)

    const vwap = await computeVWAP(PRICING_PAIR, 10)
    expect(vwap.vwap).toBe(0)
    expect(vwap.volumeTotal).toBe(0)
  })

  it('matches hand-computed AMM spot and first depth levels', () => {
    const { reserveA, reserveB, feeBp, levels, stepSize } = DEPTH_FIXTURE
    const { asks, bids } = generateAMMDepthLevels(reserveA, reserveB, feeBp, levels, stepSize)
    expect(calculateAMMSpotPrice(reserveA, reserveB)).toBe(2)

    // Ask: amountA=10, effective input=9.97, output=200*9.97/(100+9.97).
    expect(asks[0].size).toBe(10)
    expect(asks[0].price).toBeCloseTo((200 * 9.97 / 109.97) / 10, 12)
    // Bid: amountB=20, effective input=19.94, amountA=100*19.94/(200+19.94).
    expect(bids[0].size).toBeCloseTo(100 * 19.94 / 219.94, 12)
    expect(bids[0].price).toBeCloseTo(20 / (100 * 19.94 / 219.94), 12)
  })
})
