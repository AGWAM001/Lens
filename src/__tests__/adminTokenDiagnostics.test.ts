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
  pgPool: {
    query: vi.fn().mockResolvedValue({ rows: [{ last_ledger: 100, last_processed_at: new Date() }] }),
  },
}))

vi.mock('../redis', () => ({
  redis: {
    get: vi.fn(),
    multi: vi.fn().mockReturnThis(),
    on: vi.fn(),
  },
  getCachedPrice: vi.fn(),
  setCachedPrice: vi.fn(),
}))

vi.mock('../x402/metering', () => ({
  getUsageSummary: vi.fn().mockResolvedValue({ keyId: 'k1', dailyCalls: 5 }),
  getAllUsageSummaries: vi.fn().mockResolvedValue([]),
}))

import { registerAdminRoutes } from '../api/admin'
import { registerUsageRoutes } from '../api/usage'
import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'
import { checkAdminAuth, isAdminConfigured } from '../api/auth'

const ORIGINAL_ADMIN_TOKEN = process.env.ADMIN_TOKEN

afterEach(() => {
  if (ORIGINAL_ADMIN_TOKEN === undefined) {
    delete process.env.ADMIN_TOKEN
  } else {
    process.env.ADMIN_TOKEN = ORIGINAL_ADMIN_TOKEN
  }
})

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(registerNetworkSelector)
  app.register(registerAdminRoutes)
  app.register(registerUsageRoutes)
  app.register(registerRESTRoutes)
  return app
}

describe('ADMIN_TOKEN unset diagnostics and distinguishing responses (#508)', () => {
  it('detects when ADMIN_TOKEN is not configured', () => {
    delete process.env.ADMIN_TOKEN
    expect(isAdminConfigured()).toBe(false)

    process.env.ADMIN_TOKEN = ''
    expect(isAdminConfigured()).toBe(false)

    process.env.ADMIN_TOKEN = '   '
    expect(isAdminConfigured()).toBe(false)

    process.env.ADMIN_TOKEN = 'your-admin-token-here'
    expect(isAdminConfigured()).toBe(false)

    process.env.ADMIN_TOKEN = 'real-admin-secret-token-12345'
    expect(isAdminConfigured()).toBe(true)
  })

  it('returns 503 admin_not_configured for all admin endpoints when ADMIN_TOKEN is unset', async () => {
    delete process.env.ADMIN_TOKEN
    const app = buildApp()

    const endpoints = [
      { method: 'POST' as const, url: '/admin/keys', payload: { label: 'test' } },
      { method: 'DELETE' as const, url: '/admin/keys/key-123' },
      { method: 'GET' as const, url: '/admin/usage' },
      { method: 'GET' as const, url: '/admin/usage/key-123' },
    ]

    for (const ep of endpoints) {
      const res = await app.inject({
        method: ep.method,
        url: ep.url,
        payload: ep.payload,
        headers: { 'x-admin-token': 'any-token' },
      })

      expect(res.statusCode).toBe(503)
      const body = res.json()
      expect(body.error).toBe('Service Unavailable')
      expect(body.code).toBe('admin_not_configured')
      expect(body.message).toContain('Admin surface is disabled')
      expect(JSON.stringify(body)).not.toContain('super-secret')
    }
  })

  it('distinguishes wrong token (401) from unconfigured server (503)', async () => {
    process.env.ADMIN_TOKEN = 'configured-secret-token'
    const app = buildApp()

    // 1. Wrong token -> 401 admin_unauthorized
    const wrongRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      payload: { label: 'key-1' },
      headers: { 'x-admin-token': 'wrong-token' },
    })
    expect(wrongRes.statusCode).toBe(401)
    expect(wrongRes.json().code).toBe('admin_unauthorized')
    expect(wrongRes.json().message).toContain('Provide a valid X-Admin-Token header')

    // 2. Unset token -> 503 admin_not_configured
    delete process.env.ADMIN_TOKEN
    const unsetRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      payload: { label: 'key-1' },
      headers: { 'x-admin-token': 'wrong-token' },
    })
    expect(unsetRes.statusCode).toBe(503)
    expect(unsetRes.json().code).toBe('admin_not_configured')
  })

  it('surfaces adminConfigured on /status endpoint', async () => {
    delete process.env.ADMIN_TOKEN
    const appUnset = buildApp()
    const resUnset = await appUnset.inject({ method: 'GET', url: '/status' })
    expect(resUnset.statusCode).toBe(200)
    expect(resUnset.json().adminConfigured).toBe(false)

    process.env.ADMIN_TOKEN = 'valid-token'
    const appSet = buildApp()
    const resSet = await appSet.inject({ method: 'GET', url: '/status' })
    expect(resSet.statusCode).toBe(200)
    expect(resSet.json().adminConfigured).toBe(true)
  })
})
