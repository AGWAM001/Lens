/**
 * Liveness and readiness probes.
 *
 * The distinction under test is the one that keeps a dependency outage from
 * becoming a fleet-wide restart loop: `/live` must not touch Postgres or Redis
 * (so a database blip never makes the orchestrator kill healthy processes), and
 * `/ready` must actually reflect them (so a process that cannot serve is not
 * sent traffic).
 *
 * Boot state matters as much as the dependency checks. `app.listen()` runs part-
 * way through `main()`, before the ingesters exist, so a process that is
 * listening is not yet able to serve — hence `/ready` being unhealthy until
 * `markBootComplete()`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { registerHealthRoutes } from '../src/routes/health'
import { markBootComplete, resetHealthState } from '../src/health'
import { registerHttpMetrics } from '../src/middleware/httpMetrics'
import { registerCachePolicy } from '../src/middleware/cachePolicy'
import { registerApiKeyAuth } from '../src/api/auth'
import { http_requests_total, http_request_duration_seconds } from '../src/metrics'

const { mockQuery, mockPing, mockFindUnique } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockPing: vi.fn(),
  mockFindUnique: vi.fn(),
}))

// `prisma` is here only because registerApiKeyAuth imports it; the probes never
// touch it.
vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
  prisma: { apiKey: { findUnique: mockFindUnique } },
}))
vi.mock('../src/redis', () => ({ redis: { ping: mockPing } }))

/** Postgres reachable and migrated — the healthy baseline. */
function postgresUp() {
  mockQuery.mockResolvedValue({ rows: [{ migrated: true }] })
}

/**
 * Builds an app with the probe routes registered.
 *
 * Plugins are registered before the routes, as src/app.ts does. Order matters:
 * a plugin registered afterwards lands in a fresh encapsulated scope whose
 * hooks do not reach routes already on the parent, and the rate-limit
 * assertions below would pass vacuously.
 */
async function buildApp(opts: {
  plugins?: (app: FastifyInstance) => Promise<void> | void
  routes?: (app: FastifyInstance) => Promise<void> | void
} = {}) {
  const app = Fastify({ logger: false })
  if (opts.plugins) await opts.plugins(app)
  await registerHealthRoutes(app)
  if (opts.routes) await opts.routes(app)
  await app.ready()
  return app
}

/**
 * A rate limiter configured the way src/app.ts configures it, but with a limit
 * low enough that a handful of requests exhausts it. `probePaths` stands in for
 * the app's own allow-list.
 */
function limiter(max: number, probePaths: string[]) {
  return async (app: FastifyInstance) => {
    await app.register(rateLimit, {
      max,
      timeWindow: '1 minute',
      keyGenerator: req => req.ip,
      allowList: req => probePaths.includes(req.url),
    })
  }
}

/** The allow-list src/app.ts actually installs for /status, /live and /ready. */
const PROBE_PATHS = ['/status', '/live', '/ready']

beforeEach(() => {
  vi.clearAllMocks()
  resetHealthState()
  postgresUp()
  mockPing.mockResolvedValue('PONG')
  delete process.env.READINESS_REDIS_CHECK
})

afterEach(() => {
  resetHealthState()
})

describe('GET /live', () => {
  it('is healthy', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/live' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, uptimeSeconds: expect.any(Number) })
  })

  it('touches neither Postgres nor Redis', async () => {
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/live' })

    // Not even when both are down: the whole point is that a database outage
    // must not fail liveness on every instance at once.
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockPing).not.toHaveBeenCalled()
  })

  it('stays healthy while every dependency is down and the app has not booted', async () => {
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'))
    mockPing.mockRejectedValue(new Error('ECONNREFUSED'))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/live' })

    // A starting or degraded process must be held out of rotation, not killed.
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })

  it('reports a plausible uptime', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/live' })

    const { uptimeSeconds } = res.json()
    expect(Number.isInteger(uptimeSeconds)).toBe(true)
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0)
  })
})

