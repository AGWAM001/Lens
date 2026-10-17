import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Asset } from '@stellar/stellar-sdk'

vi.mock('../db', () => ({ pgPool: { query: vi.fn() } }))
vi.mock('../network/clients', () => ({ getHorizonServer: vi.fn() }))

import { pgPool } from '../db'
import { getHorizonServer } from '../network/clients'
import { registerNetworkSelector } from '../middleware/network'
import { registerBookRoutes } from '../routes/book'
import { aggregateBookLevels, generateAmmBookLevels } from '../pricing/book'

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

describe('aggregated order book', () => {
  let app: FastifyInstance
  const mockOrderbook = vi.fn()

  beforeEach(async () => {
    const call = vi.fn().mockResolvedValue({
      asks: [
        { price: '1.02', amount: '5' },
        { price: '1.04', amount: '7' },
      ],
      bids: [
        { price: '0.98', amount: '4' },
        { price: '0.96', amount: '6' },
      ],
    })
    const limit = vi.fn().mockReturnValue({ call })
    mockOrderbook.mockReturnValue({ limit })
    vi.mocked(getHorizonServer).mockReturnValue({ orderbook: mockOrderbook } as any)
    vi.mocked(pgPool.query).mockResolvedValue({
      rows: [{
        pool_id: 'pool-1',
        asset_a: 'XLM',
        asset_b: 'USDC',
        reserve_a: '1000',
        reserve_b: '1000',
        fee_bp: 30,
        timestamp: new Date('2026-10-16T12:00:00.000Z'),
      }],
      rowCount: 1,
    } as any)

    app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerBookRoutes(app)
    await app.ready()
  })

  afterEach(async () => {
    await app?.close()
    vi.clearAllMocks()
  })

  it('combines an AMM pool with the SDEX book and honours the selected network', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/book/XLM/USDC:${ISSUER}?network=mainnet&depth=0.1&step=0.01`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.network).toBe('mainnet')
    expect(body.status).toBe('ok')
    expect(body.spotPrice).toBe(1)
    expect(body.provenance.venues).toEqual(expect.arrayContaining([
      expect.objectContaining({ venue: 'SDEX', status: 'available', sampleCount: 4 }),
      expect.objectContaining({ venue: 'AMM', status: 'available', sampleCount: 1 }),
    ]))

    for (const side of ['asks', 'bids'] as const) {
      expect(body[side].some((level: any) => !level.synthetic && level.venues.includes('SDEX'))).toBe(true)
      expect(body[side].some((level: any) => level.synthetic && level.venues.includes('AMM:pool-1'))).toBe(true)
      for (let i = 1; i < body[side].length; i++) {
        expect(body[side][i].cumulativeSize).toBeGreaterThan(body[side][i - 1].cumulativeSize)
      }
    }

    expect(getHorizonServer).toHaveBeenCalledWith('mainnet')
    expect(mockOrderbook).toHaveBeenCalledWith(Asset.native(), expect.any(Asset))
    expect(pgPool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE network = $1'), [
      'mainnet',
      `USDC:${ISSUER}/XLM`,
    ])
  })

  it('aggregates equal-price contributions and calculates cumulative base size per side', () => {
    expect(aggregateBookLevels([
      { price: 1.25, size: 2, venue: 'SDEX', synthetic: false },
      { price: 1.25, size: 3, venue: 'SDEX', synthetic: false },
      { price: 1.25, size: 4, venue: 'AMM:pool-1', synthetic: true },
    ], 'asks')).toEqual([
      { price: 1.25, size: 5, cumulativeSize: 5, venues: ['SDEX'], synthetic: false, sampleCount: 2 },
      { price: 1.25, size: 4, cumulativeSize: 9, venues: ['AMM:pool-1'], synthetic: true, sampleCount: 1 },
    ])
  })

  it('bounds synthetic levels around the reference spot', () => {
    const levels = generateAmmBookLevels({ poolId: 'pool-1', reserveA: 1000, reserveB: 1000, feeBp: 30 }, 0.05, 0.01, 1)
    expect(levels.asks.every(level => level.price <= 1.05)).toBe(true)
    expect(levels.bids.every(level => level.price >= 0.95)).toBe(true)
    expect(levels.asks.every(level => level.synthetic)).toBe(true)
    expect(levels.bids.every(level => level.synthetic)).toBe(true)
  })

  it('reports an empty market explicitly instead of returning a zero-price book', async () => {
    mockOrderbook.mockReturnValue({
      limit: vi.fn().mockReturnValue({ call: vi.fn().mockResolvedValue({ asks: [], bids: [] }) }),
    })
    vi.mocked(pgPool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any)

    const response = await app.inject({ method: 'GET', url: `/book/XLM/USDC:${ISSUER}?network=testnet` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      network: 'testnet',
      spotPrice: null,
      status: 'no_liquidity',
      asks: [],
      bids: [],
    })
  })
})
