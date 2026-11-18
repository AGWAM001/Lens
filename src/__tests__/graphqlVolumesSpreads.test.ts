import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery }, prisma: {} }))
vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({ config: { pairs: [] }, activeNetwork: 'testnet' }))

import { registerGraphQL } from '../api/graphql'
import { registerVolumeRoutes } from '../routes/volumes'
import { registerSpreadsRoutes } from '../routes/spreads'

// #368: the GraphQL `volumes` and `spreads` queries share the REST routes'
// implementation. These tests drive both surfaces of one server with the same
// database rows and assert they answer alike.

const VOLUMES_QUERY = `query Volumes($asset: String!, $window: String, $network: String) {
  volumes(asset: $asset, window: $window, network: $network) {
    asset
    network
    window
    startTime
    endTime
    totals { net gross }
    netVolume
    grossVolume
    totalVolume
    venues { venue volume aggregator bid spreadBps }
    tradeCount
    netTradeCount
    grossTradeCount
    medianTradeSize
    topTradeVolumeShare
    volumeConcentration
    concentrationMeasure
    status
    provenance { venues sampleCount observedSampleCount latestTradeAt dataAgeSeconds }
  }
}`

const SPREADS_QUERY = `query Spreads($asset: String!, $window: String, $network: String) {
  spreads(asset: $asset, window: $window, network: $network) {
    asset
    network
    window
    startTime
    endTime
    venues { venue pairKey bid ask mid spreadBps spreadPct observations lastSeen volume }
    tightest { venue pairKey bid ask mid spreadBps spreadPct observations lastSeen }
  }
}`

/** One aggregate row as the volumes query returns it. */
const VOLUME_ROW = {
  total_volume: '160',
  by_venue: { amm: 49.5, aquarius: 10, sdex: 100.5 },
  venues: ['amm', 'aquarius', 'sdex'],
  trade_count_by_venue: { amm: 2, aquarius: 1, sdex: 3 },
  trade_count: 6,
  observed_sample_count: 7,
  median_trade_size: '25',
  top_trade_volume_share: '0.5',
  volume_concentration: '0.3',
  latest_trade_at: new Date('2026-09-01T12:00:00.000Z'),
}

/** One grouped row as the spreads query returns it. */
function spreadRow(source: string, pairKey: string, bid: string, ask: string, observations = 10) {
  return {
    source,
    pair_key: pairKey,
    bid,
    ask,
    observations,
    last_seen: new Date('2026-09-01T12:00:00.000Z'),
  }
}

const SPREAD_ROWS = [
  spreadRow('sdex', 'XLM/USDC', '90', '110'),
  spreadRow('amm', 'XLM/USDC', '99.9', '100.1'),
  spreadRow('sdex', 'XLM/EURC', '0.90', '0.92'),
  spreadRow('soroswap', 'XLM/USDC', '1', '1', 1), // dropped: single observation
]

/** Removes the per-request clock fields, which legitimately differ between two calls. */
function withoutClock<T extends Record<string, unknown>>(body: T) {
  const { startTime, endTime, provenance, ...rest } = body as Record<string, any>
  return {
    ...rest,
    ...(provenance ? { provenance: { ...provenance, dataAgeSeconds: undefined } } : {}),
  }
}

async function gql(app: FastifyInstance, query: string, variables: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/graphql', payload: { query, variables } })
  return res.json()
}

