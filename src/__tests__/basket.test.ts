import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import { registerBasketRoutes } from '../routes/basket'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerBasketRoutes(app)
  await app.ready()
  return app
}

describe('GET /basket', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns weighted basket price with normalized weights', async () => {
    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      const asset = params[0]
      if (asset === 'USDC') return { rows: [{ vwap: '1.0' }] }
      if (asset === 'XLM') return { rows: [{ vwap: '0.1' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=1&asset=XLM&weight=1',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.basketPrice).toBeCloseTo(0.55, 5)
    expect(body.weightSum).toBeCloseTo(1.0, 5)
    expect(body.components).toHaveLength(2)
    expect(body.components[0].asset).toBe('USDC')
    expect(body.components[0].weight).toBeCloseTo(0.5, 5)
    expect(body.components[1].asset).toBe('XLM')
    expect(body.components[1].weight).toBeCloseTo(0.5, 5)
    expect(body.computedAt).toBeDefined()
  })

  it('normalizes unequal weights to sum to 1.0', async () => {
    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      const asset = params[0]
      if (asset === 'USDC') return { rows: [{ vwap: '1.0' }] }
      if (asset === 'EURC') return { rows: [{ vwap: '1.1' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=3&asset=EURC&weight=1',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.weightSum).toBeCloseTo(1.0, 5)
    // USDC weight = 0.75, EURC weight = 0.25
    // basketPrice = 0.75*1.0 + 0.25*1.1 = 0.75 + 0.275 = 1.025
    expect(body.basketPrice).toBeCloseTo(1.025, 5)
    expect(body.components[0].weight).toBeCloseTo(0.75, 5)
    expect(body.components[1].weight).toBeCloseTo(0.25, 5)
  })

  it('returns 400 when no assets provided', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/basket' })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid asset: at least one asset is required/)
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when only one asset provided', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/basket?asset=USDC&weight=1' })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid asset: basket requires at least 2 assets/)
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when asset and weight counts do not match', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&asset=XLM&weight=1',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid weight: number of assets and weights must match/)
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when a weight is not a positive number', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=0&asset=XLM&weight=1',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid weight: all weights must be positive numbers/)
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for a negative or non-numeric weight', async () => {
    const app = await buildApp()
    const negative = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=-1&asset=XLM&weight=1',
    })
    expect(negative.statusCode).toBe(400)
    expect(negative.json().code).toBe('VALIDATION_ERROR')

    const nonNumeric = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=abc&asset=XLM&weight=1',
    })
    expect(nonNumeric.statusCode).toBe(400)
    expect(nonNumeric.json().code).toBe('VALIDATION_ERROR')
    await app.close()
  })

  it('returns 404 when an asset has no price data', async () => {
    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      const asset = params[0]
      if (asset === 'USDC') return { rows: [{ vwap: '1.0' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=1&asset=UNKNOWN&weight=1',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/UNKNOWN/)
  })
})
