import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildApp } from '../app'
import type { FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

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

describe('Multi-Currency Fiat Pricing (#290)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [dollarPairRow()] })
    app = await buildApp()
  })

  it('converts XLM to Nigerian Naira (NGN) via base USD cross-rate', async () => {
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
    const res = await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=XYZ_UNSUPPORTED' })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
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

  it('prices a dollar stablecoin at its peg, labelled as such, with no pair', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/price/USDC/fiat?currency=USD' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.baseUsdPrice).toBe(1)
    expect(body.pair).toBeNull()
    expect(body.crossLegs[0].source).toBe('stablecoin_peg')
  })

  it('only queries pairs against a dollar stablecoin', async () => {
    await app.inject({ method: 'GET', url: '/price/XLM/fiat?currency=USD' })
    const [sql, params] = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as [string, unknown[]]
    expect(sql).toContain('split_part(asset_a')
    expect(sql).toContain('split_part(asset_b')
    expect(params[0]).toBe('XLM')
    expect(params[2]).toEqual(expect.arrayContaining(['USDC', 'USD']))
  })
})
