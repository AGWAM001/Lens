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
