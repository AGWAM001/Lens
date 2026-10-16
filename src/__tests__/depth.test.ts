import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  calculateAMMOutput,
  calculateAMMPrice,
  calculateAMMSpotPrice,
  generateAMMDepthLevels,
  calculateImpact,
} from '../pricing/depth'

describe('Depth and slippage calculations', () => {
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

  describe('calculateImpact', () => {
    it('returns standard sizes plus a liquidity-adaptive cap', () => {
      const result = calculateImpact(10_000, 5_000, 30)

      expect(result.status).toBe('ok')
      expect(result.ladder.map(point => point.size)).toEqual([100, 1_000, 5_000])
      expect(result.ladder[1].slippagePct).toBeGreaterThan(result.ladder[0].slippagePct)
      expect(result.thresholds.map(threshold => threshold.thresholdPct)).toEqual([1, 5, 10])
      expect(result.thresholds.every(threshold => threshold.crossed)).toBe(true)
      expect(result.thresholds[0].size).toBeLessThan(result.thresholds[1].size!)
    })

    it('reports a thin pair instead of fabricating a full-slippage point', () => {
      const result = calculateImpact(100, 200, 30)

      expect(result.status).toBe('insufficient_liquidity')
      expect(result.availableLiquidity).toBe(50)
      expect(result.ladder).toEqual([])
      expect(result.thresholds.every(threshold => !threshold.crossed && threshold.size === null)).toBe(true)
    })

    it('accepts caller-configured threshold levels', () => {
      const result = calculateImpact(10_000, 5_000, 30, { thresholds: [2, 100] })

      expect(result.thresholds.map(threshold => threshold.thresholdPct)).toEqual([2, 100])
      expect(result.thresholds[0].crossed).toBe(true)
      expect(result.thresholds[1].crossed).toBe(false)
    })
  })
})