describe('GET /ready — boot state', () => {
  it('is unhealthy before the boot sequence finishes', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ ok: false, booted: false })
  })

  it('probes nothing while not booted', async () => {
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/ready' })

    // Nothing can make a not-yet-booted process ready, so polling it must not
    // cost a database round trip.
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockPing).not.toHaveBeenCalled()
  })

  it('becomes healthy once boot completes and dependencies answer', async () => {
    markBootComplete()
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ok: true,
      booted: true,
      checks: {
        postgres: { status: 'up', reason: null },
        redis: { status: 'up', reason: null },
      },
    })
  })
})

describe('GET /ready — dependencies', () => {
  beforeEach(() => markBootComplete())

  it('is unhealthy when Postgres is unreachable', async () => {
    mockQuery.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
    }))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json().checks.postgres.status).toBe('down')
    expect(res.json().ok).toBe(false)
  })

  it('does not leak the dependency address in a public response', async () => {
    mockQuery.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.body).not.toContain('10.0.0.5')
    expect(res.body).not.toContain('5432')
    expect(res.body).not.toContain('ECONNREFUSED')
  })

  it('is unhealthy when Redis is unreachable', async () => {
    mockPing.mockRejectedValue(new Error('Connection is closed.'))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json().checks.redis.status).toBe('down')
    // Postgres alone is not readiness — the retention worker and the aggregate
    // queue are Redis-backed and silently stop when it goes.
    expect(res.json().checks.postgres.status).toBe('up')
  })

  it('skips Redis entirely when READINESS_REDIS_CHECK=false', async () => {
    process.env.READINESS_REDIS_CHECK = 'false'
    mockPing.mockRejectedValue(new Error('Connection is closed.'))
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/ready' })

    // A deliberately Redis-less deployment serves prices uncached from Postgres,
    // so failing readiness there would pull a healthy instance from rotation.
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    expect(res.json().checks.redis.status).toBe('skipped')
    expect(mockPing).not.toHaveBeenCalled()
  })

  it('calls a probe that never settles down rather than hanging the endpoint', async () => {
    process.env.READINESS_TIMEOUT_MS = '60'
    mockQuery.mockImplementation(() => new Promise(() => {}))
    const app = await buildApp()

    const started = Date.now()
    const res = await app.inject({ method: 'GET', url: '/ready' })
    const elapsed = Date.now() - started

    expect(res.statusCode).toBe(503)
    expect(res.json().checks.postgres.status).toBe('down')
    // A probe slower than the platform's polling interval reports stale answers.
    expect(elapsed).toBeLessThan(2_000)
  })

  it('caches an answer, so repeated polling does not multiply probes', async () => {
    process.env.READINESS_CACHE_MS = '5000'
    const app = await buildApp()

    for (let i = 0; i < 25; i++) await app.inject({ method: 'GET', url: '/ready' })

    // One round trip per dependency for 25 polls. Without this a probe that
    // times out — and cannot be cancelled — would leave one stuck query per poll
    // accumulating against the pool.
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockPing).toHaveBeenCalledTimes(1)
  })

  it('serves one in-flight run to concurrent polls', async () => {
    process.env.READINESS_CACHE_MS = '0'
    const app = await buildApp()

    await Promise.all(
      Array.from({ length: 10 }, () => app.inject({ method: 'GET', url: '/ready' }))
    )

    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})

describe('probe wiring', () => {
  it('checks that migrations are applied, not just that the server answers', async () => {
    markBootComplete()
    const app = await buildApp()

    await app.inject({ method: 'GET', url: '/ready' })

    // Connectivity alone would report a process with no tables as ready, and
    // every route that reads one would fail.
    expect(mockQuery.mock.calls[0][0]).toContain('to_regclass')
  })
})

