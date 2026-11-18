import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '../db'
import { admin_auth_failures_total } from '../metrics'
import { formatValidationError } from '../validation'
import { hashApiKey, isAdminAuthorized, checkAdminAuth, invalidateApiKey } from './auth'
import { copyUsageHistory } from '../x402/metering'

import { apiError } from '../errors'
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

interface RotateKeyBody {
  overlapHours?: number
}

/** The only overage policies `src/x402/metering.ts` understands. */
const OVERAGE_POLICIES = ['block', 'charge_402', 'allow_overage'] as const

// Rates and quota cents are stored in Postgres `Int` columns (32-bit signed), so
// their value cannot exceed this without overflowing the column anyway.
const MAX_INT32 = 2_147_483_647

/**
 * A rate or quota: a positive integer within the `Int` column's range. Rejects
 * zero, negatives, and fractions rather than coercing them, so a mistake fails
 * loudly at creation instead of silently minting a key that can never call
 * anything or one that is never limited.
 */
const quotaField = (name: string) =>
  z
    .number({ error: `${name} must be a positive integer` })
    .int({ error: `${name} must be a positive integer` })
    .min(1, { error: `${name} must be a positive integer` })
    .max(MAX_INT32, { error: `${name} must be at most ${MAX_INT32}` })

/**
 * Validates the `POST /admin/keys` body and rejects rather than coerces. Every
 * field a caller can send is checked here so nothing reaches the database
 * unvalidated (see issue #506).
 */
const CreateKeySchema = z
  .object({
    label: z.string({ error: 'label is required' }).trim().min(1, { error: 'label is required' }),
    expiresAt: z.string({ error: 'expiresAt must be a valid future date' }).optional(),
    ratePerMin: quotaField('ratePerMin').optional(),
    ratePerDay: quotaField('ratePerDay').optional(),
    monthlyQuotaCents: quotaField('monthlyQuotaCents').optional(),
    dailyQuotaCents: quotaField('dailyQuotaCents').optional(),
    overagePolicy: z
      .enum(OVERAGE_POLICIES, {
        error: `overagePolicy must be one of: ${OVERAGE_POLICIES.join(', ')}`,
      })
      .optional(),
    // Scopes are optional, but an unknown-key strip would silently mint a key
    // with no scopes at all — so they must be in the schema. The transform does
    // the same de-dupe/trim/drop-empty normalisation the route used to do by
    // hand, keeping a single source of truth for what gets stored (issue #506).
    scopes: z
      .array(z.string(), { error: 'scopes must be an array of strings' })
      .optional()
      .transform((s) =>
        s === undefined ? undefined : Array.from(new Set(s.map((v) => v.trim()).filter(Boolean))),
      ),
  })
  .superRefine((data, ctx) => {
    if (data.expiresAt !== undefined) {
      const t = new Date(data.expiresAt).getTime()
      if (!Number.isFinite(t) || t <= Date.now()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expiresAt'],
          message: 'expiresAt must be a valid future date',
        })
      }
    }
    // A per-day cap below the per-minute cap can never bind and is always a mistake.
    if (
      data.ratePerMin !== undefined &&
      data.ratePerDay !== undefined &&
      data.ratePerDay < data.ratePerMin
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ratePerDay'],
        message: 'ratePerDay must be greater than or equal to ratePerMin',
      })
    }
  })

interface ListKeysQuery {
  limit?: string
  offset?: string
  revoked?: string
}

const MAX_KEY_PAGE_SIZE = 100

