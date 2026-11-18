import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { registerApiKeyAuth, registerAdminAuth } from '../api/auth'
import { registerAdminRoutes } from '../api/admin'
import { registerUsageRoutes } from '../api/usage'

describe('Issue #514: Structural admin authentication hook', () => {
  let app: FastifyInstance
  const validAdminToken = 'admin-secret-token-123'

  beforeEach(async () => {
    vi.stubEnv('ADMIN_TOKEN', validAdminToken)
    vi.stubEnv('REQUIRE_API_KEY', 'true')

    app = Fastify()
    await app.register(registerApiKeyAuth)
    await app.register(registerAdminAuth)
    await app.register(registerAdminRoutes)
    await app.register(registerUsageRoutes)

    app.get('/status', { config: { public: true, auth: 'none' } }, async () => ({ status: 'ok' }))
    app.get('/price/test', async () => ({ price: 100 }))

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('rejects unauthenticated requests to /admin/keys with 401 admin_unauthorized', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      payload: { name: 'test-key' },
    })

    expect(res.statusCode).toBe(401)
    const body = res.json()
    expect(body.code).toBe('admin_unauthorized')
  })

  it('rejects requests with invalid X-Admin-Token to /admin/keys with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: {
        'x-admin-token': 'wrong-token',
      },
      payload: { name: 'test-key' },
    })

    expect(res.statusCode).toBe(401)
    const body = res.json()
    expect(body.code).toBe('admin_unauthorized')
  })

  it('rejects unauthenticated requests to /admin/usage with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage',
    })

    expect(res.statusCode).toBe(401)
    const body = res.json()
    expect(body.code).toBe('admin_unauthorized')
  })

  it('automatically protects dynamically registered /admin routes by default', async () => {
    // Dynamically register a new route under /admin with standard app.get
    const dynamicApp = Fastify()
    await dynamicApp.register(registerAdminAuth)
    dynamicApp.get('/admin/custom-diagnostic', async (_req, reply) => {
      return reply.send({ diagnostic: 'ok' })
    })
    await dynamicApp.ready()

    // Calling it without admin token should be rejected structurally by onRequest hook
    const unauthRes = await dynamicApp.inject({
      method: 'GET',
      url: '/admin/custom-diagnostic',
    })

    expect(unauthRes.statusCode).toBe(401)
    expect(unauthRes.json().code).toBe('admin_unauthorized')

    // Calling it with valid admin token should succeed
    const authRes = await dynamicApp.inject({
      method: 'GET',
      url: '/admin/custom-diagnostic',
      headers: {
        'x-admin-token': validAdminToken,
      },
    })

    expect(authRes.statusCode).toBe(200)
    expect(authRes.json()).toEqual({ diagnostic: 'ok' })
    await dynamicApp.close()
  })

  it('leaves genuinely public routes accessible without credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('allows access to admin routes when valid X-Admin-Token is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage',
      headers: {
        'x-admin-token': validAdminToken,
      },
    })

    expect(res.statusCode).toBe(200)
  })

  it('guards a percent-encoded spelling of an admin path', async () => {
    // A route with no `isAdminAuthorized` call of its own, so the hook is the
    // only thing that can refuse the request — the admin plugins' own handlers
    // return the identical 401 body, which would make this pass either way.
    const bare = Fastify()
    await bare.register(registerAdminAuth)
    bare.get('/admin/diagnostic', async () => ({ diagnostic: 'ok' }))
    await bare.ready()

    // find-my-way percent-decodes before matching, so this reaches the
    // /admin/diagnostic handler while req.url is still '/%61dmin/diagnostic'.
    // A guard keyed on the raw URL waves it through; isAdminRoute reads the
    // matched route pattern, which cannot be spelled around.
    const encoded = await bare.inject({ method: 'GET', url: '/%61dmin/diagnostic' })
    expect(encoded.statusCode).toBe(401)
    expect(encoded.json().code).toBe('admin_unauthorized')

    // Same route, same guard, with the token: still reachable.
    const authorized = await bare.inject({
      method: 'GET',
      url: '/%61dmin/diagnostic',
      headers: { 'x-admin-token': validAdminToken },
    })
    expect(authorized.statusCode).toBe(200)

    await bare.close()
  })

  it('answers 503, not 401, when ADMIN_TOKEN is unset — from the hook, not the handler', async () => {
    // #508 through #514: the hook runs before the handler, so if it collapses
    // "no token configured" into "wrong token" the handlers' 503 is
    // unreachable and an operator with a perfectly good token is told their
    // token is bad. A route with no check of its own isolates the hook.
    vi.stubEnv('ADMIN_TOKEN', '')

    const bare = Fastify()
    await bare.register(registerAdminAuth)
    bare.get('/admin/diagnostic', async () => ({ diagnostic: 'ok' }))
    await bare.ready()

    const res = await bare.inject({
      method: 'GET',
      url: '/admin/diagnostic',
      headers: { 'x-admin-token': validAdminToken },
    })

    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('admin_not_configured')
    await bare.close()
  })

  it('does not sweep a route that merely starts with the letters "admin" into the admin tier', async () => {
    const neighbour = Fastify()
    await neighbour.register(registerAdminAuth)
    neighbour.get('/administrators', async () => ({ ok: true }))
    await neighbour.ready()

    const res = await neighbour.inject({ method: 'GET', url: '/administrators' })

    expect(res.statusCode).toBe(200)
    await neighbour.close()
  })
})

/**
 * The invariant, rather than a sample of it.
 *
 * The point of #514 is that an admin endpoint is protected by *where it lives*,
 * so the test that matters is over every route the admin plugins register, not
 * over the three a test author happened to think of. `onRoute` sees each route
 * as it is registered, including its config, which is exactly what the guard
 * reads at request time.
 *
 * It also catches the inverse mistake: a route under /admin that still declares
 * `public: true`. That combination used to be how admin routes opted out of the
 * API-key hook, and five of them were still written that way — harmless while
 * the per-handler `isAdminAuthorized` checks remain, and a hole the moment
 * someone removes them on the strength of "the hook handles it now".
 */
describe('Issue #514: every registered /admin route declares itself admin', () => {
  it('has no /admin route left on public: true or an undeclared tier', async () => {
    const seen: Array<{ method: string; url: string; config: Record<string, unknown> }> = []

    const collector = Fastify()
    collector.addHook('onRoute', route => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) {
        seen.push({ method, url: route.url, config: (route.config ?? {}) as Record<string, unknown> })
      }
    })
    await collector.register(registerAdminRoutes)
    await collector.register(registerUsageRoutes)
    await collector.ready()

    const adminRoutes = seen.filter(route => route.url === '/admin' || route.url.startsWith('/admin/'))
    expect(adminRoutes.length, 'the admin plugins should register admin routes').toBeGreaterThan(0)

    const undeclared = adminRoutes.filter(
      route => route.config['admin'] !== true && route.config['auth'] !== 'admin'
    )
    expect(
      undeclared.map(route => `${route.method} ${route.url}`),
      "every /admin route must declare { admin: true, auth: 'admin' }"
    ).toEqual([])

    const stillPublic = adminRoutes.filter(route => route.config['public'] === true)
    expect(
      stillPublic.map(route => `${route.method} ${route.url}`),
      'an /admin route must not also declare itself public'
    ).toEqual([])
  })
})
