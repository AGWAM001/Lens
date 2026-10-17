import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: vi.fn(),
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: vi.fn(),
}))

import { registerRESTRoutes } from '../api/rest'
import { activeNetwork } from '../config'

// Same pair_key and same bucket on both networks, distinguishable by vwap.
const BUCKET = new Date('2025-01-01T00:00:00Z')
const TABLE = [
  { network: 'testnet', pair_key: 'USDC/XLM', window: '1h', bucket: BUCKET, vwap: 1.72 },
  { network: 'mainnet', pair_key: 'USDC/XLM', window: '1h', bucket: BUCKET, vwap: 0.18 },
]

function row(r: (typeof TABLE)[number]) {
  return {
    bucket: r.bucket,
    window: r.window,
    vwap: r.vwap,
    sdex_vwap: r.vwap,
    amm_vwap: null,
    volume: 10,
    trade_count: 1,
    open_price: r.vwap,
    close_price: r.vwap,
    high_price: r.vwap,
    low_price: r.vwap,
  }
}

async function buildApp(network?: 'testnet' | 'mainnet') {
  const app = Fastify({ logger: false })
  if (network) {
    app.decorateRequest('network', undefined as any)
    app.addHook('onRequest', async (req) => {
      req.network = network
    })
  }
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

describe('GET /price/:assetA/:assetB/history network scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Behaves like the table: honours the network predicate the SQL carries.
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(sql).toMatch(/network = \$3/)
      const [pairKey, window, network] = params
      return {
        rows: TABLE.filter(r => r.pair_key === pairKey && r.window === window && r.network === network).map(row),
      }
    })
  })

  it.each(['testnet', 'mainnet'] as const)('returns only %s rows and echoes the network', async (network) => {
    const app = await buildApp(network)
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/history?window=1h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe(network)
    expect(body.pairKey).toBe('USDC/XLM')
    expect(body.buckets).toHaveLength(1)
    expect(body.buckets[0].vwap).toBe(network === 'testnet' ? 1.72 : 0.18)
    await app.close()
  })

  it('falls back to the active network when none is resolved', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/history' })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe(activeNetwork)
    expect(mockQuery.mock.calls[0][1]).toEqual(['USDC/XLM', '1h', activeNetwork, 100])
    await app.close()
  })
})
