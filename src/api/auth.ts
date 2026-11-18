import { redis } from '../redis'
import { createLogger } from '../logger'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHash, timingSafeEqual } from 'crypto'
import fp from 'fastify-plugin'
import { prisma } from '../db'
import { config } from '../config'
import { api_key_auth_failures_total, admin_auth_failures_total, api_key_cache_lookups_total } from '../metrics'

import { apiError } from '../errors'
const log = createLogger('auth')

type ApiKeyAuthFailureReason = 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired' | 'insufficient_scope'

/**
 * Metadata for an authenticated API key, attached to each request as
 * `req.apiKey` once the key has been validated.
 */
export interface ApiKeyContext {
  id: string
  label: string
  ratePerMin: number
  ratePerDay: number
  scopes: string[]
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext
  }
  interface FastifyContextConfig {
    /** When true, this route is genuinely public and requires no authentication (e.g. health probes). */
    public?: boolean
    /** When true, this route is an operator-only admin route guarded by ADMIN_TOKEN. */
    admin?: boolean
    /** Semantic authentication classification. */
    auth?: 'none' | 'api-key' | 'admin'
    /** Required scope to access this route (e.g. 'read:prices', 'read:history', 'subscribe'). */
    scope?: string
    /** Required scopes to access this route. */
    scopes?: string[]
  }
}

/** SHA-256 hex digest of a plaintext API key. We only ever store/compare hashes. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/**
 * Checks whether an API key context satisfies the required scope.
 *
 * A key with no scopes recorded (empty or undefined) means "everything"
 * so that existing integrations continue to work without disruption.
 */
export function hasScope(key: ApiKeyContext, requiredScope?: string): boolean {
  if (!requiredScope) return true
  // A key with no scopes recorded means "everything"
  if (!key.scopes || key.scopes.length === 0) return true
  return key.scopes.includes(requiredScope) || key.scopes.includes('*')
}

/** Extracts the bearer token from an Authorization header, or null. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

// ── In-process API-key lookup cache (Issue #495) ────────────────────────────
//
// Authentication runs in an `onRequest` hook, so without a cache every request
// — including ones served entirely from the Redis price cache — pays a Postgres
// round-trip before any work begins, and the API cannot even accept traffic
// when the shared connection pool is slow or exhausted. We cache the lookup,
// keyed by the key hash, for a short TTL (`config.cache.apiKeyTtl` seconds).
//
// Correctness of the sharp edges:
//   • Revocation. The revoke route (admin.ts) calls `invalidateApiKey(hash)`,
//     so a key revoked on THIS instance stops working immediately. A key
//     revoked on another instance keeps working here until its cache entry
//     expires — a worst case of exactly `config.cache.apiKeyTtl` seconds. The
//     test "a revoked key stops working" pins this contract.
//   • Expiry. We store the key's own `expiresAt` and re-check it on every hit
//     (see `evaluate`), so the TTL never extends a key past its expiry.
//   • Negative lookups are cached too. Otherwise an invalid key is a free way
//     to make the API hit Postgres as fast as a client can send requests.
//   • The cache is size-bounded (`MAX_CACHE_ENTRIES`) so a flood of distinct
//     invalid keys cannot grow the negative cache without limit; the oldest
//     entry is evicted once the cap is reached.

/** What we remember about a hash, enough to re-derive the auth result. */
type CachedKey =
  | { found: false }
  | { found: true; revoked: boolean; expiresAt: Date | null; context: ApiKeyContext }

interface CacheEntry {
  /** Epoch ms after which this entry is stale and must be re-read from Postgres. */
  staleAt: number
  value: CachedKey
}

const MAX_CACHE_ENTRIES = 10_000
const apiKeyCache = new Map<string, CacheEntry>()

/** Turns a remembered lookup into an auth result, re-checking expiry at `now`. */
function evaluate(
  value: CachedKey,
  now: number,
): { context: ApiKeyContext | null; failureReason?: ApiKeyAuthFailureReason } {
  if (!value.found) return { context: null, failureReason: 'unknown' }
  if (value.revoked) return { context: null, failureReason: 'revoked' }
  if (value.expiresAt && value.expiresAt.getTime() <= now) {
    return { context: null, failureReason: 'expired' }
  }
  return { context: value.context }
}

