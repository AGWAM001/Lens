import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ErrorWithProps } from 'mercurius'

vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../db', () => ({ pgPool: { query: vi.fn() } }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({ config: { pairs: [] }, activeNetwork: 'testnet' }))

import { registerGraphQL } from '../api/graphql'
import { pgPool } from '../db'

const HISTORY_QUERY = `{ getPriceHistory(assetA: "XLM", assetB: "USDC", window: "1h") { bucket } }`

async function post(app: FastifyInstance, query: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query },
  })
  return res.json()
}

describe('GraphQL error masking', () => {
  let app: FastifyInstance
  const errorLog = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    app = Fastify({ logger: false })
    app.addHook('onRequest', async req => {
      req.log.error = errorLog as any
    })
    await registerGraphQL(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('keeps the message and code of an intentional INVALID_INPUT error', async () => {
    vi.mocked(pgPool.query).mockRejectedValue(
      new ErrorWithProps('window must be one of 1m, 5m, 1h, 24h', { code: 'INVALID_INPUT' })
    )
    const res = await post(app, HISTORY_QUERY)
    expect(res.errors[0].message).toBe('window must be one of 1m, 5m, 1h, 24h')
    expect(res.errors[0].extensions.code).toBe('INVALID_INPUT')
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('keeps validation errors readable', async () => {
    const res = await post(app, `{ getPrice(assetA: "XLM") { price } }`)
    expect(res.errors[0].message).toMatch(/assetB/)
    expect(res.errors[0].extensions?.code).not.toBe('INTERNAL_SERVER_ERROR')
  })

  it('masks a database failure and attaches a request id', async () => {
    const secret = 'connect ECONNREFUSED postgresql://user:secret@localhost:5432/db'
    vi.mocked(pgPool.query).mockRejectedValue(new Error(secret))

    const res = await post(app, HISTORY_QUERY)
    const err = res.errors[0]
    expect(err.message).toBe('Internal server error')
    expect(err.extensions.code).toBe('INTERNAL_SERVER_ERROR')
    expect(typeof err.extensions.requestId).toBe('string')
    expect(err.extensions.requestId.length).toBeGreaterThan(0)

    const raw = JSON.stringify(res)
    expect(raw).not.toContain('postgresql://')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('localhost:5432')

    expect(errorLog).toHaveBeenCalledTimes(1)
    const [fields] = errorLog.mock.calls[0]
    expect(fields.requestId).toBe(err.extensions.requestId)
    expect(String(fields.err.message)).toContain('postgresql://')
  })

  it('does not leak SQL or file paths from a query error', async () => {
    const pgErr = Object.assign(
      new Error('syntax error at or near "SELECT" in SELECT bucket FROM price_aggregates'),
      { stack: 'Error: boom\n    at Pool.query (/home/app/node_modules/pg/lib/pool.js:12:3)' }
    )
    vi.mocked(pgPool.query).mockRejectedValue(pgErr)

    const res = await post(app, HISTORY_QUERY)
    const raw = JSON.stringify(res)
    expect(res.errors[0].message).toBe('Internal server error')
    expect(raw).not.toMatch(/SELECT|price_aggregates|syntax error/i)
    expect(raw).not.toMatch(/node_modules|\/home\/|\.js:\d+/)
    expect(res.errors[0].extensions.stacktrace).toBeUndefined()
  })
})