function parsePageValue(value: string | undefined, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null
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
  app.get<{ Querystring: { limit?: string } }>(
    '/admin/webhook-delivery-failures',
    { config: { admin: true, auth: 'admin' } },
    async (req, reply) => {
      if (!isAdminAuthorized(req)) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Provide a valid X-Admin-Token header.' })
      }
      const requestedLimit = Number(req.query.limit ?? 25)
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
        return reply.status(400).send(apiError('invalid_parameter', 'limit must be a positive integer'))
      }
      const failures = await prisma.webhookDeliveryFailure.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.min(requestedLimit, 100),
      })
      return reply.send({ failures })
    },
  )

  app.post<{ Body: CreateKeyBody }>(
    '/admin/keys',
    { config: { admin: true, auth: 'admin' } },
    async (req: FastifyRequest<{ Body: CreateKeyBody }>, reply: FastifyReply) => {
      const auth = checkAdminAuth(req)
      if (auth === 'not_configured') {
        return reply.status(503).send({
          error: 'Service Unavailable',
          code: 'admin_not_configured',
          message: 'Admin surface is disabled: ADMIN_TOKEN is not configured on this server.',
        })
      }
      if (auth !== 'authorized') {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const parsed = CreateKeySchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const { label, expiresAt, ratePerMin, ratePerDay, monthlyQuotaCents, dailyQuotaCents, overagePolicy, scopes } = parsed.data
      const expiration = expiresAt === undefined ? undefined : new Date(expiresAt)

      // Generate the key, store only its hash, and return the plaintext once.
      const plaintext = generateApiKey()
      const record = await prisma.apiKey.create({
        data: {
          hash: hashApiKey(plaintext),
          label,
          ...(expiration ? { expiresAt: expiration } : {}),
          ...(ratePerMin !== undefined ? { ratePerMin } : {}),
          ...(ratePerDay !== undefined ? { ratePerDay } : {}),
          ...(monthlyQuotaCents !== undefined ? { monthlyQuotaCents } : {}),
          ...(dailyQuotaCents !== undefined ? { dailyQuotaCents } : {}),
          ...(overagePolicy !== undefined ? { overagePolicy } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
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

  app.get<{ Querystring: ListKeysQuery }>(
    '/admin/keys',
    { config: { admin: true, auth: 'admin' } },
    async (req: FastifyRequest<{ Querystring: ListKeysQuery }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const limit = parsePageValue(req.query.limit, 50, MAX_KEY_PAGE_SIZE)
      const offset = parsePageValue(req.query.offset, 0, Number.MAX_SAFE_INTEGER)
      const revoked = req.query.revoked ?? 'false'
      if (limit === null || limit < 1 || offset === null || !['true', 'false'].includes(revoked)) {
        return reply.status(400).send({
          ...apiError('invalid_parameter', 'Invalid pagination or revoked filter. Use limit (1-100), offset (0 or greater), and revoked=true|false.'),
        })
      }

      const where = revoked === 'true' ? { revokedAt: { not: null } } : { revokedAt: null }
      const [keys, total] = await Promise.all([
        prisma.apiKey.findMany({
          where,
          skip: offset,
          take: limit,
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
            // #500: null means "never authenticated since this column existed",
            // which is what makes an abandoned key visible to an operator.
            lastUsedAt: true,
            monthlyQuotaCents: true,
            dailyQuotaCents: true,
            overagePolicy: true,
          },
        }),
        prisma.apiKey.count({ where }),
      ])

      return reply.status(200).send({
        keys: keys.map(record => ({
          id: record.id,
          label: record.label,
          scopes: record.scopes,
          ratePerMin: record.ratePerMin,
          ratePerDay: record.ratePerDay,
          revokedAt: record.revokedAt,
          expiresAt: record.expiresAt,
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt,
          monthlyQuotaCents: record.monthlyQuotaCents,
          dailyQuotaCents: record.dailyQuotaCents,
          overagePolicy: record.overagePolicy,
        })),
        pagination: { limit, offset, total },
      })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/keys/:id',
    { config: { admin: true, auth: 'admin' } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const auth = checkAdminAuth(req)
      if (auth === 'not_configured') {
        return reply.status(503).send({
          error: 'Service Unavailable',
          code: 'admin_not_configured',
          message: 'Admin surface is disabled: ADMIN_TOKEN is not configured on this server.',
        })
      }
      if (auth !== 'authorized') {
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
        return reply.status(404).send(apiError('not_found', 'API key not found'))
      }
      if (existing.revokedAt) {
        return reply.status(200).send({ id, revoked: true, alreadyRevoked: true })
      }

      await prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      })

      // Drop the cached lookup so the revoke takes effect immediately on this
      // instance (Issue #495). Other instances pick it up within the cache TTL.
      invalidateApiKey(existing.hash)

      return reply.status(200).send({ id, revoked: true })
    },
  )

  app.post<{ Params: { id: string }; Body: RotateKeyBody }>(
    '/admin/keys/:id/rotate',
    { config: { admin: true, auth: 'admin' } },
    async (req: FastifyRequest<{ Params: { id: string }; Body: RotateKeyBody }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { id } = req.params
      const oldKey = await prisma.apiKey.findUnique({ where: { id } })
      if (!oldKey) {
        return reply.status(404).send(apiError('not_found', 'API key not found'))
      }
      if (oldKey.revokedAt) {
        return reply.status(400).send(apiError('invalid_parameter', 'Cannot rotate a revoked API key'))
      }

      const defaultOverlap = parseInt(process.env.KEY_ROTATION_OVERLAP_HOURS ?? '24', 10) || 24
      const overlapHours =
        req.body?.overlapHours !== undefined &&
        Number.isFinite(req.body.overlapHours) &&
        req.body.overlapHours > 0
          ? req.body.overlapHours
          : defaultOverlap

      const overlapEndsAt = new Date(Date.now() + overlapHours * 3600 * 1000)

      // Set bounded expiration on old key so it automatically stops working when overlap ends
      await prisma.apiKey.update({
        where: { id: oldKey.id },
        data: { expiresAt: overlapEndsAt },
      })

      // The old key's cached lookup still says `expiresAt: null` (#495). Expiry
      // is re-checked on every cache hit, but against the *cached* value, so
      // without this the overlap deadline only starts being enforced once the
      // entry goes stale. Dropping it makes the new expiry effective at once.
      invalidateApiKey(oldKey.hash)

      // Generate replacement key inheriting quotas and metadata
      const plaintext = generateApiKey()
      const newKey = await prisma.apiKey.create({
        data: {
          hash: hashApiKey(plaintext),
          label: oldKey.label,
          ratePerMin: oldKey.ratePerMin,
          ratePerDay: oldKey.ratePerDay,
          monthlyQuotaCents: oldKey.monthlyQuotaCents,
          dailyQuotaCents: oldKey.dailyQuotaCents,
          overagePolicy: oldKey.overagePolicy,
          // Rotation has to carry the scopes across. `scopes` defaults to `[]`,
          // so a replacement key minted without them authenticates fine and
          // then 403s on every scoped route — a rotation that hands the caller
          // a key which cannot do what the old one did.
          scopes: oldKey.scopes ?? [],
        },
      })

      // Carry across usage history from old key to replacement key
      await copyUsageHistory(oldKey.id, newKey.id)

      return reply.status(201).send({
        id: newKey.id,
        key: plaintext,
        label: newKey.label,
        oldKeyId: oldKey.id,
        overlapEndsAt: overlapEndsAt.toISOString(),
        overlapHours,
        ratePerMin: newKey.ratePerMin,
        ratePerDay: newKey.ratePerDay,
        monthlyQuotaCents: newKey.monthlyQuotaCents,
        dailyQuotaCents: newKey.dailyQuotaCents,
        overagePolicy: newKey.overagePolicy,
        createdAt: newKey.createdAt,
      })
    },
  )
}
