import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildApp } from '../app'
import type { FastifyInstance } from 'fastify'
import { STATIC_FIAT_RATES_AS_OF } from '../routes/fiat'
import { pgPool } from '../db'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

const { fiatLogger } = vi.hoisted(() => ({
  fiatLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => fiatLogger,
  logger: fiatLogger,
  loggerOptions: () => ({}),
  createDestination: () => ({ write: () => {} }),
}))

vi.mock('../db', () => ({
  pgPool: {
    query: mockQuery,
  },
  prisma: {},
}))

const USDC_FULL = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function dollarPairRow(overrides: Record<string, unknown> = {}) {
  return {
    pair_key: 'XLM/USDC',
    asset_a: 'XLM',
    asset_b: USDC_FULL,
    source: 'sdex',
    vwap: '0.125',
    price_timestamp: new Date(),
    ...overrides,
  }
}

describe('Multi-Currency Fiat Pricing (#290, #674)', () => {
  const savedEnv = process.env.FIAT_RATES_JSON

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.FIAT_RATES_JSON
    mockQuery.mockResolvedValue({ rows: [dollarPairRow()] })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (savedEnv === undefined) delete process.env.FIAT_RATES_JSON
    else process.env.FIAT_RATES_JSON = savedEnv
  })

  it('stamps rateTimestamp with STATIC_FIAT_RATES_AS_OF across app rebuilds and computes stale when past 24h', async () => {
    vi.useFakeTimers()
    const baseMs = Date.parse(STATIC_FIAT_RATES_AS_OF)

    // Within 24h of the static table's honest as-of date -> not stale
    vi.setSystemTime(baseMs + 3_600 * 1000)
    const app1: FastifyInstance = await buildApp()
    const freshRes = await app1.inject({ method: 'GET', url: '/price/XLM/fiat?currency=NGN' })
    expect(freshRes.statusCode).toBe(200)
    const freshBody = freshRes.json()
    expect(freshBody).toMatchObject({
      asset: 'XLM',
      currency: 'NGN',
      rateSource: 'static_reference',
      fiatRatesAsOf: STATIC_FIAT_RATES_AS_OF,
      rateTimestamp: STATIC_FIAT_RATES_AS_OF,
      rateAgeSeconds: 3600,
      stale: false,
    })
    expect(freshBody.supportedCurrencies).toContain('NGN')
    expect(freshBody.crossLegs[0]).toMatchObject({ from: 'XLM', to: 'USD' })
    expect(freshBody.crossLegs[1]).toMatchObject({
      from: 'USD',
      to: 'NGN',
      source: 'static_reference',
      asOf: STATIC_FIAT_RATES_AS_OF,
    })

    // Simulating a restart 48h later: rateTimestamp does not reset to "now", stale becomes true
    vi.setSystemTime(baseMs + 48 * 3_600 * 1000)
    const app2: FastifyInstance = await buildApp()
    const staleRes = await app2.inject({ method: 'GET', url: '/price/XLM/fiat?currency=NGN' })
    expect(staleRes.statusCode).toBe(200)
    const staleBody = staleRes.json()
    expect(staleBody.rateTimestamp).toBe(STATIC_FIAT_RATES_AS_OF)
    expect(staleBody.rateAgeSeconds).toBe(48 * 3600)
    expect(staleBody.stale).toBe(true)
  })

  it('uses valid FIAT_RATES_JSON operator override and exposes its currencies and as-of date', async () => {
    vi.useFakeTimers()
    const overrideAsOf = '2026-11-21T12:00:00.000Z'
    vi.setSystemTime(Date.parse('2026-11-21T13:00:00.000Z'))
    process.env.FIAT_RATES_JSON = JSON.stringify({
      asOf: overrideAsOf,
      rates: { USD: 1, NGN: 1600, GHS: 15.5 },
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=NGN' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      fiatPerUsd: 1600,
      priceInFiat: 200,
      rateTimestamp: overrideAsOf,
      fiatRatesAsOf: overrideAsOf,
      rateAgeSeconds: 3600,
      stale: false,
      supportedCurrencies: ['USD', 'NGN', 'GHS'],
    })
  })

  it('logs a warning and falls back to built-in static rates when FIAT_RATES_JSON is invalid', async () => {
    process.env.FIAT_RATES_JSON = '{"asOf":"not-a-date","rates":{"NGN":-5}}'

    const app = await buildApp()
    expect(fiatLogger.warn).toHaveBeenCalled()

    const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=NGN' })
    expect(res.statusCode).toBe(200)
    expect(res.json().fiatRatesAsOf).toBe(STATIC_FIAT_RATES_AS_OF)
    expect(res.json().fiatPerUsd).toBe(1563.5)
  })

  it('honours header-only x-network selection via req.network', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/fiat?currency=USD',
      headers: { 'x-network': 'mainnet' },
    })
    expect(res.statusCode).toBe(200)
    expect(pgPool.query).toHaveBeenCalledWith(expect.any(String), [
      'XLM',
      'mainnet',
      expect.arrayContaining(['USDC', 'USD']),
    ])
  })

  it('converts XLM to Nigerian Naira (NGN) via base USD cross-rate', async () => {
    // Pin the clock just after the static table's as-of date so the rate is not stale (#674).
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(STATIC_FIAT_RATES_AS_OF) + 3_600 * 1000)
    const app: FastifyInstance = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=NGN' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.asset).toBe('XLM')
    expect(body.currency).toBe('NGN')
    expect(body.priceInFiat).toBeGreaterThan(0)
    expect(body.baseUsdPrice).toBeGreaterThan(0)
    expect(body.fiatPerUsd).toBeGreaterThan(1000)
    expect(Array.isArray(body.crossLegs)).toBe(true)
    expect(body.crossLegs.length).toBe(2)
    expect(body.crossLegs[0].to).toBe('USD')
    expect(body.crossLegs[1].from).toBe('USD')
    expect(body.crossLegs[1].to).toBe('NGN')
    expect(body.stale).toBe(false)
  })

  it('rejects unsupported currency with 400 listing supported currencies', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=XYZ_UNSUPPORTED' })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toContain('Unsupported currency')
    expect(body.supportedCurrencies).toContain('NGN')
    expect(body.supportedCurrencies).toContain('USD')
    expect(body.supportedCurrencies).toContain('EUR')
  })
})

