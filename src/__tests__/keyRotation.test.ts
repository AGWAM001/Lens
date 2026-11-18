import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../redis', () => ({
  redis: {
    get: vi.fn(),
    multi: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    on: vi.fn(),
  },
}))

import { prisma } from '../db'
import { redis } from '../redis'
import { registerAdminRoutes } from '../api/admin'
import { registerApiKeyAuth, hashApiKey } from '../api/auth'

const mockFindUnique = prisma.apiKey.findUnique as any
const mockCreate = prisma.apiKey.create as any
const mockUpdate = prisma.apiKey.update as any
const mockRedisGet = redis.get as any

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_TOKEN = 'admin-secret-token'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  // One test advances the system clock to walk past an overlap window; leaving
  // fake timers installed would leak that into every test after it.
  vi.useRealTimers()
})

describe('Issue #501: Key Rotation (POST /admin/keys/:id/rotate)', () => {
  it('rejects rotation without admin authorization', async () => {
    const app = Fastify()
    await app.register(registerAdminRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/old-key-id/rotate',
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects rotation if key is not found or already revoked', async () => {
    const app = Fastify()
    await app.register(registerAdminRoutes)

    mockFindUnique.mockResolvedValueOnce(null)
    const resNotFound = await app.inject({
      method: 'POST',
      url: '/admin/keys/non-existent/rotate',
      headers: { 'x-admin-token': 'admin-secret-token' },
    })
    expect(resNotFound.statusCode).toBe(404)

    mockFindUnique.mockResolvedValueOnce({
      id: 'revoked-key',
      revokedAt: new Date(),
    })
    const resRevoked = await app.inject({
      method: 'POST',
      url: '/admin/keys/revoked-key/rotate',
      headers: { 'x-admin-token': 'admin-secret-token' },
    })
    expect(resRevoked.statusCode).toBe(400)
    expect(resRevoked.json().error).toContain('revoked')
  })

  it('successfully rotates a key with bounded overlap window, carries quotas and usage', async () => {
    const oldKeyRecord = {
      id: 'old-key-uuid',
      label: 'Partner Billing Key',
      ratePerMin: 120,
      ratePerDay: 50000,
      monthlyQuotaCents: 100000,
      dailyQuotaCents: 5000,
      overagePolicy: 'charge_402',
      revokedAt: null,
      expiresAt: null,
    }
    mockFindUnique.mockResolvedValue(oldKeyRecord)
    mockUpdate.mockResolvedValue({})
    mockCreate.mockImplementation(({ data }: any) => {
      return Promise.resolve({
        id: 'new-key-uuid',
        ...data,
        createdAt: new Date(),
      })
    })

    // Mock existing usage on old key
    mockRedisGet.mockImplementation((key: string) => {
      if (key.includes('old-key-uuid') && key.endsWith(':calls')) return Promise.resolve('45')
      if (key.includes('old-key-uuid') && key.endsWith(':cents')) return Promise.resolve('450')
      return Promise.resolve(null)
    })

    const app = Fastify()
    await app.register(registerAdminRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys/old-key-uuid/rotate',
      headers: { 'x-admin-token': 'admin-secret-token' },
      payload: { overlapHours: 48 },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe('new-key-uuid')
    expect(body.oldKeyId).toBe('old-key-uuid')
    expect(body.label).toBe('Partner Billing Key')
    expect(body.ratePerMin).toBe(120)
    expect(body.ratePerDay).toBe(50000)
    expect(body.monthlyQuotaCents).toBe(100000)
    expect(body.dailyQuotaCents).toBe(5000)
    expect(body.overagePolicy).toBe('charge_402')
    expect(body.key).toMatch(/^lens_[a-f0-9]{48}$/)
    expect(body.overlapHours).toBe(48)
    expect(body.overlapEndsAt).toBeDefined()

    // Assert that the old key was updated with expiresAt matching overlap window
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'old-key-uuid' },
        data: expect.objectContaining({
          expiresAt: expect.any(Date),
        }),
      })
    )
  })

  it('both keys work during overlap, and the old one fails after overlap window ends', async () => {
    const oldPlainKey = 'lens_old_key_during_overlap_1234567890123'
    const newPlainKey = 'lens_new_key_during_overlap_1234567890123'
    const oldHash = hashApiKey(oldPlainKey)
    const newHash = hashApiKey(newPlainKey)

    const futureExpiration = new Date(Date.now() + 24 * 3600 * 1000)
    const pastExpiration = new Date(Date.now() - 1000) // 1 second in the past

    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/protected', async (req, reply) => reply.send({ success: true, key: req.apiKey?.id }))

    // State 1: During overlap (both valid)
    mockFindUnique.mockImplementation(({ where }: any) => {
      if (where.hash === oldHash) {
        return Promise.resolve({
          id: 'old-key-id',
          label: 'Customer Key',
          ratePerMin: 60,
          ratePerDay: 5000,
          revokedAt: null,
          expiresAt: futureExpiration, // still valid
        })
      }
      if (where.hash === newHash) {
        return Promise.resolve({
          id: 'new-key-id',
          label: 'Customer Key',
          ratePerMin: 60,
          ratePerDay: 5000,
          revokedAt: null,
          expiresAt: null,
        })
      }
      return Promise.resolve(null)
    })

    const resOldDuringOverlap = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${oldPlainKey}` },
    })
    expect(resOldDuringOverlap.statusCode).toBe(200)
    expect(resOldDuringOverlap.json().key).toBe('old-key-id')

    const resNewDuringOverlap = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${newPlainKey}` },
    })
    expect(resNewDuringOverlap.statusCode).toBe(200)
    expect(resNewDuringOverlap.json().key).toBe('new-key-id')

    // State 2: after the overlap window ends.
    //
    // Advance the clock rather than only swapping the database row. With the
    // API-key lookup cache (#495) the old key's entry is already held, and the
    // guarantee that matters is that a cached entry is re-checked against its
    // own `expiresAt` on every hit — so the cache can never keep a key alive
    // past its expiry, with or without a database read. Rewriting the row
    // alone would only exercise the documented cross-instance TTL window, and
    // would have passed before the cache existed for reasons that no longer
    // hold.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(futureExpiration.getTime() + 1000))

    mockFindUnique.mockImplementation(({ where }: any) => {
      if (where.hash === oldHash) {
        return Promise.resolve({
          id: 'old-key-id',
          label: 'Customer Key',
          ratePerMin: 60,
          ratePerDay: 5000,
          revokedAt: null,
          expiresAt: pastExpiration, // EXPIRED
        })
      }
      if (where.hash === newHash) {
        return Promise.resolve({
          id: 'new-key-id',
          label: 'Customer Key',
          ratePerMin: 60,
          ratePerDay: 5000,
          revokedAt: null,
          expiresAt: null,
        })
      }
      return Promise.resolve(null)
    })

    const resOldAfterOverlap = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${oldPlainKey}` },
    })
    expect(resOldAfterOverlap.statusCode).toBe(401)
    expect(resOldAfterOverlap.json().code).toBe('expired')

    // New key continues to work smoothly without outage — it has no expiry,
    // so the advanced clock must not touch it.
    const resNewAfterOverlap = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${newPlainKey}` },
    })
    expect(resNewAfterOverlap.statusCode).toBe(200)
    expect(resNewAfterOverlap.json().key).toBe('new-key-id')
  })
})
