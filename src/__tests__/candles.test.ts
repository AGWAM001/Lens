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

  describe('cursor pagination', () => {
    it('fetches limit+1 buckets and reports hasMore with a cursor', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValue({
        rows: [
          makeRow({ time: new Date('2025-01-01T00:00:00Z') }),
          makeRow({ time: new Date('2025-01-01T01:00:00Z') }),
          makeRow({ time: new Date('2025-01-01T02:00:00Z') }),
        ],
      })

      const res = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h&limit=2' })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.candles).toHaveLength(2)
      expect(body.hasMore).toBe(true)
      // The cursor carries the last kept bucket's epoch seconds (tiebroken by pairKey).
      expect(JSON.parse(Buffer.from(body.nextCursor, 'base64').toString())).toEqual([
        Math.floor(Date.parse('2025-01-01T01:00:00Z') / 1000),
        'USDC/XLM',
      ])
      // The probe binds limit+1.
      expect(mockQuery.mock.calls[0][1].at(-1)).toBe(3)
      await app.close()
    })

    it('applies the cursor as a keyset condition on the bucket expression', async () => {
      const app = await buildApp()
      mockQuery.mockResolvedValue({ rows: [] })
      const cursor = Buffer.from(JSON.stringify([Math.floor(Date.parse('2025-01-01T01:00:00Z') / 1000), 'USDC/XLM'])).toString('base64')

      const res = await app.inject({ method: 'GET', url: `/candles/XLM/USDC?interval=1h&cursor=${cursor}` })

      expect(res.statusCode).toBe(200)
      const [sql, params] = mockQuery.mock.calls[0]
      // The keyset runs on observed_at, the same column the range predicate
      // and the bucket expression use. `timestamp` is the legacy partition key
      // and a different clock, so mixing the two buckets by one and filters by
      // the other. $5 is the network predicate; the cursor is $6.
      expect(sql).toMatch(/floor\(EXTRACT\(EPOCH FROM observed_at\) \/ \$1\) \* \$1 > \$6/)
      expect(params[4]).toBe('testnet')
      expect(params[5]).toBe(Math.floor(Date.parse('2025-01-01T01:00:00Z') / 1000))
      await app.close()
    })

    it('rejects a malformed cursor with 400', async () => {
      const app = await buildApp()
      const res = await app.inject({ method: 'GET', url: '/candles/XLM/USDC?interval=1h&cursor=@@@' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/cursor/)
      await app.close()
    })
  })
})
