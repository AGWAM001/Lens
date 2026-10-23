import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildApp, RATE_LIMITS } from '../app'
import type { FastifyInstance } from 'fastify'

describe('Rate Limiting & 429 Contract (#272)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    process.env.REQUIRE_API_KEY = 'false'
    process.env.RATE_LIMIT_IP_MAX = '5'
    app = await buildApp()
    await app.ready()
  })

  afterEach(async () => {
    delete process.env.REQUIRE_API_KEY
    delete process.env.RATE_LIMIT_IP_MAX
    await app.close()
  })

  it('exports RATE_LIMITS constants with default quotas matching documentation', () => {
    expect(RATE_LIMITS.ipDefault).toBe(100)
    expect(RATE_LIMITS.authenticatedDefault).toBe(1000)
    expect(RATE_LIMITS.monitoring).toBe(1000)
    expect(RATE_LIMITS.timeWindow).toBe('1 minute')
  })

  it('returns 429 with code rate_limited and Retry-After header when limit exceeded', async () => {
    let rateLimitedRes: any = null

    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/pairs',
      })
      if (res.statusCode === 429) {
        rateLimitedRes = res
        break
      }
    }

    expect(rateLimitedRes).not.toBeNull()
    expect(rateLimitedRes.statusCode).toBe(429)
    const body = JSON.parse(rateLimitedRes.payload)
    expect(body.code).toBe('rate_limited')
    expect(typeof body.retryAfter).toBe('number')
    expect(rateLimitedRes.headers['retry-after']).toBeDefined()
  })
})
