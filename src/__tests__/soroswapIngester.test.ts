/**
 * Unit tests for the Soroswap AMM ingester.
 *
 * Tests cover:
 * - calcSpotPrice: pure function — no mocks needed
 * - ingestPool: mocked upsertPricePoints + dispatchPriceUpdate
 * - fetchSoroswapTokenList: mocked global fetch
 * - ingestPair: pair filtering / skipping logic
 */

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../db', () => ({
  upsertPricePoints: vi.fn().mockResolvedValue(undefined),
}))

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}))

vi.mock('../logger', () => ({
  createLogger: () => mockLogger,
  logger: mockLogger,
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../ingesters/soroswap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingesters/soroswap')>()
  return {
    ...actual,
    fetchPoolReserves: vi.fn(),
    fetchPoolsFromFactory: vi.fn(),
    fetchSoroswapTokenList: vi.fn(),
    fetchTokenDecimals: vi.fn().mockImplementation(async () => null),
  }
})

// ── Imports ──────────────────────────────────────────────────────────────────
import {
  calcSpotPrice,
  ingestPool,
  ingestPair,
  fetchSoroswapTokenList,
  fetchPoolReserves,
  fetchPoolsFromFactory,
  fetchTokenDecimals,
  getCachedTokenDecimals,
  setCachedTokenDecimals,
  _resetTokenDecimalsCache,
  isPricePlausible,
  type PoolEntry,
  type SoroswapToken,
} from '../ingesters/soroswap'
import { upsertPricePoints } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'
import { price_rejected_total } from '../metrics'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const mockPair = {
  pairKey: 'USDC/XLM',
  assetA: { code: 'XLM', issuer: null },
  assetB: {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
}

const xlmToken: SoroswapToken = {
  address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  symbol: 'XLM',
  name: 'Stellar Lumens',
  decimals: 7,
}

const usdcToken: SoroswapToken = {
  address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 7,
}

// ── calcSpotPrice ─────────────────────────────────────────────────────────────
describe('calcSpotPrice', () => {
  it('returns reserveA / reserveB as a number', () => {
    expect(calcSpotPrice(1000n, 200n)).toBeCloseTo(5.0)
  })

  it('returns 0 when reserveA is zero (empty pool guard)', () => {
    expect(calcSpotPrice(0n, 200n)).toBe(0)
  })

  it('returns 0 when reserveB is zero (empty pool guard)', () => {
    expect(calcSpotPrice(1000n, 0n)).toBe(0)
  })

  it('handles large i128 reserves correctly', () => {
    // 10_000_000 / 2_000_000 = 5.0 (7-decimal precision amounts)
    expect(calcSpotPrice(10_000_000n, 2_000_000n)).toBeCloseTo(5.0)
  })

  it('handles 1:1 ratio', () => {
    expect(calcSpotPrice(5000n, 5000n)).toBe(1)
  })

  it('scales reserves correctly when token decimals differ from 7 (#227)', () => {
    // Token A (USDC) has 6 decimals, Token B (XLM) has 7 decimals
    // 10 USDC (10 * 10^6 = 10,000,000) and 100 XLM (100 * 10^7 = 1,000,000,000)
    // Price = 10 USDC / 100 XLM = 0.1 USDC per XLM
    const priceA = calcSpotPrice(10_000_000n, 1_000_000_000n, 6, 7)
    expect(priceA).toBeCloseTo(0.1, 5)

    // Token A has 18 decimals, Token B has 7 decimals
    // 5 * 10^18 A and 10 * 10^7 B -> price = 5 / 10 = 0.5
    const priceB = calcSpotPrice(5_000_000_000_000_000_000n, 100_000_000n, 18, 7)
    expect(priceB).toBeCloseTo(0.5, 5)

    // Token A has 7 decimals, Token B has 6 decimals
    // 20 * 10^7 A and 10 * 10^6 B -> price = 20 / 10 = 2.0
    const priceC = calcSpotPrice(200_000_000n, 10_000_000n, 7, 6)
    expect(priceC).toBeCloseTo(2.0, 5)
  })
})

// ── Token Decimals Cache ──────────────────────────────────────────────────────
describe('Token Decimals Cache (#227)', () => {
  beforeEach(() => {
    _resetTokenDecimalsCache()
  })

  it('stores and retrieves cached decimals', () => {
    expect(getCachedTokenDecimals('CTOKEN1')).toBeUndefined()
    setCachedTokenDecimals('CTOKEN1', 6)
    expect(getCachedTokenDecimals('CTOKEN1')).toBe(6)

    _resetTokenDecimalsCache()
    expect(getCachedTokenDecimals('CTOKEN1')).toBeUndefined()
  })
})

// ── Plausibility Check ────────────────────────────────────────────────────────
describe('Price Plausibility Sanity Check (#227)', () => {
  it('accepts prices within plausible range', () => {
    expect(isPricePlausible(1.0, 0.0001, 10000)).toBe(true)
    expect(isPricePlausible(0.0001, 0.0001, 10000)).toBe(true)
    expect(isPricePlausible(10000, 0.0001, 10000)).toBe(true)
  })

  it('rejects prices below or above plausible range or NaN/Infinite', () => {
    expect(isPricePlausible(0.00001, 0.0001, 10000)).toBe(false)
    expect(isPricePlausible(20000, 0.0001, 10000)).toBe(false)
    expect(isPricePlausible(NaN, 0.0001, 10000)).toBe(false)
    expect(isPricePlausible(Infinity, 0.0001, 10000)).toBe(false)
    expect(isPricePlausible(-1.0, 0.0001, 10000)).toBe(false)
  })
})

// ── ingestPool ────────────────────────────────────────────────────────────────
describe('ingestPool', () => {
  const mockPoolEntry: PoolEntry = {
    poolAddress: 'CPOOL000000000000000000000000000000000000000000000000001234',
    tokenA: xlmToken,
    tokenB: usdcToken,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(upsertPricePoints as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  it('stores a price point when reserves are non-zero', async () => {
    const mockFetch = vi.fn().mockResolvedValue([10_000_000n, 2_000_000n])

    // See the note in ammIngester.test.ts: the network passed in must be the
    // one written, so this uses a network the process is not running as.
    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, 'mainnet')

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'soroswap_amm',
          price: expect.closeTo(5.0, 5),
          poolId: mockPoolEntry.poolAddress,
        }),
      ]),
      'mainnet'
    )
    expect(dispatchPriceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ assetA: 'XLM', assetB: 'USDC' })
    )
  })

  it('skips price storage when pool is empty (zero reserves)', async () => {
    const mockFetch = vi.fn().mockResolvedValue([0n, 0n])

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch)

    expect(upsertPricePoints).not.toHaveBeenCalled()
    expect(dispatchPriceUpdate).not.toHaveBeenCalled()
  })

  it('skips price storage when fetchPoolReserves returns null (RPC error)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(null)

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch)

    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('does not throw when upsertPricePoints rejects', async () => {
    const mockFetch = vi.fn().mockResolvedValue([1000n, 200n])
    ;(upsertPricePoints as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'))

    await expect(ingestPool(mockPoolEntry, mockPair as any, mockFetch)).resolves.toBeUndefined()
  })

  it('correctly reads and scales for tokens with decimals other than 7 (#227)', async () => {
    // 10_000_000 raw tokenA (with 6 decimals = 10 units)
    // 1_000_000_000 raw tokenB (with 7 decimals = 100 units)
    // spotPrice = 10 / 100 = 0.1
    const mockFetch = vi.fn().mockResolvedValue([10_000_000n, 1_000_000_000n])
    const mockDecimals = vi.fn().mockImplementation(async (addr: string) => {
      if (addr === mockPoolEntry.tokenA.address) return 6
      if (addr === mockPoolEntry.tokenB.address) return 7
      return 7
    })

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, 'mainnet', mockDecimals)

    expect(mockDecimals).toHaveBeenCalledWith(mockPoolEntry.tokenA.address, 'mainnet')
    expect(mockDecimals).toHaveBeenCalledWith(mockPoolEntry.tokenB.address, 'mainnet')
    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'soroswap_amm',
          price: expect.closeTo(0.1, 5),
          poolId: mockPoolEntry.poolAddress,
        }),
      ]),
      'mainnet'
    )
  })

  it('rejects derived price outside plausible sanity range and increments metric (#227)', async () => {
    // Extremely small price (1n / 100_000_000_000_000n = 1e-14 < 1e-10 min)
    const mockFetch = vi.fn().mockResolvedValue([1n, 100_000_000_000_000n])

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, 'testnet')

    expect(upsertPricePoints).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ spotPrice: expect.any(Number) }),
      expect.stringContaining('outside plausible range')
    )

    const metric = await price_rejected_total.get()
    const rejectedEntry = metric.values.find((v) => v.labels.pair === mockPair.pairKey)
    expect(rejectedEntry?.value).toBeGreaterThanOrEqual(1)
  })
})

