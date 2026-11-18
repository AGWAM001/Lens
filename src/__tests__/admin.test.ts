import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import Fastify from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import { registerAdminRoutes } from '../api/admin'
import { registerApiKeyAuth } from '../api/auth'

const findUnique = vi.mocked(prisma.apiKey.findUnique)
const create = vi.mocked(prisma.apiKey.create)
const update = vi.mocked(prisma.apiKey.update)
const originalAdminToken = process.env.ADMIN_TOKEN

async function appWithAdminAndAuth() {
  const app = Fastify()
  await app.register(registerApiKeyAuth)
  await app.register(registerAdminRoutes)
  app.get('/protected', async () => ({ ok: true }))
  await app.ready()
  return app
}

describe('admin key security contract', () => {
  let adminToken: string

  beforeEach(() => {
    vi.resetAllMocks()
    adminToken = randomBytes(32).toString('hex')
    process.env.ADMIN_TOKEN = adminToken
  })

  afterEach(() => {
    if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = originalAdminToken
  })

  it.each(['POST', 'DELETE'] as const)(
    '%s rejects absent and incorrect admin tokens before accessing the database',
    async (method) => {
      const app = await appWithAdminAndAuth()
      try {
        const url = method === 'POST' ? '/admin/keys' : '/admin/keys/key-id'
        for (const headers of [{}, { 'x-admin-token': randomBytes(32).toString('hex') }]) {
          const response = await app.inject({
            method,
            url,
            headers,
            ...(method === 'POST' ? { payload: { label: 'test' } } : {}),
          })
          expect(response.statusCode).toBe(401)
          expect(response.json()).not.toHaveProperty('key')
        }
        expect(create).not.toHaveBeenCalled()
        expect(findUnique).not.toHaveBeenCalled()
        expect(update).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    },
  )

  it('mints only a SHA-256 hash, returns plaintext once, and rejects it after revocation', async () => {
    const rows = new Map<string, {
      id: string
      hash: string
      label: string
      ratePerMin: number
      ratePerDay: number
      monthlyQuotaCents: number
      dailyQuotaCents: number
      overagePolicy: string
      createdAt: Date
      revokedAt: Date | null
    }>()
    create.mockImplementation(async ({ data }: any) => {
      const row = {
        id: 'generated-key-id',
        ratePerMin: 60,
        ratePerDay: 10000,
        monthlyQuotaCents: 10000,
        dailyQuotaCents: 500,
        overagePolicy: 'block',
        createdAt: new Date(),
        revokedAt: null,
        ...data,
      }
      rows.set(row.id, row)
      return row as any
    })
    findUnique.mockImplementation(async ({ where }: any) => {
      return ([...rows.values()].find((row) =>
        where.id ? row.id === where.id : row.hash === where.hash) ?? null) as any
    })
    update.mockImplementation(async ({ where, data }: any) => {
      const row = rows.get(where.id)!
      Object.assign(row, data)
      return row as any
    })

    const app = await appWithAdminAndAuth()
    try {
      const adminHeaders = { 'x-admin-token': adminToken }
      const minted = await app.inject({
        method: 'POST',
        url: '/admin/keys',
        headers: adminHeaders,
        payload: { label: 'temporary-test-key' },
      })
      expect(minted.statusCode).toBe(201)
      const body = minted.json()
      expect(body.key).toMatch(/^lens_[0-9a-f]{48}$/)
      const plaintext = body.key as string
      const savedRow = rows.get(body.id)!
      const expectedHash = createHash('sha256').update(plaintext, 'utf8').digest('hex')
      expect(savedRow.hash).toBe(expectedHash)
      expect(JSON.stringify(savedRow)).not.toContain(plaintext)
      expect(JSON.stringify(create.mock.calls[0][0].data)).not.toContain(plaintext)

      const bearer = { authorization: `Bearer ${plaintext}` }
      const accepted = await app.inject({ method: 'GET', url: '/protected', headers: bearer })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.json()).toEqual({ ok: true })
      expect(JSON.stringify(accepted.json())).not.toContain(plaintext)

      const revoked = await app.inject({
        method: 'DELETE', url: `/admin/keys/${body.id}`, headers: adminHeaders,
      })
      expect(revoked.statusCode).toBe(200)
      expect(revoked.json()).toEqual({ id: body.id, revoked: true })
      expect(JSON.stringify(revoked.json())).not.toContain(plaintext)
      expect(savedRow.revokedAt).toBeInstanceOf(Date)

      const denied = await app.inject({ method: 'GET', url: '/protected', headers: bearer })
      expect(denied.statusCode).toBe(401)
      expect(JSON.stringify(denied.json())).not.toContain(plaintext)
      const again = await app.inject({
        method: 'DELETE', url: `/admin/keys/${body.id}`, headers: adminHeaders,
      })
      expect(again.statusCode).toBe(200)
      expect(again.json()).toEqual({ id: body.id, revoked: true, alreadyRevoked: true })
      expect(JSON.stringify(again.json())).not.toContain(plaintext)
      expect(update).toHaveBeenCalledTimes(1)
    } finally {
      await app.close()
    }
  })
})
