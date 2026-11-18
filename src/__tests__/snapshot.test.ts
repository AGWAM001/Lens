import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import Ajv from 'ajv'

const { mockQuery, mockGetCachedSnapshot, mockSetCachedSnapshot, configState } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedSnapshot: vi.fn(),
  mockSetCachedSnapshot: vi.fn(),
  configState: {
    active: 'testnet',
    pairs: {} as Record<string, unknown[]>,
  },
}))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))

vi.mock('../redis', () => ({
  getCachedSnapshot: mockGetCachedSnapshot,
  setCachedSnapshot: mockSetCachedSnapshot,
}))

vi.mock('../config', () => ({
  activeNetwork: configState.active,
  getNetworkConfig: (network: string) => ({
    pairs: configState.pairs[network] ?? [],
    soroswap: { enabled: true },
    aquarius: { enabled: network === 'mainnet' },
  }),
  config: { cache: { snapshotTtl: 15 } },
}))

import { registerSnapshotRoutes } from '../routes/snapshot'
import { snapshotResponseSchema } from '../api/schemas'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDT_ISSUER = 'GCQTGZRCLVOJWLAW3P5OTFXPCD3HH4HAJ5DVVQMVJ4BQ7ZOBHYP3F7M'

const PAIR_KEY = `USDC:${USDC_ISSUER}/XLM`

const pairUsdcXlm = {
  assetA: { code: 'USDC', issuer: USDC_ISSUER },
  assetB: { code: 'XLM', issuer: null },
  pairKey: PAIR_KEY,
}
const pairUsdcUsdt = {
  assetA: { code: 'USDC', issuer: USDC_ISSUER },
  assetB: { code: 'USDT', issuer: USDT_ISSUER },
  pairKey: `USDC:${USDC_ISSUER}/USDT:${USDT_ISSUER}`,
}

/** The row shape a single CTE query returns: one row, all sections as JSON. */
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        as_of: new Date('2026-10-17T12:00:00.000Z'),
        venues: [],
        series: [],
        latest: [],
        pools: [],
        ...overrides,
      },
    ],
  }
}

const populated = {
  venues: [
    { source: 'SDEX', samples: 50, last_seen: '2026-10-17T11:59:50.000Z' },
    { source: 'AMM', samples: 20, last_seen: '2026-10-17T11:59:00.000Z' },
  ],
  series: [
    {
      source: 'SDEX',
      pair_key: PAIR_KEY,
      samples_24h: 40,
      base_volume_24h: 1000,
      counter_volume_24h: 5500,
      last_seen_24h: '2026-10-17T11:59:50.000Z',
    },
    {
      source: 'AMM',
      pair_key: PAIR_KEY,
      samples_24h: 15,
      base_volume_24h: 400,
      counter_volume_24h: 2200,
      last_seen_24h: '2026-10-17T11:59:00.000Z',
    },
  ],
  latest: [{ pair_key: PAIR_KEY, price: 5.5, last_seen: '2026-10-17T11:59:50.000Z' }],
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerSnapshotRoutes(app)
  await app.ready()
  return app
}

function validateSchema(body: unknown) {
  const ajv = new Ajv({ allErrors: true })
  const validate = ajv.compile(snapshotResponseSchema as object)
  const ok = validate(body)
  expect(ok, ajv.errorsText(validate.errors)).toBe(true)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCachedSnapshot.mockResolvedValue(null)
  mockSetCachedSnapshot.mockResolvedValue(undefined)
  configState.pairs = {
    testnet: [pairUsdcXlm],
    mainnet: [pairUsdcXlm],
  }
})