describe('GraphQL volumes and spreads queries (#368)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    app = Fastify({ logger: false })
    await registerVolumeRoutes(app)
    await registerSpreadsRoutes(app)
    await registerGraphQL(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('volumes', () => {
    beforeEach(() => {
      mockQuery.mockResolvedValue({ rows: [VOLUME_ROW] })
    })

    it('matches REST GET /volumes/:asset for the same input', async () => {
      const rest = (await app.inject({ method: 'GET', url: '/volumes/XLM?window=7d' })).json()
      const body = await gql(app, VOLUMES_QUERY, { asset: 'XLM', window: '7d' })

      expect(body.errors).toBeUndefined()
      const g = body.data.volumes

      // Every scalar REST reports, GraphQL reports identically.
      const { byVenue, venues: restVenueNames, ...restScalars } = withoutClock(rest) as any
      const { venues: gqlVenues, ...gqlScalars } = withoutClock(g) as any
      expect(gqlScalars).toEqual(restScalars)

      // The per-venue map becomes a typed list, in REST's venue order.
      expect(gqlVenues.map((v: any) => v.venue)).toEqual(restVenueNames)
      for (const v of gqlVenues) {
        expect(v.volume).toBe(byVenue[v.venue])
      }
      // Net excludes the aggregator on both surfaces.
      expect(g.totals).toEqual({ net: 150, gross: 160 })
      expect(gqlVenues.find((v: any) => v.venue === 'aquarius').aggregator).toBe(true)
      expect(gqlVenues.find((v: any) => v.venue === 'sdex').aggregator).toBe(false)
      // Spread-only fields are null on a volume quote.
      expect(gqlVenues[0].bid).toBeNull()
      expect(gqlVenues[0].spreadBps).toBeNull()
    })

    it('runs the same SQL with the same parameters as REST', async () => {
      await app.inject({ method: 'GET', url: '/volumes/XLM?network=mainnet' })
      await gql(app, VOLUMES_QUERY, { asset: 'XLM', network: 'mainnet' })

      const [restSql, restParams] = mockQuery.mock.calls[0] as [string, unknown[]]
      const [gqlSql, gqlParams] = mockQuery.mock.calls[1] as [string, unknown[]]
      expect(gqlSql).toBe(restSql)
      expect(gqlParams.slice(0, 2)).toEqual(['XLM', 'mainnet'])
      expect(gqlParams.slice(0, 2)).toEqual(restParams.slice(0, 2))
    })

    it('defaults to the active network and echoes it', async () => {
      const body = await gql(app, VOLUMES_QUERY, { asset: 'XLM' })
      expect(body.data.volumes.network).toBe('testnet')
      expect(body.data.volumes.window).toBe('24h')
      expect((mockQuery.mock.calls[0] as [string, unknown[]])[1][1]).toBe('testnet')
    })

    it('rejects an unknown network with INVALID_INPUT, as REST answers 400', async () => {
      const rest = await app.inject({ method: 'GET', url: '/volumes/XLM?network=devnet' })
      const body = await gql(app, VOLUMES_QUERY, { asset: 'XLM', network: 'devnet' })

      expect(rest.statusCode).toBe(400)
      expect(body.data).toBeNull()
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].message).toBe(rest.json().error)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('rejects an unknown window with INVALID_INPUT, as REST answers 400', async () => {
      const rest = await app.inject({ method: 'GET', url: '/volumes/XLM?window=1y' })
      const body = await gql(app, VOLUMES_QUERY, { asset: 'XLM', window: '1y' })

      expect(rest.statusCode).toBe(400)
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].message).toBe(rest.json().error)
    })

    it('masks a database failure instead of leaking it', async () => {
      mockQuery.mockRejectedValue(new Error('connection refused to 10.0.0.5'))
      const body = await gql(app, VOLUMES_QUERY, { asset: 'XLM' })
      expect(body.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR')
      expect(JSON.stringify(body)).not.toMatch(/connection refused/)
    })
  })

  describe('spreads', () => {
    beforeEach(() => {
      mockQuery.mockResolvedValue({ rows: SPREAD_ROWS })
    })

    it('matches REST GET /spreads/:asset for the same input', async () => {
      const rest = (await app.inject({ method: 'GET', url: '/spreads/XLM?window=1h' })).json()
      const body = await gql(app, SPREADS_QUERY, { asset: 'XLM', window: '1h' })

      expect(body.errors).toBeUndefined()
      const g = body.data.spreads
      const { venues, tightest, ...scalars } = withoutClock(g) as any
      const { venues: restVenues, tightest: restTightest, ...restScalars } = withoutClock(rest) as any

      expect(scalars).toEqual(restScalars)
      // A typed list of venue quotes, same entries and order (tightest first).
      expect(venues.map(({ volume, ...v }: any) => v)).toEqual(restVenues)
      expect(venues.every((v: any) => v.volume === null)).toBe(true)
      expect(tightest).toEqual(restTightest)
      expect(tightest.venue).toBe('amm')
      // The single-observation venue is dropped on both surfaces.
      expect(venues.some((v: any) => v.venue === 'soroswap')).toBe(false)
    })

    it('keeps (venue, pair) grouping: two pairs on one venue stay separate', async () => {
      const body = await gql(app, SPREADS_QUERY, { asset: 'XLM' })
      const sdex = body.data.spreads.venues.filter((v: any) => v.venue === 'sdex')
      expect(sdex.map((v: any) => v.pairKey).sort()).toEqual(['XLM/EURC', 'XLM/USDC'])
    })

    it('is network-aware: passes the requested network to the query', async () => {
      const body = await gql(app, SPREADS_QUERY, { asset: 'XLM', network: 'mainnet' })
      expect(body.data.spreads.network).toBe('mainnet')
      expect((mockQuery.mock.calls[0] as [string, unknown[]])[1][1]).toBe('mainnet')
    })

    it('defaults to the active network and the 5m window', async () => {
      const body = await gql(app, SPREADS_QUERY, { asset: 'XLM' })
      expect(body.data.spreads.network).toBe('testnet')
      expect(body.data.spreads.window).toBe('5m')
    })

    it('returns tightest: null, not a zeroed quote, when nobody quoted the asset', async () => {
      mockQuery.mockResolvedValue({ rows: [] })
      const rest = (await app.inject({ method: 'GET', url: '/spreads/XLM' })).json()
      const body = await gql(app, SPREADS_QUERY, { asset: 'XLM' })
      expect(rest.tightest).toBeNull()
      expect(body.data.spreads.tightest).toBeNull()
      expect(body.data.spreads.venues).toEqual([])
    })

    it('rejects an unknown network or window with INVALID_INPUT, as REST answers 400', async () => {
      for (const [qs, variables] of [
        ['network=devnet', { network: 'devnet' }],
        ['window=7d', { window: '7d' }],
      ] as const) {
        const rest = await app.inject({ method: 'GET', url: `/spreads/XLM?${qs}` })
        const body = await gql(app, SPREADS_QUERY, { asset: 'XLM', ...variables })
        expect(rest.statusCode).toBe(400)
        expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
        expect(body.errors[0].message).toBe(rest.json().error)
      }
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('rejects an empty asset with INVALID_INPUT', async () => {
      const body = await gql(app, SPREADS_QUERY, { asset: '' })
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(mockQuery).not.toHaveBeenCalled()
    })
  })
})