describe('operational wiring', () => {
  it('is excluded from http_requests_total, so a poller cannot inflate the rate', async () => {
    const app = await buildApp({ plugins: app => app.register(registerHttpMetrics) })
    http_requests_total.reset()
    http_request_duration_seconds.reset()

    for (let i = 0; i < 10; i++) await app.inject({ method: 'GET', url: '/live' })
    for (let i = 0; i < 10; i++) await app.inject({ method: 'GET', url: '/ready' })

    // A fixed-interval poller would otherwise put a floor under request rate
    // that no amount of real traffic dropping could go below.
    expect((await http_requests_total.get()).values).toHaveLength(0)
    expect((await http_request_duration_seconds.get()).values).toHaveLength(0)
  })

  it('still counts the routes that surround them', async () => {
    // Guard against excluding by accident: the exclusion is per-route, not a
    // blanket switch over the whole app.
    const app = await buildApp({
      plugins: app => app.register(registerHttpMetrics),
      routes: app => { app.get('/status', async () => ({ ok: true })) },
    })
    http_requests_total.reset()

    await app.inject({ method: 'GET', url: '/status' })
    await app.inject({ method: 'GET', url: '/live' })

    const samples = (await http_requests_total.get()).values
    expect(samples).toHaveLength(1)
    expect(samples[0].labels.route).toBe('/status')
  })

  it('is exempt from rate limiting', async () => {
    // A limit of 5 stands in for the default, so an un-exempt route would 429
    // long before a platform finished polling. Being throttled during an
    // incident is indistinguishable from being unhealthy.
    const app = await buildApp({ plugins: limiter(5, PROBE_PATHS) })

    const statuses = []
    for (let i = 0; i < 30; i++) {
      statuses.push((await app.inject({ method: 'GET', url: '/live' })).statusCode)
      statuses.push((await app.inject({ method: 'GET', url: '/ready' })).statusCode)
    }

    expect(statuses.every(s => s !== 429)).toBe(true)
  })

  it('still rate limits ordinary routes under the same limiter', async () => {
    // The exemption must be narrow: matching by prefix or wildcard would quietly
    // exempt the whole API.
    const app = await buildApp({
      plugins: limiter(5, PROBE_PATHS),
      routes: app => { app.get('/price', async () => ({ ok: true })) },
    })

    const statuses = []
    for (let i = 0; i < 10; i++) {
      statuses.push((await app.inject({ method: 'GET', url: '/price' })).statusCode)
    }

    expect(statuses).toContain(429)
  })

  it('does not require an API key', async () => {
    // The real auth hook, registered the way src/app.ts registers it. If either
    // probe lost `config.public`, every platform poll would 401 and a healthy
    // instance would look broken.
    const app = await buildApp({
      plugins: async app => {
        await app.register(registerApiKeyAuth)
        await app.register(rateLimit, {
          max: (req: { apiKey?: { ratePerMin?: number } }) => req.apiKey?.ratePerMin ?? 100,
          timeWindow: '1 minute',
          keyGenerator: (req: { apiKey?: { id?: string } }) => req.apiKey?.id ?? 'ip',
        })
      },
    })

    const live = await app.inject({ method: 'GET', url: '/live' })
    const ready = await app.inject({ method: 'GET', url: '/ready' })

    expect(live.statusCode).toBe(200)
    expect(ready.statusCode).not.toBe(401)
    // The control: a route without `config.public` really is gated, so the two
    // assertions above mean something.
    expect((await app.inject({ method: 'GET', url: '/status' })).statusCode).toBe(401)
  })

  it('is never cached by a shared cache', async () => {
    const app = await buildApp({ plugins: app => app.register(registerCachePolicy) })

    const live = await app.inject({ method: 'GET', url: '/live' })
    const ready = await app.inject({ method: 'GET', url: '/ready' })

    // A cached readiness answer would keep sending traffic to an instance that
    // has already gone away.
    expect(live.headers['cache-control']).toBe('no-store')
    expect(ready.headers['cache-control']).toBe('no-store')
  })
})

describe('/status is unchanged', () => {
  it('is still allow-listed from rate limiting', async () => {
    // The probes must not have displaced /status in the rate-limit allow-list.
    const app = await buildApp({
      plugins: limiter(2, PROBE_PATHS),
      routes: app => { app.get('/status', async () => ({ ok: true })) },
    })

    const statuses = []
    for (let i = 0; i < 10; i++) {
      statuses.push((await app.inject({ method: 'GET', url: '/status' })).statusCode)
    }

    expect(statuses.every(s => s !== 429)).toBe(true)
  })

  it('is still cached like it always was', async () => {
    const app = await buildApp({
      plugins: app => app.register(registerCachePolicy),
      routes: app => { app.get('/status', async () => ({ ok: true })) },
    })

    const res = await app.inject({ method: 'GET', url: '/status' })

    expect(res.headers['cache-control']).toBe('public, max-age=15')
  })
})
