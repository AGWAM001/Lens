import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { getBestRoute } from '../src/aggregator/bestRoute'
import { pgPool } from '../src/db'
import * as StellarSdk from '@stellar/stellar-sdk'

vi.mock('../src/db', () => ({
  pgPool: {
    query: vi.fn(),
  },
}))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  const callFn = vi.fn()
  return {
    ...actual,
    Horizon: {
      Server: vi.fn(function () {
        return {
          strictSendPaths: vi.fn().mockReturnThis(),
          call: callFn,
        }
      }),
    },
    Asset: Object.assign(
      vi.fn(function (code: string, issuer: string | null) {
        return { code, issuer }
      }),
      { native: vi.fn(() => 'native') }
    ),
    // config.ts's buildNetworkConfig() falls back to these when no
    // NETWORK_PASSPHRASE_* env var is set — needed now that getBestRoute
    // resolves a per-network Horizon client via getNetworkConfig().
    Networks: {
      PUBLIC: 'Public Global Stellar Network ; September 2015',
      TESTNET: 'Test SDF Network ; September 2015',
    },
    __mockCall: callFn,
  }
})

describe('Price aggregator property tests', () => {
  const assetA = { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' }
  const assetB = { code: 'XLM', issuer: null }
  const pairKey = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM'
  const mockQuery = vi.mocked(pgPool.query)
  const mockCall = (StellarSdk as any).__mockCall as ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 10,000 fast-check runs of getBestRoute now actually execute (previously
  // this test failed before running a single iteration — the mocked
  // @stellar/stellar-sdk had no Networks export, which getNetworkConfig()
  // needs); that volume of real work needs more than the 5s default.
  // 30s keeps real headroom for 10k async iterations under fork load while
  // staying tight enough that a genuine hang still fails the run.
  it('produces valid route results for random venue prices', { timeout: 30_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true, noNegativeZero: true }),
        fc.float({ min: 0, max: 2000, noNaN: true, noDefaultInfinity: true, noNegativeZero: true }),
        fc.integer({ min: 1, max: 20000 }),
        async (sdexPrice, ammPrice, amount) => {
          const feeBp = 30
          const fee = 1 - feeBp / 10000

          if (sdexPrice <= 0) {
            mockCall.mockResolvedValue({ records: [] })
          } else {
            mockCall.mockResolvedValue({ records: [{ destination_amount: String(sdexPrice * amount) }] })
          }

          if (ammPrice <= 0) {
            mockQuery.mockResolvedValue({ rows: [] } as any)
          } else {
            const reserveA = 10000
            const reserveB = String((ammPrice * (reserveA + amount * fee)) / fee)
            mockQuery.mockResolvedValue({ rows: [{ reserve_a: String(reserveA), reserve_b: reserveB, fee_bp: String(feeBp) }] } as any)
          }

          if (sdexPrice === 0 && ammPrice === 0) {
            await expect(getBestRoute(assetA, assetB, pairKey, amount)).rejects.toThrow('No pricing data available')
            return
          }

          const result = await getBestRoute(assetA, assetB, pairKey, amount)
          expect(result.sdexPrice).toBeGreaterThanOrEqual(0)
          expect(result.ammPrice).toBeGreaterThanOrEqual(0)
          expect(['SDEX', 'AMM', 'SPLIT', 'UNKNOWN']).toContain(result.route)
          expect(result.estimatedOutput).toBeGreaterThanOrEqual(0)
          expect(result.slippagePct).toBeGreaterThanOrEqual(0)
          expect(Number.isFinite(result.slippagePct)).toBe(true)
          if (ammPrice <= 0 || result.route !== 'AMM') {
            // slippage is only measured against the AMM spot on an AMM route;
            // SDEX/SPLIT (or no pool) have no size-independent reference
            expect(result.slippagePct).toBe(0)
          }

          if (sdexPrice === 0) {
            // AMM-only: slippage is exactly the curve's gap to reserve-ratio spot
            const reserveA = 10000
            const reserveB = (ammPrice * (reserveA + amount * fee)) / fee
            const spot = reserveB / reserveA
            expect(result.slippagePct).toBeCloseTo(Math.max(0, ((spot - ammPrice) / spot) * 100), 4)
            expect(result.route).toBe('AMM')
            expect(result.estimatedOutput).toBeCloseTo(ammPrice * amount, 6)
          }
          if (ammPrice === 0) {
            expect(result.route).toBe('SDEX')
            expect(result.estimatedOutput).toBeCloseTo(sdexPrice * amount, 6)
          }
          if (sdexPrice > 0 && ammPrice > 0) {
            const diff = Math.abs(sdexPrice - ammPrice) / Math.max(sdexPrice, ammPrice)
            if (diff < 0.001) {
              if (amount > 10000) {
                expect(result.route).toBe('SPLIT')
              } else {
                expect(['SDEX', 'AMM']).toContain(result.route)
              }
            } else if (sdexPrice > ammPrice) {
              expect(result.route).toBe('SDEX')
            } else {
              expect(result.route).toBe('AMM')
            }
            expect(result.estimatedOutput).toBeCloseTo(Math.max(sdexPrice, ammPrice) * amount, 6)
          }
        }
      ),
      { numRuns: 10000 }
    )
  })
})
