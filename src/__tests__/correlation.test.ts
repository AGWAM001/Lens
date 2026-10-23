import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
}))

import {
  registerCorrelationRoutes,
  computePearsonCorrelation,
  MIN_CORRELATION_SAMPLES,
} from '../routes/correlation'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerCorrelationRoutes(app)
  await app.ready()
  return app
}

describe('Pearson correlation math helper', () => {
  it('computes exact Pearson correlation against a hand-computed example', () => {
    // Hand-computed benchmark:
    // X = [10, 20, 30, 40, 50]
    // Y = [15, 25, 35, 45, 55]
    // meanX = 30, meanY = 35
    // dx = [-20, -10, 0, 10, 20]
    // dy = [-20, -10, 0, 10, 20]
    // sum(dx * dy) = 400 + 100 + 0 + 100 + 400 = 1000
    // sum(dx^2) = 1000, sum(dy^2) = 1000
    // r = 1000 / sqrt(1000 * 1000) = 1.0
    const x = [10, 20, 30, 40, 50]
    const y = [15, 25, 35, 45, 55]
    const r = computePearsonCorrelation(x, y)
    expect(r).toBe(1.0)
  })

  it('computes exact negative correlation against a hand-computed example', () => {
    // Hand-computed benchmark:
    // X = [1, 2, 3, 4]
    // Y = [8, 6, 4, 2]
    // meanX = 2.5, meanY = 5
    // dx = [-1.5, -0.5, 0.5, 1.5]
    // dy = [3, 1, -1, -3]
    // sum(dx * dy) = -4.5 + -0.5 + -0.5 + -4.5 = -10
    // sum(dx^2) = 2.25 + 0.25 + 0.25 + 2.25 = 5
    // sum(dy^2) = 9 + 1 + 1 + 9 = 20
    // r = -10 / sqrt(5 * 20) = -10 / 10 = -1.0
    const x = [1, 2, 3, 4]
    const y = [8, 6, 4, 2]
    const r = computePearsonCorrelation(x, y)
    expect(r).toBe(-1.0)
  })

  it('computes fractional correlation against a hand-computed example', () => {
    // Hand-computed benchmark:
    // X = [1, 2, 3, 4, 5]
    // Y = [2, 1, 4, 3, 7]
    // meanX = 3, meanY = 3.4
    // dx = [-2, -1, 0, 1, 2]
    // dy = [-1.4, -2.4, 0.6, -0.4, 3.6]
    // dx * dy = [2.8, 2.4, 0, -0.4, 7.2] => sum = 12
    // dx^2 = [4, 1, 0, 1, 4] => sum = 10
    // dy^2 = [1.96, 5.76, 0.36, 0.16, 12.96] => sum = 21.2
    // r = 12 / sqrt(10 * 21.2) = 12 / sqrt(212) = 12 / 14.56021977856... ≈ 0.824163
    const x = [1, 2, 3, 4, 5]
    const y = [2, 1, 4, 3, 7]
    const r = computePearsonCorrelation(x, y)
    expect(r).toBeCloseTo(0.824163, 5)
  })

  it('reports null when sample count is less than MIN_CORRELATION_SAMPLES', () => {
    const x = [10, 20]
    const y = [15, 25]
    expect(computePearsonCorrelation(x, y)).toBeNull()
  })

  it('returns 0 when variance is zero (constant price)', () => {
    const x = [10, 10, 10, 10]
    const y = [15, 20, 25, 30]
    expect(computePearsonCorrelation(x, y)).toBe(0)
  })
})

