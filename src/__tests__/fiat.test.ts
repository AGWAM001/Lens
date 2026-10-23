import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildApp } from '../app'
import type { FastifyInstance } from 'fastify'

vi.mock('../db', () => ({
  pgPool: {
    query: vi.fn().mockResolvedValue({
      rows: [{ vwap: '0.125' }],
    }),
  },
  prisma: {},
}))

describe('Multi-Currency Fiat Pricing (#290)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
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
