import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))
vi.mock('../config', () => ({ activeNetwork: 'testnet' }))
vi.mock('../ingest/oracles/reflector', () => ({
  reflectorOracleAdapter: {
    name: 'reflector',
    isConfigured: () => false,
    getPrice: vi.fn(),
  },
}))

import { registerOracleRoutes } from '../routes/oracle'
import type { OracleAdapter } from '../ingest/oracles/adapter'

describe('GET /compare/:asset', () => {
  beforeEach(() => mockQuery.mockReset())

  it('returns every configured oracle with its timestamp and deviation, including unreachable sources', async () => {
    mockQuery.mockResolvedValue({ rows: [{ vwap: '100' }] })
    const adapters: OracleAdapter[] = [
      {
        name: 'reflector',
        isConfigured: () => true,
        getPrice: async () => ({ price: 101, timestamp: 1_760_000_000 }),
      },
      {
        name: 'second-oracle',
        isConfigured: () => true,
        getPrice: async () => { throw new Error('oracle unavailable') },
      },
    ]
    const app = Fastify({ logger: false })
    await registerOracleRoutes(app, adapters)
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/compare/xlm' })
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(body.asset).toBe('XLM')
    expect(body.oracles).toEqual([
      {
        name: 'reflector',
        price: 101,
        timestamp: new Date(1_760_000_000 * 1000).toISOString(),
        deviationPct: 0.9901,
        status: 'available',
        ageSeconds: expect.any(Number),
      },
      {
        name: 'second-oracle',
        price: null,
        timestamp: null,
        deviationPct: null,
        status: 'unreachable',
        ageSeconds: null,
      },
    ])
    expect(mockQuery.mock.calls[0][1]).toEqual(['XLM', 'testnet'])
    await app.close()
  })

  it('rejects unsupported network values before querying prices', async () => {
    const app = Fastify({ logger: false })
    await registerOracleRoutes(app, [])
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/compare/xlm?network=futurenet' })

    expect(response.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })
})
