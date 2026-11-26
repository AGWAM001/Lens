import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

process.env.REQUIRE_API_KEY = 'false'

const RUNTIME_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const { TESTNET_ISSUER, mockQuery, mockGetBestRoute, mockGetAggregatedPrice } = vi.hoisted(() => ({
  TESTNET_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mockQuery: vi.fn(),
  mockGetBestRoute: vi.fn(),
  mockGetAggregatedPrice: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
  prisma: {},
}))

vi.mock('../src/redis', () => ({
  getCachedPrice: vi.fn().mockResolvedValue(null),
  setCachedPrice: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

vi.mock('../src/aggregator/vwap', () => ({
  getAggregatedPrice: mockGetAggregatedPrice,
}))

vi.mock('../src/config', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config')>()
  return {
    ...actual,
    activeNetwork: 'testnet',
    config: {
      ...actual.config,
      pairs: [
        {
          pairKey: `USDC:${TESTNET_ISSUER}/XLM`,
          assetA: { code: 'XLM', issuer: null },
          assetB: { code: 'USDC', issuer: TESTNET_ISSUER },
        },
      ],
    },
    getNetworkConfig: (network: 'testnet' | 'mainnet') => ({
      ...actual.getNetworkConfig(network),
      pairs:
        network === 'testnet'
          ? [
              {
                pairKey: `USDC:${TESTNET_ISSUER}/XLM`,
                assetA: { code: 'XLM', issuer: null },
                assetB: { code: 'USDC', issuer: TESTNET_ISSUER },
              },
            ]
          : [
              {
                pairKey: `USDC:${TESTNET_ISSUER}/XLM`,
                assetA: { code: 'XLM', issuer: null },
                assetB: { code: 'USDC', issuer: TESTNET_ISSUER },
              },
            ],
    }),
  }
})

import { registerPair, getPairsForNetwork } from '../src/pairsRegistry'
import { createLensPriceQueries } from '../src/mcp/priceQueries'
import { registerNetworkSelector } from '../src/middleware/network'
import { registerRESTRoutes } from '../src/api/rest'

describe('runtime pair resolution (#669)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerRESTRoutes(app)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAggregatedPrice.mockResolvedValue({
      price: 0.25,
      sdexPrice: 0.25,
      ammPrice: 0.25,
      volume24h: 100,
      sdexVolume24h: 60,
      ammVolume24h: 40,
      vwap1m: 0.25,
      vwap5m: 0.25,
      vwap1h: 0.25,
      vwap24h: 0.25,
      priceChange24h: 0,
      sources: 2,
      confidence: 'high',
      lastTradeAgeSeconds: 5,
      stale: false,
      newestInputObservedAt: new Date().toISOString(),
      inputCount: 2,
      stalenessThresholdSeconds: 60,
    })
    mockGetBestRoute.mockResolvedValue({
      route: 'SDEX',
      sdexPrice: 0.25,
      ammPrice: 0.25,
      estimatedOutput: 250,
      slippagePct: 0.1,
      recommendation: 'Use SDEX',
    })
  })

  it('resolves a runtime-registered pair on activeNetwork in REST /price and MCP watchedPairs, while refusing it on the other network', async () => {
    const runtimePair = {
      pairKey: `AQUA:${RUNTIME_ISSUER}/XLM`,
      assetA: { code: 'AQUA', issuer: RUNTIME_ISSUER },
      assetB: { code: 'XLM', issuer: null },
    }
    expect(registerPair(runtimePair)).toBe(true)

    expect(getPairsForNetwork('testnet').some(p => p.pairKey === runtimePair.pairKey)).toBe(true)
    expect(getPairsForNetwork('mainnet').some(p => p.pairKey === runtimePair.pairKey)).toBe(false)

    const priceQueries = createLensPriceQueries()
    expect(priceQueries.watchedPairs('testnet').some(p => p.pairKey === runtimePair.pairKey)).toBe(true)
    expect(priceQueries.watchedPairs('mainnet').some(p => p.pairKey === runtimePair.pairKey)).toBe(false)

    const okRes = await app.inject({
      method: 'GET',
      url: `/price/AQUA:${RUNTIME_ISSUER}/XLM`,
    })
    expect(okRes.statusCode).toBe(200)
    expect(okRes.json()).toMatchObject({
      pairKey: runtimePair.pairKey,
      network: 'testnet',
      price: 0.25,
    })

    const otherRes = await app.inject({
      method: 'GET',
      url: `/price/AQUA:${RUNTIME_ISSUER}/XLM?network=mainnet`,
    })
    expect(otherRes.statusCode).toBe(404)
    expect(otherRes.json()).toMatchObject({ code: 'unwatched_pair' })
  })
})
