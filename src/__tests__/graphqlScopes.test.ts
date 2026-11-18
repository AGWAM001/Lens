import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import type { AddressInfo } from 'net'
import { buildSchema } from 'graphql'
import type { ApiKeyContext } from '../api/auth'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const SUBPROTOCOL = 'graphql-transport-ws'

const mocks = vi.hoisted(() => {
  const usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  const keys: Record<string, ApiKeyContext> = {
    prices: {
      id: 'k-prices',
      label: 'prices-only',
      ratePerMin: 100,
      ratePerDay: 1000,
      scopes: ['read:prices'],
    },
    history: {
      id: 'k-history',
      label: 'history-only',
      ratePerMin: 100,
      ratePerDay: 1000,
      scopes: ['read:history'],
    },
    subscribe: {
      id: 'k-subscribe',
      label: 'subscribe-only',
      ratePerMin: 100,
      ratePerDay: 1000,
      scopes: ['subscribe'],
    },
    multi: {
      id: 'k-multi',
      label: 'multi-scope',
      ratePerMin: 100,
      ratePerDay: 1000,
      scopes: ['read:prices', 'read:history'],
    },
    wildcard: {
      id: 'k-wild',
      label: 'wildcard-admin',
      ratePerMin: 100,
      ratePerDay: 1000,
      scopes: ['*'],
    },
    unscoped: {
      id: 'k-all',
      label: 'legacy-unscoped',
      ratePerMin: 100,
      ratePerDay: 1000,
      scopes: [],
    },
    insufficient: {
      id: 'k-none',
      label: 'unrelated-scope',
      ratePerMin: 100,
      ratePerDay: 1000,
      scopes: ['read:unrelated'],
    },
  }

  return {
    keys,
    lookupApiKey: vi.fn(async (key: string) => keys[key] ?? null),
    getCachedPrice: vi.fn(),
    getAggregatedPrice: vi.fn(),
    getBestRoute: vi.fn(),
    pgPoolQuery: vi.fn(),
    compareOracles: vi.fn(),
    runScreener: vi.fn(),
    computeVolumes: vi.fn(),
    computeSpreads: vi.fn(),
    pairs: [
      {
        pairKey: `USDC:${usdcIssuer}/XLM`,
        assetA: { code: 'USDC', issuer: usdcIssuer },
        assetB: { code: 'XLM', issuer: null },
      },
      {
        pairKey: 'XLM/USDC',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: usdcIssuer },
      },
    ],
  }
})

vi.mock('../redis', () => ({ getCachedPrice: mocks.getCachedPrice }))
vi.mock('../db', () => ({ pgPool: { query: mocks.pgPoolQuery }, prisma: {} }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mocks.getBestRoute }))
vi.mock('../services/oracleComparison', () => ({ compareOracles: mocks.compareOracles }))
vi.mock('../services/screener', () => ({
  runScreener: mocks.runScreener,
  ALLOWED_SORT_FIELDS: ['volume', 'change_24h', 'price', 'liquidity'],
  MARKET_CAP_CODE: 'UNSUPPORTED_PARAMETER',
  MARKET_CAP_UNSUPPORTED: 'market_cap unsupported',
  ScreenerCursorError: class extends Error {},
  ScreenerSortError: class extends Error {},
  SCREENER_DEFAULT_LIMIT: 20,
  SCREENER_MAX_LIMIT: 100,
}))
vi.mock('../routes/volumes', () => ({
  computeVolumes: mocks.computeVolumes,
  VolumesInputError: class extends Error {},
}))
vi.mock('../routes/spreads', () => ({
  computeSpreads: mocks.computeSpreads,
  SpreadsInputError: class extends Error {},
}))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  config: {
    pairs: mocks.pairs,
  },
}))
vi.mock('../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/auth')>()
  return {
    ...actual,
    lookupApiKey: mocks.lookupApiKey,
  }
})

import {
  registerGraphQL,
  FIELD_SCOPES,
  resolvers,
  schema as codeSchema,
} from '../api/graphql'

const KEYS = mocks.keys

function connect(url: string, payload?: any): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, SUBPROTOCOL)
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init', payload })))
    ws.on('message', function onAck(raw) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'connection_ack') {
        ws.off('message', onAck)
        resolve(ws)
      }
    })
  })
}

function waitFor(ws: WebSocket, type: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`timed out waiting for "${type}"`))
    }, timeoutMs)
    function onMsg(raw: WebSocket.RawData) {
      const msg = JSON.parse(raw.toString())
      if (msg.type === type) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
  })
}

