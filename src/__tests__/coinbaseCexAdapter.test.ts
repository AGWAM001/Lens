/**
 * Tests for the Coinbase CEX adapter (issue #215) and the createCexAdapter
 * registry it is wired through.
 *
 * The adapter is a pure HTTP fetch layer, so these tests inject `fetchImpl`
 * and a virtual clock (`now` + a `sleep` that advances it) rather than mocking
 * global fetch or waiting on real timers.
 */

import { describe, it, expect } from 'vitest'
import {
  createCexAdapter,
  getCexAdapter,
  getAllCexAdapters,
  type CexAdapter,
} from '../ingest/cex/index'
import {
  CoinbaseAdapter,
  toCoinbaseProductId,
  fromCoinbaseProductId,
  canonicalPair,
  parseRetryAfter,
  type CoinbaseAdapterOptions,
} from '../ingest/cex/coinbase'

/** Minimal Response-shaped stub. */
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
  } as unknown as Response
}

/** A virtual clock: `sleep` advances time without real waiting. */
function testHarness() {
  let nowMs = 1_000_000
  const sleeps: number[] = []
  return {
    opts: {
      now: () => nowMs,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        nowMs += ms
      },
      // Generous bucket so backoff tests isolate backoff from throttling waits.
      requestsPerSecond: 100,
      burst: 100,
    } as CoinbaseAdapterOptions,
    sleeps,
  }
}

const TICKER = {
  trade_id: 86326522,
  price: '0.100',
  size: '10',
  bid: '0.098',
  ask: '0.102',
  volume: '1000',
  time: '2026-01-01T00:00:00.000Z',
}

describe('createCexAdapter registry', () => {
  it('builds the coinbase adapter and registers it by name', () => {
    const adapter: CexAdapter = createCexAdapter('coinbase')
    expect(adapter).toBeInstanceOf(CoinbaseAdapter)
    expect(adapter.name).toBe('Coinbase')
    expect(typeof adapter.fetchTicker).toBe('function')
    expect(typeof adapter.fetchOrderBook).toBe('function')
    expect(getCexAdapter('Coinbase')).toBe(adapter)
    expect(getAllCexAdapters().some((a) => a === adapter)).toBe(true)
  })

  it('is case-insensitive on the exchange name', () => {
    const a = createCexAdapter('CoinBase')
    const b = createCexAdapter('coinbase')
    expect(a.constructor).toBe(CoinbaseAdapter)
    expect(b.constructor).toBe(CoinbaseAdapter)
  })

  it('throws for an exchange with no registered factory', () => {
    expect(() => createCexAdapter('no-such-exchange')).toThrow(/no-such-exchange/)
  })
})

describe('pair normalisation — both directions', () => {
  it('forward: Lens canonical pair -> the exchange name (dash form)', () => {
    // The exchange names the pair differently: "XLM-USD", not "XLM/USD".
    expect(toCoinbaseProductId('XLM', 'USD')).toBe('XLM-USD')
    expect(toCoinbaseProductId('xlm', 'usd')).toBe('XLM-USD')
    expect(canonicalPair('XLM', 'USD')).toBe('XLM/USD')
  })

  it('reverse: exchange name -> Lens canonical pair', () => {
    expect(fromCoinbaseProductId('XLM-USD')).toMatchObject({
      productId: 'XLM-USD',
      pair: 'XLM/USD',
      base: 'XLM',
      quote: 'USD',
    })
    // A pair the exchange spells against a different quote asset.
    expect(fromCoinbaseProductId('btc-usdc')).toMatchObject({ pair: 'BTC/USDC', base: 'BTC', quote: 'USDC' })
    expect(fromCoinbaseProductId('NOSEPARATOR')).toBeNull()
  })

  it('round-trips canonical -> exchange -> canonical', () => {
    const id = toCoinbaseProductId('XLM', 'USDC')
    expect(fromCoinbaseProductId(id)!.pair).toBe(canonicalPair('XLM', 'USDC'))
  })

  it('fetchTicker hits the exchange identifier and returns the canonical pair', async () => {
    const urls: string[] = []
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async (url) => {
        urls.push(url)
        return response(200, TICKER)
      },
    })

    const ticker = await adapter.fetchTicker('xlm', 'usd')

    // The wire request uses the exchange's own name for the pair...
    expect(urls[0]).toContain('/products/XLM-USD/ticker')
    // ...while the returned ticker carries the Lens canonical form.
    expect(ticker!.pair).toBe('XLM/USD')
    expect(ticker!.last).toBeCloseTo(0.1)
    expect(ticker!.bid).toBeCloseTo(0.098)
    expect(ticker!.ask).toBeCloseTo(0.102)
    expect(ticker!.baseVolume).toBe(1000)
    expect(ticker!.quoteVolume).toBeCloseTo(100) // 1000 base * 0.100 last
    expect(ticker!.timestamp.toISOString()).toBe(TICKER.time)
  })
})

