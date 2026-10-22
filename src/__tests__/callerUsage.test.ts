import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

vi.mock('../redis', () => ({
  redis: {
    get: vi.fn(),
    multi: vi.fn().mockReturnThis(),
    on: vi.fn(),
  },
}))

import { prisma } from '../db'
import { redis } from '../redis'
import { registerUsageRoutes } from '../api/usage'
import { registerApiKeyAuth, hashApiKey } from '../api/auth'

const mockFindUnique = prisma.apiKey.findUnique as any
const mockRedisGet = redis.get as any

beforeEach(() => {
  vi.clearAllMocks()
})

async function buildTestApp() {
  const app = Fastify()
  await app.register(registerApiKeyAuth)
  await app.register(registerUsageRoutes)
  return app
}

describe('Issue #513: Caller Own Usage (/usage and /usage/me)', () => {
  it('returns 401 without API key', async () => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: 'GET',
      url: '/usage',
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'Unauthorized' })
  })

  it('caller can read their own usage with their own key, receiving no-store and reset countdowns', async () => {
    const key1Plain = 'lens_test_key_1_12345678901234567890'
    const key1Hash = hashApiKey(key1Plain)

    mockFindUnique.mockImplementation(({ where }: any) => {
      if (where.hash === key1Hash) {
        return Promise.resolve({
          id: 'key-uuid-1',
          label: 'Client 1',
          ratePerMin: 60,
          ratePerDay: 5000,
          monthlyQuotaCents: 15000,
          dailyQuotaCents: 800,
          overagePolicy: 'block',
          revokedAt: null,
          expiresAt: null,
        })
      }
      if (where.id === 'key-uuid-1') {
        return Promise.resolve({
          id: 'key-uuid-1',
          monthlyQuotaCents: 15000,
          dailyQuotaCents: 800,
          overagePolicy: 'block',
        })
      }
      return Promise.resolve(null)
    })

    mockRedisGet.mockImplementation((key: string) => {
      if (key.endsWith(':calls')) return Promise.resolve('25')
      if (key.endsWith(':cents')) return Promise.resolve('150')
      return Promise.resolve('0')
    })

    const app = await buildTestApp()
    const res = await app.inject({
      method: 'GET',
      url: '/usage',
      headers: {
        authorization: `Bearer ${key1Plain}`,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')

    const body = res.json()
    expect(body.keyId).toBe('key-uuid-1')
    expect(body.dailyCalls).toBe(25)
    expect(body.dailyCents).toBe(150)
    expect(body.dailyQuotaCents).toBe(800)
    expect(body.dailyRemainingCents).toBe(650)
    expect(body.monthlyQuotaCents).toBe(15000)
    expect(body.monthlyRemainingCents).toBe(14850)
    expect(body.quotaExceeded).toBe(false)
    expect(body.dailyResetsAt).toBeDefined()
    expect(body.monthlyResetsAt).toBeDefined()
    expect(body.resets.daily).toBeDefined()
    expect(body.resets.monthly).toBeDefined()
    expect(body.resetsInSeconds.daily).toBeGreaterThan(0)
    expect(body.resetsInSeconds.monthly).toBeGreaterThan(0)
  })

  it('guarantees no parameter can make it return another key usage (key isolation)', async () => {
    const key1Plain = 'lens_test_key_1_12345678901234567890'
    const key1Hash = hashApiKey(key1Plain)

    mockFindUnique.mockImplementation(({ where }: any) => {
      if (where.hash === key1Hash) {
        return Promise.resolve({
          id: 'key-uuid-1',
          label: 'Client 1',
          ratePerMin: 60,
          ratePerDay: 5000,
          monthlyQuotaCents: 10000,
          dailyQuotaCents: 500,
          overagePolicy: 'block',
          revokedAt: null,
          expiresAt: null,
        })
      }
      if (where.id === 'key-uuid-1') {
        return Promise.resolve({
          id: 'key-uuid-1',
          monthlyQuotaCents: 10000,
          dailyQuotaCents: 500,
          overagePolicy: 'block',
        })
      }
      if (where.id === 'victim-key-uuid-2') {
        return Promise.resolve({
          id: 'victim-key-uuid-2',
          monthlyQuotaCents: 999999,
          dailyQuotaCents: 999999,
          overagePolicy: 'allow_overage',
        })
      }
      return Promise.resolve(null)
    })

    const app = await buildTestApp()

    // Caller attempts to pass another key ID via query string
    const resQuery = await app.inject({
      method: 'GET',
      url: '/usage?keyId=victim-key-uuid-2&id=victim-key-uuid-2',
      headers: {
        authorization: `Bearer ${key1Plain}`,
      },
    })
    expect(resQuery.statusCode).toBe(200)
    expect(resQuery.json().keyId).toBe('key-uuid-1')
    expect(resQuery.json().keyId).not.toBe('victim-key-uuid-2')

    // Also assert on /usage/me
    const resMe = await app.inject({
      method: 'GET',
      url: '/usage/me?keyId=victim-key-uuid-2',
      headers: {
        authorization: `Bearer ${key1Plain}`,
      },
    })
    expect(resMe.statusCode).toBe(200)
    expect(resMe.json().keyId).toBe('key-uuid-1')
  })
})