async function buildServer(): Promise<{ app: FastifyInstance; wsUrl: string }> {
  const app = Fastify({ logger: false })

  app.addHook('onRequest', async (req) => {
    const authHeader = req.headers['authorization']
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const keyName = authHeader.slice(7).trim()
      if (KEYS[keyName]) {
        req.apiKey = KEYS[keyName]
      }
    }
  })

  await registerGraphQL(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { app, wsUrl: `ws://127.0.0.1:${port}/graphql` }
}

async function queryGraphQL(
  app: FastifyInstance,
  query: string,
  keyName?: string,
  variables: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {}
  if (keyName) {
    headers['authorization'] = `Bearer ${keyName}`
  }
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers,
    payload: { query, variables },
  })
  return {
    statusCode: res.statusCode,
    body: res.json(),
  }
}

describe('GraphQL per-route scope enforcement (#618)', () => {
  let app: FastifyInstance
  let wsUrl: string

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.getCachedPrice.mockResolvedValue(null)
    mocks.getAggregatedPrice.mockResolvedValue({
      price: 0.12,
      sdexPrice: 0.12,
      ammPrice: 0.12,
      volume24h: 1000,
    })
    mocks.getBestRoute.mockResolvedValue({ route: 'SDEX' })
    mocks.pgPoolQuery.mockResolvedValue({ rows: [] })
    mocks.compareOracles.mockResolvedValue({
      asset: 'XLM',
      network: 'testnet',
      lens: 0.12,
      reflector: 0.12,
      deviationPct: 0,
      status: 'aligned',
      fetchedAt: new Date().toISOString(),
      oracles: [{ name: 'Reflector', price: 0.12, timestamp: new Date().toISOString(), status: 'available', deviationPct: 0, ageSeconds: 10 }],
    })
    mocks.runScreener.mockResolvedValue({
      network: 'testnet',
      hasMore: false,
      nextCursor: null,
      data: [],
    })
    mocks.computeVolumes.mockResolvedValue({
      asset: 'XLM',
      network: 'testnet',
      window: '24h',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      totals: { net: 500, gross: 500 },
      netVolume: 500,
      grossVolume: 500,
      totalVolume: 500,
      byVenue: { sdex: 500 },
      venues: ['sdex'],
      tradeCount: 1,
      netTradeCount: 1,
      grossTradeCount: 1,
      medianTradeSize: 500,
      topTradeVolumeShare: 1,
      volumeConcentration: 1,
      concentrationMeasure: 'hhi',
      status: 'ok',
      provenance: {
        venues: ['sdex'],
        sampleCount: 1,
        observedSampleCount: 1,
        latestTradeAt: new Date().toISOString(),
        dataAgeSeconds: 0,
      },
    })
    mocks.computeSpreads.mockResolvedValue({
      venues: [],
      tightestVenue: null,
      widestVenue: null,
      asset: 'XLM',
      window: '5m',
      network: 'testnet',
    })

    const server = await buildServer()
    app = server.app
    wsUrl = server.wsUrl
  })

  afterEach(async () => {
    await app.close()
  })

  describe('Single-field queries assert scope matching REST equivalents', () => {
    it('getPrice requires read:prices and rejects read:history', async () => {
      const query = `{ getPrice(assetA: "XLM", assetB: "USDC:${USDC_ISSUER}") { price } }`

      // Refusal with insufficient key
      const refused = await queryGraphQL(app, query, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors).toBeDefined()
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')
      expect(refused.body.errors[0].message).toContain('Missing required scope: read:prices')

      // Success with sufficient key
      const success = await queryGraphQL(app, query, 'prices')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.getPrice.price).toBe(0.12)
    })

    it('getBestRoute requires read:prices and rejects read:history', async () => {
      const query = `{ getBestRoute(assetA: "XLM", assetB: "USDC:${USDC_ISSUER}", amount: 100) { route } }`

      const refused = await queryGraphQL(app, query, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')

      const success = await queryGraphQL(app, query, 'prices')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.getBestRoute.route).toBe('SDEX')
    })

    it('getPriceHistory requires read:history and rejects read:prices', async () => {
      const query = `{ getPriceHistory(assetA: "XLM", assetB: "USDC:${USDC_ISSUER}", window: "1d") { bucket } }`

      const refused = await queryGraphQL(app, query, 'prices')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:history')

      const success = await queryGraphQL(app, query, 'history')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.getPriceHistory).toEqual([])
    })

    it('listPairs requires read:prices and rejects read:history', async () => {
      const query = `{ listPairs }`

      const refused = await queryGraphQL(app, query, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')

      const success = await queryGraphQL(app, query, 'prices')
      expect(success.statusCode).toBe(200)
      expect(Array.isArray(success.body.data.listPairs)).toBe(true)
    })

    it('pairs requires read:prices and rejects read:history', async () => {
      const query = `{ pairs { pairKey } }`

      const refused = await queryGraphQL(app, query, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')

      const success = await queryGraphQL(app, query, 'prices')
      expect(success.statusCode).toBe(200)
      expect(Array.isArray(success.body.data.pairs)).toBe(true)
    })

    it('oracle requires read:prices and rejects read:history', async () => {
      const query = `{ oracle(asset: "XLM") { lens } }`

      const refused = await queryGraphQL(app, query, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')

      const success = await queryGraphQL(app, query, 'prices')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.oracle.lens).toBe(0.12)
    })

    it('screener requires read:prices and rejects read:history', async () => {
      const query = `{ screener { rows { pairKey } } }`

      const refused = await queryGraphQL(app, query, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')

      const success = await queryGraphQL(app, query, 'prices')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.screener.rows).toEqual([])
    })

    it('volumes requires read:prices and rejects read:history', async () => {
      const query = `{ volumes(asset: "XLM") { totalVolume } }`

      const refused = await queryGraphQL(app, query, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')

      const success = await queryGraphQL(app, query, 'prices')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.volumes.totalVolume).toBe(500)
    })

    it('spreads requires read:prices and rejects read:history', async () => {
      const query = `{ spreads(asset: "XLM") { asset } }`

      const refused = await queryGraphQL(app, query, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')

      const success = await queryGraphQL(app, query, 'prices')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.spreads.asset).toBe('XLM')
    })
  })

  describe('Multi-field documents require the union of fields\' scopes', () => {
    const multiQuery = `{
      getPrice(assetA: "XLM", assetB: "USDC:${USDC_ISSUER}") { price }
      getPriceHistory(assetA: "XLM", assetB: "USDC:${USDC_ISSUER}", window: "1d") { bucket }
    }`

    it('refuses a key that only has read:prices when read:history is also selected', async () => {
      const res = await queryGraphQL(app, multiQuery, 'prices')
      expect(res.statusCode).toBe(403)
      expect(res.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(res.body.errors[0].extensions.requiredScope).toBe('read:history')
      // No resolver runs
      expect(res.body.data).toBeNull()
    })

    it('refuses a key that only has read:history when read:prices is also selected', async () => {
      const res = await queryGraphQL(app, multiQuery, 'history')
      expect(res.statusCode).toBe(403)
      expect(res.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(res.body.errors[0].extensions.requiredScope).toBe('read:prices')
      expect(res.body.data).toBeNull()
    })

    it('succeeds when a key possesses the union of all required scopes', async () => {
      const res = await queryGraphQL(app, multiQuery, 'multi')
      expect(res.statusCode).toBe(200)
      expect(res.body.data.getPrice.price).toBe(0.12)
      expect(res.body.data.getPriceHistory).toEqual([])
    })

    it('succeeds with wildcard * key', async () => {
      const res = await queryGraphQL(app, multiQuery, 'wildcard')
      expect(res.statusCode).toBe(200)
      expect(res.body.data.getPrice.price).toBe(0.12)
    })

    it('succeeds with unscoped key (which grants all access per REST rules)', async () => {
      const res = await queryGraphQL(app, multiQuery, 'unscoped')
      expect(res.statusCode).toBe(200)
      expect(res.body.data.getPrice.price).toBe(0.12)
    })
  })

  describe('Fragment and alias extraction of scopes', () => {
    it('enforces union across inline fragments and fragment spreads', async () => {
      const fragmentQuery = `
        query {
          ...PriceFrag
          ... on Query {
            getPriceHistory(assetA: "XLM", assetB: "USDC:${USDC_ISSUER}", window: "1d") { bucket }
          }
        }
        fragment PriceFrag on Query {
          getPrice(assetA: "XLM", assetB: "USDC:${USDC_ISSUER}") { price }
        }
      `

      // Key with only read:prices is refused because inline fragment requires read:history
      const res = await queryGraphQL(app, fragmentQuery, 'prices')
      expect(res.statusCode).toBe(403)
      expect(res.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(res.body.errors[0].extensions.requiredScope).toBe('read:history')

      const success = await queryGraphQL(app, fragmentQuery, 'multi')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.getPrice.price).toBe(0.12)
    })

    it('extracts field scope correctly when aliased', async () => {
      const aliasedQuery = `{
        myCustomPriceAlias: getPrice(assetA: "XLM", assetB: "USDC:${USDC_ISSUER}") { price }
      }`

      const refused = await queryGraphQL(app, aliasedQuery, 'history')
      expect(refused.statusCode).toBe(403)
      expect(refused.body.errors[0].extensions.code).toBe('insufficient_scope')
      expect(refused.body.errors[0].extensions.requiredScope).toBe('read:prices')

      const success = await queryGraphQL(app, aliasedQuery, 'prices')
      expect(success.statusCode).toBe(200)
      expect(success.body.data.myCustomPriceAlias.price).toBe(0.12)
    })
  })

  describe('WebSocket subscriptions scope check', () => {
    it('refuses subscription if API key lacks subscribe scope', async () => {
      const ws = await connect(wsUrl, { authorization: 'Bearer prices' })
      const errorPromise = waitFor(ws, 'error', 3000)

      ws.send(JSON.stringify({
        id: '1',
        type: 'subscribe',
        payload: {
          query: `subscription { priceUpdated(pair: "XLM/USDC") { pair price } }`,
        },
      }))

      const errMsg = await errorPromise
      expect(errMsg.id).toBe('1')
      expect(errMsg.payload[0].extensions.code).toBe('insufficient_scope')
      expect(errMsg.payload[0].extensions.requiredScope).toBe('subscribe')
      ws.close()
    })

    it('allows subscription when key possesses subscribe scope', async () => {
      const ws = await connect(wsUrl, { authorization: 'Bearer subscribe' })

      ws.send(JSON.stringify({
        id: '2',
        type: 'subscribe',
        payload: {
          query: `subscription { priceUpdated(pair: "XLM/USDC") { pair price } }`,
        },
      }))

      // Wait a moment without error
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(ws.readyState).toBe(WebSocket.OPEN)
      ws.close()
    })
  })

  describe('Registry and Schema Drift Guard', () => {
    it('every query, mutation and subscription field in the schema has an explicit scope declared in FIELD_SCOPES', () => {
      const parsed = buildSchema(codeSchema)

      const queryFields = parsed.getQueryType()?.getFields() ?? {}
      for (const fieldName of Object.keys(queryFields)) {
        expect(
          FIELD_SCOPES[fieldName],
          `Query field "${fieldName}" in schema has no scope declared in FIELD_SCOPES!`,
        ).toBeDefined()
        expect(typeof FIELD_SCOPES[fieldName]).toBe('string')
        expect(FIELD_SCOPES[fieldName].length).toBeGreaterThan(0)
      }

      const subFields = parsed.getSubscriptionType()?.getFields() ?? {}
      for (const fieldName of Object.keys(subFields)) {
        expect(
          FIELD_SCOPES[fieldName],
          `Subscription field "${fieldName}" in schema has no scope declared in FIELD_SCOPES!`,
        ).toBeDefined()
        expect(typeof FIELD_SCOPES[fieldName]).toBe('string')
        expect(FIELD_SCOPES[fieldName].length).toBeGreaterThan(0)
      }

      if (parsed.getMutationType()) {
        const mutFields = parsed.getMutationType()?.getFields() ?? {}
        for (const fieldName of Object.keys(mutFields)) {
          expect(
            FIELD_SCOPES[fieldName],
            `Mutation field "${fieldName}" in schema has no scope declared in FIELD_SCOPES!`,
          ).toBeDefined()
        }
      }
    })

    it('every resolver in resolvers object declares matching _scope property', () => {
      for (const [field, fn] of Object.entries(resolvers.Query)) {
        expect(
          (fn as any)?._scope,
          `Resolver for Query.${field} must declare its scope with withScope(scope, resolver)`,
        ).toBe(FIELD_SCOPES[field])
      }

      for (const [field, sub] of Object.entries(resolvers.Subscription)) {
        const fn = typeof sub === 'function' ? sub : (sub as any)?.subscribe
        expect(
          (fn as any)?._scope,
          `Resolver for Subscription.${field} must declare its scope with withScope(scope, resolver)`,
        ).toBe(FIELD_SCOPES[field])
      }
    })

    it('fails if a new field is added to the schema without declaring a scope', () => {
      const driftingSchema = `${codeSchema}\nextend type Query { unreviewedNewField: String }`
      const parsed = buildSchema(driftingSchema)
      const queryFields = parsed.getQueryType()?.getFields() ?? {}

      const undeclared = Object.keys(queryFields).filter((f) => !FIELD_SCOPES[f])
      expect(undeclared).toContain('unreviewedNewField')
    })
  })
})
