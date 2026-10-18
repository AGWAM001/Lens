import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

const { pairsByNetwork } = vi.hoisted(() => ({
  pairsByNetwork: {
    testnet: [
      {
        pairKey: 'XLM:native/USDC:GTEST',
        assetA: { code: 'USDC', issuer: 'GTEST' },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
    mainnet: [
      {
        pairKey: 'XLM:native/USDC:GMAIN',
        assetA: { code: 'USDC', issuer: 'GMAIN' },
        assetB: { code: 'XLM', issuer: null },
      },
    ],
  } as Record<string, unknown[]>,
}))

vi.mock('../config', () => ({
  config: {
    pairs: pairsByNetwork.testnet,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: pairsByNetwork[network] ?? [],
  }),
}))

import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

/** One indexer_state row per network, as a real deployment would have. */
const rowsByNetwork: Record<string, { last_ledger: number; last_processed_at: Date }> = {
  testnet: { last_ledger: 111111, last_processed_at: new Date(Date.now() - 30_000) },
  mainnet: { last_ledger: 222222, last_processed_at: new Date(Date.now() - 5_000) },
}

describe('GET /status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Return a row only for the network the query actually filtered on; an
    // unfiltered SELECT would therefore hand a network the other one's row.
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => ({
      rows: rowsByNetwork[params[0] as string] ? [rowsByNetwork[params[0] as string]] : [],
    }))
  })

  it('answers for the requested network and filters indexer_state by it', async () => {
    const app = await buildApp()

    const testnet = await app.inject({ method: 'GET', url: '/status' })
    expect(testnet.statusCode).toBe(200)
    expect(testnet.json().network).toBe('testnet')
    expect(testnet.json().lastIndexedLedger).toBe(111111)
    expect(testnet.json().watchedPairs).toEqual(['XLM:native/USDC:GTEST'])
    expect(mockQuery.mock.calls[0][1]).toEqual(['testnet'])

    const mainnet = await app.inject({ method: 'GET', url: '/status?network=mainnet' })
    expect(mainnet.statusCode).toBe(200)
    expect(mainnet.json().network).toBe('mainnet')
    expect(mainnet.json().lastIndexedLedger).toBe(222222)
    expect(mainnet.json().watchedPairs).toEqual(['XLM:native/USDC:GMAIN'])
    expect(mockQuery.mock.calls[1][1]).toEqual(['mainnet'])
  })

  it("does not let one network's indexer rows bleed into the other", async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/status?network=mainnet' })
    const body = res.json()

    expect(body.network).toBe('mainnet')
    expect(body.lastIndexedLedger).toBe(222222)
    expect(body.lastIndexedLedger).not.toBe(rowsByNetwork.testnet.last_ledger)
  })

  it('reports ingestLagSeconds from the last processed timestamp', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/status?network=mainnet' })
    const body = res.json()

    expect(Number.isInteger(body.ingestLagSeconds)).toBe(true)
    expect(body.ingestLagSeconds).toBeGreaterThanOrEqual(0)
    expect(body.ingestLagSeconds).toBeLessThan(60)
  })

  it('returns nulls — never another network\'s data — when a network has not ingested', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/status?network=mainnet' })
    const body = res.json()

    expect(body.network).toBe('mainnet')
    expect(body.lastIndexedLedger).toBeNull()
    expect(body.lastProcessedAt).toBeNull()
    expect(body.ingestLagSeconds).toBeNull()
  })

  it('rejects an unrecognised network before answering', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/status?network=pubnet' })

    expect(res.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