describe('GET /snapshot', () => {
  it('returns the whole-network summary in one consistent read', async () => {
    mockQuery.mockResolvedValue(dbRow(populated))

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/snapshot' })
    const body = res.json()

    expect(res.statusCode).toBe(200)
    expect(body.network).toBe('testnet')
    expect(body.asOf).toBe('2026-10-17T12:00:00.000Z')
    expect(body.window).toBe('24h')
    expect(body.cache).toEqual({
      ttlSeconds: 15,
      maxAgeSeconds: 15,
      hit: false,
      storedAt: '2026-10-17T12:00:00.000Z',
      ageSeconds: 0,
    })

    // One statement, scoped to the network, is what makes `asOf` trustworthy.
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][1]).toEqual(['testnet'])
    expect(mockQuery.mock.calls[0][0]).toMatch(/FROM price_points[\s\S]*network = \$1/)

    validateSchema(body)
    await app.close()
  })

  it('reports every venue, including the enabled-but-silent one', async () => {
    mockQuery.mockResolvedValue(dbRow(populated))
    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

    expect(body.venues).toEqual([
      {
        name: 'SDEX',
        source: 'SDEX',
        type: 'orderbook',
        enabled: true,
        status: 'reporting',
        samples: 50,
        samples24h: 40,
        pairs24h: 1,
        lastUpdated: '2026-10-17T11:59:50.000Z',
        ageSeconds: 10,
      },
      {
        name: 'AMM',
        source: 'AMM',
        type: 'amm',
        enabled: true,
        status: 'reporting',
        samples: 20,
        samples24h: 15,
        pairs24h: 1,
        lastUpdated: '2026-10-17T11:59:00.000Z',
        ageSeconds: 60,
      },
      {
        name: 'Soroswap',
        source: 'soroswap_amm',
        type: 'amm',
        enabled: true,
        status: 'silent',
        samples: 0,
        samples24h: 0,
        pairs24h: 0,
        lastUpdated: null,
        ageSeconds: null,
      },
      {
        name: 'Aquarius',
        source: 'aquarius_amm',
        type: 'amm',
        enabled: false,
        status: 'disabled',
        samples: 0,
        samples24h: 0,
        pairs24h: 0,
        lastUpdated: null,
        ageSeconds: null,
      },
    ])
    await app.close()
  })

  it('sums volume per venue and returns a single-unit total', async () => {
    mockQuery.mockResolvedValue(dbRow(populated))
    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

    expect(body.volume24h.window).toBe('24h')
    expect(body.volume24h.sampleCount).toBe(55)
    expect(body.volume24h.byVenue).toEqual([
      {
        venue: 'AMM',
        baseVolume: 400,
        counterVolume: 2200,
        samples: 15,
        pairs: 1,
        lastUpdated: '2026-10-17T11:59:00.000Z',
        ageSeconds: 60,
      },
      {
        venue: 'SDEX',
        baseVolume: 1000,
        counterVolume: 5500,
        samples: 40,
        pairs: 1,
        lastUpdated: '2026-10-17T11:59:50.000Z',
        ageSeconds: 10,
      },
    ])
    expect(body.volume24h.total).toEqual({
      value: 1400,
      unit: { code: 'USDC', issuer: USDC_ISSUER },
      reason: null,
    })
    await app.close()
  })

  it('reports a null total with a reason when pairs do not share a unit', async () => {
    configState.pairs.testnet = [
      pairUsdcXlm,
      {
        assetA: { code: 'BTC', issuer: 'GBTC' },
        assetB: { code: 'EUR', issuer: 'GEUR' },
        pairKey: 'BTC:GBTC/EUR:GEUR',
      },
    ]
    mockQuery.mockResolvedValue(
      dbRow({
        series: [
          { source: 'SDEX', pair_key: PAIR_KEY, samples_24h: 3, base_volume_24h: 10, counter_volume_24h: 55, last_seen_24h: '2026-10-17T11:59:00.000Z' },
          { source: 'SDEX', pair_key: 'BTC:GBTC/EUR:GEUR', samples_24h: 2, base_volume_24h: 1, counter_volume_24h: 50000, last_seen_24h: '2026-10-17T11:59:00.000Z' },
        ],
        latest: [{ pair_key: PAIR_KEY, price: 5.5, last_seen: '2026-10-17T11:59:00.000Z' }],
      }),
    )
    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

    expect(body.volume24h.total.value).toBeNull()
    expect(body.volume24h.total.unit).toBeNull()
    expect(body.volume24h.total.reason).toMatch(/base and .* counter assets/)
    await app.close()
  })

  it('ranks top pairs, keeping the issuer and the price direction', async () => {
    mockQuery.mockResolvedValue(dbRow(populated))
    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

    expect(body.topPairs[0]).toEqual({
      pairKey: PAIR_KEY,
      configured: true,
      assetA: { code: 'USDC', issuer: USDC_ISSUER },
      assetB: { code: 'XLM', issuer: null },
      price: 5.5,
      baseVolume24h: 1400,
      counterVolume24h: 7700,
      samples24h: 55,
      venues: ['AMM', 'SDEX'],
      lastUpdated: '2026-10-17T11:59:50.000Z',
      ageSeconds: 10,
    })
    await app.close()
  })

  it('reports TVL as per-asset reserves with pool detail', async () => {
    mockQuery.mockResolvedValue(
      dbRow({
        pools: [
          {
            pool_id: 'CPOOL',
            asset_a: 'USDC',
            asset_b: 'XLM',
            reserve_a: 1234.5,
            reserve_b: 6789,
            spot_price: 5.5,
            fee_bp: 30,
            timestamp: '2026-10-17T11:58:00.000Z',
            pair_key: PAIR_KEY,
          },
        ],
      }),
    )
    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

    expect(body.tvl.poolCount).toBe(1)
    expect(body.tvl.stale).toBe(false)
    expect(body.tvl.byAsset).toEqual([
      { asset: { code: 'XLM', issuer: null }, amount: 6789, pools: 1 },
      { asset: { code: 'USDC', issuer: USDC_ISSUER }, amount: 1234.5, pools: 1 },
    ])
    expect(body.tvl.pools[0]).toMatchObject({
      poolId: 'CPOOL',
      pairKey: PAIR_KEY,
      assetA: { code: 'USDC', issuer: USDC_ISSUER },
      assetB: { code: 'XLM', issuer: null },
      reserveA: 1234.5,
      reserveB: 6789,
      spotPrice: 5.5,
      feeBp: 30,
    })
    await app.close()
  })

  it('summarises freshness from the single as_of clock', async () => {
    mockQuery.mockResolvedValue(dbRow(populated))
    const app = await buildApp()
    const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

    expect(body.freshness).toEqual({
      asOf: '2026-10-17T12:00:00.000Z',
      windowStart: '2026-10-16T12:00:00.000Z',
      windowEnd: '2026-10-17T12:00:00.000Z',
      lastUpdated: '2026-10-17T11:59:50.000Z',
      ageSeconds: 10,
      staleAfterSeconds: 300,
      stale: false,
      venuesReporting: 2,
      venuesExpected: 3,
      venuesSilent: 1,
    })
    await app.close()
  })

  describe('pegs', () => {
    it('measures a stablecoin against a fiat-target sibling', async () => {
      configState.pairs.testnet = [pairUsdcUsdt]
      mockQuery.mockResolvedValue(
        dbRow({
          series: [
            { source: 'SDEX', pair_key: pairUsdcUsdt.pairKey, samples_24h: 12, base_volume_24h: 500, counter_volume_24h: 500, last_seen_24h: '2026-10-17T11:59:00.000Z' },
          ],
          latest: [{ pair_key: pairUsdcUsdt.pairKey, price: 1.0005, last_seen: '2026-10-17T11:59:00.000Z' }],
        }),
      )
      const app = await buildApp()
      const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

      const peg = body.pegs.find((p: { asset: { code: string } }) => p.asset.code === 'USDC')
      expect(peg.target).toBe('USD')
      expect(peg.status).toBe('on_peg')
      expect(peg.price).toBeCloseTo(1.0005)
      expect(peg.deviationBp).toBeCloseTo(5)
      await app.close()
    })

    it('flags an off-peg reading beyond the tolerance', async () => {
      configState.pairs.testnet = [pairUsdcUsdt]
      mockQuery.mockResolvedValue(
        dbRow({
          latest: [{ pair_key: pairUsdcUsdt.pairKey, price: 1.05, last_seen: '2026-10-17T11:59:00.000Z' }],
        }),
      )
      const app = await buildApp()
      const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

      const peg = body.pegs.find((p: { asset: { code: string } }) => p.asset.code === 'USDC')
      expect(peg.status).toBe('off_peg')
      expect(peg.deviationBp).toBeGreaterThan(100)
      await app.close()
    })

    it('says no_reference when quoted in an asset that is not the target', async () => {
      mockQuery.mockResolvedValue(dbRow(populated))
      const app = await buildApp()
      const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

      const peg = body.pegs.find((p: { asset: { code: string } }) => p.asset.code === 'USDC')
      expect(peg.status).toBe('no_reference')
      expect(peg.deviationBp).toBeNull()
      expect(peg.reason).toMatch(/not USD/)
      await app.close()
    })

    it('says no_data when the pair has no observed price', async () => {
      mockQuery.mockResolvedValue(dbRow())
      const app = await buildApp()
      const body = (await app.inject({ method: 'GET', url: '/snapshot' })).json()

      const peg = body.pegs.find((p: { asset: { code: string } }) => p.asset.code === 'USDC')
      expect(peg.status).toBe('no_data')
      expect(peg.price).toBeNull()
      await app.close()
    })
  })

  it('is honest, not empty-handed, when nothing has been ingested yet', async () => {
    mockQuery.mockResolvedValue(dbRow())
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/snapshot' })
    const body = res.json()

    expect(res.statusCode).toBe(200)
    expect(body.topPairs).toEqual([])
    expect(body.volume24h.total).toEqual({
      value: null,
      unit: null,
      reason: 'no trades in the last 24h',
    })
    expect(body.tvl.poolCount).toBe(0)
    expect(body.freshness.lastUpdated).toBeNull()
    expect(body.freshness.stale).toBe(true)
    validateSchema(body)
    await app.close()
  })

  describe('caching', () => {
    it('serves a cache hit without touching the database, but republishing its age', async () => {
      const storedAt = new Date(Date.now() - 4000).toISOString()
      mockGetCachedSnapshot.mockResolvedValue(
        JSON.stringify({
          network: 'testnet',
          asOf: storedAt,
          generatedAt: storedAt,
          window: '24h',
          cache: { ttlSeconds: 15, maxAgeSeconds: 15, hit: false, storedAt, ageSeconds: 0 },
          venues: [],
          tvl: { note: '', poolCount: 0, sampleCount: 0, lastUpdated: null, ageSeconds: null, stale: false, byAsset: [], pools: [] },
          volume24h: { window: '24h', sampleCount: 0, byVenue: [], total: { value: null, unit: null, reason: 'no trades in the last 24h' } },
          topPairs: [],
          pegs: [],
          freshness: {
            asOf: storedAt,
            windowStart: storedAt,
            windowEnd: storedAt,
            lastUpdated: null,
            ageSeconds: null,
            staleAfterSeconds: 300,
            stale: true,
            venuesReporting: 0,
            venuesExpected: 0,
            venuesSilent: 0,
          },
        }),
      )

      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/snapshot' })
      const body = res.json()

      expect(res.headers['x-cache']).toBe('HIT')
      expect(res.headers['cache-control']).toBe('public, max-age=15')
      expect(body.cache.hit).toBe(true)
      expect(body.cache.ageSeconds).toBeGreaterThanOrEqual(3)
      expect(mockQuery).not.toHaveBeenCalled()
      await app.close()
    })

    it('stores a miss under the network key with the configured TTL', async () => {
      mockQuery.mockResolvedValue(dbRow(populated))
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/snapshot' })

      expect(res.headers['x-cache']).toBe('MISS')
      expect(mockSetCachedSnapshot).toHaveBeenCalledWith('testnet', expect.objectContaining({ network: 'testnet' }), 15)
      await app.close()
    })
  })

  describe('network scoping', () => {
    it('queries and echoes the requested network', async () => {
      mockQuery.mockResolvedValue(dbRow(populated))
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/snapshot?network=mainnet' })

      expect(res.json().network).toBe('mainnet')
      expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet'])
      await app.close()
    })

    it('rejects an unknown network with 400 and issues no query', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/snapshot?network=futurenet' })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/network must be one of/)
      expect(mockQuery).not.toHaveBeenCalled()
      await app.close()
    })
  })

  it('returns 500 when the aggregation query fails', async () => {
    mockQuery.mockRejectedValue(new Error('db down'))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/snapshot' })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({
      code: 'internal_error',
      message: 'An internal server error occurred.',
      correlationId: expect.any(String),
    })
    expect(res.body).not.toMatch(/db down/)
    await app.close()
  })
})
