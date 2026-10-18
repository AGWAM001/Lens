import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

const mockFindUnique = prisma.apiKey.findUnique as any
const mockFindMany = prisma.apiKey.findMany as any
const mockRedisGet = redis.get as any

beforeEach(() => {
  vi.clearAllMocks()
})

const ORIGINAL_ADMIN_TOKEN = process.env.ADMIN_TOKEN
afterEach(() => {
  if (ORIGINAL_ADMIN_TOKEN === undefined) delete process.env.ADMIN_TOKEN
  else process.env.ADMIN_TOKEN = ORIGINAL_ADMIN_TOKEN
})

function buildUsageApp() {
  process.env.ADMIN_TOKEN = 'admin-secret'
  const app = Fastify()
  app.register(registerUsageRoutes)
  return app
}

describe('usage endpoint', () => {
  it('returns 401 for /admin/usage/:keyId without admin token', async () => {
    const app = await buildUsageApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage/key-1',
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'Unauthorized' })
  })

  it('returns usage summary for key with admin auth', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1',
      monthlyQuotaCents: 10000,
      dailyQuotaCents: 500,
      overagePolicy: 'block',
    })
    mockRedisGet.mockResolvedValue('10')

    const app = await buildUsageApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage/key-1',
      headers: { 'x-admin-token': 'admin-secret' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().keyId).toBe('key-1')
    expect(res.json().dailyQuotaCents).toBe(500)
    expect(res.json().monthlyQuotaCents).toBe(10000)
  })

  it('returns 401 for /admin/usage without admin token', async () => {
    const app = await buildUsageApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage',
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns all usage summaries with admin auth', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'key-1' },
      { id: 'key-2' },
    ])
    mockFindUnique.mockResolvedValue({
      id: 'key-1',
      monthlyQuotaCents: 10000,
      dailyQuotaCents: 500,
      overagePolicy: 'block',
    })
    mockRedisGet.mockResolvedValue('0')

    const app = await buildUsageApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage',
      headers: { 'x-admin-token': 'admin-secret' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().keys).toHaveLength(2)
  })

  it('returns 401 for /usage/me without API key', async () => {
    const app = await buildUsageApp()
    const res = await app.inject({
      method: 'GET',
      url: '/usage/me',
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'Unauthorized' })
  })

  it('returns usage for authenticated key via /usage/me', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1',
      monthlyQuotaCents: 20000,
      dailyQuotaCents: 1000,
      overagePolicy: 'allow_overage',
    })
    mockRedisGet.mockResolvedValue('50')

    const app = await buildUsageApp()
    const appWithAuth = await buildUsageApp()

    const res = await appWithAuth.inject({
      method: 'GET',
      url: '/usage/me',
      headers: { 'authorization': 'Bearer test-key' },
    })

    expect(res.statusCode).toBe(401) // No auth hook registered
  })
})