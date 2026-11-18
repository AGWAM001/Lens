import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  queryDispersionHistory: vi.fn(),
}))

vi.mock('../reconciliation/dispersion', () => ({
  queryDispersionHistory: mocks.queryDispersionHistory,
}))

import { registerDispersionRoutes } from '../routes/dispersion'

async function buildTestApp() {
  const app = Fastify()
  await registerDispersionRoutes(app)
  await app.ready()
  return app
}

describe('Dispersion Routes (GET /dispersion)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET /dispersion/:assetA/:assetB returns pair dispersion history and latest record', async () => {
    const app = await buildTestApp()
    const fakeHistory = [
      {
        id: '1',
        network: 'testnet',
        pairKey: 'USDC/XLM',
        timestamp: '2026-10-17T12:00:00.000Z',
        venueCount: 3,
        median: 0.10,
        dispersionPct: 2.5,
        spreadBps: 50,
        minPrice: 0.098,
        maxPrice: 0.1025,
        outlierVenue: 'Aquarius',
        outlierDeviation: 2.5,
        status: 'ok',
        isAmbiguous: false,
        freshVenues: ['AMM', 'Aquarius', 'SDEX'],
        staleVenues: [],
        venues: [],
      },
    ]

    mocks.queryDispersionHistory.mockResolvedValue(fakeHistory)

    const res = await app.inject({
      method: 'GET',
      url: '/dispersion/XLM/USDC?network=testnet&limit=20',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pairKey).toBe('USDC/XLM')
    expect(body.network).toBe('testnet')
    expect(body.count).toBe(1)
    expect(body.latest.outlierVenue).toBe('Aquarius')
    expect(body.latest.dispersionPct).toBe(2.5)

    expect(mocks.queryDispersionHistory).toHaveBeenCalledWith({
      pairKey: 'USDC/XLM',
      network: 'testnet',
      from: undefined,
      to: undefined,
      limit: 20,
    })
  })

  it('GET /dispersion/:assetA/:assetB rejects invalid network', async () => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: 'GET',
      url: '/dispersion/XLM/USDC?network=kovan',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('network must be one of: testnet, mainnet')
  })

  it('GET /dispersion/:assetA/:assetB rejects invalid from or to dates', async () => {
    const app = await buildTestApp()
    const resBadFrom = await app.inject({
      method: 'GET',
      url: '/dispersion/XLM/USDC?from=invalid-date',
    })
    expect(resBadFrom.statusCode).toBe(400)
    expect(resBadFrom.json().error).toContain('from must be a valid ISO 8601 date')

    const resBadTo = await app.inject({
      method: 'GET',
      url: '/dispersion/XLM/USDC?to=not-a-date',
    })
    expect(resBadTo.statusCode).toBe(400)
    expect(resBadTo.json().error).toContain('to must be a valid ISO 8601 date')
  })

  it('GET /dispersion lists recent dispersion across pairs', async () => {
    const app = await buildTestApp()
    mocks.queryDispersionHistory.mockResolvedValue([
      { id: '1', pairKey: 'USDC/XLM', dispersionPct: 1.2 },
      { id: '2', pairKey: 'EURC/USDC', dispersionPct: 0.4 },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/dispersion?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('mainnet')
    expect(body.count).toBe(2)
    expect(body.history).toHaveLength(2)
  })
})
