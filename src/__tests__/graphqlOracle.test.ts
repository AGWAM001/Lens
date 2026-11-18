import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockAdapter } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockAdapter: {
    name: 'reflector',
    isConfigured: vi.fn(),
    getPrice: vi.fn(),
  },
}))

vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../db', () => ({ pgPool: { query: mockQuery } }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({ config: { pairs: [] }, activeNetwork: 'testnet' }))
vi.mock('../ingest/oracles/reflector', () => ({ reflectorOracleAdapter: mockAdapter }))

import { registerGraphQL } from '../api/graphql'

const QUERY = `
  query ($asset: String!, $network: String) {
    oracle(asset: $asset, network: $network) {
      asset
      network
      lens
      reflector
      deviationPct
      status
      oracles { name price timestamp deviationPct status ageSeconds }
    }
  }
`

async function run(variables: Record<string, unknown>) {
  const app = Fastify({ logger: false })
  await registerGraphQL(app)
  await app.ready()
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query: QUERY, variables },
  })
  await app.close()
  return response.json()
}

describe('GraphQL Query.oracle', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockAdapter.isConfigured.mockReset().mockReturnValue(true)
    mockAdapter.getPrice.mockReset()
    mockQuery.mockResolvedValue({ rows: [{ vwap: '100' }] })
  })

  it('reports an available source with its price, timestamp and deviation', async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 30
    mockAdapter.getPrice.mockResolvedValue({ price: 101, timestamp })

    const body = await run({ asset: 'xlm' })

    expect(body.errors).toBeUndefined()
    expect(body.data.oracle.asset).toBe('XLM')
    expect(body.data.oracle.network).toBe('testnet')
    expect(body.data.oracle.lens).toBe(100)
    expect(body.data.oracle.reflector).toBe(101)
    expect(body.data.oracle.status).toBe('aligned')
    const [source] = body.data.oracle.oracles
    expect(source).toMatchObject({
      name: 'reflector',
      price: 101,
      timestamp: new Date(timestamp * 1000).toISOString(),
      deviationPct: 0.9901,
      status: 'AVAILABLE',
    })
    expect(source.ageSeconds).toBeGreaterThanOrEqual(30)
    expect(source.ageSeconds).toBeLessThan(40)
  })

  it('reports UNREACHABLE when the adapter throws', async () => {
    mockAdapter.getPrice.mockRejectedValue(new Error('rpc down'))

    const body = await run({ asset: 'XLM' })

    expect(body.errors).toBeUndefined()
    expect(body.data.oracle.oracles).toEqual([
      { name: 'reflector', price: null, timestamp: null, deviationPct: null, status: 'UNREACHABLE', ageSeconds: null },
    ])
    expect(body.data.oracle.status).toBe('partial')
  })

  it('reports EMPTY when a configured adapter returns no quote', async () => {
    mockAdapter.getPrice.mockResolvedValue(null)

    const body = await run({ asset: 'XLM' })

    expect(body.errors).toBeUndefined()
    expect(body.data.oracle.oracles[0]).toMatchObject({ price: null, status: 'EMPTY' })
  })

  it('reports NOT_CONFIGURED without calling the adapter', async () => {
    mockAdapter.isConfigured.mockReturnValue(false)

    const body = await run({ asset: 'XLM' })

    expect(mockAdapter.getPrice).not.toHaveBeenCalled()
    expect(body.data.oracle.oracles[0].status).toBe('NOT_CONFIGURED')
  })

  it('passes the requested network to the adapter', async () => {
    mockAdapter.getPrice.mockResolvedValue({ price: 100, timestamp: 1_760_000_000 })

    const body = await run({ asset: 'XLM', network: 'mainnet' })

    expect(body.data.oracle.network).toBe('mainnet')
    expect(mockAdapter.getPrice).toHaveBeenCalledWith('XLM', 'mainnet')
  })

  it('returns null when there is no Lens price and no oracle is configured', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    mockAdapter.isConfigured.mockReturnValue(false)

    const body = await run({ asset: 'NOPE' })

    expect(body.data.oracle).toBeNull()
  })

  it('rejects an unknown network', async () => {
    const body = await run({ asset: 'XLM', network: 'devnet' })

    expect(body.errors[0].message).toContain('network must be one of')
  })
})
