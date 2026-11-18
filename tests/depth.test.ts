import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// Spreading the real config above enables API-key auth; these tests exercise
// pricing, not authentication. tests/httpStatusCodes.test.ts does the same.
process.env.REQUIRE_API_KEY = 'false'

// ── Mocks ────────────────────────────────────────────────────────────────────
// Path guesses: confirm these match your repo.

vi.mock('../src/db', () => ({ pgPool: { query: vi.fn() } }))

// Spread the real module: src/api/rest.ts imports `config` as well, and a mock
// that defines only the two symbols this test cares about makes every other
// import from here undefined.
vi.mock('../src/config', async importActual => {
  const actual = await importActual<typeof import('../src/config')>()
  return {
    ...actual,
    activeNetwork: 'testnet',
    // findPair in src/api/rest.ts is local and reads getNetworkConfig(network).pairs,
    // so the watched pair has to come from here — mocking '../src/pairs' does
    // not reach it. horizonUrl is overridden so getPoolFee talks to the
    // injected fetch below rather than a real Horizon.
    getNetworkConfig: (network?: string) => ({
      ...actual.getNetworkConfig((network ?? 'testnet') as never),
      horizon: { url: 'https://horizon.example.test' },
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
    }),
  }
})

vi.mock('../src/pairs', () => ({
  findPair: (assetA: string, assetB: string) => {
    if (assetA === 'XLM' && assetB === 'USDC') {
      return {
        pairKey: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM',
        assetA: { code: 'XLM' },
        assetB: { code: 'USDC' },
      }
    }
    return undefined
  },
}))

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { pgPool } from '../src/db'
import { buildApp } from '../src/app'
import { calculateAMMPrice } from '../src/pricing/depth'
import { clearPoolFeeCache } from '../src/pricing/pool-fee'

const query = pgPool.query as unknown as ReturnType<typeof vi.fn>
const ts = new Date('2026-10-17T10:00:00Z')

/** Venue stub: fee per pool id, or 'error' to simulate an unreadable fee. */
function venue(fees: Record<string, number | 'error'>) {
  return async (url: string | URL | Request) => {
    const poolId = String(url).split('/').pop()!
    const fee = fees[poolId]
    if (fee === undefined || fee === 'error') {
      return new Response('not found', { status: 404 })
    }
    return new Response(JSON.stringify({ id: poolId, fee_bp: fee }), { status: 200 })
  }
}

function poolRows(...ids: string[]) {
  return { rows: ids.map((id) => ({ pool_id: id, reserve_a: '1000', reserve_b: '120', timestamp: ts })) }
}

// ── Tests ────────────────────────────────────────────────────────────────────

let app: Awaited<ReturnType<typeof buildApp>>

beforeEach(async () => {
  clearPoolFeeCache()
  query.mockReset()
  app = await buildApp()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await app?.close()
})

describe('GET /price/:assetA/:assetB/depth', () => {
  it('200: prices with the venue fee and reports the pool that was used', async () => {
    query.mockResolvedValue(poolRows('p1'))
    vi.stubGlobal('fetch', venue({ p1: 50 }))

    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/depth?amount=10' })
    const body = res.json()

    expect(res.statusCode).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.network).toBe('testnet')
    expect(body.assetA).toBe('XLM')
    expect(body.assetB).toBe('USDC')
    expect(body.pool.poolId).toBe('p1')
    expect(body.pool.feeBp).toBe(50)
    expect(body.executionPrice).toBeCloseTo(calculateAMMPrice(1000, 120, 10, 50), 12)
    expect(body.excludedPools).toEqual([])
  })

  it('200: skips a pool with an unreadable fee and lists it as excluded', async () => {
    query.mockResolvedValue(poolRows('p1', 'p2'))
    vi.stubGlobal('fetch', venue({ p1: 'error', p2: 30 }))

    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/depth?amount=10' })
    const body = res.json()

    expect(res.statusCode).toBe(200)
    expect(body.pool.poolId).toBe('p2')
    expect(body.excludedPools).toHaveLength(1)
    expect(body.excludedPools[0].poolId).toBe('p1')
    expect(body.excludedPools[0].reason).toMatch(/venue responded 404/)
  })

  it('503: returns unavailable with no numbers when every pool is excluded', async () => {
    query.mockResolvedValue(poolRows('p1'))
    vi.stubGlobal('fetch', venue({ p1: 'error' }))

    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/depth?amount=10' })
    const body = res.json()

    expect(res.statusCode).toBe(503)
    expect(body.status).toBe('unavailable')
    expect(body.reason).toBe('every AMM pool for this pair was excluded')
    expect(body).not.toHaveProperty('spotPrice')
    expect(body).not.toHaveProperty('executionPrice')
    expect(body.excludedPools).toHaveLength(1)
  })

  it('503: returns unavailable when the pair has no AMM pool snapshots on this network', async () => {
    query.mockResolvedValue({ rows: [] })
    vi.stubGlobal('fetch', venue({}))

    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC/depth?amount=10' })

    expect(res.statusCode).toBe(503)
    expect(res.json().status).toBe('unavailable')
    expect(res.json().excludedPools).toEqual([])
  })

  it('404: returns not found for a pair that is not watched', async () => {
    const res = await app.inject({ method: 'GET', url: '/price/ABC/XYZ/depth?amount=10' })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/not watched/)
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['non-numeric', 'abc'],
    ['trailing junk', '1000abc'],
    ['empty', ''],
  ])('400: rejects an amount that is %s', async (_label, amount) => {
    const res = await app.inject({ method: 'GET', url: `/price/XLM/USDC/depth?amount=${amount}` })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('amount must be a positive number')
    expect(query).not.toHaveBeenCalled()
  })

  it('defaults to the active network when none is given', async () => {
    query.mockResolvedValue({ rows: [] })
    vi.stubGlobal('fetch', venue({}))

    await app.inject({ method: 'GET', url: '/price/XLM/USDC/depth?amount=10' })

    const params = query.mock.calls[0][1] as unknown[]
    expect(params).toContain('testnet')
  })
})
