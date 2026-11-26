import { describe, it, expect } from 'vitest'
import {
  calcUtilization,
  deriveUtilization,
  calcInterestRates,
  deriveReserveRates,
  BLEND_SCALES,
  type BlendReserveEntry,
  type BlendReserveConfig,
  type BlendReserveData,
} from '../ingest/venues/blend'

// 10% backstop take rate. bstop_rate is 7 decimals in both v1 and v2.
const TEN_PCT_BACKSTOP = 1_000_000n

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
      const unitRate = 10n ** 12n // 1.0 rate
      const dSupply = 600_0000000n
      const bSupply = 1000_0000000n

      const util = deriveUtilization(dSupply, unitRate, bSupply, unitRate, 2)
      expect(util).toBe(0.6)
    })

    it('derives utilization from dTokens and bTokens with 9 rateDecimals (Blend v1)', () => {
      const unitRate = 10n ** 9n // 1.0 rate
      const dSupply = 600_0000000n
      const bSupply = 1000_0000000n

      const util = deriveUtilization(dSupply, unitRate, bSupply, unitRate, 1)
      expect(util).toBe(0.6)
    })

    it('properly applies ceil to liabilities and floor to supply', () => {
      const scalar = 10n ** 12n
      // dSupply * dRate produces a remainder => ceil should add 1
      const dSupply = 100n
      const dRate = scalar + 1n // > 1.0
      // bSupply * bRate produces a remainder => floor discards it
      const bSupply = 200n
      const bRate = scalar + 1n

      const util = deriveUtilization(dSupply, dRate, bSupply, bRate, 2)
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
      const at0 = calcInterestRates(standardConfig, standardData, 0, TEN_PCT_BACKSTOP, 2)
      expect(at0.borrowApr).toBeCloseTo(0.01, 4)
      expect(at0.supplyApr).toBe(0) // supplyCapture is 0 at 0 util

      // At target util (75%): borrowApr should be r_base + r_one = 1% + 4% = 5%
      const at75 = calcInterestRates(standardConfig, standardData, 0.75, TEN_PCT_BACKSTOP, 2)
      expect(at75.borrowApr).toBeCloseTo(0.05, 4)
      // supplyCapture = (1 - 0.10) * 0.75 = 0.675
      // supplyApr = 0.05 * 0.675 = 0.03375 (3.375%)
      expect(at75.supplyApr).toBeCloseTo(0.03375, 4)
    })

    it('calculates Tier 2 rates when targetUtil < utilization <= 95%', () => {
      // Halfway between 75% and 95% is 85%
      // utilScalar = (0.85 - 0.75) / (0.95 - 0.75) = 0.10 / 0.20 = 0.5
      // baseRate = 0.5 * 20% + 4% + 1% = 10% + 5% = 15%
      const at85 = calcInterestRates(standardConfig, standardData, 0.85, TEN_PCT_BACKSTOP, 2)
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
      const at100 = calcInterestRates(standardConfig, standardData, 1.0, TEN_PCT_BACKSTOP, 2)
      expect(at100.borrowApr).toBeCloseTo(0.75, 3)
    })

    it('computes compound APY correctly from APR', () => {
      const rates = calcInterestRates(standardConfig, standardData, 0.75, TEN_PCT_BACKSTOP, 2)
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
      const at75 = calcInterestRates(standardConfig, highModifierData, 0.75, TEN_PCT_BACKSTOP, 2)
      // At 75% util: baseRate is 5%, multiplied by 2.0 = 10%
      expect(at75.borrowApr).toBeCloseTo(0.10, 4)
    })
  })

  describe('deriveReserveRates', () => {
    it('correctly scales token decimals to float amounts', () => {
      const entry: BlendReserveEntry = {
        assetId: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EZH3MS2UY7',
        assetSymbol: 'XLM',
        version: 2,
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

// #641: v1 pools store b_rate/d_rate/ir_mod at 9 decimals; v2 stores b_rate/d_rate
// at 12 and ir_mod at 7. The sourced table is above BLEND_SCALES in blend.ts.
describe('Blend v1 and v2 scales (#641)', () => {
  it('pins the scale table read from the v1.0.0 and v2.0.0 pool sources', () => {
    expect(BLEND_SCALES[1]).toEqual({ rateDecimals: 9, irModDecimals: 9, backstopRateDecimals: 7, configDecimals: 7 })
    expect(BLEND_SCALES[2]).toEqual({ rateDecimals: 12, irModDecimals: 7, backstopRateDecimals: 7, configDecimals: 7 })
  })

  // One real-world position, written once in each version's on-chain encoding:
  //   1,000,000 bTokens at b_rate 1.1   => 1,100,000 XLM supplied
  //   dTokens        at d_rate 1.32
  //   ir_mod 1.2345678, backstop take rate 20%
  const TWENTY_PCT_BACKSTOP = 2_000_000n // 7 decimals in v1 and v2
  const curve = {
    index: 0,
    decimals: 7,
    c_factor: 7_500_000,
    l_factor: 8_000_000,
    util: 7_500_000, // 75% target
    max_util: 9_500_000,
    r_base: 100_000, // 1%
    r_one: 400_000, // 4%
    r_two: 2_000_000, // 20%
    r_three: 5_000_000, // 50%
    reactivity: 20,
  }

  function v1Entry(dSupply: bigint): BlendReserveEntry {
    return {
      assetId: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EZH3MS2UY7',
      assetSymbol: 'XLM',
      version: 1,
      // v1 ResConfig has no supply_cap or enabled
      config: { ...curve },
      data: {
        b_supply: 1_000_000_0000000n,
        d_supply: dSupply,
        b_rate: 1_100_000_000n, // 1.1 at 9 dp
        d_rate: 1_320_000_000n, // 1.32 at 9 dp
        ir_mod: 1_234_567_800n, // 1.2345678 at 9 dp
      },
    }
  }

  function v2Entry(dSupply: bigint): BlendReserveEntry {
    return {
      assetId: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EZH3MS2UY7',
      assetSymbol: 'XLM',
      version: 2,
      config: { ...curve, supply_cap: 10n ** 18n, enabled: true },
      data: {
        b_supply: 1_000_000_0000000n,
        d_supply: dSupply,
        b_rate: 1_100_000_000_000n, // 1.1 at 12 dp
        d_rate: 1_320_000_000_000n, // 1.32 at 12 dp
        ir_mod: 12_345_678n, // 1.2345678 at 7 dp
      },
    }
  }

  const IR_MOD = 1.2345678
  const positions = [
    // tier 1: util <= target
    { name: 'below target utilisation', dSupply: 500_000_0000000n, borrowed: 660_000, util: 0.6, borrowApr: (0.6 / 0.75 * 0.04 + 0.01) * IR_MOD },
    // tier 2: target < util <= 95%
    { name: 'between target and 95%', dSupply: 700_000_0000000n, borrowed: 924_000, util: 0.84, borrowApr: (((0.84 - 0.75) / 0.2) * 0.2 + 0.04 + 0.01) * IR_MOD },
    // tier 3: util > 95%
    { name: 'above 95%', dSupply: 800_000_0000000n, borrowed: 1_056_000, util: 0.96, borrowApr: ((0.96 - 0.95) / 0.05) * 0.5 + IR_MOD * 0.25 },
  ]

  it.each(positions)('v1 and v2 fixtures of the same position give the same totals, utilisation and rates ($name)', (p) => {
    const v1 = deriveReserveRates(v1Entry(p.dSupply), TWENTY_PCT_BACKSTOP)
    const v2 = deriveReserveRates(v2Entry(p.dSupply), TWENTY_PCT_BACKSTOP)

    expect(v1).toEqual(v2)

    expect(v1.totalSupply).toBe(1_100_000)
    expect(v1.totalBorrowed).toBe(p.borrowed)
    expect(v1.reserves).toBe(1_100_000 - p.borrowed)
    expect(v1.utilization).toBeCloseTo(p.util, 12)
    expect(v1.borrowApr).toBeCloseTo(p.borrowApr, 10)
    expect(v1.supplyApr).toBeCloseTo(p.borrowApr * 0.8 * p.util, 10)
    expect(v1.borrowApy).toBeCloseTo(Math.pow(1 + p.borrowApr / 365, 365) - 1, 10)
    expect(v1.supplyApy).toBeCloseTo(Math.pow(1 + (p.borrowApr * 0.8 * p.util) / 52, 52) - 1, 10)
  })

  it('reading a v1 reserve with the v2 scales (the old behaviour) is off by powers of ten', () => {
    const truth = deriveReserveRates(v1Entry(500_000_0000000n), TWENTY_PCT_BACKSTOP)
    const misread = deriveReserveRates({ ...v1Entry(500_000_0000000n), version: 2 }, TWENTY_PCT_BACKSTOP)

    // b_rate/d_rate divided by 1e12 instead of 1e9: totals 1000x too small
    expect(misread.totalSupply).toBe(truth.totalSupply / 1000)
    expect(misread.totalBorrowed).toBe(truth.totalBorrowed / 1000)
    // ir_mod divided by 1e7 instead of 1e9: borrow APR 100x too large
    expect(misread.borrowApr / truth.borrowApr).toBeCloseTo(100, 9)
  })

  it('reads a missing ir_mod as 1.0 in the scale of each version', () => {
    const v1 = calcInterestRates(curve, {}, 0.75, TWENTY_PCT_BACKSTOP, 1)
    const v2 = calcInterestRates(curve, {}, 0.75, TWENTY_PCT_BACKSTOP, 2)
    expect(v1).toEqual(v2)
    expect(v1.borrowApr).toBeCloseTo(0.05, 12)
  })
})