describe('rate limiting and 429 backoff', () => {
  it('honours Retry-After on a stubbed 429, then succeeds', async () => {
    const harness = testHarness()
    let calls = 0
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async () => {
        calls++
        if (calls === 1) return response(429, {}, { 'retry-after': '3' })
        return response(200, TICKER)
      },
    })

    const ticker = await adapter.fetchTicker('XLM', 'USD')

    expect(calls).toBe(2)
    // 3 seconds advertised via Retry-After -> ~3000ms, not a blind retry.
    expect(harness.sleeps.some((s) => s >= 2900 && s <= 3000)).toBe(true)
    expect(ticker).not.toBeNull()
  })

  it('backs off exponentially when a 429 omits Retry-After, then degrades to null', async () => {
    const harness = testHarness()
    let calls = 0
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      initialBackoffMs: 100,
      maxRetries: 2,
      fetchImpl: async () => {
        calls++
        return response(429, {}, {})
      },
    })

    const ticker = await adapter.fetchTicker('XLM', 'USD')

    expect(ticker).toBeNull()
    expect(calls).toBe(3) // 1 initial + 2 retries
    expect(harness.sleeps).toEqual([100, 200]) // 100 * 2^0, 100 * 2^1
  })

  it('throttles bursts beyond the bucket capacity before the first request', async () => {
    const harness = testHarness()
    let calls = 0
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      requestsPerSecond: 2,
      burst: 1,
      fetchImpl: async () => {
        calls++
        return response(200, TICKER)
      },
    })

    // First request drains the single available token.
    await adapter.fetchTicker('XLM', 'USD')
    expect(calls).toBe(1)
    expect(harness.sleeps).toEqual([])

    // Second request must wait for a refill (1 token / 2 per sec = 500ms).
    await adapter.fetchTicker('XLM', 'USD')
    expect(calls).toBe(2)
    expect(harness.sleeps.length).toBeGreaterThan(0)
    expect(harness.sleeps[0]).toBeLessThanOrEqual(500)
  })
})

describe('graceful degradation — never throws', () => {
  it('returns null when the exchange is unreachable (fetch rejects)', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      maxRetries: 1,
      initialBackoffMs: 1,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })

    await expect(adapter.fetchTicker('XLM', 'USD')).resolves.toBeNull()
  })

  it('returns null on a 404 (unknown pair), without retrying', async () => {
    const harness = testHarness()
    let calls = 0
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async () => {
        calls++
        return response(404, { message: 'Product not found' })
      },
    })

    expect(await adapter.fetchTicker('FAKE', 'COIN')).toBeNull()
    expect(calls).toBe(1)
  })

  it('returns null on a persistent 5xx after retries', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      maxRetries: 1,
      initialBackoffMs: 1,
      fetchImpl: async () => response(500, { message: 'server error' }),
    })

    expect(await adapter.fetchTicker('XLM', 'USD')).toBeNull()
  })

  it('returns null on a malformed JSON body', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      maxRetries: 0,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid json')
        },
        headers: { get: () => null },
      }) as unknown as Response,
    })

    expect(await adapter.fetchTicker('XLM', 'USD')).toBeNull()
  })

  it('returns null when the ticker carries no numeric price', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async () => response(200, { price: 'n/a', bid: 'n/a', ask: 'n/a' }),
    })

    expect(await adapter.fetchTicker('XLM', 'USD')).toBeNull()
  })
})

describe('source tagging', () => {
  it('stamps coinbase_cex so a CEX price is never mistaken for an on-chain one', async () => {
    const harness = testHarness()
    const adapter = new CoinbaseAdapter({
      ...harness.opts,
      fetchImpl: async () => response(200, TICKER),
    })

    const ticker = await adapter.fetchTicker('XLM', 'USD')
    const pair = {
      pairKey: 'USD/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USD', issuer: null },
    }
    const point = adapter.toPricePoint(ticker!, pair, 'mainnet')

    expect(point.source).toBe('coinbase_cex')
    expect(point.network).toBe('mainnet')
    expect(point.price).toBeCloseTo(0.1)
    expect(point.ledger).toBe(0)
    expect(point.poolId).toBe('coinbase:XLM-USD')
  })
})

describe('parseRetryAfter', () => {
  it('parses delay-seconds and HTTP-date forms', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('not-a-number')).toBeNull()
    // A future HTTP-date yields a non-negative delay.
    const future = new Date(Date.now() + 5000).toUTCString()
    const parsed = parseRetryAfter(future)
    expect(parsed).not.toBeNull()
    expect(parsed!).toBeGreaterThanOrEqual(0)
  })
})
