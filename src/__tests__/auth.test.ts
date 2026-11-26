import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

// ── Mock Prisma (mirrors the pattern used by webhooks.test.ts) ─────────────────
vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    webhookDeliveryFailure: {
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import {
  registerApiKeyAuth,
  hashApiKey,
  extractBearer,
  lookupApiKey,
  hasScope,
  invalidateApiKey,
  clearApiKeyCache,
  recordApiKeyLastUsed,
  getKeyLastUsedThrottleMs,
  resetApiKeyLastUsedThrottle,
  DEFAULT_KEY_LAST_USED_THROTTLE_SECONDS,
} from '../api/auth'
import { registerAdminRoutes, generateApiKey } from '../api/admin'
import {
  register,
  api_key_auth_failures_total,
  admin_auth_failures_total,
  api_key_cache_lookups_total,
} from '../metrics'

const mockFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>
const mockFindMany = prisma.apiKey.findMany as unknown as ReturnType<typeof vi.fn>
const mockCount = prisma.apiKey.count as unknown as ReturnType<typeof vi.fn>
const mockCreate = prisma.apiKey.create as unknown as ReturnType<typeof vi.fn>
const mockUpdate = prisma.apiKey.update as unknown as ReturnType<typeof vi.fn>

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

async function apiKeyAuthFailureCount(reason: string): Promise<number> {
  const metric = await api_key_auth_failures_total.get()
  return metric.values.find((value) => value.labels.reason === reason)?.value ?? 0
}

/** Builds an app with auth enabled + one protected and one public route. */
async function buildAuthedApp() {
  const app = Fastify()
  // Auth must register before rate-limit: both run in `onRequest`, and the
  // limiter reads req.apiKey, which the auth hook populates.
  await app.register(registerApiKeyAuth)
  await app.register(rateLimit, {
    max: (req) => req.apiKey?.ratePerMin ?? 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
  })
  app.get('/price/test', { config: { scope: 'read:prices' } }, async () => ({ ok: true }))
  app.get('/history/test', { config: { scope: 'read:history' } }, async () => ({ ok: true }))
  app.get('/status', { config: { public: true } }, async () => ({ ok: true }))
  await app.ready()
  return app
}

beforeEach(() => {
  // The lastUsedAt throttle is module-level state keyed by id; without this a
  // window claimed in one test silently throttles the next one's write.
  resetApiKeyLastUsedThrottle()
  mockFindUnique.mockReset()
  mockFindMany.mockReset()
  mockCount.mockReset()
  mockCreate.mockReset()
  mockUpdate.mockReset()
  // webhookDeliveryFailure mocks are shared across the admin-endpoint tests;
  // reset them too, or a prior test's call count / mockResolvedValue leaks into
  // the next one under shuffled order (the "recent webhook failure endpoint"
  // test then sees findMany already called and fails).
  vi.mocked(prisma.webhookDeliveryFailure.findMany).mockReset()
  vi.mocked(prisma.webhookDeliveryFailure.create).mockReset()
  vi.mocked(prisma.webhookDeliveryFailure.deleteMany).mockReset()
  // The lookup cache is module-global; a stale entry from a previous test
  // would otherwise mask a different mock for the same key.
  clearApiKeyCache()
})

describe('hashApiKey / extractBearer', () => {
  it('hashes keys with SHA-256 (never stores plaintext)', () => {
    expect(hashApiKey('lens_secret')).toBe(sha256('lens_secret'))
    // 64 hex chars = SHA-256
    expect(hashApiKey('x')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('extracts the bearer token, case-insensitively', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123')
    expect(extractBearer('bearer  spaced ')).toBe('spaced')
    expect(extractBearer(undefined)).toBeNull()
    expect(extractBearer('Basic abc')).toBeNull()
  })
})

describe('lookupApiKey', () => {
  it('looks up by hash and returns context for a valid key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null,
    })
    const ctx = await lookupApiKey('lens_plain')
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { hash: sha256('lens_plain') } })
    expect(ctx).toEqual({ id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, scopes: [] })
  })

  it('returns scopes when the key has scopes defined', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null, scopes: ['read:prices', 'subscribe'],
    })
    const ctx = await lookupApiKey('lens_plain')
    expect(ctx).toEqual({
      id: 'key-1',
      label: 'acme',
      ratePerMin: 120,
      ratePerDay: 50000,
      scopes: ['read:prices', 'subscribe'],
    })
  })

  it('returns null for an unknown key', async () => {
    mockFindUnique.mockResolvedValue(null)
    expect(await lookupApiKey('nope')).toBeNull()
  })

  it('returns null for a revoked key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: new Date(),
    })
    expect(await lookupApiKey('lens_plain')).toBeNull()
  })

  it('returns null for an expired key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1',
      label: 'acme',
      ratePerMin: 60,
      ratePerDay: 1000,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await lookupApiKey('lens_plain')).toBeNull()
  })
})