function cacheSet(hash: string, value: CachedKey, now: number): void {
  // Re-insert so the Map's insertion order tracks recency, then evict the
  // oldest entries while we are over the cap.
  apiKeyCache.delete(hash)
  apiKeyCache.set(hash, { staleAt: now + config.cache.apiKeyTtl * 1000, value })
  while (apiKeyCache.size > MAX_CACHE_ENTRIES) {
    const oldest = apiKeyCache.keys().next().value
    if (oldest === undefined) break
    apiKeyCache.delete(oldest)
  }
}

/**
 * Drops a key's cached lookup so the next request re-reads it from Postgres.
 * Called on revoke to make revocation effectively immediate on this instance.
 */
export function invalidateApiKey(hash: string): void {
  apiKeyCache.delete(hash)
}

/** Clears the entire lookup cache. Intended for tests. */
export function clearApiKeyCache(): void {
  apiKeyCache.clear()
}

/**
 * Looks up an API key by its plaintext value, returning the key context only
 * when the key exists and has not been revoked or expired.
 */
export async function lookupApiKey(plaintext: string): Promise<ApiKeyContext | null> {
  return (await lookupApiKeyResult(plaintext)).context
}

/**
 * How long to wait between `lastUsedAt` writes for the same key.
 *
 * Authentication is otherwise a read, and a key doing 200 req/s would turn it
 * into 200 writes/s against a row nobody reads in real time. A minute is far
 * finer than any question `lastUsedAt` answers — "is this key still in use",
 * "when did this integration stop calling" — and coarse enough that the write
 * disappears into the noise.
 */
export const DEFAULT_KEY_LAST_USED_THROTTLE_SECONDS = 60

/** Per-key wall-clock time of the last write, in this process. */
const keyLastUsedTimestamps = new Map<string, number>()

/**
 * The configured throttle in milliseconds. `KEY_LAST_USED_THROTTLE_SECONDS` is
 * the documented name; `API_KEY_LAST_USED_THROTTLE_SECONDS` is accepted as an
 * alias. `0` disables the throttle and writes on every authenticated request.
 */
export function getKeyLastUsedThrottleMs(): number {
  const envVal =
    process.env.KEY_LAST_USED_THROTTLE_SECONDS ??
    process.env.API_KEY_LAST_USED_THROTTLE_SECONDS
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed * 1000
    }
  }
  return DEFAULT_KEY_LAST_USED_THROTTLE_SECONDS * 1000
}

/** Test seam: forget every key's last write time. */
export function resetApiKeyLastUsedThrottle(): void {
  keyLastUsedTimestamps.clear()
}

/** Keys whose write has already been reported, so one bad column is one log line. */
const lastUsedWriteFailuresLogged = new Set<string>()

/**
 * Stamp `lastUsedAt` on an authenticated key, at most once per throttle window.
 *
 * Resolves true when a write happened, false when it was throttled or failed.
 * A failure is deliberately not fatal — a valid, authenticated request must not
 * be refused because an audit timestamp could not be stored — but it is logged
 * once per key rather than swallowed. Lens no longer converges its schema at
 * boot (`migrate deploy` replaced `db push`, see docs/database-migrations.md),
 * so a missing `last_used_at` column would otherwise leave this feature
 * silently dead in an environment nobody migrated, with every write rejected
 * and nothing anywhere saying so.
 */
export async function recordApiKeyLastUsed(
  keyId: string,
  timestamp: Date = new Date(),
): Promise<boolean> {
  const now = timestamp.getTime()
  const lastRecorded = keyLastUsedTimestamps.get(keyId) ?? 0
  const throttleMs = getKeyLastUsedThrottleMs()

  if (now - lastRecorded < throttleMs) {
    return false
  }

  // Claim the window before awaiting, so concurrent requests for the same key
  // do not each decide they are the one that should write.
  keyLastUsedTimestamps.set(keyId, now)

  try {
    await prisma.apiKey.update({
      where: { id: keyId },
      data: { lastUsedAt: timestamp },
    })
    return true
  } catch (err: unknown) {
    if (!lastUsedWriteFailuresLogged.has(keyId)) {
      lastUsedWriteFailuresLogged.add(keyId)
      log.warn({ err, keyId }, 'could not record lastUsedAt for an API key; authentication is unaffected')
    }
    return false
  }
}

