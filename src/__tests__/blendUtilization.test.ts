import { describe, it, expect } from 'vitest'
import {
  calcUtilization,
  deriveUtilization,
  calcInterestRates,
  deriveReserveRates,
  type BlendReserveEntry,
  type BlendReserveConfig,
  type BlendReserveData,
} from '../ingest/venues/blend'

describe('Blend Utilisation Arithmetic (#pinning)', () => {
  describe('calcUtilization', () => {
    it('returns exact ratio for typical utilization', () => {
      expect(calcUtilization(500, 1000)).toBe(0.5)
      expect(calcUtilization(750, 1000)).toBe(0.75)
      expect(calcUtilization(10, 100)).toBe(0.1)
      expect(calcUtilization(1, 3)).toBeCloseTo(1 / 3, 6)
    })

    it('returns 0 when total liabilities are 0', () => {
      expect(calcUtilization(0, 1000)).toBe(0)
      expect(calcUtilization(0n, 1000n)).toBe(0)
    })

    it('returns 0 when total supply is 0 or negative', () => {
      expect(calcUtilization(500, 0)).toBe(0)
      expect(calcUtilization(500n, 0n)).toBe(0)
      expect(calcUtilization(500, -100)).toBe(0)
      expect(calcUtilization(500n, -100n)).toBe(0)
    })

    it('returns 0 when liabilities are negative', () => {
      expect(calcUtilization(-50, 100)).toBe(0)
      expect(calcUtilization(-50n, 100n)).toBe(0)
    })

    it('returns 1.0 when liabilities equal supply (100% utilization)', () => {
      expect(calcUtilization(1000, 1000)).toBe(1.0)
      expect(calcUtilization(1000n, 1000n)).toBe(1.0)
    })

    it('caps utilization at 1.0 when liabilities exceed supply', () => {
      expect(calcUtilization(1200, 1000)).toBe(1.0)
      expect(calcUtilization(2000n, 1000n)).toBe(1.0)
    })

    it('handles BigInt amounts accurately without precision loss', () => {
      // 5 million USDC (7 decimals)
      const liabilities = 5_000_000_0000000n
      const supply = 10_000_000_0000000n
      expect(calcUtilization(liabilities, supply)).toBe(0.5)
    })

    it('handles non-finite numbers safely', () => {
      expect(calcUtilization(NaN, 1000)).toBe(0)
      expect(calcUtilization(100, NaN)).toBe(0)
      expect(calcUtilization(Infinity, 1000)).toBe(0)
      expect(calcUtilization(100, Infinity)).toBe(0)
    })
  })

  describe('deriveUtilization', () => {
    it('derives utilization from dTokens and bTokens with 12 rateDecimals (Blend v2)', () => {
      const rateDecimals = 12
      const unitRate = 10n ** 12n // 1.0 rate
      const dSupply = 600_0000000n
      const bSupply = 1000_0000000n

      const util = deriveUtilization(dSupply, unitRate, bSupply, unitRate, rateDecimals)
      expect(util).toBe(0.6)
    })

    it('properly applies ceil to liabilities and floor to supply', () => {
      const rateDecimals = 12
      const scalar = 10n ** 12n
      // dSupply * dRate produces a remainder => ceil should add 1
      const dSupply = 100n
      const dRate = scalar + 1n // > 1.0
      // bSupply * bRate produces a remainder => floor discards it
      const bSupply = 200n
      const bRate = scalar + 1n

      const util = deriveUtilization(dSupply, dRate, bSupply, bRate, rateDecimals)
      expect(util).toBeGreaterThan(0.5)
      expect(util).toBeLessThan(0.51)
    })
  })

  describe('calcInterestRates', () => {
    const standardConfig: BlendReserveConfig = {
      index: 0,
      decimals: 7,
      util: 7_500_000,     // 75% target util
      r_base: 100_000,     // 1% base rate
      r_one: 400_000,      // 4% slope 1
      r_two: 2_000_000,    // 20% slope 2
      r_three: 5_000_000,  // 50% slope 3
      c_factor: 7_500_000,
      l_factor: 8_000_000,
    }

    const standardData: BlendReserveData = {
      ir_mod: 10_000_000n, // 1.0 modifier
    }

    it('calculates Tier 1 rates when utilization <= targetUtil', () => {
      // At 0% utilization: borrowApr should be r_base (1%)
      const at0 = calcInterestRates(standardConfig, standardData, 0)
      expect(at0.borrowApr).toBeCloseTo(0.01, 4)
      expect(at0.supplyApr).toBe(0) // supplyCapture is 0 at 0 util

      // At target util (75%): borrowApr should be r_base + r_one = 1% + 4% = 5%
      const at75 = calcInterestRates(standardConfig, standardData, 0.75)
      expect(at75.borrowApr).toBeCloseTo(0.05, 4)
      // supplyCapture = (1 - 0.10) * 0.75 = 0.675
      // supplyApr = 0.05 * 0.675 = 0.03375 (3.375%)
      expect(at75.supplyApr).toBeCloseTo(0.03375, 4)
    })

    it('calculates Tier 2 rates when targetUtil < utilization <= 95%', () => {
      // Halfway between 75% and 95% is 85%
      // utilScalar = (0.85 - 0.75) / (0.95 - 0.75) = 0.10 / 0.20 = 0.5
      // baseRate = 0.5 * 20% + 4% + 1% = 10% + 5% = 15%
      const at85 = calcInterestRates(standardConfig, standardData, 0.85)
      expect(at85.borrowApr).toBeCloseTo(0.15, 3)
      // supplyCapture = (1 - 0.10) * 0.85 = 0.765
      // supplyApr = 0.15 * 0.765 = 0.11475
      expect(at85.supplyApr).toBeCloseTo(0.11475, 3)
    })

    it('calculates Tier 3 rates when utilization > 95%', () => {
      // At 100% utilization:
      // utilScalar = (1.0 - 0.95) / 0.05 = 1.0
      // extraRate = 1.0 * 50% = 50%
      // intersection = 1.0 * (20% + 4% + 1%) = 25%
      // borrowApr = 50% + 25% = 75%
      const at100 = calcInterestRates(standardConfig, standardData, 1.0)
      expect(at100.borrowApr).toBeCloseTo(0.75, 3)
    })

    it('computes compound APY correctly from APR', () => {
      const rates = calcInterestRates(standardConfig, standardData, 0.75)
      // borrowApy: daily compounding (365 days)
      const expectedBorrowApy = Math.pow(1 + rates.borrowApr / 365, 365) - 1
      expect(rates.borrowApy).toBeCloseTo(expectedBorrowApy, 6)

      // supplyApy: weekly compounding (52 weeks)
      const expectedSupplyApy = Math.pow(1 + rates.supplyApr / 52, 52) - 1
      expect(rates.supplyApy).toBeCloseTo(expectedSupplyApy, 6)

      // Compound APY must always be >= nominal APR for positive rates
      expect(rates.borrowApy).toBeGreaterThanOrEqual(rates.borrowApr)
      expect(rates.supplyApy).toBeGreaterThanOrEqual(rates.supplyApr)
    })

    it('scales with interestRateModifier', () => {
      const highModifierData: BlendReserveData = {
        ir_mod: 20_000_000n, // 2.0x modifier
      }
      const at75 = calcInterestRates(standardConfig, highModifierData, 0.75)
      // At 75% util: baseRate is 5%, multiplied by 2.0 = 10%
      expect(at75.borrowApr).toBeCloseTo(0.10, 4)
    })
  })

  describe('deriveReserveRates', () => {
    it('correctly scales token decimals to float amounts', () => {
      const entry: BlendReserveEntry = {
        assetId: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EZH3MS2UY7',
        assetSymbol: 'XLM',
        rateDecimals: 12,
        config: {
          index: 0,
          decimals: 7,
          util: 7_500_000,
          r_base: 100_000,
          r_one: 400_000,
          r_two: 2_000_000,
          r_three: 5_000_000,
        },
        data: {
          b_supply: 1_000_000_0000000n, // 1M XLM supplied (7 decimals)
          d_supply: 400_000_0000000n,   // 400k XLM borrowed
          b_rate: 10n ** 12n,
          d_rate: 10n ** 12n,
          ir_mod: 10_000_000n,
        },
      }

      const derived = deriveReserveRates(entry, 1_000_000n)
      expect(derived.totalSupply).toBe(1_000_000)
      expect(derived.totalBorrowed).toBe(400_000)
      expect(derived.reserves).toBe(600_000)
      expect(derived.utilization).toBe(0.4)
      expect(derived.borrowApy).toBeGreaterThan(0)
      expect(derived.supplyApy).toBeGreaterThan(0)
    })
  })
})