describe('hasScope', () => {
  const unscopedKey = { id: 'k1', label: 'unscoped', ratePerMin: 60, ratePerDay: 1000, scopes: [] }
  const scopedKey = { id: 'k2', label: 'scoped', ratePerMin: 60, ratePerDay: 1000, scopes: ['read:prices'] }
  const wildcardKey = { id: 'k3', label: 'wildcard', ratePerMin: 60, ratePerDay: 1000, scopes: ['*'] }

  it('allows access when route requires no scope', () => {
    expect(hasScope(scopedKey, undefined)).toBe(true)
    expect(hasScope(unscopedKey, undefined)).toBe(true)
  })

  it('allows legacy unscoped key access to any scope', () => {
    expect(hasScope(unscopedKey, 'read:prices')).toBe(true)
    expect(hasScope(unscopedKey, 'read:history')).toBe(true)
    expect(hasScope(unscopedKey, 'subscribe')).toBe(true)
  })

  it('allows scoped key access only to declared scopes', () => {
    expect(hasScope(scopedKey, 'read:prices')).toBe(true)
    expect(hasScope(scopedKey, 'read:history')).toBe(false)
    expect(hasScope(scopedKey, 'subscribe')).toBe(false)
  })

  it('allows wildcard key access to any scope', () => {
    expect(hasScope(wildcardKey, 'read:prices')).toBe(true)
    expect(hasScope(wildcardKey, 'read:history')).toBe(true)
  })
})

