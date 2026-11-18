import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import {
  generateETag,
  matchesIfNoneMatch,
  isETagEligible,
  registerETag,
  LIST_AND_HISTORICAL_ROUTES,
} from '../middleware/etag'

describe('ETag Middleware Unit Tests', () => {
  describe('generateETag', () => {
    it('produces a quoted SHA-256 hex digest', () => {
      const etag = generateETag('{"hello":"world"}')
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    })

    it('is purely deterministic and does not depend on the clock', () => {
      const payload = JSON.stringify({ pairs: [{ pairKey: 'XLM/USDC', price: 0.12 }] })
      const etag1 = generateETag(payload)
      const etag2 = generateETag(payload)
      expect(etag1).toBe(etag2)
    })

    it('changes when and only when content changes', () => {
      const etag1 = generateETag('{"price": 1.0}')
      const etag2 = generateETag('{"price": 1.0}')
      const etag3 = generateETag('{"price": 1.1}')
      expect(etag1).toBe(etag2)
      expect(etag1).not.toBe(etag3)
    })

    it('works identically for Buffer payloads', () => {
      const str = 'test payload'
      const buf = Buffer.from(str)
      expect(generateETag(buf)).toBe(generateETag(str))
    })
  })

  describe('matchesIfNoneMatch', () => {
    const etag = '"c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2"'

    it('matches exact strong ETag', () => {
      expect(matchesIfNoneMatch(etag, etag)).toBe(true)
    })

    it('matches wildcard *', () => {
      expect(matchesIfNoneMatch('*', etag)).toBe(true)
    })

    it('matches comma-separated list of ETags', () => {
      expect(matchesIfNoneMatch(`"old-tag", ${etag}, "another"`, etag)).toBe(true)
      expect(matchesIfNoneMatch('"old-tag", "another"', etag)).toBe(false)
    })

    it('matches weak tag against strong entity tag', () => {
      const weakEtag = `W/${etag}`
      expect(matchesIfNoneMatch(weakEtag, etag)).toBe(true)
    })

    it('returns false for undefined or mismatched header', () => {
      expect(matchesIfNoneMatch(undefined, etag)).toBe(false)
      expect(matchesIfNoneMatch('""', etag)).toBe(false)
      expect(matchesIfNoneMatch('"mismatch"', etag)).toBe(false)
    })
  })

  describe('isETagEligible', () => {
    it('approves list routes on 200 GET', () => {
      expect(isETagEligible('GET', 200, '/pairs')).toBe(true)
      expect(isETagEligible('GET', 200, '/pools')).toBe(true)
      expect(isETagEligible('GET', 200, '/screener')).toBe(true)
    })

    it('approves historical routes on 200 GET', () => {
      expect(isETagEligible('GET', 200, '/price/:assetA/:assetB/history')).toBe(true)
      expect(isETagEligible('GET', 200, '/prices/history')).toBe(true)
      expect(isETagEligible('GET', 200, '/candles/:assetA/:assetB')).toBe(true)
      expect(isETagEligible('GET', 200, '/price/twap/:assetA/:assetB')).toBe(true)
      expect(isETagEligible('GET', 200, '/price/vwap/:assetA/:assetB')).toBe(true)
    })

    it('rejects non-GET/HEAD methods', () => {
      expect(isETagEligible('POST', 200, '/pairs')).toBe(false)
      expect(isETagEligible('DELETE', 200, '/pairs')).toBe(false)
      expect(isETagEligible('PUT', 200, '/pairs')).toBe(false)
    })

    it('accepts HEAD method', () => {
      expect(isETagEligible('HEAD', 200, '/pairs')).toBe(true)
    })

    it('rejects non-200 responses', () => {
      expect(isETagEligible('GET', 400, '/pairs')).toBe(false)
      expect(isETagEligible('GET', 404, '/pairs')).toBe(false)
      expect(isETagEligible('GET', 500, '/pairs')).toBe(false)
      expect(isETagEligible('GET', 304, '/pairs')).toBe(false)
    })

    it('rejects other unclassified routes', () => {
      expect(isETagEligible('GET', 200, '/status')).toBe(false)
      expect(isETagEligible('GET', 200, '/price/:assetA/:assetB')).toBe(false)
      expect(isETagEligible('GET', 200, '/admin/keys')).toBe(false)
    })

    it('respects route config overrides', () => {
      expect(isETagEligible('GET', 200, '/pairs', { etag: false })).toBe(false)
      expect(isETagEligible('GET', 200, '/custom', { etag: true })).toBe(true)
    })
  })
})

describe('ETag Plugin Fastify Integration', () => {
  async function createTestApp(getData: () => any) {
    const app = Fastify({ logger: false })
    await app.register(registerETag)

    app.get('/pairs', async () => getData())
    app.get('/status', async () => ({ ok: true }))
    app.get('/candles/:assetA/:assetB', async () => getData())
    await app.ready()
    return app
  }

  it('emits strong ETag and Cache-Control on list routes', async () => {
    const app = await createTestApp(() => ({ pairs: [{ pairKey: 'XLM/USDC' }] }))
    const res = await app.inject({ method: 'GET', url: '/pairs' })

    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBeDefined()
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/)
    expect(res.headers['cache-control']).toBe('public, no-cache')
  })

  it('does not emit ETag on non-eligible routes like /status', async () => {
    const app = await createTestApp(() => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/status' })

    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBeUndefined()
  })

  it('honours If-None-Match returning 304 with empty body when polling twice', async () => {
    const data = { pairs: [{ pairKey: 'XLM/USDC', price: 0.12 }] }
    const app = await createTestApp(() => data)

    // First poll
    const firstRes = await app.inject({ method: 'GET', url: '/pairs' })
    expect(firstRes.statusCode).toBe(200)
    const etag = firstRes.headers.etag
    expect(etag).toBeDefined()
    expect(firstRes.body).toContain('XLM/USDC')

    // Second poll with If-None-Match
    const secondRes = await app.inject({
      method: 'GET',
      url: '/pairs',
      headers: {
        'if-none-match': etag as string,
      },
    })

    expect(secondRes.statusCode).toBe(304)
    expect(secondRes.headers.etag).toBe(etag)
    expect(secondRes.body).toBe('')
  })

  it('returns 200 with new content and updated ETag when content changes', async () => {
    let price = 0.12
    const app = await createTestApp(() => ({
      pairs: [{ pairKey: 'XLM/USDC', price }],
    }))

    // First poll
    const res1 = await app.inject({ method: 'GET', url: '/pairs' })
    const etag1 = res1.headers.etag

    // Content changes
    price = 0.15

    // Second poll with old ETag
    const res2 = await app.inject({
      method: 'GET',
      url: '/pairs',
      headers: {
        'if-none-match': etag1 as string,
      },
    })

    expect(res2.statusCode).toBe(200)
    expect(res2.headers.etag).not.toBe(etag1)
    expect(res2.json().pairs[0].price).toBe(0.15)
  })

  it('preserves pre-existing Cache-Control header if already set', async () => {
    const app = Fastify({ logger: false })
    await app.register(registerETag)

    app.get('/pairs', async (req, reply) => {
      reply.header('Cache-Control', 'public, max-age=300')
      return { pairs: [] }
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/pairs' })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBeDefined()
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })
})
