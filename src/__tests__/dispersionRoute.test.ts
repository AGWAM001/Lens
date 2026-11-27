import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  queryDispersionHistory: vi.fn(),
}))

vi.mock('../reconciliation/dispersion', () => ({
  queryDispersionHistory: mocks.queryDispersionHistory,
}))

import { registerDispersionRoutes } from '../routes/dispersion'

// Default mainnet pair from src/config.ts (MAINNET_DEFAULT_PAIRS). This is the
// key the reconciliation job writes rows under.
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const MAINNET_PAIR_KEY = `USDC:${USDC_ISSUER}/XLM`

async function buildTestApp() {
  const app = Fastify()
  await registerDispersionRoutes(app)
  await app.ready()
  return app
}

describe('Dispersion Routes (GET /dispersion)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryDispersionHistory.mockResolvedValue([])
  })

  it('GET /dispersion/:assetA/:assetB returns pair dispersion history and latest record', async () => {
    const app = await buildTestApp()
    const fakeHistory = [
      {
        id: '1',
        network: 'mainnet',
        pairKey: MAINNET_PAIR_KEY,
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
      url: '/dispersion/XLM/USDC?network=mainnet&limit=20',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pairKey).toBe(MAINNET_PAIR_KEY)
    expect(body.network).toBe('mainnet')
    expect(body.count).toBe(1)
    expect(body.latest.outlierVenue).toBe('Aquarius')
    expect(body.latest.dispersionPct).toBe(2.5)

    expect(mocks.queryDispersionHistory).toHaveBeenCalledWith({
      pairKey: MAINNET_PAIR_KEY,
      network: 'mainnet',
      from: undefined,
      to: undefined,
      limit: 20,
    })
  })

  it.each([
    ['/dispersion/XLM/USDC'],
    ['/dispersion/usdc/native'],
    [`/dispersion/USDC:${USDC_ISSUER}/XLM`],
    [`/dispersion/native/USDC:${USDC_ISSUER}`],
  ])('%s queries with the watched pair key', async (path) => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: `${path}?network=mainnet` })

    expect(res.statusCode).toBe(200)
    expect(res.json().pairKey).toBe(MAINNET_PAIR_KEY)
    expect(mocks.queryDispersionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ pairKey: MAINNET_PAIR_KEY, network: 'mainnet' }),
    )
  })

  it('GET /dispersion/:assetA/:assetB is a 404 for a pair not watched on the network', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/dispersion/XLM/EURC?network=mainnet' })

    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('unwatched_pair')
    expect(mocks.queryDispersionHistory).not.toHaveBeenCalled()
  })

  it('GET /dispersion/:assetA/:assetB is a 404 when the issuer does not match', async () => {
    const app = await buildTestApp()
    const otherIssuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    const res = await app.inject({
      method: 'GET',
      url: `/dispersion/XLM/USDC:${otherIssuer}?network=mainnet`,
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('unwatched_pair')
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

  it.each([
    ['/dispersion/XLM/USDC?network=mainnet'],
    ['/dispersion?network=mainnet'],
  ])('%s rejects from later than to', async (url) => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: 'GET',
      url: `${url}&from=2026-10-18T00:00:00Z&to=2026-10-17T00:00:00Z`,
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_parameter')
    expect(mocks.queryDispersionHistory).not.toHaveBeenCalled()
  })

  it.each([
    ['/dispersion/XLM/USDC?network=mainnet'],
    ['/dispersion?network=mainnet'],
  ])('%s accepts limit=500 and rejects limit above 500', async (url) => {
    const app = await buildTestApp()
    const ok = await app.inject({ method: 'GET', url: `${url}&limit=500` })
    expect(ok.statusCode).toBe(200)
    expect(mocks.queryDispersionHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }))

    const tooBig = await app.inject({ method: 'GET', url: `${url}&limit=501` })
    expect(tooBig.statusCode).toBe(400)
    expect(tooBig.json().code).toBe('invalid_parameter')
    expect(tooBig.json().error).toContain('500')
  })

  it('GET /dispersion lists recent dispersion across pairs', async () => {
    const app = await buildTestApp()
    mocks.queryDispersionHistory.mockResolvedValue([
      { id: '1', pairKey: MAINNET_PAIR_KEY, dispersionPct: 1.2 },
      { id: '2', pairKey: 'EURC/USDC', dispersionPct: 0.4 },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/dispersion?network=mainnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('mainnet')
    expect(body.pair).toBeNull()
    expect(body.count).toBe(2)
    expect(body.history).toHaveLength(2)
    expect(mocks.queryDispersionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ pairKey: undefined, network: 'mainnet' }),
    )
  })

  it.each([
    ['XLM/USDC'],
    ['usdc/native'],
    [MAINNET_PAIR_KEY],
  ])('GET /dispersion?pair=%s resolves to the watched pair key', async (pair) => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: 'GET',
      url: `/dispersion?network=mainnet&pair=${encodeURIComponent(pair)}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().pair).toBe(MAINNET_PAIR_KEY)
    expect(mocks.queryDispersionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ pairKey: MAINNET_PAIR_KEY, network: 'mainnet' }),
    )
  })

  it.each([['XLM/EURC'], ['XLM'], ['XLM/USDC/EURC']])(
    'GET /dispersion?pair=%s is a 404 for a pair that is not watched',
    async (pair) => {
      const app = await buildTestApp()
      const res = await app.inject({
        method: 'GET',
        url: `/dispersion?network=mainnet&pair=${encodeURIComponent(pair)}`,
      })

      expect(res.statusCode).toBe(404)
      expect(res.json().code).toBe('unwatched_pair')
      expect(mocks.queryDispersionHistory).not.toHaveBeenCalled()
    },
  )
})
