import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))
// `importOriginal` rather than a bare factory: this module's import chain
// pulls in `config` as well as `activeNetwork` and `getNetworkConfig`, and a
// factory that lists only what the test uses fails at import time with
// `No "config" export is defined on the "../config" mock` — a message that
// points at the mock rather than at whoever needed the missing export.
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>()
  return {
    ...actual,
    activeNetwork: 'testnet',
    getNetworkConfig: (network: string) => ({
      soroswap: { enabled: network === 'mainnet' },
      aquarius: { enabled: network === 'mainnet' },
      oracle: { enabled: false },
    }),
  }
})

import { registerVenueRoutes } from '../routes/venues'
import { venueAdapters, type VenueAdapter } from '../ingest/venues'
import { registerNetworkSelector } from '../middleware/network'
import { calculateVenueVolumeShare } from '../services/venueVolume'

const testAdapter: VenueAdapter = {
  name: 'test-adapter',
  source: 'test-source',
  kind: 'amm',
  isEnabled: () => true,
  getPollIntervalMs: () => 1000,
  discover: async () => [],
  read: async () => null,
  derive: () => [],
  write: async () => {},
  ingestPair: async () => {},
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerVenueRoutes(app)
  await app.ready()
  return app
}

describe('GET /venues/registry', () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({
      rows: [{ source: 'SDEX', last_seen_at: new Date().toISOString() }],
    })
  })

  afterEach(() => {
    const index = venueAdapters.indexOf(testAdapter)
    if (index !== -1) venueAdapters.splice(index, 1)
  })

  it('lists registered venues with kind, selected network, configuration, and recent liveness', async () => {
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/venues/registry' })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.network).toBe('testnet')
    expect(body.venues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'SDEX', kind: 'orderbook', network: 'testnet', enabled: true, liveness: 'live' }),
      expect.objectContaining({ id: 'Soroswap', kind: 'amm', enabled: false, liveness: 'disabled' }),
      expect.objectContaining({ id: 'Aquarius', kind: 'amm', enabled: false, liveness: 'disabled' }),
    ]))
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('price_points'), ['testnet', expect.any(Array)])
    await app.close()
  })

  it('reflects newly registered adapters without changing the route', async () => {
    venueAdapters.push(testAdapter)
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/venues/registry?network=mainnet' })

    expect(response.statusCode).toBe(200)
    expect(response.json().venues).toContainEqual(expect.objectContaining({
      id: 'test-adapter', kind: 'amm', network: 'mainnet', enabled: true, liveness: 'stale', lastSeenAt: null,
    }))
    await app.close()
  })
})

describe('GET /venues?window= — Venue Share of Volume', () => {
  async function buildVenueApp() {
    const app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerVenueRoutes(app)
    await app.ready()
    return app
  }

  const sdexVolumeRows = [
    { source: 'SDEX', samples: 10, base_volume: 1000, counter_volume: 2000, last_seen: new Date() },
  ]
  const ammVolumeRows = [
    { source: 'AMM', samples: 5, base_volume: 500, counter_volume: 1000, last_seen: new Date() },
  ]
  const emptyRows = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calculates volume share across multiple active venues with shares summing to 100%', async () => {
    // Both SDEX and AMM have data in the current 24h window
    const combinedVolumeRows = [
      { source: 'SDEX', samples: 10, base_volume: 1000, counter_volume: 2000, last_seen: new Date() },
      { source: 'AMM', samples: 5, base_volume: 500, counter_volume: 1000, last_seen: new Date() },
    ]
    mockQuery
      .mockResolvedValueOnce({ rows: combinedVolumeRows })  // currentQuery
      .mockResolvedValueOnce({ rows: [] })  // previousQuery

    const app = await buildVenueApp()

    const response = await app.inject({ method: 'GET', url: '/venues?window=24h' })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.network).toBe('testnet')
    expect(body.window).toBe('24h')
    expect(body.venues.length).toBe(4)

    const sdex = body.venues.find((v: any) => v.venue === 'SDEX')
    const amm = body.venues.find((v: any) => v.venue === 'AMM')
    const soroswap = body.venues.find((v: any) => v.venue === 'soroswap_amm')
    const aquarius = body.venues.find((v: any) => v.venue === 'aquarius_amm')
    expect(sdex.baseVolume).toBe(1000)
    expect(amm.baseVolume).toBe(500)
    expect(soroswap.baseVolume).toBe(0)
    expect(aquarius.baseVolume).toBe(0)

// Shares must sum to ~100%
    const totalShare = sdex.marketShare + amm.marketShare + soroswap.marketShare + aquarius.marketShare
    expect(totalShare).toBeGreaterThanOrEqual(99.99)
    expect(totalShare).toBeLessThanOrEqual(100.01)

    expect(body.excludedVenues.sort()).toEqual(['aquarius_amm', 'soroswap_amm'])
    expect(body.periodOverPeriodPctChange).toBeDefined()

    await app.close()
  })

  it('accepts window values 24h, 7d, 30d', async () => {
    mockQuery.mockResolvedValue({ rows: emptyRows })

    for (const window of ['24h', '7d', '30d']) {
      const app = await buildVenueApp()
      const response = await app.inject({ method: 'GET', url: `/venues?window=${window}` })
      expect(response.statusCode).toBe(200)
      expect(response.json().window).toBe(window)
      await app.close()
    }
  })

  it('rejects invalid window with 400', async () => {
    mockQuery.mockResolvedValue({ rows: emptyRows })

    const app = await buildVenueApp()
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/venues?window=1y' })
    expect(response.statusCode).toBe(400)

    await app.close()
  })

  it('handles zero-trade venue gracefully (no zero-division) and reports staleness', async () => {
    // SDEX has trades, AMM has none → AMM is excluded/stale
    const sdexRows = [
      { source: 'SDEX', samples: 10, base_volume: 1000, counter_volume: 2000, last_seen: new Date() },
    ]
    mockQuery
      .mockResolvedValueOnce({ rows: sdexRows })  // currentQuery
      .mockResolvedValueOnce({ rows: [] })  // previousQuery

    const app = await buildVenueApp()

    const response = await app.inject({ method: 'GET', url: '/venues?window=24h' })

    expect(response.statusCode).toBe(200)
    const body = response.json()

    const amm = body.venues.find((v: any) => v.venue === 'AMM')
    expect(amm.baseVolume).toBe(0)
    expect(amm.marketShare).toBe(0)

    // SDEX should have ~100% share since it's the only one with volume
    const sdex = body.venues.find((v: any) => v.venue === 'SDEX')
    expect(sdex.marketShare).toBeCloseTo(100, 1)

    // AMM should be listed as excluded due to zero samples
    expect(body.excludedVenues).toContain('AMM')

    await app.close()
  })

  it('defaults to 24h when window is omitted', async () => {
    mockQuery.mockResolvedValue({ rows: emptyRows })

    const app = await buildVenueApp()
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/venues' })
    expect(response.statusCode).toBe(200)
    expect(response.json().window).toBe('24h')

    await app.close()
  })
})
