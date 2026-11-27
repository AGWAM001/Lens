import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery, mockGetNetworkConfig } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetNetworkConfig: vi.fn(),
}))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>()
  return { ...actual, getNetworkConfig: mockGetNetworkConfig }
})

import { usdPriceOf } from '../pricing/usdPrice'

const CIRCLE_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

interface FixtureSample {
  price: string
  baseVolume: string
  counterVolume: string
  source: string
  ts: string
}

const fixtures = new Map<string, FixtureSample[]>()

function usdPeg(issuer: string) {
  return { asset: { code: 'USDC', issuer }, target: 'USD', targetPrice: 1.0, windowHours: 24 }
}

function pair(assetA: { code: string; issuer: string | null }, assetB: { code: string; issuer: string | null }) {
  const label = (a: { code: string; issuer: string | null }) =>
    a.issuer ? `${a.code}:${a.issuer}` : a.code
  return { assetA, assetB, pairKey: [label(assetA), label(assetB)].sort().join('/') }
}

/** Invert a positive decimal string exactly, with 18 fractional digits, then trim. */
function invertDecimal(price: string): string {
  const [whole, fraction = ''] = price.split('.')
  const scaled = BigInt(`${whole}${fraction}` || '0')
  const precision = 18
  const quotient = (10n ** BigInt(precision + fraction.length)) / scaled
  const digits = quotient.toString().padStart(precision + 1, '0')
  const result = `${digits.slice(0, digits.length - precision)}.${digits.slice(digits.length - precision)}`
  return result.replace(/\.?0+$/, '')
}

function fakePriceQuery() {
  mockQuery.mockImplementation((sql: string, params: unknown[]) => {
    const [pairKey] = params as [string, string, number]
    const samples = fixtures.get(pairKey) ?? []
    if (samples.length === 0) {
      return Promise.resolve({
        rows: [{ vwap: null, venues: null, sample_count: 0, last_seen: null }],
      })
    }
    // The fixtures use one sample, so the volume-weighted average is that
    // sample. The inverse is Postgres numeric division; mirror it exactly here.
    const sample = samples[0]
    const inverse = sql.includes('1::numeric / NULLIF(price::numeric, 0)')
    return Promise.resolve({
      rows: [
        {
          vwap: inverse ? invertDecimal(sample.price) : sample.price,
          venues: [sample.source],
          sample_count: samples.length,
          last_seen: sample.ts,
        },
      ],
    })
  })
}

function setSamples(pairKey: string, price: string, source = 'SDEX') {
  fixtures.set(pairKey, [
    { price, baseVolume: '10.0000000', counterVolume: '10.0000000', source, ts: '2026-11-21T00:00:00.000Z' },
  ])
}

beforeEach(() => {
  mockQuery.mockReset()
  mockGetNetworkConfig.mockReset()
  fixtures.clear()
  fakePriceQuery()
})

