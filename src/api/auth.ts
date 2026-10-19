import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHash, timingSafeEqual } from 'crypto'
import fp from 'fastify-plugin'
import { prisma } from '../db'

/**
 * Metadata for an authenticated API key, attached to each request as
 * `req.apiKey` once the key has been validated.
 */
export interface ApiKeyContext {
  id: string
  label: string
  ratePerMin: number
  ratePerDay: number
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext
  }
  interface FastifyContextConfig {
    /** When true, the API-hey auth hook skips this route (e.g. health, admin). */
    public?: boolean
  }
}

/** SHA-256 hex digest of a plaintext API key. We only ever store/compare hashes. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Extracts the bearer token from an Authorization header, or null. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/**
 * Looks up an API key by its plaintext value, returning the key context only
 * when the key exists and has not been revoked.
 */
export async function lookupApiKey(plaintext: string): Promise<ApiKeyContext | null> {
  const hash = hashApiKey(plaintext)
  const record = await prisma.apiKey.findUnique({ where: { hash } })
  if (!record || record.revokedAt) return null
  return {
    id: record.id,
    label: record.label,
    ratePerMin: record.ratePerMin,
    ratePerDay: record.ratePerDay,
  }
}

/**
 * Guards admin routes with a shared secret supplied via the `ADMIN_TOKEN`
 * env var, sent as `X-Admin-Token` (or `Authorization: Bearer <token>`).
 * Returns true if the caller is authorized.
 *
 * This is the single implementation used by every admin route (keys and
 * usage), so the two surfaces cannot drift apart.
 */
export function isAdminAuthorized(req: FastifyRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  const supplied =
    (req.headers['x-admin-token'] as string | undefined) ??
    req.headers['authorization']?.replace(/^Bearer\s+/i, '')
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(adminToken)
  // Constant-time comparison (timingSafeEqual requires equal-length buffers).
  // The length guard is not itself a meaningful leak for a high-entropy token.
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Fastify plugin that authenticates requests via `Authorization: Bearer <key>`.
 *
 * A request without a valid, non-revoked key gets 401. Valid requests have
 * their key metadata attached to `req.apiKey` so downstream rate limiting can
 * read per-key quotas.
 *
 * Runs as an `onRequest` hook (and must be registered BEFORE @fastify/rate-limit)
 * so that `req.apiKey` is populated before the rate limiter — which also runs in
 * `onRequest` — evaluates its per-key `max`/keyGenerator.
 *
 * Routes can opt out of auth (e.g. health/metrics) by setting
 * `config.public = true` on the route definition.
 */
async function apiKeyAuthPlugin(app: FastifyInstance) {
  app.decorateRequest('apiKey', undefined)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Allow routes to mark themselves public (no auth required).
    const routeConfig = (req.routeOptions?.config ?? {}) as { public?: boolean }
    if (routeConfig.public) return

    const token = extractBearer(req.headers['authorization'])
    if (!token) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing API key. Provide an Authorization: Bearer <key> header.',
      })
    }

    const keyContext = await lookupApiKey(token)
    if (!keyContext) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid or revoked API key.',
      })
    }

    req.apiKey = keyContext
  })
}

export const registerApiKeyAuth = fp(apiKeyAuthPlugin, { name: 'api-key-auth' })