// ── ingestPair ────────────────────────────────────────────────────────────────
describe('ingestPair', () => {
  const tokens = [xlmToken, usdcToken]
  const factory = 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls fetchPoolsFromFactory with correct token addresses', async () => {
    const mockFetchPools = vi.fn().mockResolvedValue([])

    await ingestPair(mockPair as any, tokens, factory, mockFetchPools)

    expect(mockFetchPools).toHaveBeenCalledWith(
      factory,
      xlmToken.address,
      usdcToken.address,
      expect.any(String)
    )
  })

  it('skips silently when one token is not in the token list', async () => {
    const pairWithUnknownToken = {
      ...mockPair,
      assetB: { code: 'UNKNOWN', issuer: null },
      pairKey: 'UNKNOWN/XLM',
    }

    await ingestPair(pairWithUnknownToken as any, tokens, factory)

    expect(fetchPoolsFromFactory).not.toHaveBeenCalled()
  })

  it('skips silently when factory returns no pools', async () => {
    const mockFetchPools = vi.fn().mockResolvedValue([])

    await ingestPair(mockPair as any, tokens, factory, mockFetchPools)

    expect(upsertPricePoints).not.toHaveBeenCalled()
  })
})

// ── fetchSoroswapTokenList ────────────────────────────────────────────────────
describe('fetchSoroswapTokenList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns tokens from a successful fetch', async () => {
    ;(fetchSoroswapTokenList as ReturnType<typeof vi.fn>).mockResolvedValue([xlmToken, usdcToken])

    const result = await fetchSoroswapTokenList()
    expect(result).toHaveLength(2)
    expect(result[0].symbol).toBe('XLM')
  })

  it('returns empty array on fetch failure', async () => {
    ;(fetchSoroswapTokenList as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await fetchSoroswapTokenList()
    expect(result).toEqual([])
  })
})
