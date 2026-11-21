import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildApp } from '../app'
import type { FastifyInstance } from 'fastify'
import { STATIC_FIAT_RATES_AS_OF } from '../routes/fiat'
import { pgPool } from '../db'

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
    query: vi.fn().mockResolvedValue({
      rows: [{ vwap: '0.125' }],
    }),
  },
  prisma: {},
}))

describe('Multi-Currency Fiat Pricing (#290, #674)', () => {
  const savedEnv = process.env.FIAT_RATES_JSON

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.FIAT_RATES_JSON
    vi.mocked(pgPool.query).mockResolvedValue({
      rows: [{ vwap: '0.125' }],
    } as any)
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
    expect(pgPool.query).toHaveBeenCalledWith(expect.any(String), ['XLM', 'mainnet'])
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
