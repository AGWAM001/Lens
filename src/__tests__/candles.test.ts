import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// vi.mock factory is hoisted — declare mock fns with vi.hoisted() so they exist before hoisting
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import { registerCandleRoutes } from '../routes/candles'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerCandleRoutes(app)
  await app.ready()
  return app
}

function makeRow(overrides = {}) {
  return {
    time: new Date('2025-01-01T00:00:00Z'),
    open: '1.0',
    high: '1.5',
    low: '0.9',
    close: '1.2',
    volume: '500.0',
    ...overrides,
  }
}

describe('GET /candles/:assetA/:assetB', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('returns OHLCV candles with all required fields', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [makeRow(), makeRow({ time: new Date('2025-01-01T01:00:00Z') })] })

    const res = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.interval).toBe('1h')
    expect(body.candles).toHaveLength(2)

    const c = body.candles[0]
    expect(c).toHaveProperty('time')
    expect(c).toHaveProperty('open')
    expect(c).toHaveProperty('high')
    expect(c).toHaveProperty('low')
    expect(c).toHaveProperty('close')
    expect(c).toHaveProperty('volume')
  })

  it('passes intervalSecs=3600 for 1h', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h' })

    expect(mockQuery.mock.calls[0][1][0]).toBe(3600)
  })

  it('passes intervalSecs=86400 for 1d', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1d' })

    expect(mockQuery.mock.calls[0][1][0]).toBe(86_400)
  })

  it('passes intervalSecs=900 for 15m', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=15m' })

    expect(mockQuery.mock.calls[0][1][0]).toBe(900)
  })

  it('passes intervalSecs=14400 for 4h', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=4h' })

    expect(mockQuery.mock.calls[0][1][0]).toBe(14_400)
  })

  it('returns 400 for unsupported interval', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=3m' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/interval must be one of/)
  })

  it('returns 400 for invalid from date', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h&from=not-a-date' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/from/)
  })

  it('sorts pairKey alphabetically regardless of param order', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    await app.inject({ method: 'GET', url: '/candles/USDC/XLM?interval=1h' })
    const pk1 = mockQuery.mock.calls[0][1][1]

    mockQuery.mockClear()
    await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h' })
    const pk2 = mockQuery.mock.calls[0][1][1]

    expect(pk1).toBe(pk2)
  })

  it('passes from/to date range to the SQL query', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    const from = '2025-01-01T00:00:00.000Z'
    const to = '2025-01-02T00:00:00.000Z'
    await app.inject({ method: 'GET', url: `/candles/XLM/USDC?interval=1h&from=${from}&to=${to}` })

    const params = mockQuery.mock.calls[0][1]
    expect(new Date(params[2]).toISOString()).toBe(from)
    expect(new Date(params[3]).toISOString()).toBe(to)
  })

  it('uses half-open interval [from, to) in SQL query', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h&from=2025-01-01T00:00:00Z&to=2025-01-01T01:00:00Z' })

    // The SQL query should use < (exclusive) for the upper bound, not <=
    const sql = mockQuery.mock.calls[0][0]
    expect(sql).toMatch(/AND timestamp < \$4/)
    expect(sql).not.toMatch(/AND timestamp <= \$4/)
  })
})
