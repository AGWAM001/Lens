import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import { registerPoolsRoutes } from '../routes/pools'
import { activeNetwork } from '../config'

async function buildApp(network?: 'testnet' | 'mainnet') {
  const app = Fastify({ logger: false })
  if (network) {
    app.decorateRequest('network', undefined as any)
    app.addHook('onRequest', async (req) => {
      req.network = network
    })
  }
  await registerPoolsRoutes(app)
  await app.ready()
  return app
}

describe('GET /pools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it('filters by the active network and does not scan the whole history', async () => {
    const app = await buildApp()
    await app.inject({ method: 'GET', url: '/pools' })

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).not.toMatch(/DISTINCT ON/i)
    expect(sql).toMatch(/network = \$1/)
    expect(sql).toMatch(/LIMIT 1/i)
    // Last bind is the limit+1 probe (default 50 + 1).
    expect(params).toEqual([activeNetwork, 51])
    await app.close()
  })

  it('uses the request network when one is resolved', async () => {
    const app = await buildApp('mainnet')
    await app.inject({ method: 'GET', url: '/pools' })
    expect(mockQuery.mock.calls[0][1]).toEqual(['mainnet', 51])
    await app.close()
  })

  it('keeps the response shape and a quiet pool with its real timestamp', async () => {
    const old = new Date('2020-01-01T00:00:00Z')
    mockQuery.mockResolvedValue({
      rows: [
        { pool_id: 'C1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 10, reserve_b: 20, spot_price: 2, fee_bp: 30, timestamp: old },
      ],
    })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/pools' })
    expect(res.statusCode).toBe(200)
    expect(res.json().pools).toEqual([
      {
        pool_id: 'C1', asset_a: 'XLM', asset_b: 'USDC', reserve_a: 10, reserve_b: 20, spot_price: 2, fee_bp: 30,
        timestamp: old.toISOString(),
        // A pool with nothing in the 24h window reports unknown estimates, not
        // zeroed ones — a 0% return and an unmeasurable one rank differently.
        window: '24h', feeAprPct: null, impermanentLossPct: null, netReturn24hPct: null, estimate: true,
      },
    ])
    expect(res.json().nextCursor).toBeNull()
    expect(res.json().hasMore).toBe(false)
    await app.close()
  })

  it('estimates fee return and divergence loss when the window has data', async () => {
    const now = new Date('2026-10-27T00:00:00Z')
    mockQuery.mockResolvedValue({
      rows: [
        {
          pool_id: 'C1', asset_a: 'XLM', asset_b: 'USDC',
          reserve_a: 100, reserve_b: 200, spot_price: 2, fee_bp: 30, timestamp: now,
          // Price doubled over the window, so divergence loss is the textbook
          // 2*sqrt(2)/3 - 1 = -5.72%. Pool value is 2 * 200 = 400 USDC and the
          // 30bp fee on 1000 USDC of volume is 3 USDC, i.e. 0.75% over 24h.
          window_start_price: 1,
          window_counter_volume: 1000,
        },
      ],
    })
    const app = await buildApp()
    const pool = (await app.inject({ method: 'GET', url: '/pools' })).json().pools[0]
    expect(pool.window).toBe('24h')
    expect(pool.estimate).toBe(true)
    expect(pool.feeAprPct).toBeCloseTo(0.75 * 365, 6)
    expect(pool.impermanentLossPct).toBeCloseTo(-5.719095841793653, 6)
    // Net adds the already-negative loss rather than subtracting it.
    expect(pool.netReturn24hPct).toBeCloseTo(0.75 - 5.719095841793653, 6)
    await app.close()
  })
})