describe('usdPriceOf', () => {
  it('returns the inverse of a USDC/XLM stored price for XLM', async () => {
    const usdcXlm = pair({ code: 'USDC', issuer: CIRCLE_USDC }, { code: 'XLM', issuer: null })
    mockGetNetworkConfig.mockReturnValue({ pairs: [usdcXlm], pegged: [usdPeg(CIRCLE_USDC)] })
    setSamples(usdcXlm.pairKey, '0.4')

    const result = await usdPriceOf({ code: 'XLM' }, 'mainnet', 5)

    expect(result).toMatchObject({
      status: 'ok',
      reason: 'found',
      asset: 'XLM',
      price: '2.5',
      pair: usdcXlm.pairKey,
      venues: ['SDEX'],
      sampleCount: 1,
    })
    expect(mockQuery.mock.calls[0][0]).toContain('1::numeric / NULLIF(price::numeric, 0)')
    expect(mockQuery.mock.calls[0][1]).toEqual([usdcXlm.pairKey, 'mainnet', 5])
  })

  it('returns the same USD price when the pair is stored the other way round', async () => {
    const xlmUsdc = pair({ code: 'XLM', issuer: null }, { code: 'USDC', issuer: CIRCLE_USDC })
    mockGetNetworkConfig.mockReturnValue({ pairs: [xlmUsdc], pegged: [usdPeg(CIRCLE_USDC)] })
    setSamples(xlmUsdc.pairKey, '2.5')

    const result = await usdPriceOf({ code: 'XLM' }, 'mainnet', 5)

    expect(result.status).toBe('ok')
    expect(result.price).toBe('2.5')
    expect(result.pair).toBe(xlmUsdc.pairKey)
    expect(mockQuery.mock.calls[0][0]).toContain('SUM(price::numeric * base_volume::numeric)')
    expect(mockQuery.mock.calls[0][0]).not.toContain('1::numeric /')
  })

  it('returns unknown, not a number, when no watched pair has a USD peg on the other side', async () => {
    const xlmBtc = pair({ code: 'BTC', issuer: CIRCLE_USDC }, { code: 'XLM', issuer: null })
    mockGetNetworkConfig.mockReturnValue({ pairs: [xlmBtc], pegged: [usdPeg(CIRCLE_USDC)] })

    const result = await usdPriceOf({ code: 'XLM' }, 'mainnet', 5)

    expect(result).toMatchObject({ status: 'unknown', reason: 'no_usd_pair', price: null, pair: null })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('refuses a bare code that matches two issuers instead of mixing them', async () => {
    // Same code, two issuers: the code alone cannot identify the market.
    const a = pair({ code: 'TEST', issuer: CIRCLE_USDC }, { code: 'USDC', issuer: CIRCLE_USDC })
    const b = pair({ code: 'TEST', issuer: TESTNET_USDC }, { code: 'USDC', issuer: TESTNET_USDC })
    mockGetNetworkConfig.mockReturnValue({
      pairs: [a, b],
      pegged: [usdPeg(CIRCLE_USDC), usdPeg(TESTNET_USDC)],
    })
    setSamples(a.pairKey, '0.25')
    setSamples(b.pairKey, '0.75')

    const ambiguous = await usdPriceOf({ code: 'TEST' }, 'mainnet', 5)
    expect(ambiguous).toMatchObject({ status: 'unknown', reason: 'ambiguous_asset', price: null })
    expect(mockQuery).not.toHaveBeenCalled()

    const aOnly = await usdPriceOf({ code: 'TEST', issuer: CIRCLE_USDC }, 'mainnet', 5)
    const bOnly = await usdPriceOf({ code: 'TEST', issuer: TESTNET_USDC }, 'mainnet', 5)

    expect(aOnly).toMatchObject({ status: 'ok', price: '0.25', pair: a.pairKey })
    expect(bOnly).toMatchObject({ status: 'ok', price: '0.75', pair: b.pairKey })
  })

  it('chooses the lexicographically smallest qualifying pair, deterministically', async () => {
    const circlePair = pair({ code: 'USDC', issuer: CIRCLE_USDC }, { code: 'XLM', issuer: null })
    const testnetPair = pair({ code: 'USDC', issuer: TESTNET_USDC }, { code: 'XLM', issuer: null })
    mockGetNetworkConfig.mockReturnValue({
      pairs: [testnetPair, circlePair],
      pegged: [usdPeg(TESTNET_USDC), usdPeg(CIRCLE_USDC)],
    })
    setSamples(circlePair.pairKey, '0.4')
    setSamples(testnetPair.pairKey, '0.2')

    const result = await usdPriceOf({ code: 'XLM' }, 'mainnet', 5)

    // GA5... < GBBD..., regardless of config order.
    expect(result.pair).toBe(circlePair.pairKey)
    expect(result.price).toBe('2.5')
    expect(mockQuery.mock.calls[0][1][0]).toBe(circlePair.pairKey)
  })

  it('reports a configured USD peg as pegged instead of pricing it from a market pair', async () => {
    const usdcXlm = pair({ code: 'USDC', issuer: CIRCLE_USDC }, { code: 'XLM', issuer: null })
    mockGetNetworkConfig.mockReturnValue({ pairs: [usdcXlm], pegged: [usdPeg(CIRCLE_USDC)] })

    const result = await usdPriceOf({ code: 'USDC', issuer: CIRCLE_USDC }, 'mainnet', 5)

    expect(result).toMatchObject({
      status: 'pegged',
      reason: 'asset_is_usd_peg',
      price: '1',
      asset: `USDC:${CIRCLE_USDC}`,
      pair: null,
    })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('returns unknown with the chosen pair when the window holds no samples', async () => {
    const usdcXlm = pair({ code: 'USDC', issuer: CIRCLE_USDC }, { code: 'XLM', issuer: null })
    mockGetNetworkConfig.mockReturnValue({ pairs: [usdcXlm], pegged: [usdPeg(CIRCLE_USDC)] })

    const result = await usdPriceOf({ code: 'XLM' }, 'mainnet', 180)

    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'no_recent_samples',
      price: null,
      pair: usdcXlm.pairKey,
      sampleCount: 0,
    })
    expect(mockQuery.mock.calls[0][1]).toEqual([usdcXlm.pairKey, 'mainnet', 180])
  })
})