describe('API key auth hook', () => {
  it('returns 401 when no key is provided', async () => {
    const before = await apiKeyAuthFailureCount('missing')
    const app = await buildAuthedApp()
    const res = await app.inject({ method: 'GET', url: '/price/test' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'Unauthorized' })
    expect(res.json().code).toBe('missing')
    expect(res.json().message).toBe('Missing API key. Provide an Authorization header.')
    expect(await apiKeyAuthFailureCount('missing')).toBe(before + 1)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('rejects X-API-Key in place of Authorization: Bearer', async () => {
    const app = await buildAuthedApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/price/test',
        headers: { 'x-api-key': 'lens_not-a-real-key' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('missing')
      expect(res.json().message).toBe('Missing API key. Provide an Authorization header.')
      expect(mockFindUnique).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('counts malformed authorization separately from missing credentials', async () => {
    const before = await apiKeyAuthFailureCount('malformed')
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Basic value' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'malformed' })
    expect(await apiKeyAuthFailureCount('malformed')).toBe(before + 1)
  })

  it('returns 401 for an invalid key', async () => {
    const before = await apiKeyAuthFailureCount('unknown')
    mockFindUnique.mockResolvedValue(null)
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unknown')
    expect(res.json().message).toBe('Unknown API key.')
    expect(await apiKeyAuthFailureCount('unknown')).toBe(before + 1)
  })

  it('returns 401 for a revoked key', async () => {
    const before = await apiKeyAuthFailureCount('revoked')
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: new Date(),
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer revoked' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('revoked')
    expect(res.json().message).toBe('Revoked API key. Request a replacement key.')
    expect(await apiKeyAuthFailureCount('revoked')).toBe(before + 1)
  })

  it('returns a distinct code and message for an expired key', async () => {
    const before = await apiKeyAuthFailureCount('expired')
    mockFindUnique.mockResolvedValue({
      id: 'key-1',
      label: 'acme',
      ratePerMin: 60,
      ratePerDay: 1000,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer test-expired-api-key' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('expired')
    expect(res.json().message).toBe('Expired API key. Request a replacement key.')
    expect(await apiKeyAuthFailureCount('expired')).toBe(before + 1)
  })

  it('allows a valid key through and attaches metadata', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null,
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer good' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('lets public routes through without a key', async () => {
    const app = await buildAuthedApp()
    const res = await app.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(200)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('allows a call when key has the required scope', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null, scopes: ['read:prices'],
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer good' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('refuses a call when key lacks the required scope and names the required scope in the error', async () => {
    const before = await apiKeyAuthFailureCount('insufficient_scope')
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null, scopes: ['read:prices'],
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/history/test',
      headers: { authorization: 'Bearer good' },
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBe('Forbidden')
    expect(body.code).toBe('insufficient_scope')
    expect(body.requiredScope).toBe('read:history')
    expect(body.message).toContain('read:history')
    expect(await apiKeyAuthFailureCount('insufficient_scope')).toBe(before + 1)
  })

  it('allows a legacy unscoped key with no scopes recorded to access any route', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-legacy', label: 'legacy-partner', ratePerMin: 120, ratePerDay: 50000, revokedAt: null, scopes: [],
    })
    const app = await buildAuthedApp()
    const priceRes = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer legacy' },
    })
    expect(priceRes.statusCode).toBe(200)
    expect(priceRes.json()).toEqual({ ok: true })

    const historyRes = await app.inject({
      method: 'GET',
      url: '/history/test',
      headers: { authorization: 'Bearer legacy' },
    })
    expect(historyRes.statusCode).toBe(200)
    expect(historyRes.json()).toEqual({ ok: true })
  })

  it('allows a key with multiple scopes to access routes matching any of its scopes', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-multi', label: 'multi', ratePerMin: 120, ratePerDay: 50000, revokedAt: null, scopes: ['read:prices', 'read:history'],
    })
    const app = await buildAuthedApp()
    const priceRes = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer multi' },
    })
    expect(priceRes.statusCode).toBe(200)

    const historyRes = await app.inject({
      method: 'GET',
      url: '/history/test',
      headers: { authorization: 'Bearer multi' },
    })
    expect(historyRes.statusCode).toBe(200)
  })
})

describe('per-key rate quotas', () => {
  it('honors each key’s own ratePerMin (429 after the quota)', async () => {
    // A key allowed only 2 requests/min.
    mockFindUnique.mockResolvedValue({
      id: 'key-limited', label: 'small', ratePerMin: 2, ratePerDay: 1000, revokedAt: null,
    })
    const app = await buildAuthedApp()
    const headers = { authorization: 'Bearer limited' }

    const r1 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r2 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r3 = await app.inject({ method: 'GET', url: '/price/test', headers })

    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r3.statusCode).toBe(429) // quota exhausted
  })

  it('tracks quotas independently per key', async () => {
    const app = await buildAuthedApp()
    // First key: limited to 1/min.
    mockFindUnique.mockResolvedValue({
      id: 'key-a', label: 'a', ratePerMin: 1, ratePerDay: 100, revokedAt: null,
    })
    const a1 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer a' } })
    const a2 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer a' } })
    expect(a1.statusCode).toBe(200)
    expect(a2.statusCode).toBe(429)

    // Second, distinct key gets its own fresh bucket.
    mockFindUnique.mockResolvedValue({
      id: 'key-b', label: 'b', ratePerMin: 1, ratePerDay: 100, revokedAt: null,
    })
    const b1 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer b' } })
    expect(b1.statusCode).toBe(200)
  })
})

