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

vi.mock('../config', async importOriginal => {
  const actual = await importOriginal<typeof import('../config')>()
  return {
    ...actual,
    getNetworkConfig: (network?: string) => {
      const cfg = actual.getNetworkConfig((network ?? actual.activeNetwork) as never)
      if ((network ?? actual.activeNetwork) === 'testnet') {
        return {
          ...cfg,
          pairs: [
            {
              pairKey: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM',
              assetA: { code: 'XLM', issuer: null },
              assetB: {
                code: 'USDC',
                issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              },
            },
          ],
        }
      }
      return cfg
    },
  }
})

import { registerRESTRoutes } from '../api/rest'
import { activeNetwork } from '../config'

const TESTNET_PAIR_KEY = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM'
const MAINNET_PAIR_KEY = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM'
const EXPECTED_ACTIVE_PAIR_KEY = activeNetwork === 'mainnet' ? MAINNET_PAIR_KEY : TESTNET_PAIR_KEY

// Same pair_key and same bucket on both networks, distinguishable by vwap.
const BUCKET = new Date('2025-01-01T00:00:00Z')
const TABLE = [
  { network: 'testnet', pair_key: TESTNET_PAIR_KEY, window: '1h', bucket: BUCKET, vwap: 1.72 },
  { network: 'mainnet', pair_key: MAINNET_PAIR_KEY, window: '1h', bucket: BUCKET, vwap: 0.18 },
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
    expect(body.pairKey).toBe(network === 'mainnet' ? MAINNET_PAIR_KEY : TESTNET_PAIR_KEY)
    expect(body.buckets).toHaveLength(1)
    expect(body.buckets[0].vwap).toBe(network === 'testnet' ? 1.72 : 0.18)
    await app.close()
  })

  it('falls back to the active network when none is resolved', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/history' })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe(activeNetwork)
    expect(mockQuery.mock.calls[0][1]).toEqual([EXPECTED_ACTIVE_PAIR_KEY, '1h', activeNetwork, 100])
    await app.close()
  })

  it('rejects non-integer limit with 400 and clamps out-of-range limits', async () => {
    const app = await buildApp('testnet')

    const badRes = await app.inject({ method: 'GET', url: '/price/XLM/USDC/history?limit=abc' })
    expect(badRes.statusCode).toBe(400)
    expect(badRes.json()).toMatchObject({ code: 'invalid_parameter' })
    expect(mockQuery).not.toHaveBeenCalled()

    const negativeRes = await app.inject({ method: 'GET', url: '/price/XLM/USDC/history?limit=-5' })
    expect(negativeRes.statusCode).toBe(200)
    expect(mockQuery.mock.calls[0][1]).toEqual([TESTNET_PAIR_KEY, '1h', 'testnet', 1])

    const hugeRes = await app.inject({ method: 'GET', url: '/price/XLM/USDC/history?limit=999999' })
    expect(hugeRes.statusCode).toBe(200)
    expect(mockQuery.mock.calls[1][1]).toEqual([TESTNET_PAIR_KEY, '1h', 'testnet', 1000])

    await app.close()
  })

  it('returns 404 unwatched_pair for unwatched pairs and resolves lowercase or native spellings', async () => {
    const app = await buildApp('testnet')

    const missingRes = await app.inject({ method: 'GET', url: '/price/FOO/BAR/history' })
    expect(missingRes.statusCode).toBe(404)
    expect(missingRes.json()).toMatchObject({ code: 'unwatched_pair' })
    expect(mockQuery).not.toHaveBeenCalled()

    const badWindowOnMissing = await app.inject({
      method: 'GET',
      url: '/price/FOO/BAR/history?window=invalid',
    })
    expect(badWindowOnMissing.statusCode).toBe(400)
    expect(badWindowOnMissing.json()).toMatchObject({ code: 'bad_window' })

    const lowerRes = await app.inject({ method: 'GET', url: '/price/xlm/usdc/history' })
    expect(lowerRes.statusCode).toBe(200)
    expect(lowerRes.json().pairKey).toBe(TESTNET_PAIR_KEY)
    expect(lowerRes.json().buckets).toHaveLength(1)

    const nativeRes = await app.inject({ method: 'GET', url: '/price/native/USDC/history' })
    expect(nativeRes.statusCode).toBe(200)
    expect(nativeRes.json().pairKey).toBe(TESTNET_PAIR_KEY)
    expect(nativeRes.json().buckets).toHaveLength(1)

    await app.close()
  })
})