async function lookupApiKeyResult(
  plaintext: string,
): Promise<{ context: ApiKeyContext | null; failureReason?: ApiKeyAuthFailureReason }> {
  const hash = hashApiKey(plaintext)
  const now = Date.now()

  const cached = apiKeyCache.get(hash)
  if (cached && cached.staleAt > now) {
    api_key_cache_lookups_total.inc({ result: 'hit' })
    return evaluate(cached.value, now)
  }

  api_key_cache_lookups_total.inc({ result: 'miss' })
  const record = await prisma.apiKey.findUnique({ where: { hash } })
  const value: CachedKey = record
    ? {
        found: true,
        revoked: Boolean(record.revokedAt),
        expiresAt: record.expiresAt ?? null,
        context: {
          id: record.id,
          label: record.label,
          ratePerMin: record.ratePerMin,
          ratePerDay: record.ratePerDay,
          // Scopes are part of the cached context, not re-read on a hit. Omit
          // them and every cache hit authenticates with `scopes: undefined`,
          // so `hasScope` refuses and each scoped route 403s for the TTL —
          // the kind of break that looks like an authorization bug rather than
          // a caching one.
          scopes: record.scopes ?? [],
        },
      }
    : { found: false }
  cacheSet(hash, value, now)
  return evaluate(value, now)
}

export type AdminAuthResult = 'authorized' | 'unauthorized' | 'not_configured'

/**
 * Checks whether ADMIN_TOKEN is set to a non-empty, non-placeholder value.
 * An unset token, whitespace-only string, or obvious placeholder disables the admin surface.
 */
export function isAdminConfigured(): boolean {
  const adminToken = process.env.ADMIN_TOKEN?.trim()
  if (!adminToken || adminToken.length === 0) return false
  const weakPlaceholders = new Set(['your-admin-token-here', 'change-me', 'placeholder'])
  return !weakPlaceholders.has(adminToken.toLowerCase())
}

/**
 * Evaluates admin authorization for an incoming request:
 * - 'not_configured': ADMIN_TOKEN is not set or empty (admin surface disabled)
 * - 'unauthorized': valid token configured, but request has missing/wrong token
 * - 'authorized': request provided matching token in constant-time
 */
export function checkAdminAuth(req: FastifyRequest): AdminAuthResult {
  if (!isAdminConfigured()) {
    return 'not_configured'
  }
  const adminToken = process.env.ADMIN_TOKEN!.trim()
  const supplied =
    (req.headers['x-admin-token'] as string | undefined) ??
    req.headers['authorization']?.replace(/^Bearer\s+/i, '')
  if (!supplied) return 'unauthorized'
  const a = Buffer.from(supplied)
  const b = Buffer.from(adminToken)
  // Constant-time comparison (timingSafeEqual requires equal-length buffers).
  // The length guard is not itself a meaningful leak for a high-entropy token.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return 'unauthorized'
  }
  return 'authorized'
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
  return checkAdminAuth(req) === 'authorized'
}


/**
 * Seconds remaining until UTC midnight.
 * Used for both Redis TTL and the HTTP Retry-After response header.
 */
export function getSecondsUntilUtcMidnight(now = new Date()): number {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return Math.max(1, Math.floor((tomorrow.getTime() - now.getTime()) / 1000))
}

// In-memory fallback daily request tracker (keyed by apiKeyId), used if Redis is unreachable or in tests
const inMemoryDailyUsage = new Map<string, { count: number; date: string }>()

/**
 * Checks and increments the daily request count for an authenticated API key.
 *
 * Uses Redis (ratelimit:day:{apiKeyId}:{YYYY-MM-DD}) with an expiration set to
 * the remaining seconds until UTC midnight.
 *
 * On Redis being unreachable, allow the request and log it — do not fail closed.
 * Unlike x402 metering which guards an actual payment and must fail closed,
 * a rate limiter failing closed would turn a cache/Redis outage into a total API
 * outage for every authenticated caller, which is a far worse trade.
 */
