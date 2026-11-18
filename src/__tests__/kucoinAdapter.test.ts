import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  upsertPricePoints: vi.fn().mockResolvedValue(undefined),
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
  publishPriceUpdate: vi.fn(),
}))

vi.mock('../db', () => ({
  upsertPricePoints: mocks.upsertPricePoints,
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: mocks.dispatchPriceUpdate,
}))

vi.mock('../events', () => ({
  publishPriceUpdate: mocks.publishPriceUpdate,
}))

import {
  kucoinAdapter,
  normalizePair,
  toKuCoinSymbol,
  fetchKuCoinTicker,
  fetchKuCoinOrderBook,
  ingestKuCoinPair,
  getKuCoinCredentials,
  hasKuCoinCredentials,
  _resetLastPrice,
  _getLastPrice,
} from '../ingest/venues/kucoin'
import { getCexAdapter } from '../ingest/cex'
import type { WatchedPair } from '../types'

const mockPair: WatchedPair = {
  pairKey: 'XLM/USDT',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDT', issuer: null },
}

describe('KuCoin Adapter - Pair Normalisation', () => {
  it('normalises hyphenated exchange pairs to internal pairKey format', () => {
    expect(normalizePair('XLM-USDT')).toBe('XLM/USDT')
    expect(normalizePair('xlm-usdc')).toBe('XLM/USDC')
    expect(normalizePair('XLM-BTC')).toBe('XLM/BTC')
  })

  it('converts internal asset codes to KuCoin symbol format', () => {
    expect(toKuCoinSymbol('XLM', 'USDT')).toBe('XLM-USDT')
    expect(toKuCoinSymbol('xlm', 'usdc')).toBe('XLM-USDC')
  })
})

describe('KuCoin Adapter - Credentials Handling', () => {
  const originalKey = process.env.KUCOIN_API_KEY
  const originalSecret = process.env.KUCOIN_API_SECRET

  beforeEach(() => {
    delete process.env.KUCOIN_API_KEY
    delete process.env.KUCOIN_API_SECRET
    vi.clearAllMocks()
    _resetLastPrice()
  })

  afterEach(() => {
    if (originalKey !== undefined) process.env.KUCOIN_API_KEY = originalKey
    else delete process.env.KUCOIN_API_KEY
    if (originalSecret !== undefined) process.env.KUCOIN_API_SECRET = originalSecret
    else delete process.env.KUCOIN_API_SECRET
  })

  it('returns null and does not throw when credentials are absent or empty', async () => {
    expect(getKuCoinCredentials()).toBeNull()
    expect(hasKuCoinCredentials()).toBe(false)
    expect(kucoinAdapter.isEnabled('testnet')).toBe(false)
    expect(kucoinAdapter.isEnabled('mainnet')).toBe(false)

    // fetchTicker returns null quietly
    const ticker = await fetchKuCoinTicker('XLM', 'USDT')
    expect(ticker).toBeNull()

    // discover returns empty array
    const targets = await kucoinAdapter.discover(mockPair, 'testnet')
    expect(targets).toEqual([])

    // read returns null
    const readResult = await kucoinAdapter.read(mockPair, mockPair, 'testnet')
    expect(readResult).toBeNull()

    // ingestKuCoinPair completes without throwing and without writing
    await ingestKuCoinPair(mockPair, 'testnet')
    expect(mocks.upsertPricePoints).not.toHaveBeenCalled()
  })

  it('detects credentials when KUCOIN_API_KEY is populated', () => {
    process.env.KUCOIN_API_KEY = 'test-kucoin-key'
    process.env.KUCOIN_API_SECRET = 'test-kucoin-secret'

    expect(hasKuCoinCredentials()).toBe(true)
    expect(getKuCoinCredentials()).toEqual({
      apiKey: 'test-kucoin-key',
      apiSecret: 'test-kucoin-secret',
    })
    expect(kucoinAdapter.isEnabled('testnet')).toBe(true)
  })
})

