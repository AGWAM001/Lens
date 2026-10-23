import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const AQUA_ISSUER = 'GBNZILSTVQZ4ROOOA3KLGGBKLS5O3UMT7GHIHMXHGOSSSTJRXORMSKE8'

const mocks = vi.hoisted(() => {
  const usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  const aquaIssuer = 'GBNZILSTVQZ4ROOOA3KLGGBKLS5O3UMT7GHIHMXHGOSSSTJRXORMSKE8'
  return {
    getCachedPrice: vi.fn(),
    getAggregatedPrice: vi.fn(),
    getBestRoute: vi.fn(),
    pgPoolQuery: vi.fn(),
    pairs: [
      {
        pairKey: `USDC:${usdcIssuer}/XLM`,
        assetA: { code: 'USDC', issuer: usdcIssuer },
        assetB: { code: 'XLM', issuer: null },
      },
      {
        pairKey: `AQUA:${aquaIssuer}/XLM`,
        assetA: { code: 'AQUA', issuer: aquaIssuer },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
  }
})

vi.mock('../redis', () => ({ getCachedPrice: mocks.getCachedPrice }))
vi.mock('../db', () => ({ pgPool: { query: mocks.pgPoolQuery }, prisma: {} }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mocks.getBestRoute }))
vi.mock('../config', () => ({
  activeNetwork: 'mainnet',
  config: {
    pairs: mocks.pairs,
  },
}))

import { registerGraphQL } from '../api/graphql'

const PAIRS_QUERY = `query {
  pairs {
    pairKey
    network
    assetA {
      code
      issuer
    }
    assetB {
      code
      issuer
    }
    latestPrice
    lastUpdated
  }
}`

const LIST_PAIRS_QUERY = `query {
  listPairs
}`

describe('GraphQL pairs and listPairs queries', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.getCachedPrice.mockResolvedValue(null)
    mocks.getAggregatedPrice.mockResolvedValue({})
    mocks.getBestRoute.mockResolvedValue({ route: 'SDEX' })
    app = Fastify({ logger: false })
    await registerGraphQL(app)
    await app.ready()
  })

  it('keeps listPairs working for backward compatibility', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: LIST_PAIRS_QUERY },
    })
    const json = res.json()
    expect(json.errors).toBeUndefined()
    expect(json.data.listPairs).toEqual([
      `USDC:${USDC_ISSUER}/XLM`,
      `AQUA:${AQUA_ISSUER}/XLM`,
    ])
  })

  it('resolves pairs query carrying full asset metadata, network, and price info', async () => {
    const timestamp = new Date('2026-10-17T12:00:00.000Z')
    mocks.pgPoolQuery.mockResolvedValue({
      rows: [
        {
          pair_key: `USDC:${USDC_ISSUER}/XLM`,
          price: '0.25',
          timestamp,
        },
      ],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: PAIRS_QUERY },
    })

    const json = res.json()
    expect(json.errors).toBeUndefined()
    const pairs = json.data.pairs
    expect(pairs).toHaveLength(2)

    // Check USDC/XLM pair
    const usdcPair = pairs.find((p: any) => p.pairKey === `USDC:${USDC_ISSUER}/XLM`)
    expect(usdcPair).toBeDefined()
    expect(usdcPair.network).toBe('mainnet')
    expect(usdcPair.assetA).toEqual({
      code: 'USDC',
      issuer: USDC_ISSUER,
    })
    expect(usdcPair.assetB).toEqual({
      code: 'XLM',
      issuer: null,
    })
    expect(usdcPair.latestPrice).toBe(0.25)
    expect(usdcPair.lastUpdated).toBe(timestamp.toISOString())

    // Check quiet AQUA/XLM pair (no rows returned from lateral join)
    const aquaPair = pairs.find((p: any) => p.pairKey === `AQUA:${AQUA_ISSUER}/XLM`)
    expect(aquaPair).toBeDefined()
    expect(aquaPair.network).toBe('mainnet')
    expect(aquaPair.assetA).toEqual({
      code: 'AQUA',
      issuer: AQUA_ISSUER,
    })
    expect(aquaPair.assetB).toEqual({
      code: 'XLM',
      issuer: null,
    })
    expect(aquaPair.latestPrice).toBeNull()
    expect(aquaPair.lastUpdated).toBeNull()

    // Verify lateral query parameters passed to pgPool.query
    expect(mocks.pgPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('CROSS JOIN LATERAL'),
      ['mainnet', [`USDC:${USDC_ISSUER}/XLM`, `AQUA:${AQUA_ISSUER}/XLM`]]
    )
  })
})