export async function checkAndIncrementDailyUsage(
  apiKeyId: string,
  ratePerDay: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const redisKey = `ratelimit:day:${apiKeyId}:${today}`

  try {
    if (redis && redis.status === 'ready') {
      const count = await redis.incr(redisKey)
      if (count === 1) {
        const ttl = getSecondsUntilUtcMidnight(now)
        await redis.expire(redisKey, ttl)
      }
      if (count > ratePerDay) {
        return { allowed: false, remaining: 0 }
      }
      return { allowed: true, remaining: Math.max(0, ratePerDay - count) }
    }
  } catch (err) {
    // Fail-open: allow request and log warning
    log.warn({ err, apiKeyId }, 'redis rate limiter unreachable; failing open')
  }

  // In-memory fallback when Redis is offline or during testing
  const entry = inMemoryDailyUsage.get(apiKeyId)
  if (!entry || entry.date !== today) {
    inMemoryDailyUsage.set(apiKeyId, { count: 1, date: today })
    return { allowed: true, remaining: Math.max(0, ratePerDay - 1) }
  }
  if (entry.count >= ratePerDay) {
    return { allowed: false, remaining: 0 }
  }
  entry.count++
  return { allowed: true, remaining: Math.max(0, ratePerDay - entry.count) }
}

export function resetDailyUsage(): void {
  inMemoryDailyUsage.clear()
}

/**
 * Fastify plugin that authenticates requests via `Authorization: Bearer <key>`.
 *
 * A request without a valid, non-revoked, unexpired key gets 401. Valid requests have
 * their key metadata attached to `req.apiKey` so downstream rate limiting can
 * read per-key quotas.
 *
 * Runs as an `onRequest` hook (and must be registered BEFORE @fastify/rate-limit)
 * so that `req.apiKey` is populated before the rate limiter — which also runs in
 * `onRequest` — evaluates its per-key `max`/`keyGenerator`.
 *
 * Routes can opt out of auth (e.g. health/metrics) by setting
 * `config.public = true` on the route definition.
 */
/** Route config fields the two auth hooks read. */
type AuthRouteConfig = {
  public?: boolean
  admin?: boolean
  auth?: 'none' | 'api-key' | 'admin'
}

/**
 * Whether a request is bound for an operator-only admin route.
 *
 * Decided from the *matched route*, never from `req.url`. The raw URL is the
 * client's spelling of the path: find-my-way percent-decodes before matching, so
 * `GET /%61dmin/keys` reaches the `/admin/keys` handler while
 * `req.url.startsWith('/admin')` is false — a structural guard keyed on the raw
 * string would wave that request straight through. `routeOptions.url` is the
 * pattern the route was registered with (`/admin/keys/:id`), so it cannot be
 * spelled around. It is undefined when nothing matched, which needs no guard:
 * the request is a 404 either way.
 *
 * The prefix is `/admin/` with the separator, plus `/admin` exactly, so a future
 * `/administrators` route is not silently swept into the admin tier.
 */
export function isAdminRoute(req: FastifyRequest): boolean {
  const config = (req.routeOptions?.config ?? {}) as AuthRouteConfig
  if (config.admin === true || config.auth === 'admin') return true

  const pattern = req.routeOptions?.url
  if (!pattern) return false
  return pattern === '/admin' || pattern.startsWith('/admin/')
}

