import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../redis', () => ({ getCachedPrice: vi.fn(), setCachedPrice: vi.fn() }))
vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({
  config: { pairs: [], cache: { priceTtl: 60 } },
  activeNetwork: 'testnet',
}))

import { registerGraphQL, schema } from '../api/graphql'

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await registerGraphQL(app)
  await app.ready()
  return app
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    bucket: new Date('2025-01-01T12:00:00Z'),
    window: '1h',
    vwap: '1.25',
    sdex_vwap: '1.24',
    amm_vwap: '1.26',
    volume: '1000.5',
    trade_count: 42,
    open_price: '1.20',
    close_price: '1.28',
    high_price: '1.30',
    low_price: '1.18',
    ...overrides,
  }
}

describe('GraphQL getPriceHistory with time range (Issue #370)', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('documents boundary inclusivity in the schema description', () => {
    expect(schema).toContain('The time range is inclusive at both ends: a bucket is included if bucket >= from and bucket <= to')
    expect(schema).toContain('adjacent windows')
    expect(schema).toMatch(/from:\s*String/)
    expect(schema).toMatch(/to:\s*String/)
  })

  it('rejects an invalid from date', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `
          query {
            getPriceHistory(assetA: "XLM", assetB: "USDC", window: "1h", from: "not-a-valid-date") {
              bucket
            }
          }
        `,
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.errors).toBeDefined()
    expect(json.errors[0].message).toMatch(/from must be a valid ISO 8601 date/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects an invalid to date', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `
          query {
            getPriceHistory(assetA: "XLM", assetB: "USDC", window: "1h", to: "garbage-value") {
              bucket
            }
          }
        `,
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.errors).toBeDefined()
    expect(json.errors[0].message).toMatch(/to must be a valid ISO 8601 date/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects from after to', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `
          query {
            getPriceHistory(
              assetA: "XLM"
              assetB: "USDC"
              window: "1h"
              from: "2025-01-02T00:00:00Z"
              to: "2025-01-01T00:00:00Z"
            ) {
              bucket
            }
          }
        `,
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.errors).toBeDefined()
    expect(json.errors[0].message).toMatch(/from must be before to/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects an over-large range that exceeds MAX_HISTORY_POINTS', async () => {
    const app = await buildApp()

    // 1m window over 31 days = ~44640 points > MAX_HISTORY_POINTS (10,000)
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `
          query {
            getPriceHistory(
              assetA: "XLM"
              assetB: "USDC"
              window: "1m"
              from: "2025-01-01T00:00:00Z"
              to: "2025-02-01T00:00:00Z"
            ) {
              bucket
            }
          }
        `,
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.errors).toBeDefined()
    expect(json.errors[0].message).toMatch(/too large/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('allows a bounded range at coarser window and queries database inclusively', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({
      rows: [
        makeRow({ bucket: new Date('2025-01-15T00:00:00Z'), vwap: '1.25' }),
        makeRow({ bucket: new Date('2025-01-15T01:00:00Z'), vwap: '1.27' }),
      ],
    })

    const from = '2025-01-01T00:00:00.000Z'
    const to = '2025-01-20T00:00:00.000Z'

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `
          query {
            getPriceHistory(
              assetA: "USDC"
              assetB: "XLM"
              window: "1h"
              limit: 50
              from: "${from}"
              to: "${to}"
            ) {
              bucket
              window
              vwap
              volume
              tradeCount
              open
              close
              high
              low
            }
          }
        `,
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.errors).toBeUndefined()
    expect(json.data.getPriceHistory).toHaveLength(2)
    expect(json.data.getPriceHistory[0].vwap).toBe(1.25)
    expect(json.data.getPriceHistory[0].tradeCount).toBe(42)

    expect(mockQuery).toHaveBeenCalledOnce()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('bucket >= $3')
    expect(sql).toContain('bucket <= $4')
    expect(params[0]).toBe('USDC/XLM') // sorted pairKey
    expect(params[1]).toBe('1h')
    expect((params[2] as Date).toISOString()).toBe(from)
    expect((params[3] as Date).toISOString()).toBe(to)
    expect(params[4]).toBe(50) // limit
  })

  it('supports querying with only from argument', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    const from = new Date(Date.now() - 3600 * 1000).toISOString()

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `
          query {
            getPriceHistory(
              assetA: "XLM"
              assetB: "USDC"
              window: "1h"
              from: "${from}"
            ) {
              bucket
            }
          }
        `,
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.errors).toBeUndefined()

    expect(mockQuery).toHaveBeenCalledOnce()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('bucket >= $3')
    expect(sql).not.toContain('bucket <=')
    expect((params[2] as Date).toISOString()).toBe(from)
  })

  it('supports legacy calls without from or to', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({
      rows: [makeRow()],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `
          query {
            getPriceHistory(assetA: "XLM", assetB: "USDC", window: "5m") {
              bucket
              window
              vwap
            }
          }
        `,
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.errors).toBeUndefined()
    expect(json.data.getPriceHistory).toHaveLength(1)

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).not.toContain('bucket >=')
    expect(sql).not.toContain('bucket <=')
    expect(params).toEqual(['USDC/XLM', '5m', 100])
  })
})
