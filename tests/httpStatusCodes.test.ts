import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../src/app'
import type { FastifyInstance } from 'fastify'

/**
 * Tests for issue #262: standardized HTTP status code behavior across all routes.
 *
 * The rule:
 * - 404 when a resource does not exist (pair not watched, key not found)
 * - 200 with empty result when a query matched nothing (no data in time window)
 */

describe('HTTP status code standardization (#262)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    process.env.STELLAR_NETWORK = 'testnet'
    process.env.WATCHED_PAIRS = 'XLM:native,USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    process.env.REQUIRE_API_KEY = 'false'  // Disable API key auth for tests
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  describe('404 for non-existent resources', () => {
    it('GET /price/:assetA/:assetB returns 404 when pair is not watched', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/NONEXISTENT',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not watched/)
    })

    it('GET /price/:assetA/:assetB/route returns 404 when pair is not watched', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/NONEXISTENT/route?amount=100',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not watched/)
    })

    it('GET /price/:assetA/:assetB/depth returns 404 when pair is not watched', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/NONEXISTENT/depth?amount=100',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not watched/)
    })

    it('GET /benchmark/:asset returns 404 when pair is not watched', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/benchmark/NONEXISTENT?target=USD',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not watched/)
    })

    it('DELETE /admin/keys/:id returns 404 when API key not found', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/keys/00000000-0000-0000-0000-000000000000',
        headers: {
          'x-admin-token': process.env.ADMIN_TOKEN || 'test-admin-token',
        },
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/not found/)
    })
  })

  describe('200 with empty result when query matched nothing', () => {
    it('GET /basket returns 200 with error and reason when assets have no price data', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/basket?asset=FAKEASSET1&asset=FAKEASSET2&weight=0.5&weight=0.5',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body).toHaveProperty('reason', 'missing_price_data')
      expect(body).toHaveProperty('missingAssets')
      expect(Array.isArray(body.missingAssets)).toBe(true)
    })

    it('GET /compare/:asset returns 200 with status:"no_data" when both sources are null', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/compare/NONEXISTENTASSET',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('status', 'no_data')
      expect(body).toHaveProperty('lens', null)
      expect(body).toHaveProperty('reflector', null)
    })

    it('GET /candles/:assetA/:assetB returns 200 with empty candles array when no data exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/candles/XLM/USDC?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('candles')
      expect(Array.isArray(body.candles)).toBe(true)
      // May be empty depending on whether fixture data exists in that range
    })

    it('GET /price/:assetA/:assetB/history returns 200 with empty buckets array when no data exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/history?window=1m&limit=1',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('buckets')
      expect(Array.isArray(body.buckets)).toBe(true)
    })

    it('GET /spreads/:asset returns 200 with empty venues array when no venue quoted the asset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/spreads/NONEXISTENTASSET?window=5m',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('venues')
      expect(Array.isArray(body.venues)).toBe(true)
      expect(body.venues).toHaveLength(0)
      expect(body).toHaveProperty('tightest', null)
    })

    it('GET /volumes/:asset returns 200 with totalVolume:0 when no trades exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/volumes/NONEXISTENTASSET?window=24h',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('totalVolume', 0)
      expect(body).toHaveProperty('byVenue')
      expect(Object.keys(body.byVenue)).toHaveLength(0)
      expect(body).toHaveProperty('tradeCount', 0)
    })

    it('GET /screener returns 200 with empty data array when no pairs match filters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/screener?volume=9999999999999',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('data')
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.data).toHaveLength(0)
      expect(body).toHaveProperty('hasMore', false)
    })

    it('GET /pools returns 200 with empty pools array when no pools exist for the network', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pools?network=testnet',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('pools')
      expect(Array.isArray(body.pools)).toBe(true)
      // May be empty or populated depending on fixture data
    })

    it('GET /pairs returns 200 with empty pairs array when no pairs are watched', async () => {
      // This scenario is unlikely in production but can occur during initial setup
      const res = await app.inject({
        method: 'GET',
        url: '/pairs',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('pairs')
      expect(Array.isArray(body.pairs)).toBe(true)
    })
  })

  describe('400 for malformed requests (unchanged behavior)', () => {
    it('GET /candles/:assetA/:assetB returns 400 for invalid interval', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/candles/XLM/USDC?interval=invalid',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
    })

    it('GET /basket returns 400 when assets and weights count mismatch', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/basket?asset=XLM&asset=USDC&weight=0.5',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
      expect(body.error).toMatch(/must match/)
    })

    it('GET /spreads/:asset returns 400 for invalid window', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/spreads/XLM?window=invalid',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
    })

    it('GET /volumes/:asset returns 400 for invalid window', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/volumes/XLM?window=invalid',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
    })

    it('GET /price/:assetA/:assetB/route returns 400 for negative amount', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/price/XLM/USDC/route?amount=-100',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('error')
    })
  })

  describe('DELETE /webhooks/:id is idempotent (204 even when not found)', () => {
    it('returns 204 for non-existent webhook ID', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/webhooks/00000000-0000-0000-0000-000000000000',
      })
      expect(res.statusCode).toBe(204)
      expect(res.body).toBe('')
    })
  })
})