describe('KuCoin Adapter - Network & Writing', () => {
  const originalKey = process.env.KUCOIN_API_KEY

  beforeEach(() => {
    process.env.KUCOIN_API_KEY = 'test-kucoin-key'
    vi.clearAllMocks()
    _resetLastPrice()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    if (originalKey !== undefined) process.env.KUCOIN_API_KEY = originalKey
    else delete process.env.KUCOIN_API_KEY
  })

  it('writes price_points rows with the exact network passed in (never hardcoded)', async () => {
    const fixedTime = 1700000000000
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        code: '200000',
        data: {
          time: fixedTime,
          price: '0.12345',
          size: '5000',
          bestBid: '0.12340',
          bestAsk: '0.12350',
        },
      }),
    })

    // Test with testnet
    await ingestKuCoinPair(mockPair, 'testnet')
    expect(mocks.upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          network: 'testnet',
          pairKey: 'XLM/USDT',
          source: 'KuCoin',
          price: 0.12345,
          timestamp: new Date(fixedTime),
        }),
      ]),
      'testnet'
    )

    // Test with mainnet
    mocks.upsertPricePoints.mockClear()
    await ingestKuCoinPair(mockPair, 'mainnet')
    expect(mocks.upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          network: 'mainnet',
          pairKey: 'XLM/USDT',
          source: 'KuCoin',
          price: 0.12345,
          timestamp: new Date(fixedTime),
        }),
      ]),
      'mainnet'
    )
  })

  it('manages last price tracking with _resetLastPrice', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        code: '200000',
        data: {
          price: '0.25',
          size: '100',
          bestBid: '0.24',
          bestAsk: '0.26',
        },
      }),
    })

    await ingestKuCoinPair(mockPair, 'testnet')
    expect(_getLastPrice('testnet', 'XLM/USDT')).toBe(0.25)

    _resetLastPrice()
    expect(_getLastPrice('testnet', 'XLM/USDT')).toBeUndefined()
  })
})

describe('KuCoin Adapter - CexAdapter & VenueAdapter Interface Contract', () => {
  it('satisfies CexAdapter interface and is registered in CEX registry', () => {
    expect(typeof kucoinAdapter.name).toBe('string')
    expect(kucoinAdapter.name).toBe('KuCoin')
    expect(typeof kucoinAdapter.fetchTicker).toBe('function')
    expect(typeof kucoinAdapter.fetchOrderBook).toBe('function')

    const registered = getCexAdapter('KuCoin')
    expect(registered).toBe(kucoinAdapter)
  })

  it('satisfies VenueAdapter interface', () => {
    expect(typeof kucoinAdapter.name).toBe('string')
    expect(typeof kucoinAdapter.source).toBe('string')
    expect(kucoinAdapter.source).toBe('KuCoin')
    expect(typeof kucoinAdapter.isEnabled).toBe('function')
    expect(typeof kucoinAdapter.getPollIntervalMs).toBe('function')
    expect(typeof kucoinAdapter.discover).toBe('function')
    expect(typeof kucoinAdapter.read).toBe('function')
    expect(typeof kucoinAdapter.derive).toBe('function')
    expect(typeof kucoinAdapter.write).toBe('function')
    expect(typeof kucoinAdapter.ingestPair).toBe('function')
  })

  it('fetches order book snapshots with depth clamping', async () => {
    process.env.KUCOIN_API_KEY = 'test-key'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: '200000',
        data: {
          time: 1700000000000,
          bids: [
            ['0.12', '100'],
            ['0.11', '200'],
          ],
          asks: [
            ['0.13', '150'],
            ['0.14', '250'],
          ],
        },
      }),
    })

    const book = await kucoinAdapter.fetchOrderBook('XLM', 'USDT', 1)
    expect(book).not.toBeNull()
    expect(book!.pair).toBe('XLM/USDT')
    expect(book!.bids).toHaveLength(1)
    expect(book!.asks).toHaveLength(1)
    expect(book!.bids[0]).toEqual({ price: 0.12, quantity: 100 })
  })
})