describe('API key lookup cache (Issue #495)', () => {
  const validRecord = {
    id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null,
  }

  it('serves a repeated request for the same key from cache (no Postgres per request)', async () => {
    mockFindUnique.mockResolvedValue({ ...validRecord })
    const app = await buildAuthedApp()
    const headers = { authorization: 'Bearer good' }
    const r1 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r2 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r3 = await app.inject({ method: 'GET', url: '/price/test', headers })
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 200, 200])
    // Three requests, one database lookup.
    expect(mockFindUnique).toHaveBeenCalledTimes(1)
  })

  it('caches negative lookups so invalid keys do not hit Postgres per attempt', async () => {
    mockFindUnique.mockResolvedValue(null)
    expect(await lookupApiKey('bad')).toBeNull()
    expect(await lookupApiKey('bad')).toBeNull()
    expect(await lookupApiKey('bad')).toBeNull()
    expect(mockFindUnique).toHaveBeenCalledTimes(1)
  })

  it('re-checks expiry on a cache hit, so the TTL never outlives the key', async () => {
    vi.useFakeTimers()
    try {
      mockFindUnique.mockResolvedValue({
        ...validRecord, expiresAt: new Date(Date.now() + 5_000),
      })
      expect(await lookupApiKey('soon')).not.toBeNull()
      // Move past the key's own expiry but stay well within the cache TTL.
      vi.advanceTimersByTime(6_000)
      expect(await lookupApiKey('soon')).toBeNull()
      // Still served from cache — expiry was re-evaluated, not re-queried.
      expect(mockFindUnique).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a revoked key immediately on the instance that handles the revoke', async () => {
    const token = 'to-be-revoked'
    mockFindUnique.mockResolvedValue({ ...validRecord })
    const app = await buildAuthedApp()
    const headers = { authorization: `Bearer ${token}` }
    expect((await app.inject({ method: 'GET', url: '/price/test', headers })).statusCode).toBe(200)

    // Revoke: Postgres now reports it revoked, and the revoke path drops the
    // cache entry (as admin.ts does after the UPDATE).
    mockFindUnique.mockResolvedValue({ ...validRecord, revokedAt: new Date() })
    invalidateApiKey(hashApiKey(token))

    const res = await app.inject({ method: 'GET', url: '/price/test', headers })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('revoked')
  })

  it('stops a revoked key within the cache TTL even without explicit invalidation', async () => {
    vi.useFakeTimers()
    try {
      mockFindUnique.mockResolvedValue({ ...validRecord })
      expect(await lookupApiKey('cross-instance')).not.toBeNull()

      // Revoked on another instance: our cache is not invalidated here.
      mockFindUnique.mockResolvedValue({ ...validRecord, revokedAt: new Date() })
      vi.advanceTimersByTime(29_000) // within the 30s TTL — still trusted
      expect(await lookupApiKey('cross-instance')).not.toBeNull()
      vi.advanceTimersByTime(2_000) // past the TTL — re-read, now rejected
      expect(await lookupApiKey('cross-instance')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps scopes on a cache hit, so a scoped route still works', async () => {
    // The cached value carries the whole ApiKeyContext, scopes included. If it
    // did not, a hit would authenticate with `scopes: undefined`, hasScope
    // would refuse, and every scoped route would 403 for the length of the TTL
    // — which reads as an authorization bug, not a caching one.
    mockFindUnique.mockResolvedValue({ ...validRecord, scopes: ['read:prices'] })

    const app = Fastify()
    await app.register(registerApiKeyAuth)
    app.get('/scoped', { config: { scope: 'read:prices' } }, async () => ({ ok: true }))
    await app.ready()

    const headers = { authorization: 'Bearer scoped-key' }
    const first = await app.inject({ method: 'GET', url: '/scoped', headers })
    const second = await app.inject({ method: 'GET', url: '/scoped', headers })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(mockFindUnique).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('exports cache lookups as a hit/miss metric', async () => {
    mockFindUnique.mockResolvedValue({ ...validRecord })
    await lookupApiKey('metric-key') // miss → Postgres
    await lookupApiKey('metric-key') // hit → cache
    const output = await register.metrics()
    expect(output).toContain('api_key_cache_lookups_total')
    const values = (await api_key_cache_lookups_total.get()).values
    const hit = values.find((v) => v.labels.result === 'hit')?.value ?? 0
    const miss = values.find((v) => v.labels.result === 'miss')?.value ?? 0
    expect(hit).toBeGreaterThanOrEqual(1)
    expect(miss).toBeGreaterThanOrEqual(1)
  })
})

describe('admin endpoints', () => {
  const ORIGINAL = process.env.ADMIN_TOKEN
  beforeEach(() => { process.env.ADMIN_TOKEN = 'admin-secret' })
  afterEach(() => {
    // Node stringifies undefined → "undefined"; delete to truly clear.
    if (ORIGINAL === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = ORIGINAL
  })

  async function buildAdminApp() {
    const app = Fastify()
    await registerAdminRoutes(app)
    await app.ready()
    return app
  }

  it('generateApiKey produces a prefixed opaque key', () => {
    const k = generateApiKey()
    expect(k).toMatch(/^lens_[a-f0-9]{48}$/)
  })

  it('lists only safe key metadata, paginates, and hides revoked keys by default', async () => {
    const createdAt = new Date('2026-10-01T12:00:00.000Z')
    mockFindMany.mockResolvedValue([{
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 5000,
      monthlyQuotaCents: 20000, dailyQuotaCents: 1000, overagePolicy: 'block',
      createdAt, revokedAt: null, expiresAt: null, scopes: ['read:prices'], lastUsedAt: null,
      hash: 'do-not-return-this-hash',
    }])
    mockCount.mockResolvedValue(3)
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'GET', url: '/admin/keys?limit=1&offset=2',
      headers: { 'x-admin-token': 'admin-secret' },
    })

    expect(res.statusCode).toBe(200)
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { revokedAt: null }, skip: 2, take: 1,
      select: expect.not.objectContaining({ hash: true }),
    }))
    expect(mockCount).toHaveBeenCalledWith({ where: { revokedAt: null } })
    expect(res.json()).toEqual({
      keys: [{
        id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 5000,
        monthlyQuotaCents: 20000, dailyQuotaCents: 1000, overagePolicy: 'block',
        scopes: ['read:prices'], createdAt: createdAt.toISOString(), revokedAt: null, expiresAt: null, lastUsedAt: null,
      }],
      pagination: { limit: 1, offset: 2, total: 3 },
    })
    expect(JSON.stringify(res.json())).not.toContain('do-not-return-this-hash')
  })

  it('requires the admin token to list API keys', async () => {
    const before = (await admin_auth_failures_total.get()).values[0]?.value ?? 0
    const app = await buildAdminApp()
    const res = await app.inject({ method: 'GET', url: '/admin/keys' })
    expect(res.statusCode).toBe(401)
    expect(mockFindMany).not.toHaveBeenCalled()
    expect((await admin_auth_failures_total.get()).values[0]?.value).toBe(before + 1)
  })

  it('can include revoked keys when explicitly requested', async () => {
    mockFindMany.mockResolvedValue([])
    mockCount.mockResolvedValue(0)
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'GET', url: '/admin/keys?revoked=true',
      headers: { 'x-admin-token': 'admin-secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { revokedAt: { not: null } } }))
  })

  it('rejects invalid key-list pagination and filters', async () => {
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'GET', url: '/admin/keys?limit=1000&revoked=maybe',
      headers: { 'x-admin-token': 'admin-secret' },
    })
    expect(res.statusCode).toBe(400)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('rejects minting without the admin token', async () => {
    const before = (await admin_auth_failures_total.get()).values[0]?.value ?? 0
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST', url: '/admin/keys', payload: { label: 'x' },
    })
    expect(res.statusCode).toBe(401)
    expect(mockCreate).not.toHaveBeenCalled()
    expect((await admin_auth_failures_total.get()).values[0]?.value).toBe(before + 1)
  })

  it('mints a key and returns the plaintext once (stored as hash only)', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, monthlyQuotaCents: 10000, dailyQuotaCents: 500, overagePolicy: 'block', ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: { label: 'acme', ratePerMin: 120, ratePerDay: 50000 },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.key).toMatch(/^lens_[a-f0-9]{48}$/)
    expect(body.label).toBe('acme')
    const stored = mockCreate.mock.calls[0][0].data
    expect(stored.hash).toBe(sha256(body.key))
    expect(stored.hash).not.toBe(body.key)
  })

  it('accepts quota configuration on key creation', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: { label: 'acme', monthlyQuotaCents: 20000, dailyQuotaCents: 1000, overagePolicy: 'allow_overage' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.monthlyQuotaCents).toBe(20000)
    expect(body.dailyQuotaCents).toBe(1000)
    expect(body.overagePolicy).toBe('allow_overage')
  })

  it('mints a key with a scope set', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: { label: 'scoped-partner', scopes: ['read:prices', 'subscribe'] },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.key).toMatch(/^lens_[a-f0-9]{48}$/)
    expect(body.scopes).toEqual(['read:prices', 'subscribe'])
    const stored = mockCreate.mock.calls[0][0].data
    expect(stored.scopes).toEqual(['read:prices', 'subscribe'])
  })

  it('lists keys with scopes visible', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'key-1',
        label: 'partner-prices',
        scopes: ['read:prices'],
        ratePerMin: 60,
        ratePerDay: 10000,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(),
        monthlyQuotaCents: 10000,
        dailyQuotaCents: 500,
        overagePolicy: 'block',
      },
      {
        id: 'key-2',
        label: 'legacy-key',
        scopes: [],
        ratePerMin: 60,
        ratePerDay: 10000,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(),
        monthlyQuotaCents: 10000,
        dailyQuotaCents: 500,
        overagePolicy: 'block',
      },
    ])
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.keys).toHaveLength(2)
    expect(body.keys[0].scopes).toEqual(['read:prices'])
    expect(body.keys[1].scopes).toEqual([])
  })

  it('rejects listing keys without admin token', async () => {
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys',
    })
    expect(res.statusCode).toBe(401)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  // ── Body validation (issue #506): reject bad quotas/policies, don't coerce ──
  async function postKey(payload: unknown) {
    const app = await buildAdminApp()
    return app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: payload as object,
    })
  }

  it('rejects a negative rate and names the field, without touching the database', async () => {
    const res = await postKey({ label: 'acme', ratePerMin: -5 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/ratePerMin/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a fractional quota', async () => {
    const res = await postKey({ label: 'acme', monthlyQuotaCents: 10.5 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/monthlyQuotaCents/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a zero rate (a key that can never call anything)', async () => {
    const res = await postKey({ label: 'acme', ratePerDay: 0 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/ratePerDay/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range value above the Int column ceiling', async () => {
    const res = await postKey({ label: 'acme', dailyQuotaCents: 9_999_999_999 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/dailyQuotaCents/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects an unknown overagePolicy instead of silently defaulting to block', async () => {
    const res = await postKey({ label: 'acme', overagePolicy: 'refund_everything' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/overagePolicy/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a per-day rate below the per-minute rate', async () => {
    const res = await postKey({ label: 'acme', ratePerMin: 100, ratePerDay: 50 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/ratePerDay/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a blank (whitespace-only) label', async () => {
    const res = await postKey({ label: '   ' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/label/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('accepts valid rates and policy at the boundary', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, ...data,
    }))
    const res = await postKey({ label: 'acme', ratePerMin: 60, ratePerDay: 60, overagePolicy: 'charge_402' })
    expect(res.statusCode).toBe(201)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('revokes a key by id', async () => {
    mockFindUnique.mockResolvedValue({ id: 'key-1', revokedAt: null })
    mockUpdate.mockResolvedValue({ id: 'key-1', revokedAt: new Date() })
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/keys/key-1',
      headers: { 'x-admin-token': 'admin-secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'key-1', revoked: true })
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('returns 404 revoking a non-existent key', async () => {
    mockFindUnique.mockResolvedValue(null)
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/keys/missing',
      headers: { 'x-admin-token': 'admin-secret' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('protects the recent webhook failure endpoint with the admin token', async () => {
    const app = await buildAdminApp()
    const res = await app.inject({ method: 'GET', url: '/admin/webhook-delivery-failures' })
    expect(res.statusCode).toBe(401)
    expect(prisma.webhookDeliveryFailure.findMany).not.toHaveBeenCalled()
  })

  it('returns a bounded newest-first diagnostic list to admins', async () => {
    const failures = [{ id: 'failed-1', endpoint: 'https://hooks.example.test/alerts', errorCategory: 'http_5xx' }]
    vi.mocked(prisma.webhookDeliveryFailure.findMany).mockResolvedValue(failures as any)
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/webhook-delivery-failures?limit=150',
      headers: { 'x-admin-token': 'admin-secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ failures })
    expect(prisma.webhookDeliveryFailure.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  })

  it('registers authentication counters in the Prometheus registry', async () => {
    const output = await register.metrics()
    expect(output).toContain('api_key_auth_failures_total')
    expect(output).toContain('admin_auth_failures_total')
  })
})

describe('lastUsedAt recording & throttling', () => {
  it('records lastUsedAt on successful authentication', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1',
      label: 'acme',
      ratePerMin: 120,
      ratePerDay: 50000,
      revokedAt: null,
      expiresAt: null,
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer test-valid-key' },
    })

    expect(res.statusCode).toBe(200)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  it('does not write lastUsedAt on failed authentication or public routes', async () => {
    mockFindUnique.mockResolvedValue(null)
    const app = await buildAuthedApp()

    // 1. Failed auth (invalid key)
    const resFail = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer non-existent' },
    })
    expect(resFail.statusCode).toBe(401)
    expect(mockUpdate).not.toHaveBeenCalled()

    // 2. Public route without auth
    const resPublic = await app.inject({
      method: 'GET',
      url: '/status',
    })
    expect(resPublic.statusCode).toBe(200)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('throttles writes so repeated requests do not cause a database write each time', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-throttled',
      label: 'acme',
      ratePerMin: 1000,
      ratePerDay: 50000,
      revokedAt: null,
      expiresAt: null,
    })
    const app = await buildAuthedApp()
    const headers = { authorization: 'Bearer test-throttled-key' }

    // Send 5 rapid requests with the same key
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/price/test',
        headers,
      })
      expect(res.statusCode).toBe(200)
    }

    // Must be called exactly once across the 5 requests
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'key-throttled' },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  it('updates lastUsedAt again once the throttle interval has elapsed', async () => {
    vi.useFakeTimers()
    try {
      const startTime = new Date('2026-10-20T12:00:00.000Z')
      vi.setSystemTime(startTime)

      mockFindUnique.mockResolvedValue({
        id: 'key-timer',
        label: 'acme',
        ratePerMin: 1000,
        ratePerDay: 50000,
        revokedAt: null,
        expiresAt: null,
      })

      const app = await buildAuthedApp()
      const headers = { authorization: 'Bearer test-timer-key' }

      // 1st request at t = 0
      const r1 = await app.inject({ method: 'GET', url: '/price/test', headers })
      expect(r1.statusCode).toBe(200)
      expect(mockUpdate).toHaveBeenCalledTimes(1)
      expect(mockUpdate).toHaveBeenLastCalledWith({
        where: { id: 'key-timer' },
        data: { lastUsedAt: startTime },
      })

      // 2nd request at t = 10s (within default 60s throttle) -> throttled
      vi.advanceTimersByTime(10_000)
      const r2 = await app.inject({ method: 'GET', url: '/price/test', headers })
      expect(r2.statusCode).toBe(200)
      expect(mockUpdate).toHaveBeenCalledTimes(1)

      // 3rd request at t = 65s (past the 60s throttle) -> writes again
      vi.advanceTimersByTime(55_000)
      const laterTime = new Date('2026-10-20T12:01:05.000Z')
      const r3 = await app.inject({ method: 'GET', url: '/price/test', headers })
      expect(r3.statusCode).toBe(200)
      expect(mockUpdate).toHaveBeenCalledTimes(2)
      expect(mockUpdate).toHaveBeenLastCalledWith({
        where: { id: 'key-timer' },
        data: { lastUsedAt: laterTime },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('documents and honors configurable throttle interval via environment variable', () => {
    const originalThrottle = process.env.KEY_LAST_USED_THROTTLE_SECONDS
    const originalApiThrottle = process.env.API_KEY_LAST_USED_THROTTLE_SECONDS
    try {
      delete process.env.KEY_LAST_USED_THROTTLE_SECONDS
      delete process.env.API_KEY_LAST_USED_THROTTLE_SECONDS

      // Default is 60s (60000ms)
      expect(getKeyLastUsedThrottleMs()).toBe(DEFAULT_KEY_LAST_USED_THROTTLE_SECONDS * 1000)
      expect(DEFAULT_KEY_LAST_USED_THROTTLE_SECONDS).toBe(60)

      // Configured via KEY_LAST_USED_THROTTLE_SECONDS
      process.env.KEY_LAST_USED_THROTTLE_SECONDS = '15'
      expect(getKeyLastUsedThrottleMs()).toBe(15_000)

      // Configured to 0 (no throttle)
      process.env.KEY_LAST_USED_THROTTLE_SECONDS = '0'
      expect(getKeyLastUsedThrottleMs()).toBe(0)

      // Fallback to API_KEY_LAST_USED_THROTTLE_SECONDS
      delete process.env.KEY_LAST_USED_THROTTLE_SECONDS
      process.env.API_KEY_LAST_USED_THROTTLE_SECONDS = '30'
      expect(getKeyLastUsedThrottleMs()).toBe(30_000)
    } finally {
      if (originalThrottle !== undefined) process.env.KEY_LAST_USED_THROTTLE_SECONDS = originalThrottle
      else delete process.env.KEY_LAST_USED_THROTTLE_SECONDS

      if (originalApiThrottle !== undefined) process.env.API_KEY_LAST_USED_THROTTLE_SECONDS = originalApiThrottle
      else delete process.env.API_KEY_LAST_USED_THROTTLE_SECONDS
    }
  })

  it('tracks throttle intervals independently per key', async () => {
    // Keyed off the hash rather than a queue of mockResolvedValueOnce values:
    // the lookup cache (#495) means a repeat request for the same key does not
    // reach Postgres at all, so a sequential queue hands the *next* key's
    // record to whichever lookup happens to miss the cache.
    const records: Record<string, unknown> = {
      [sha256('key-alpha')]: {
        id: 'key-alpha',
        label: 'alpha',
        ratePerMin: 100,
        ratePerDay: 5000,
        revokedAt: null,
        expiresAt: null,
      },
      [sha256('key-beta')]: {
        id: 'key-beta',
        label: 'beta',
        ratePerMin: 100,
        ratePerDay: 5000,
        revokedAt: null,
        expiresAt: null,
      },
    }
    mockFindUnique.mockImplementation(async ({ where }: { where: { hash: string } }) =>
      records[where.hash] ?? null
    )

    const app = await buildAuthedApp()

    // Key A: first request writes.
    await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer key-alpha' },
    })
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenLastCalledWith({
      where: { id: 'key-alpha' },
      data: { lastUsedAt: expect.any(Date) },
    })

    // Key A again, immediately: throttled.
    await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer key-alpha' },
    })
    expect(mockUpdate).toHaveBeenCalledTimes(1)

    // Key B: its own bucket, so it writes straight away.
    await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer key-beta' },
    })
    expect(mockUpdate).toHaveBeenCalledTimes(2)
    expect(mockUpdate).toHaveBeenLastCalledWith({
      where: { id: 'key-beta' },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  it('does not fail authenticated requests if database update throws', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-failing-db',
      label: 'failing',
      ratePerMin: 100,
      ratePerDay: 5000,
      revokedAt: null,
      expiresAt: null,
    })
    mockUpdate.mockRejectedValueOnce(new Error('PostgreSQL connection terminated'))

    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer test-valid-key' },
    })

    // Request must still succeed with 200
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })
})
