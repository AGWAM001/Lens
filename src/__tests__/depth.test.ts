import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('../db', () => ({
  pgPool: {
    query: (...args: any[]) => mockQuery(...args),
  },
}))

import {
  calculateAMMOutput,
  calculateAMMPrice,
  calculateAMMSpotPrice,
  calculateSlippage,
  generateAMMDepthLevels,
  getDepth,
} from '../pricing/depth'

describe('Depth and slippage calculations (#84)', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  describe('calculateAMMSpotPrice', () => {
    it('calculates correct spot price from reserves', () => {
      expect(calculateAMMSpotPrice(1000, 500)).toBe(0.5)
      expect(calculateAMMSpotPrice(500, 1000)).toBe(2)
    })

    it('returns 0 when reserveA is 0', () => {
      expect(calculateAMMSpotPrice(0, 1000)).toBe(0)
    })
  })

  describe('calculateAMMOutput', () => {
    it('calculates correct output for constant product with fees', () => {
      const reserveA = 1000
      const reserveB = 500
      const amount = 100
      const feeBp = 30 // 0.3%
      
      const output = calculateAMMOutput(reserveA, reserveB, amount, feeBp)
      
      expect(output).toBeGreaterThan(0)
      expect(output).toBeLessThan(50) // Without fees: ~45.45, with fees: less
    })

    it('handles no fees correctly', () => {
      const reserveA = 1000
      const reserveB = 500
      const amount = 100
      const feeBp = 0
      
      const output = calculateAMMOutput(reserveA, reserveB, amount, feeBp)
      
      expect(output).toBeCloseTo(45.4545, 4)
    })
  })

  describe('calculateAMMPrice', () => {
    it('calculates price per unit', () => {
      const reserveA = 1000
      const reserveB = 500
      const amount = 100
      const feeBp = 30
      
      const price = calculateAMMPrice(reserveA, reserveB, amount, feeBp)
      
      expect(price).toBeGreaterThan(0)
    })

    it('returns 0 for zero or negative amount', () => {
      expect(calculateAMMPrice(1000, 500, 0, 30)).toBe(0)
      expect(calculateAMMPrice(1000, 500, -10, 30)).toBe(0)
    })
  })

  describe('calculateSlippage against known constant-product curve', () => {
    it('verifies exact mathematical slippage on constant product curve', () => {
      // In a 1000 / 1000 pool with 0 fees, spot price = 1.0.
      // For input 100: output = 1000 * 100 / (1000 + 100) = 100000 / 1100 = 90.909090...
      // Execution price = 0.909090...
      // Expected slippage = (1 - 0.909090...) / 1 * 100 = 9.090909...%
      const spotPrice = 1.0
      const execPrice = 100000 / 1100 / 100
      const slippage = calculateSlippage(spotPrice, execPrice)
      expect(slippage).toBeCloseTo(9.0909, 3)
    })

    it('confirms that slippage increases monotonically with trade size', () => {
      const rA = 10000
      const rB = 10000
      const spot = calculateAMMSpotPrice(rA, rB) // 1.0

      const priceSmall = calculateAMMPrice(rA, rB, 10, 0)
      const priceMed = calculateAMMPrice(rA, rB, 500, 0)
      const priceLarge = calculateAMMPrice(rA, rB, 2000, 0)

      const slipSmall = calculateSlippage(spot, priceSmall)
      const slipMed = calculateSlippage(spot, priceMed)
      const slipLarge = calculateSlippage(spot, priceLarge)

      expect(slipSmall).toBeLessThan(slipMed)
      expect(slipMed).toBeLessThan(slipLarge)
    })

    it('returns 0 slippage when spot price is 0', () => {
      expect(calculateSlippage(0, 10)).toBe(0)
    })
  })

  describe('generateAMMDepthLevels', () => {
    it('generates asks and bids', () => {
      const reserveA = 1000
      const reserveB = 500
      const feeBp = 30
      
      const { asks, bids } = generateAMMDepthLevels(reserveA, reserveB, feeBp)
      
      expect(asks.length).toBe(10)
      expect(bids.length).toBe(10)
      
      // Asks (selling A for B) should have decreasing price with increasing size
      for (let i = 1; i < asks.length; i++) {
        expect(asks[i].price).toBeLessThan(asks[i-1].price)
        expect(asks[i].size).toBeGreaterThan(asks[i-1].size)
      }
      
      // Bids (buying A with B) should have increasing price with increasing size
      for (let i = 1; i < bids.length; i++) {
        expect(bids[i].price).toBeGreaterThan(bids[i-1].price)
      }
    })

    it('accepts custom numLevels and stepSize', () => {
      const reserveA = 1000
      const reserveB = 500
      const feeBp = 30
      
      const { asks, bids } = generateAMMDepthLevels(reserveA, reserveB, feeBp, 5, 0.05)
      
      expect(asks.length).toBe(5)
      expect(bids.length).toBe(5)
    })
  })

  describe('getDepth endpoint service', () => {
    it('returns empty depth response when no pools exist for pair', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })
      const depth = await getDepth('UNKNOWN/XLM', 100, 'testnet')
      expect(depth.spotPrice).toBe(0)
      expect(depth.executionPrice).toBe(0)
      expect(depth.slippagePct).toBe(0)
      expect(depth.asks).toEqual([])
      expect(depth.bids).toEqual([])
    })

    it('returns real depth and slippage when pool exists', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ reserve_a: '10000', reserve_b: '5000', fee_bp: '30' }],
      })
      const depth = await getDepth('XLM/USDC', 100, 'testnet')
      expect(depth.spotPrice).toBe(0.5)
      expect(depth.executionPrice).toBeGreaterThan(0)
      expect(depth.slippagePct).toBeGreaterThan(0)
      expect(depth.asks.length).toBe(10)
      expect(depth.bids.length).toBe(10)
    })
  })
})