describe('Fiat pricing never invents a dollar price (#673)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [dollarPairRow()] })
    app = await buildApp()
  })

  it('names the dollar pair used and the real source, and returns the price age', async () => {
    const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=USD' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.baseUsdPrice).toBeCloseTo(0.125)
    expect(body.pair).toBe('XLM/USDC')
    expect(body.crossLegs[0].pair).toBe('XLM/USDC')
    expect(body.crossLegs[0].source).toBe('sdex')
    expect(body.priceTimestamp).toBeTruthy()
    expect(body.priceAgeSeconds).toBeGreaterThanOrEqual(0)
    expect(body.priceAgeSeconds).toBeLessThan(60)
  })

  it('inverts the price when the asset is the quote side of the dollar pair', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        dollarPairRow({
          pair_key: 'USDC/XLM',
          asset_a: USDC_FULL,
          asset_b: 'XLM',
          // 1 USDC = 8 XLM, so 1 XLM = $0.125
          vwap: '8',
        }),
      ],
    })
    const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=USD' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.baseUsdPrice).toBeCloseTo(0.125)
    expect(body.pair).toBe('USDC/XLM')
  })

  it('returns 404 unknown_pair for an asset with no dollar pair, not a price', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/price/ANYTHINGATALL/fiat?currency=NGN' })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe('unknown_pair')
    expect(body.priceInFiat).toBeUndefined()
    expect(body.baseUsdPrice).toBeUndefined()
  })

  it('returns 503 upstream_unavailable when the database fails, not a price', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'))
    const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=NGN' })
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe('upstream_unavailable')
    expect(body.priceInFiat).toBeUndefined()
    expect(body.baseUsdPrice).toBeUndefined()
  })

  it('prices a dollar stablecoin at its peg, labelled as such, with no pair and no claimed age', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/price/USDC/fiat?currency=USD' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.baseUsdPrice).toBe(1)
    expect(body.pair).toBeNull()
    expect(body.crossLegs[0].source).toBe('stablecoin_peg')
    // The peg is a convention, not an observation: no timestamp, no age 0.
    expect(body.priceTimestamp).toBeNull()
    expect(body.priceAgeSeconds).toBeNull()
  })

  it('returns 503 for a dollar stablecoin when the database is down, not a fresh-looking peg', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'))
    const res = await app.inject({ method: 'GET', url: '/price/USDC/fiat?currency=USD' })
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.payload)
    expect(body.code).toBe('upstream_unavailable')
    expect(body.priceInFiat).toBeUndefined()
    expect(body.baseUsdPrice).toBeUndefined()
  })

  it('only queries pairs against a dollar stablecoin', async () => {
    await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=USD' })
    const [sql, params] = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as [string, unknown[]]
    expect(sql).toContain('split_part(asset_a')
    expect(sql).toContain('split_part(asset_b')
    expect(params[0]).toBe('XLM')
    expect(params[2]).toEqual(expect.arrayContaining(['USDC', 'USD']))
  })

  it("matches backfill rows stored with the asset as 'native' for XLM", async () => {
    await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=USD' })
    const [sql] = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as [string, unknown[]]
    // The SQL normalizes a stored 'native' asset code to XLM, mirroring
    // normalizeAssetCode, so backfilled native rows are not invisible.
    expect(sql).toContain("lower(split_part(asset_a, ':', 1)) = 'native'")
    expect(sql).toContain("lower(split_part(asset_b, ':', 1)) = 'native'")
    expect(sql).toContain("'XLM'")
  })
})
