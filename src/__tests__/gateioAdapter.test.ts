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
  gateioAdapter,
  normalizePair,
  toGateioSymbol,
  fetchGateioTicker,
  fetchGateioOrderBook,
  ingestGateioPair,
  getGateioCredentials,
  hasGateioCredentials,
  _resetLastPrice,
  _getLastPrice,
} from '../ingest/venues/gateio'
import { getCexAdapter } from '../ingest/cex'
import type { WatchedPair } from '../types'

const mockPair: WatchedPair = {
  pairKey: 'XLM/USDT',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDT', issuer: null },
}

describe('Gate.io Adapter - Pair Normalisation', () => {
  it('normalises underscore-separated exchange pairs to internal pairKey format', () => {
    expect(normalizePair('XLM_USDT')).toBe('XLM/USDT')
    expect(normalizePair('xlm_usdc')).toBe('XLM/USDC')
    expect(normalizePair('XLM_BTC')).toBe('XLM/BTC')
  })

  it('converts internal asset codes to Gate.io symbol format', () => {
    expect(toGateioSymbol('XLM', 'USDT')).toBe('XLM_USDT')
    expect(toGateioSymbol('xlm', 'usdc')).toBe('XLM_USDC')
  })
})

describe('Gate.io Adapter - Credentials Handling', () => {
  const originalKey = process.env.GATEIO_API_KEY
  const originalSecret = process.env.GATEIO_API_SECRET

  beforeEach(() => {
    delete process.env.GATEIO_API_KEY
    delete process.env.GATEIO_API_SECRET
    vi.clearAllMocks()
    _resetLastPrice()
  })

  afterEach(() => {
    if (originalKey !== undefined) process.env.GATEIO_API_KEY = originalKey
    else delete process.env.GATEIO_API_KEY
    if (originalSecret !== undefined) process.env.GATEIO_API_SECRET = originalSecret
    else delete process.env.GATEIO_API_SECRET
  })

  it('returns null and does not throw when credentials are absent or empty', async () => {
    expect(getGateioCredentials()).toBeNull()
    expect(hasGateioCredentials()).toBe(false)
    expect(gateioAdapter.isEnabled('testnet')).toBe(false)
    expect(gateioAdapter.isEnabled('mainnet')).toBe(false)

    // fetchTicker returns null quietly
    const ticker = await fetchGateioTicker('XLM', 'USDT')
    expect(ticker).toBeNull()

    // discover returns empty array
    const targets = await gateioAdapter.discover(mockPair, 'testnet')
    expect(targets).toEqual([])

    // read returns null
    const readResult = await gateioAdapter.read(mockPair, mockPair, 'testnet')
    expect(readResult).toBeNull()

    // ingestGateioPair completes without throwing and without writing
    await ingestGateioPair(mockPair, 'testnet')
    expect(mocks.upsertPricePoints).not.toHaveBeenCalled()
  })

  it('detects credentials when GATEIO_API_KEY is populated', () => {
    process.env.GATEIO_API_KEY = 'test-gateio-key'
    process.env.GATEIO_API_SECRET = 'test-gateio-secret'

    expect(hasGateioCredentials()).toBe(true)
    expect(getGateioCredentials()).toEqual({
      apiKey: 'test-gateio-key',
      apiSecret: 'test-gateio-secret',
    })
    expect(gateioAdapter.isEnabled('testnet')).toBe(true)
  })
})

describe('Gate.io Adapter - Network & Writing', () => {
  const originalKey = process.env.GATEIO_API_KEY

  beforeEach(() => {
    process.env.GATEIO_API_KEY = 'test-gateio-key'
    vi.clearAllMocks()
    _resetLastPrice()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    if (originalKey !== undefined) process.env.GATEIO_API_KEY = originalKey
    else delete process.env.GATEIO_API_KEY
  })

  it('writes price_points rows with the exact network passed in (never hardcoded)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          currency_pair: 'XLM_USDT',
          last: '0.1450',
          lowest_ask: '0.1455',
          highest_bid: '0.1445',
          base_volume: '25000',
          quote_volume: '3625',
        },
      ],
    })

    // Test with testnet
    await ingestGateioPair(mockPair, 'testnet')
    expect(mocks.upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          network: 'testnet',
          pairKey: 'XLM/USDT',
          source: 'Gate.io',
          price: 0.145,
          baseVolume: 25000,
        }),
      ]),
      'testnet'
    )

    // Test with mainnet
    mocks.upsertPricePoints.mockClear()
    await ingestGateioPair(mockPair, 'mainnet')
    expect(mocks.upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          network: 'mainnet',
          pairKey: 'XLM/USDT',
          source: 'Gate.io',
          price: 0.145,
          baseVolume: 25000,
        }),
      ]),
      'mainnet'
    )
  })

  it('manages last price tracking with _resetLastPrice', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          currency_pair: 'XLM_USDT',
          last: '0.35',
          base_volume: '1000',
        },
      ],
    })

    await ingestGateioPair(mockPair, 'testnet')
    expect(_getLastPrice('testnet', 'XLM/USDT')).toBe(0.35)

    _resetLastPrice()
    expect(_getLastPrice('testnet', 'XLM/USDT')).toBeUndefined()
  })
})

describe('Gate.io Adapter - CexAdapter & VenueAdapter Interface Contract', () => {
  it('satisfies CexAdapter interface and is registered in CEX registry', () => {
    expect(typeof gateioAdapter.name).toBe('string')
    expect(gateioAdapter.name).toBe('Gate.io')
    expect(typeof gateioAdapter.fetchTicker).toBe('function')
    expect(typeof gateioAdapter.fetchOrderBook).toBe('function')

    const registered = getCexAdapter('Gate.io')
    expect(registered).toBe(gateioAdapter)
  })

  it('satisfies VenueAdapter interface', () => {
    expect(typeof gateioAdapter.name).toBe('string')
    expect(typeof gateioAdapter.source).toBe('string')
    expect(gateioAdapter.source).toBe('Gate.io')
    expect(typeof gateioAdapter.isEnabled).toBe('function')
    expect(typeof gateioAdapter.getPollIntervalMs).toBe('function')
    expect(typeof gateioAdapter.discover).toBe('function')
    expect(typeof gateioAdapter.read).toBe('function')
    expect(typeof gateioAdapter.derive).toBe('function')
    expect(typeof gateioAdapter.write).toBe('function')
    expect(typeof gateioAdapter.ingestPair).toBe('function')
  })

  it('fetches order book snapshots with depth clamping', async () => {
    process.env.GATEIO_API_KEY = 'test-key'
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 123456,
        current: 1700000000000,
        bids: [
          ['0.14', '500'],
          ['0.13', '600'],
        ],
        asks: [
          ['0.15', '700'],
          ['0.16', '800'],
        ],
      }),
    })

    const book = await gateioAdapter.fetchOrderBook('XLM', 'USDT', 1)
    expect(book).not.toBeNull()
    expect(book!.pair).toBe('XLM/USDT')
    expect(book!.bids).toHaveLength(1)
    expect(book!.asks).toHaveLength(1)
    expect(book!.bids[0]).toEqual({ price: 0.14, quantity: 500 })
  })
})
