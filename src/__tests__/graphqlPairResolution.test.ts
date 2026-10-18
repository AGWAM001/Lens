import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const mocks = vi.hoisted(() => ({
  getCachedPrice: vi.fn(),
  getAggregatedPrice: vi.fn(),
  getBestRoute: vi.fn(),
}))

vi.mock('../redis', () => ({ getCachedPrice: mocks.getCachedPrice }))
vi.mock('../db', () => ({ pgPool: { query: vi.fn() }, prisma: {} }))
vi.mock('../aggregator/vwap', () => ({ getAggregatedPrice: mocks.getAggregatedPrice }))
vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mocks.getBestRoute }))
vi.mock('../config', () => ({
  activeNetwork: 'testnet',
  config: {
    pairs: [
      {
        pairKey: 'USDC/XLM',
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: null },
      },
    ],
  },
}))

import { registerGraphQL } from '../api/graphql'

const QUERY = `query ($a: String!, $b: String!) {
  getPrice(assetA: $a, assetB: $b) { pairKey price volume24h }
}`

const ISSUER = 'G' + 'A'.repeat(55)

const EMPTY_AGG = {
  price: 0, sdexPrice: 0, ammPrice: 0,
  volume24h: 0, sdexVolume24h: 0, ammVolume24h: 0,
  vwap1m: 0, vwap5m: 0, vwap1h: 0,
}

describe('getPrice pair resolution', () => {
  let app: FastifyInstance

  async function run(a: string, b: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: QUERY, variables: { a, b } },
    })
    return res.json()
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.getCachedPrice.mockResolvedValue(null)
    mocks.getAggregatedPrice.mockResolvedValue(EMPTY_AGG)
    mocks.getBestRoute.mockResolvedValue({ route: 'SDEX' })
    app = Fastify({ logger: false })
    await registerGraphQL(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('invalid input', () => {
    it.each([
      ['empty assetA', '', 'USDC'],
      ['code longer than 12 chars', 'ABCDEFGHIJKLM', 'USDC'],
      ['too many segments', 'USDC:' + ISSUER + ':x', 'XLM'],
      ['malformed issuer', 'USDC:notanissuer', 'XLM'],
    ])('rejects %s with INVALID_INPUT', async (_label, a, b) => {
      const body = await run(a, b)
      expect(body.data.getPrice).toBeNull()
      expect(body.errors).toHaveLength(1)
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].extensions.field).toBe('assetA')
    })

    it('reports the offending field when assetB is malformed', async () => {
      const body = await run('XLM', 'USDC:bad')
      expect(body.errors[0].extensions.code).toBe('INVALID_INPUT')
      expect(body.errors[0].extensions.field).toBe('assetB')
    })

    it('does not touch the data layer', async () => {
      await run('', 'USDC')
      expect(mocks.getCachedPrice).not.toHaveBeenCalled()
      expect(mocks.getAggregatedPrice).not.toHaveBeenCalled()
    })
  })

  describe('unknown pair', () => {
    it('rejects a well-formed but untracked pair with PAIR_NOT_FOUND', async () => {
      const body = await run('XLM', 'BTC')
      expect(body.data.getPrice).toBeNull()
      expect(body.errors).toHaveLength(1)
      expect(body.errors[0].extensions.code).toBe('PAIR_NOT_FOUND')
      expect(body.errors[0].message).toContain('XLM/BTC')
    })

    it('is distinct from INVALID_INPUT', async () => {
      const unknown = await run('XLM', 'BTC')
      const invalid = await run('XLM', 'USDC:bad')
      expect(unknown.errors[0].extensions.code).not.toBe(invalid.errors[0].extensions.code)
    })

    it('does not touch the data layer', async () => {
      await run('XLM', 'BTC')
      expect(mocks.getAggregatedPrice).not.toHaveBeenCalled()
    })
  })

  describe('known pair with no data', () => {
    it('resolves without an error and with zeroed figures', async () => {
      const body = await run('XLM', 'USDC')
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice).toEqual({ pairKey: 'USDC/XLM', price: 0, volume24h: 0 })
    })

    it('accepts either asset order', async () => {
      const body = await run('USDC', 'XLM')
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice.pairKey).toBe('USDC/XLM')
    })

    it('accepts the native alias', async () => {
      const body = await run('native', 'USDC')
      expect(body.errors).toBeUndefined()
      expect(body.data.getPrice.pairKey).toBe('USDC/XLM')
    })
  })
})
