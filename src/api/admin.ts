import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { admin_auth_failures_total } from '../metrics'
import { hashApiKey, isAdminAuthorized } from './auth'

/** Generates a new opaque API key with a recognizable `lens_` prefix. */
export function generateApiKey(): string {
  return `lens_${randomBytes(24).toString('hex')}`
}

interface CreateKeyBody {
  label?: string
  expiresAt?: string
  ratePerMin?: number
  ratePerDay?: number
  monthlyQuotaCents?: number
  dailyQuotaCents?: number
  overagePolicy?: 'block' | 'charge_402' | 'allow_overage'
  scopes?: string[]
}

/**
 * Registers admin-only endpoints for minting, listing, and revoking API keys.
 *
 * - `POST /admin/keys`   — mint a new key (returns the plaintext key ONCE).
 * - `GET /admin/keys`    — list all existing keys with metadata and scopes.
 * - `DELETE /admin/keys/:id` — revoke an existing key.
 *
 * All routes are marked `config.public = true` so the API-key auth hook skips
 * them; they enforce their own `ADMIN_TOKEN` check instead.
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateKeyBody }>(
    '/admin/keys',
    { config: { public: true } },
    async (req: FastifyRequest<{ Body: CreateKeyBody }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { label, expiresAt, ratePerMin, ratePerDay, monthlyQuotaCents, dailyQuotaCents, overagePolicy, scopes } = req.body ?? {}
      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        return reply.status(400).send({ error: 'label is required' })
      }
      if (expiresAt !== undefined && typeof expiresAt !== 'string') {
        return reply.status(400).send({ error: 'expiresAt must be a valid future date' })
      }
      const expiration = expiresAt === undefined ? undefined : new Date(expiresAt)
      if (expiration && (!Number.isFinite(expiration.getTime()) || expiration <= new Date())) {
        return reply.status(400).send({ error: 'expiresAt must be a valid future date' })
      }
      if (scopes !== undefined) {
        if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string')) {
          return reply.status(400).send({ error: 'scopes must be an array of strings' })
        }
      }
      const normalizedScopes = scopes !== undefined
        ? Array.from(new Set(scopes.map(s => s.trim()).filter(Boolean)))
        : undefined

      // Generate the key, store only its hash, and return the plaintext once.
      const plaintext = generateApiKey()
      const record = await prisma.apiKey.create({
        data: {
          hash: hashApiKey(plaintext),
          label: label.trim(),
          ...(expiration ? { expiresAt: expiration } : {}),
          ...(ratePerMin !== undefined ? { ratePerMin } : {}),
          ...(ratePerDay !== undefined ? { ratePerDay } : {}),
          ...(monthlyQuotaCents !== undefined ? { monthlyQuotaCents } : {}),
          ...(dailyQuotaCents !== undefined ? { dailyQuotaCents } : {}),
          ...(overagePolicy !== undefined ? { overagePolicy } : {}),
          ...(normalizedScopes !== undefined ? { scopes: normalizedScopes } : {}),
        },
      })

      return reply.status(201).send({
        id: record.id,
        label: record.label,
        expiresAt: record.expiresAt,
        ratePerMin: record.ratePerMin,
        ratePerDay: record.ratePerDay,
        monthlyQuotaCents: record.monthlyQuotaCents,
        dailyQuotaCents: record.dailyQuotaCents,
        overagePolicy: record.overagePolicy,
        scopes: record.scopes ?? [],
        key: plaintext,
        createdAt: record.createdAt,
      })
    },
  )

  app.get(
    '/admin/keys',
    { config: { public: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const keys = await prisma.apiKey.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          label: true,
          scopes: true,
          ratePerMin: true,
          ratePerDay: true,
          revokedAt: true,
          expiresAt: true,
          createdAt: true,
          monthlyQuotaCents: true,
          dailyQuotaCents: true,
          overagePolicy: true,
        },
      })

      return reply.status(200).send({ keys })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/keys/:id',
    { config: { public: true } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { id } = req.params
      const existing = await prisma.apiKey.findUnique({ where: { id } })
      if (!existing) {
        return reply.status(404).send({ error: 'API key not found' })
      }
      if (existing.revokedAt) {
        return reply.status(200).send({ id, revoked: true, alreadyRevoked: true })
      }

      await prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      })

      return reply.status(200).send({ id, revoked: true })
    },
  )
}
