import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetActivePairs } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetActivePairs: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../pairsRegistry', () => ({
  getActivePairs: mockGetActivePairs,
}))

import { registerBenchmarkRoutes } from '../routes/benchmark'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerBenchmarkRoutes(app)
  await app.ready()
  return app
}

describe('GET /benchmark/:asset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 404 if the pair is not watched', async () => {
    mockGetActivePairs.mockReturnValue([])
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/benchmark/USDC?target=USD',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Pair USDC/USD not watched', code: 'unwatched_pair' })
  })

  it('calculates benchmark deviation correctly when asset is assetB in the pair (e.g. USD/USDC)', async () => {
    mockGetActivePairs.mockReturnValue([
      {
        pairKey: 'USD/USDC',
        assetA: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      },
    ])

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: '1.0002',
          max_price: '1.0005',
          min_price: '0.9997',
          avg_price: '1.0001',
          max_abs_deviation_bps: '5.0',
          max_deviation_bps: '2.0',
          min_deviation_bps: '-3.0',
          sample_count: '100',
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/benchmark/USDC?target=USD',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.asset).toBe('USDC')
    expect(data.target).toBe('USD')
    expect(data.pairKey).toBe('USD/USDC')
    expect(data.currentPrice).toBe(1.0002)
    expect(data.currentDeviationBp).toBeCloseTo(2)
    expect(data.rolling24h).toEqual({
      maxDeviationBp: 2,
      minDeviationBp: -3,
      maxAbsoluteDeviationBp: 5,
      averageDeviationBp: CloseTo(1),
      sampleCount: 100,
    })

    function CloseTo(val: number) {
      return {
        asymmetricMatch: (actual: any) => Math.abs(actual - val) < 0.0001,
      }
    }
  })

  it('calculates benchmark deviation correctly when asset is assetA in the pair (e.g. USDC/XLM)', async () => {
    mockGetActivePairs.mockReturnValue([
      {
        pairKey: 'USDC/XLM',
        assetA: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        assetB: { code: 'XLM', issuer: null },
      },
    ])

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: '1.0002',
          max_price: '1.0005',
          min_price: '0.9997',
          avg_price: '1.0001',
          max_abs_deviation_bps: '5.0',
          max_deviation_bps: '2.0',
          min_deviation_bps: '-3.0',
          sample_count: '100',
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/benchmark/USDC?target=XLM',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.asset).toBe('USDC')
    expect(data.target).toBe('XLM')
    expect(data.pairKey).toBe('USDC/XLM')
    expect(data.currentPrice).toBe(1.0002)
  })

  it('handles watched pairs with no price data gracefully', async () => {
    mockGetActivePairs.mockReturnValue([
      {
        pairKey: 'USD/USDC',
        assetA: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      },
    ])

    mockQuery.mockResolvedValue({
      rows: [
        {
          latest_price: null,
          max_price: null,
          min_price: null,
          avg_price: null,
          max_abs_deviation_bps: null,
          max_deviation_bps: null,
          min_deviation_bps: null,
          sample_count: '0',
        },
      ],
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/benchmark/USDC?target=USD',
    })

    expect(res.statusCode).toBe(200)
    const data = res.json()
    expect(data.currentPrice).toBeNull()
    expect(data.currentDeviationBp).toBeNull()
    expect(data.rolling24h).toEqual({
      maxDeviationBp: null,
      minDeviationBp: null,
      maxAbsoluteDeviationBp: null,
      averageDeviationBp: null,
      sampleCount: 0,
    })
  })
})