describe('GET /correlation', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('returns correlation matrix over a window with sample counts and provenance', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const t1 = new Date('2026-01-01T00:05:00.000Z')
    const t2 = new Date('2026-01-01T00:10:00.000Z')
    const t3 = new Date('2026-01-01T00:15:00.000Z')

    // 4 overlapping points for XLM and USDC
    // XLM prices: [10, 20, 30, 40]
    // USDC prices: [15, 25, 35, 45]
    // Hand-computed correlation = 1.0
    mockQuery.mockResolvedValueOnce({
      rows: [
        { asset_a: 'XLM', asset_b: 'USDT', source: 'SDEX', price: '10', timestamp: t0 },
        { asset_a: 'USDC', asset_b: 'USDT', source: 'AMM', price: '15', timestamp: t0 },
        { asset_a: 'XLM', asset_b: 'USDT', source: 'SDEX', price: '20', timestamp: t1 },
        { asset_a: 'USDC', asset_b: 'USDT', source: 'AMM', price: '25', timestamp: t1 },
        { asset_a: 'XLM', asset_b: 'USDT', source: 'SDEX', price: '30', timestamp: t2 },
        { asset_a: 'USDC', asset_b: 'USDT', source: 'SDEX', price: '35', timestamp: t2 },
        { asset_a: 'XLM', asset_b: 'USDT', source: 'AMM', price: '40', timestamp: t3 },
        { asset_a: 'USDC', asset_b: 'USDT', source: 'AMM', price: '45', timestamp: t3 },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/correlation?assets=XLM,USDC&window=24h',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.network).toBe('testnet')
    expect(body.window).toBe('24h')
    expect(body.assets).toEqual(['XLM', 'USDC'])
    expect(body.matrix.XLM.USDC).toBe(1.0)
    expect(body.matrix.USDC.XLM).toBe(1.0)
    expect(body.matrix.XLM.XLM).toBe(1.0)
    expect(body.sampleCounts.XLM.USDC).toBe(4)
    expect(body.sampleCounts.USDC.XLM).toBe(4)

    const cell = body.pairs.find((p: any) => p.assetA === 'XLM' && p.assetB === 'USDC')
    expect(cell).toBeDefined()
    expect(cell.status).toBe('computed')
    expect(cell.sampleCount).toBe(4)
    expect(cell.coefficient).toBe(1.0)
    expect(cell.provenance.venues).toEqual(['AMM', 'SDEX'])
    expect(cell.provenance.sampleCount).toBe(4)
    expect(cell.provenance.oldestSample).toBe(t0.toISOString())
    expect(cell.provenance.newestSample).toBe(t3.toISOString())
  })

  it('reports insufficient overlap rather than computing a coefficient when samples < 3', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const t1 = new Date('2026-01-01T00:05:00.000Z')

    // Only 2 overlapping samples between XLM and BTC
    mockQuery.mockResolvedValueOnce({
      rows: [
        { asset_a: 'XLM', asset_b: 'USDT', source: 'SDEX', price: '0.12', timestamp: t0 },
        { asset_a: 'BTC', asset_b: 'USDT', source: 'AMM', price: '60000', timestamp: t0 },
        { asset_a: 'XLM', asset_b: 'USDT', source: 'SDEX', price: '0.13', timestamp: t1 },
        { asset_a: 'BTC', asset_b: 'USDT', source: 'AMM', price: '61000', timestamp: t1 },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/correlation?assets=XLM,BTC&window=1h',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.matrix.XLM.BTC).toBeNull()
    expect(body.matrix.BTC.XLM).toBeNull()
    expect(body.sampleCounts.XLM.BTC).toBe(2)

    const cell = body.pairs.find((p: any) => p.assetA === 'XLM' && p.assetB === 'BTC')
    expect(cell).toBeDefined()
    expect(cell.status).toBe('insufficient')
    expect(cell.coefficient).toBeNull()
    expect(cell.sampleCount).toBe(2)
  })

  it('honors network parameter and filters query by network', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/correlation?assets=XLM,USDC&network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe('mainnet')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE network = $1'),
      expect.arrayContaining(['mainnet'])
    )
  })

  it('returns 400 when fewer than 2 assets are provided', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/correlation?assets=XLM',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/At least 2 assets/)
  })

  it('returns 400 when invalid window is requested', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/correlation?assets=XLM,USDC&window=2h',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/window must be one of/)
  })

  it('returns 400 when invalid network is provided', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/correlation?assets=XLM,USDC&network=invalidnet',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/network must be one of|Invalid network/)
  })

  it('supports repeated query parameters for assets', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/correlation?assets=XLM&assets=USDC',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().assets).toEqual(['XLM', 'USDC'])
  })
})
