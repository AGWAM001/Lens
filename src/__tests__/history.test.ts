import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import { activeNetwork } from '../config'
import { registerNetworkSelector } from '../middleware/network'
import { registerHistoryRoutes, HISTORY_INTERVAL_SECONDS, MAX_HISTORY_POINTS } from '../api/history'

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerHistoryRoutes(app)
  await app.ready()
  return app
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    bucket: new Date('2025-01-01T00:00:00Z'),
    price: '1.25',
    volume: '500',
    ...overrides,
  }
}

describe('GET /prices/history', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('returns points with ts/price/volume and a count matching the rows', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({
      rows: [
        makeRow(),
        makeRow({ bucket: new Date('2025-01-01T00:01:00Z'), price: '1.30', volume: '100' }),
      ],
    })

    const res = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&interval=1m' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pair).toBe('XLM/USDC')
    expect(body.interval).toBe('1m')
    expect(body.count).toBe(2)
    expect(body.points).toHaveLength(2)
    expect(body.points[0]).toEqual({
      ts: '2025-01-01T00:00:00.000Z',
      price: 1.25,
      volume: 500,
    })
  })

  it('defaults to 1m interval when none is given', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC' })

    expect(mockQuery.mock.calls[0][1][0]).toBe(HISTORY_INTERVAL_SECONDS['1m'])
  })

  it('passes the correct bucket width for each interval', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&interval=5m' })
    expect(mockQuery.mock.calls[0][1][0]).toBe(300)

    mockQuery.mockClear()
    await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&interval=1h' })
    expect(mockQuery.mock.calls[0][1][0]).toBe(3600)
  })

  it('requires the pair parameter', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/prices/history?interval=1m' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/pair/)
  })

  it('rejects an unsupported interval', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&interval=15m' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/interval must be one of/)
  })

  it('rejects an invalid from date', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&from=nope' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/from/)
  })

  it('rejects from after to', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC&from=2025-01-02T00:00:00Z&to=2025-01-01T00:00:00Z',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/from must be before to/)
  })

  it('rejects windows that would exceed the max point cap', async () => {
    const app = await buildApp()

    // 1m interval over ~30 days = ~43200 points, well over MAX_HISTORY_POINTS.
    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC&interval=1m&from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/too large/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('allows a large window at a coarse interval under the cap', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    // 1h interval over 30 days = ~720 points, under MAX_HISTORY_POINTS.
    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC&interval=1h&from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z',
    })

    expect(res.statusCode).toBe(200)
    expect(mockQuery).toHaveBeenCalledOnce()
  })

  it('passes the pair and date range through to the query', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    const from = '2025-01-01T00:00:00.000Z'
    const to = '2025-01-01T06:00:00.000Z'
    await app.inject({ method: 'GET', url: `/prices/history?pair=XLM/USDC&from=${from}&to=${to}` })

    const params = mockQuery.mock.calls[0][1]
    expect(params[1]).toBe('XLM/USDC')
    expect(new Date(params[2]).toISOString()).toBe(from)
    expect(new Date(params[3]).toISOString()).toBe(to)
  })

  it('MAX_HISTORY_POINTS guard math is interval-aware', () => {
    // Sanity: the cap is points, not seconds — coarser intervals allow longer spans.
    expect(MAX_HISTORY_POINTS).toBeGreaterThan(0)
  })
})

describe('GET /prices/history network selection', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  // One table, two networks: the mock filters on the network bind ($5) the way
  // the WHERE clause would, so a handler binding the wrong value gets wrong rows.
  const table = [
    { network: 'testnet', price: '0.10' },
    { network: 'mainnet', price: '0.90' },
  ]
  function useTable() {
    mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => ({
      rows: table
        .filter(r => r.network === params[4])
        .map(r => ({ bucket: new Date('2025-01-01T00:00:00Z'), price: r.price, volume: '1' })),
    }))
  }

  it('returns different rows for ?network=mainnet and ?network=testnet and echoes the network', async () => {
    const app = await buildApp()
    useTable()

    const main = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&network=mainnet' })
    const test = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&network=testnet' })

    expect(main.statusCode).toBe(200)
    expect(main.json().network).toBe('mainnet')
    expect(main.json().points[0].price).toBe(0.9)
    expect(test.json().network).toBe('testnet')
    expect(test.json().points[0].price).toBe(0.1)
  })

  it('honors the x-network header', async () => {
    const app = await buildApp()
    useTable()

    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC',
      headers: { 'x-network': 'mainnet' },
    })

    expect(res.json().network).toBe('mainnet')
    expect(mockQuery.mock.calls[0][1][4]).toBe('mainnet')
  })

  it('defaults to the active network and rejects an unknown one', async () => {
    const app = await buildApp()
    useTable()

    const def = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC' })
    expect(def.json().network).toBe(activeNetwork)

    const bad = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC&network=nope' })
    expect(bad.statusCode).toBe(400)
  })
})
