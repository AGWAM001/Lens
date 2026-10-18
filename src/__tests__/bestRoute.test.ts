import { vi, describe, it, expect, beforeEach } from 'vitest'
import { getBestRoute, _resetHorizonServers } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import * as StellarSdk from '@stellar/stellar-sdk'

// Mock dependencies
vi.mock('../db', () => ({
  pgPool: {
    query: vi.fn()
  }
}))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  const callFn = vi.fn()
  return {
    ...actual,
    Horizon: {
      Server: vi.fn(function() {
        return {
          strictSendPaths: vi.fn().mockReturnThis(),
          call: callFn
        }
      })
    },
    Asset: Object.assign(
      vi.fn(function(code, issuer) { return { code, issuer } }),
      { native: vi.fn(() => 'native') }
    ),
    // config.ts's buildNetworkConfig() falls back to these when no
    // NETWORK_PASSPHRASE_* env var is set — needed now that getBestRoute
    // resolves a per-network Horizon client via getNetworkConfig().
    Networks: {
      PUBLIC: 'Public Global Stellar Network ; September 2015',
      TESTNET: 'Test SDF Network ; September 2015',
    },
    __mockCall: callFn
  }
})

describe('getBestRoute', () => {
  const assetA = { code: 'USDC', issuer: 'GA2C5RFPE6GCKIG3EQNCIMHO7OA7Q6M2XQ2UBNR5NCTU24VTY4A2J7B2' }
  const assetB = { code: 'XLM', issuer: null }
  const pairKey = 'USDC:XLM'

  const mockQuery = vi.mocked(pgPool.query)
  const mockCall = (StellarSdk as any).__mockCall

  beforeEach(() => {
    vi.clearAllMocks()
    // horizonServers is memoised at module scope (see bestRoute.ts) — clear
    // between tests so each one observes fresh Horizon.Server() constructions.
    _resetHorizonServers()
  })

  it('Case 1: returns SDEX when SDEX price is better', async () => {
    // SDEX Price: 0.5
    mockCall.mockResolvedValue({
      records: [{ destination_amount: '500' }] // 500 / 1000 = 0.5
    })
    
    // AMM Price: 0.4
    mockQuery.mockResolvedValue({
      rows: [{ reserve_a: '10000', reserve_b: '4000', fee_bp: '30' }]
    } as any)

    const result = await getBestRoute(assetA, assetB, pairKey, 1000)

    expect(result.route).toBe('SDEX')
    expect(result.sdexPrice).toBe(0.5)
    // precision handling
    expect(result.ammPrice).toBeCloseTo(0.362644, 6) 
  })

  it('Case 2: returns AMM when AMM price is better', async () => {
    // SDEX Price: 0.4
    mockCall.mockResolvedValue({
      records: [{ destination_amount: '400' }]
    })
    
    // AMM Price: 0.5 (approx)
    mockQuery.mockResolvedValue({
      rows: [{ reserve_a: '10000', reserve_b: '5000', fee_bp: '30' }]
    } as any)

    const result = await getBestRoute(assetA, assetB, pairKey, 1000)

    expect(result.route).toBe('AMM')
  })

  it('Case 3: Only one source available (SDEX only)', async () => {
    // SDEX Price: 0.5
    mockCall.mockResolvedValue({
      records: [{ destination_amount: '500' }]
    })
    
    // AMM: No pool data
    mockQuery.mockResolvedValue({ rows: [] } as any)

    const result = await getBestRoute(assetA, assetB, pairKey, 1000)

    expect(result.route).toBe('SDEX')
    expect(result.ammPrice).toBe(0)
  })

  it('Case 4: No data available throws error', async () => {
    // SDEX: no paths
    mockCall.mockResolvedValue({ records: [] })
    
    // AMM: No pool data
    mockQuery.mockResolvedValue({ rows: [] } as any)

    await expect(getBestRoute(assetA, assetB, pairKey, 1000))
      .rejects.toThrow('No pricing data available')
  })

  it('Case 5: Spread / price calculation precision', async () => {
    // Exact SDEX Price
    mockCall.mockResolvedValue({
      records: [{ destination_amount: '123.456789' }] // 123.456789 / 1000 = 0.123456789
    })

    // AMM: no pool data to simplify test or give known value
    mockQuery.mockResolvedValue({ rows: [] } as any)

    const result = await getBestRoute(assetA, assetB, pairKey, 1000)

    expect(result.sdexPrice).toBeCloseTo(0.123457, 6)
  })

  it('Case 6: queries the mainnet Horizon server when network="mainnet"', async () => {
    mockCall.mockResolvedValue({ records: [{ destination_amount: '500' }] })
    mockQuery.mockResolvedValue({ rows: [] } as any)

    await getBestRoute(assetA, assetB, pairKey, 1000, 'mainnet')

    const HorizonServerCtor = (StellarSdk as any).Horizon.Server
    const urls = HorizonServerCtor.mock.calls.map((call: unknown[]) => call[0])
    expect(urls.some((url: string) => url.includes('horizon.stellar.org'))).toBe(true)
    expect(urls.some((url: string) => url.includes('testnet'))).toBe(false)
  })

  it('Case 7: testnet and mainnet reuse a memoised Horizon server per network', async () => {
    mockCall.mockResolvedValue({ records: [{ destination_amount: '500' }] })
    mockQuery.mockResolvedValue({ rows: [] } as any)

    const HorizonServerCtor = (StellarSdk as any).Horizon.Server
    const callsBefore = HorizonServerCtor.mock.calls.length

    await getBestRoute(assetA, assetB, pairKey, 1000, 'mainnet')
    await getBestRoute(assetA, assetB, pairKey, 1000, 'mainnet')

    // Second mainnet call reuses the cached client — only one new Server() call.
    expect(HorizonServerCtor.mock.calls.length).toBe(callsBefore + 1)
  })

  it('Case 8: prices AMM liquidity from the requested network only', async () => {
    mockCall.mockResolvedValue({ records: [] })
    mockQuery.mockResolvedValue({
      rows: [{ reserve_a: '10000', reserve_b: '4000', fee_bp: '30' }]
    } as any)

    await getBestRoute(assetA, assetB, pairKey, 1000, 'mainnet')

    const [sql, params] = mockQuery.mock.calls[0]
    // Both legs of the lookup: the pool_snapshots scan and the price_points
    // subquery naming which pools hold this pair. Pool ids are only unique
    // within a network, so an unfiltered scan prices a mainnet pair off a
    // testnet pool's reserves.
    expect(sql).toMatch(/ps\.network\s*=\s*\$2/)
    expect(sql).toMatch(/pool_snapshots[\s\S]*WHERE pair_key = \$1 AND network = \$2 AND source = 'AMM'/)
    expect(params).toEqual([pairKey, 'mainnet'])
  })

  describe('slippagePct', () => {
    // Fixed pool: 1,000,000 A / 500,000 B, 30 bp fee, so spot = 0.5 B per A.
    const pool = { rows: [{ reserve_a: '1000000', reserve_b: '500000', fee_bp: '30' }] } as any

    it('is near zero for a tiny order and grows with amount against a fixed pool', async () => {
      mockCall.mockResolvedValue({ records: [] }) // AMM only
      mockQuery.mockResolvedValue(pool)

      const small = await getBestRoute(assetA, assetB, pairKey, 1)
      const medium = await getBestRoute(assetA, assetB, pairKey, 10_000)
      const large = await getBestRoute(assetA, assetB, pairKey, 500_000)

      // a 1-unit trade only pays the 0.30% fee
      expect(small.slippagePct).toBeGreaterThan(0.29)
      expect(small.slippagePct).toBeLessThan(0.31)
      expect(medium.slippagePct).toBeGreaterThan(small.slippagePct)
      expect(large.slippagePct).toBeGreaterThan(medium.slippagePct)
      // 500k into a 1M pool moves the price by roughly a third
      expect(large.slippagePct).toBeGreaterThan(30)
    })

    it('matches the constant-product curve exactly for a known order', async () => {
      mockCall.mockResolvedValue({ records: [] })
      mockQuery.mockResolvedValue(pool)

      const r = await getBestRoute(assetA, assetB, pairKey, 100_000)
      const eff = 100_000 * 0.997
      const exec = (500000 * eff) / (1000000 + eff) / 100_000
      expect(r.slippagePct).toBeCloseTo(((0.5 - exec) / 0.5) * 100, 6)
    })

    it('is 0 when there is no AMM pool to give a spot reference', async () => {
      mockCall.mockResolvedValue({ records: [{ destination_amount: '500' }] })
      mockQuery.mockResolvedValue({ rows: [] } as any)

      const r = await getBestRoute(assetA, assetB, pairKey, 1000)
      expect(r.slippagePct).toBe(0)
    })

    it('does not change which route is selected', async () => {
      mockCall.mockResolvedValue({ records: [{ destination_amount: '500' }] })
      mockQuery.mockResolvedValue(pool)

      const r = await getBestRoute(assetA, assetB, pairKey, 1000)
      expect(r.route).toBe('SDEX')
      expect(r.estimatedOutput).toBeCloseTo(500, 6)
      expect(r.slippagePct).toBe(0) // SDEX beats AMM spot: no shortfall
    })

    // Slippage is only measured against the spot of the venue being executed
    // on. For SDEX/SPLIT there is no size-independent reference, so an AMM
    // pool that happens to exist must not leak its spot into the figure.
    it('is 0 for an SDEX route even when the AMM spot is far above the fill', async () => {
      // thin/stale pool, spot 0.6; SDEX fills at 0.5 and wins the route
      mockCall.mockResolvedValue({ records: [{ destination_amount: '500' }] })
      mockQuery.mockResolvedValue({ rows: [{ reserve_a: '1000', reserve_b: '600', fee_bp: '30' }] } as any)

      const r = await getBestRoute(assetA, assetB, pairKey, 1000)
      expect(r.route).toBe('SDEX')
      expect(r.slippagePct).toBe(0)
    })

    it('does not report the AMM fee as slippage on an SDEX fill', async () => {
      // spot 0.5, 30 bp fee: the AMM nets about 0.4980, SDEX fills at 0.4985 and wins
      mockCall.mockResolvedValue({ records: [{ destination_amount: '498.5' }] })
      mockQuery.mockResolvedValue(pool)

      const r = await getBestRoute(assetA, assetB, pairKey, 1000)
      expect(r.route).toBe('SDEX')
      expect(r.slippagePct).toBe(0)
    })

    it('is 0 for a SPLIT route', async () => {
      // amount > 10000 and SDEX within 0.1% of the AMM execution price
      mockQuery.mockResolvedValue(pool)
      const amount = 20_000
      const eff = amount * 0.997
      const ammExec = (500000 * eff) / (1000000 + eff) / amount
      mockCall.mockResolvedValue({ records: [{ destination_amount: String(ammExec * amount) }] })

      const r = await getBestRoute(assetA, assetB, pairKey, amount)
      expect(r.route).toBe('SPLIT')
      expect(r.slippagePct).toBe(0)
    })
  })
})
