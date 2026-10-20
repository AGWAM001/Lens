import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// Keep the real GraphQL registration and request lifecycle while making Query
// resolver dependencies deterministic and side-effect free.
vi.mock('../redis', () => ({ getCachedPrice: vi.fn() }))
vi.mock('../db', () => ({ pgPool: { query: vi.fn() } }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: vi.fn() }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: vi.fn() }))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  config: {
    pairs: [{
      assetA: { code: 'XLM' },
      assetB: { code: 'USDC' },
      pairKey: 'USDC/XLM',
    }],
  },
}))
vi.mock('../ingest/oracles/reflector', () => ({ reflectorOracleAdapter: {} }))
vi.mock('../services/oracleComparison', () => ({ compareOracles: vi.fn() }))

import { registerGraphQL } from '../api/graphql'
import { getMaxGraphQLQueryDepth, DEFAULT_MAX_GRAPHQL_QUERY_DEPTH } from '../api/queryDepth'
import { getCachedPrice } from '../redis'
import { compareOracles } from '../services/oracleComparison'

const ORIGINAL_MAX_DEPTH = process.env.GRAPHQL_MAX_QUERY_DEPTH

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await registerGraphQL(app)
  await app.ready()
  return app
}

async function post(app: FastifyInstance, query: string, operationName?: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query, operationName },
  })
  return { statusCode: response.statusCode, body: response.json() }
}

describe('GraphQL query depth limit', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    process.env.GRAPHQL_MAX_QUERY_DEPTH = '2'
    vi.clearAllMocks()
    vi.mocked(getCachedPrice).mockResolvedValue(JSON.stringify({ price: 0.1234 }))
    app = await buildServer()
  })

  afterEach(async () => {
    await app.close()
  })

  afterAll(() => {
    if (ORIGINAL_MAX_DEPTH === undefined) delete process.env.GRAPHQL_MAX_QUERY_DEPTH
    else process.env.GRAPHQL_MAX_QUERY_DEPTH = ORIGINAL_MAX_DEPTH
  })

  it('accepts a query whose field depth equals the configured maximum', async () => {
    const response = await post(app, `{ getPrice(assetA: "XLM", assetB: "USDC") { price } }`)

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ data: { getPrice: { price: 0.1234 } } })
  })

  it('rejects an over-depth query with its actual depth and configured maximum before its resolver runs', async () => {
    const response = await post(app, `{ oracle(asset: "XLM") { oracles { name } } }`)

    expect(response.body.errors[0].message).toBe(
      'Query depth 3 exceeds the maximum allowed depth of 2.',
    )
    expect(compareOracles).not.toHaveBeenCalled()
  })

  it('counts named fragment spreads and inline fragments as their selected fields', async () => {
    const fragmentResponse = await post(app, `
      query FragmentDepth { first: oracle(asset: "XLM") { ...OracleFields ...OracleFields } }
      fragment OracleFields on OracleComparison { sources: oracles { label: name } }
    `)
    const inlineResponse = await post(app, `
      { oracle(asset: "XLM") { ... on OracleComparison { oracles { name } } } }
    `)

    expect(fragmentResponse.body.errors[0].message).toBe(
      'Query depth 3 exceeds the maximum allowed depth of 2.',
    )
    expect(inlineResponse.body.errors[0].message).toBe(
      'Query depth 3 exceeds the maximum allowed depth of 2.',
    )
  })

  it('allows standard introspection but does not let a mixed operation bypass the application limit', async () => {
    const introspection = await post(app, `query Introspection { __schema { queryType { name } } }`)
    const mixed = await post(app, `
      query Mixed {
        __schema { queryType { name } }
        oracle(asset: "XLM") { oracles { name } }
      }
    `)

    expect(introspection.body.data.__schema.queryType.name).toBe('Query')
    expect(mixed.body.errors[0].message).toBe(
      'Query depth 3 exceeds the maximum allowed depth of 2.',
    )
    expect(compareOracles).not.toHaveBeenCalled()
  })

  it('measures only the operation selected by operationName in a multi-operation document', async () => {
    const response = await post(app, `
      query Shallow { listPairs }
      query Deep { oracle(asset: "XLM") { oracles { name } } }
    `, 'Shallow')

    expect(response.body).toEqual({ data: { listPairs: ['USDC/XLM'] } })
  })

  it('leaves cyclic fragment documents to GraphQL validation without recursive depth traversal', async () => {
    const response = await post(app, `
      query Cycle { ...A }
      fragment A on Query { ...B }
      fragment B on Query { ...A }
    `)

    expect(response.body.errors.map((error: { message: string }) => error.message).join('\n')).toMatch(
      /Cannot spread fragment "A" within itself via "B"/,
    )
  })

  it('uses the default and fails safely for invalid configuration', async () => {
    expect(getMaxGraphQLQueryDepth({})).toBe(DEFAULT_MAX_GRAPHQL_QUERY_DEPTH)
    expect(() => getMaxGraphQLQueryDepth({ GRAPHQL_MAX_QUERY_DEPTH: '0' })).toThrow(
      'GRAPHQL_MAX_QUERY_DEPTH must be a positive integer.',
    )
    expect(() => getMaxGraphQLQueryDepth({ GRAPHQL_MAX_QUERY_DEPTH: 'two' })).toThrow(
      'GRAPHQL_MAX_QUERY_DEPTH must be a positive integer.',
    )

    process.env.GRAPHQL_MAX_QUERY_DEPTH = '0'
    const invalidApp = Fastify({ logger: false })
    await expect(registerGraphQL(invalidApp)).rejects.toThrow(
      'GRAPHQL_MAX_QUERY_DEPTH must be a positive integer.',
    )
    await invalidApp.close()
    process.env.GRAPHQL_MAX_QUERY_DEPTH = '2'
  })
})
