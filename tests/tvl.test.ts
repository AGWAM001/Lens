import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { pgPool } from '../src/db'

describe('GET /tvl (Issue #284)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('rejects invalid network parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tvl?network=invalid_network',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBeDefined()
  })

  it('honors ?network= parameter and returns total, venue breakdown, and asset breakdown', async () => {
    const originalQuery = pgPool.query

    // Mock pgPool.query responses
    vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlStr = typeof sql === 'string' ? sql : sql.text

      // Price query
      if (sqlStr.includes('FROM price_points') && sqlStr.includes('SELECT DISTINCT ON (pair_key, source)')) {
        return {
          rows: [
            {
              asset_a: 'XLM:native',
              asset_b: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              price: '0.50',
              source: 'sdex',
              timestamp: new Date().toISOString(),
            },
          ],
        } as any
      }

      // AMM snapshots query
      if (sqlStr.includes('FROM pool_snapshots ps')) {
        return {
          rows: [
            {
              pool_id: 'pool-amm-1',
              asset_a: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              asset_b: 'XLM:native',
              reserve_a: '1000',
              reserve_b: '2000',
              timestamp: new Date().toISOString(),
            },
          ],
        } as any
      }

      // External pools query
      if (sqlStr.includes('source IN (\'soroswap_amm\', \'aquarius_amm\')')) {
        return {
          rows: [],
        } as any
      }

      return (originalQuery as any)(sql, params)
    })

    const res = await app.inject({
      method: 'GET',
      url: '/tvl?network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('testnet')
    expect(body.totalTvlUsd).toBeDefined()
    // USDC: 1000 * 1 = 1000; XLM: 2000 * 0.5 = 1000. Total = 2000.
    expect(body.totalTvlUsd).toBe(2000)
    expect(body.venues).toBeDefined()
    expect(body.venues['Stellar Classic AMM']).toBeDefined()
    expect(body.venues['Stellar Classic AMM'].tvlUsd).toBe(2000)
    expect(body.byAsset).toBeDefined()
    expect(body.byAsset['USDC']).toBeDefined()
    expect(body.byAsset['USDC'].priceSource).toBe('STABLECOIN_PEG')
    expect(body.byAsset['XLM'].priceSource).toBe('sdex')
    expect(body.pools).toHaveLength(1)
    expect(body.pools[0].priced).toBe(true)
    expect(body.pools[0].tvlUsd).toBe(2000)

    vi.restoreAllMocks()
  })

  it('reports pool as unpriced (priced: false, tvlUsd: null) when an asset cannot be priced, never counting as zero', async () => {
    const originalQuery = pgPool.query

    vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlStr = typeof sql === 'string' ? sql : sql.text

      // Price query returns no prices
      if (sqlStr.includes('FROM price_points') && sqlStr.includes('SELECT DISTINCT ON (pair_key, source)')) {
        return {
          rows: [],
        } as any
      }

      // AMM snapshots query returns pool with unknown asset
      if (sqlStr.includes('FROM pool_snapshots ps')) {
        return {
          rows: [
            {
              pool_id: 'pool-unpriceable',
              asset_a: 'UNKNOWN_TOKEN:GCXXXXXXXX',
              asset_b: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              reserve_a: '500',
              reserve_b: '1000',
              timestamp: new Date().toISOString(),
            },
          ],
        } as any
      }

      if (sqlStr.includes('source IN (\'soroswap_amm\', \'aquarius_amm\')')) {
        return {
          rows: [],
        } as any
      }

      return (originalQuery as any)(sql, params)
    })

    const res = await app.inject({
      method: 'GET',
      url: '/tvl?network=testnet',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pools).toHaveLength(1)
    expect(body.pools[0].priced).toBe(false)
    expect(body.pools[0].tvlUsd).toBeNull()
    // Unpriced pool must never be counted as zero into totalTvlUsd
    expect(body.totalTvlUsd).toBe(0)
    expect(body.unpricedPoolsCount).toBe(1)
    expect(body.pricedPoolsCount).toBe(0)

    vi.restoreAllMocks()
  })

  it('supports historical series with ?history=true', async () => {
    const originalQuery = pgPool.query

    vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlStr = typeof sql === 'string' ? sql : sql.text

      if (sqlStr.includes('FROM price_points') && sqlStr.includes('SELECT DISTINCT ON (pair_key, source)')) {
        return {
          rows: [
            {
              asset_a: 'XLM:native',
              asset_b: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              price: '0.50',
              source: 'sdex',
              timestamp: new Date().toISOString(),
            },
          ],
        } as any
      }

      if (sqlStr.includes('date_trunc(\'hour\', ps.timestamp) AS bucket')) {
        return {
          rows: [
            {
              bucket: new Date(Date.now() - 3600 * 1000).toISOString(),
              pool_id: 'pool-amm-1',
              asset_a: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              asset_b: 'XLM:native',
              reserve_a: '1000',
              reserve_b: '2000',
            },
            {
              bucket: new Date().toISOString(),
              pool_id: 'pool-amm-1',
              asset_a: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              asset_b: 'XLM:native',
              reserve_a: '1200',
              reserve_b: '2000',
            },
          ],
        } as any
      }

      return (originalQuery as any)(sql, params)
    })

    const res = await app.inject({
      method: 'GET',
      url: '/tvl?network=testnet&history=true&window=24',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.network).toBe('testnet')
    expect(body.window).toBe('24h')
    expect(body.points).toBeDefined()
    expect(Array.isArray(body.points)).toBe(true)
    expect(body.points.length).toBe(2)
    expect(body.points[0].tvlUsd).toBe(2000)
    expect(body.points[1].tvlUsd).toBe(2200)

    vi.restoreAllMocks()
  })

  describe('history window vs pool snapshot retention (#689)', () => {
    /** Mocks the history queries and returns the hours the snapshot query was asked for. */
    function captureHistoryWindow(): { hours: () => string | undefined } {
      let hours: string | undefined
      vi.spyOn(pgPool, 'query').mockImplementation(async (sql: any, params?: any) => {
        const sqlStr = typeof sql === 'string' ? sql : sql.text
        if (sqlStr.includes('date_trunc(\'hour\', ps.timestamp) AS bucket')) {
          hours = params?.[1]
        }
        return { rows: [] } as any
      })
      return { hours: () => hours }
    }

    it('caps the window at the retention period when retention is on, and reports the window used', async () => {
      process.env.POOL_SNAPSHOT_RETENTION_ENABLED = 'true'
      process.env.POOL_SNAPSHOT_RETENTION_DAYS = '7'
      const captured = captureHistoryWindow()

      const res = await app.inject({ method: 'GET', url: '/tvl?network=testnet&history=true&window=1000' })

      expect(res.statusCode).toBe(200)
      expect(res.json().window).toBe('168h')
      expect(captured.hours()).toBe('168')
      vi.restoreAllMocks()
    })

    it('leaves a window inside the retention period alone', async () => {
      process.env.POOL_SNAPSHOT_RETENTION_ENABLED = 'true'
      process.env.POOL_SNAPSHOT_RETENTION_DAYS = '7'
      const captured = captureHistoryWindow()

      const res = await app.inject({ method: 'GET', url: '/tvl?network=testnet&history=true&window=48' })

      expect(res.json().window).toBe('48h')
      expect(captured.hours()).toBe('48')
      vi.restoreAllMocks()
    })

    it('does not cap the window while retention is off, since nothing is pruned', async () => {
      delete process.env.POOL_SNAPSHOT_RETENTION_ENABLED
      const captured = captureHistoryWindow()

      const res = await app.inject({ method: 'GET', url: '/tvl?network=testnet&history=true&window=1000' })

      expect(res.json().window).toBe('1000h')
      expect(captured.hours()).toBe('1000')
      vi.restoreAllMocks()
    })
  })
})