async function apiKeyAuthPlugin(app: FastifyInstance) {
  app.decorateRequest('apiKey', undefined)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const routeConfig = (req.routeOptions?.config ?? {}) as AuthRouteConfig & {
      scope?: string
      scopes?: string[]
    }
    // Admin routes carry an operator token, not an API key, and are enforced by
    // the admin hook below — so this hook steps aside rather than demanding a
    // key it was never going to be given.
    const isPublic = routeConfig.public === true || routeConfig.auth === 'none'
    if (isPublic || isAdminRoute(req)) return

    const authorization = req.headers['authorization']
    const token = extractBearer(authorization)
    if (authorization !== undefined && !token) {
      api_key_auth_failures_total.inc({ reason: 'malformed' })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'malformed',
        message: 'Malformed Authorization header.',
      })
    }

    if (authorization === undefined) {
      api_key_auth_failures_total.inc({ reason: 'missing' })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'missing',
        message: 'Missing API key. Provide an Authorization header.',
      })
    }

    if (!token) {
      api_key_auth_failures_total.inc({ reason: 'malformed' })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'malformed',
        message: 'Missing API key. Provide an Authorization: Bearer <key> header.',
      })
    }

    const result = await lookupApiKeyResult(token)
    const keyContext = result.context
    if (!keyContext) {
      const reason = result.failureReason ?? 'unknown'
      api_key_auth_failures_total.inc({ reason })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: reason,
        message: reason === 'revoked'
          ? 'Revoked API key. Request a replacement key.'
          : reason === 'expired'
            ? 'Expired API key. Request a replacement key.'
            : 'Unknown API key.',
      })
    }

    req.apiKey = keyContext
    // #500: after the key is known to be valid and before any scope or quota
    // rejection — "last used" means "last authenticated", not "last allowed
    // through", or a key whose quota is exhausted looks abandoned.
    await recordApiKeyLastUsed(keyContext.id)

    const requiredScopes = routeConfig.scopes ?? (routeConfig.scope ? [routeConfig.scope] : [])
    for (const scope of requiredScopes) {
      if (!hasScope(keyContext, scope)) {
        api_key_auth_failures_total.inc({ reason: 'insufficient_scope' })
        return reply.status(403).send({
          error: 'Forbidden',
          code: 'insufficient_scope',
          message: `Missing required scope: ${scope}`,
          requiredScope: scope,
          scope,
        })
      }
    }

    // The per-minute limiter cannot express a daily cap, so this runs alongside it
    if (keyContext.ratePerDay && keyContext.ratePerDay > 0) {
      const { allowed, remaining } = await checkAndIncrementDailyUsage(keyContext.id, keyContext.ratePerDay)
      const retryAfterSec = getSecondsUntilUtcMidnight()
      reply.header('X-RateLimit-Limit-Day', keyContext.ratePerDay)
      reply.header('X-RateLimit-Remaining-Day', remaining)
      if (!allowed) {
        reply.header('Retry-After', retryAfterSec)
        return reply.status(429).send({
          statusCode: 429,
          ...apiError('rate_limited', 'Too Many Requests'),
          message: `Daily rate limit of ${keyContext.ratePerDay} requests exceeded for this API key. Quota resets at UTC midnight.`,
          retryAfter: retryAfterSec,
        })
      }
    }
  })
}

export const registerApiKeyAuth = fp(apiKeyAuthPlugin, { name: 'api-key-auth' })

/**
 * Fastify plugin that structurally guards every operator-only admin endpoint.
 *
 * Runs as an onRequest hook over everything {@link isAdminRoute} recognises: a
 * route declaring `admin: true` or `auth: 'admin'`, and anything registered
 * under `/admin/`. So a new admin endpoint is protected by the fact of where it
 * lives, not by whoever writes it remembering to call `isAdminAuthorized`.
 *
 * Register it before the admin routes themselves. Fastify resolves a route's
 * hook chain when the route is registered, so a hook added afterwards does not
 * apply to it — `src/__tests__/adminStructuralAuth.test.ts` holds that ordering
 * by asserting on routes registered through `buildApp`'s own sequence.
 */
async function adminAuthHookPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminRoute(req)) return

    // Three outcomes, not two (#508). The hook runs before the handler, so it
    // has to make the same distinction the handlers make, or a deployment with
    // no ADMIN_TOKEN answers 401 "provide a valid token" to an operator who
    // supplied a perfectly good one — and the 503 the handlers would have
    // returned is unreachable.
    const auth = checkAdminAuth(req)
    if (auth === 'not_configured') {
      return reply.status(503).send({
        error: 'Service Unavailable',
        code: 'admin_not_configured',
        message: 'Admin surface is disabled: ADMIN_TOKEN is not configured on this server.',
      })
    }
    if (auth !== 'authorized') {
      // Only a real rejection is a failure. An unconfigured surface is a
      // deployment fact, and counting it here would turn one misconfigured
      // environment into a permanent stream of auth-failure alerts.
      admin_auth_failures_total.inc()
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'admin_unauthorized',
        message: 'Provide a valid X-Admin-Token header.',
      })
    }
  })
}

export const registerAdminAuth = fp(adminAuthHookPlugin, { name: 'admin-auth-hook' })
