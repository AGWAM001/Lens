import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerHttpMetrics, statusClass, routeLabel } from '../src/middleware/httpMetrics'
import { register, http_requests_total, http_request_duration_seconds } from '../src/metrics'

/** Every `http_requests_total` sample currently in the registry. */
async function requestSamples() {
  const metric = await register.getSingleMetric('http_requests_total')!.get()
  return metric.values
}

/** Every `http_request_duration_seconds` sample currently in the registry. */
async function durationSamples() {
  const metric = await register.getSingleMetric('http_request_duration_seconds')!.get()
  return metric.values
}

/** The `_count` samples of the duration histogram — one per label combination. */
async function durationCounts() {
  return (await durationSamples()).filter(v => v.metricName === 'http_request_duration_seconds_count')
}

it('exports runtime metrics with the Lens label on repeated scrapes', async () => {
  for (let pass = 0; pass < 2; pass++) {
    const scrape = await register.metrics()
    expect(scrape).toMatch(/^process_resident_memory_bytes\{app="lens"\} /m)
    expect(scrape).toMatch(/^nodejs_eventloop_lag_seconds\{app="lens"\} /m)
  }
})

/**
 * Builds an app wired the way src/index.ts wires it: the metrics plugin is
 * registered FIRST, ahead of the hooks that can reject a request, so the
 * rejection paths are exercised by these tests the same way they are in
 * production.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(registerHttpMetrics)

  // Stands in for the API-key auth hook: rejects in onRequest, before routing
  // completes, exactly as src/api/auth.ts does.
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-fail-auth']) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  })

  app.get('/price/:assetA/:assetB', async () => ({ ok: true }))
  app.get('/status', async () => ({ ok: true }))
  app.get('/boom', async () => {
    throw new Error('intentional failure')
  })
  app.get('/bad', async (_req, reply) => reply.status(400).send({ error: 'Bad Request' }))
  app.get('/metrics', async () => 'metrics body')

  await app.ready()
  return app
}

let app: FastifyInstance

beforeEach(async () => {
  http_requests_total.reset()
  http_request_duration_seconds.reset()
  app = await buildApp()
})

describe('statusClass', () => {
  it('buckets codes into classes rather than keeping the exact code', () => {
    expect(statusClass(200)).toBe('2xx')
    expect(statusClass(204)).toBe('2xx')
    expect(statusClass(301)).toBe('3xx')
    expect(statusClass(400)).toBe('4xx')
    expect(statusClass(404)).toBe('4xx')
    expect(statusClass(429)).toBe('4xx')
    expect(statusClass(500)).toBe('5xx')
    expect(statusClass(503)).toBe('5xx')
  })
})

describe('routeLabel', () => {
  it('falls back to the literal "unmatched" when no route resolved', () => {
    expect(routeLabel({ routeOptions: undefined } as never)).toBe('unmatched')
    expect(routeLabel({ routeOptions: { url: undefined } } as never)).toBe('unmatched')
  })
})

describe('label cardinality', () => {
  it('collapses 100 requests to distinct addresses into a single series', async () => {
    for (let i = 0; i < 100; i++) {
      await app.inject({ method: 'GET', url: `/price/XLM/GABC${i}DEADBEEF` })
    }

    const samples = await requestSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0].labels).toEqual({
      method: 'GET',
      route: '/price/:assetA/:assetB',
      status_class: '2xx',
    })
    expect(samples[0].value).toBe(100)

    // The resolved URL must never appear in a label.
    const serialised = JSON.stringify(samples)
    expect(serialised).not.toContain('DEADBEEF')

    const counts = await durationCounts()
    expect(counts).toHaveLength(1)
    expect(counts[0].value).toBe(100)
  })

  it('does not create a series per path for unmatched routes', async () => {
    for (let i = 0; i < 25; i++) {
      await app.inject({ method: 'GET', url: `/no/such/route/${i}` })
    }

    const samples = await requestSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0].labels.route).toBe('unmatched')
    expect(samples[0].labels.status_class).toBe('4xx')
    expect(samples[0].value).toBe(25)
  })
})

describe('error accounting', () => {
  it('counts a 5xx from a handler that throws', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)

    const samples = await requestSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0].labels).toEqual({ method: 'GET', route: '/boom', status_class: '5xx' })
    expect(samples[0].value).toBe(1)
  })

  it('distinguishes 4xx from 5xx', async () => {
    await app.inject({ method: 'GET', url: '/bad' })
    await app.inject({ method: 'GET', url: '/boom' })

    const byClass = Object.fromEntries(
      (await requestSamples()).map(s => [s.labels.status_class, s.value])
    )
    expect(byClass['4xx']).toBe(1)
    expect(byClass['5xx']).toBe(1)
  })

  it('counts a request rejected by an auth hook before routing completes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC',
      headers: { 'x-fail-auth': '1' },
    })
    expect(res.statusCode).toBe(401)

    const samples = await requestSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0].labels.status_class).toBe('4xx')
    expect(samples[0].value).toBe(1)
  })
})

describe('latency observation', () => {
  it('observes duration for both successful and failed requests', async () => {
    await app.inject({ method: 'GET', url: '/status' })
    await app.inject({ method: 'GET', url: '/boom' })

    const byRoute = Object.fromEntries(
      (await durationCounts()).map(s => [s.labels.route, s.value])
    )
    expect(byRoute['/status']).toBe(1)
    expect(byRoute['/boom']).toBe(1)
  })

  it('records a non-negative, finite duration in the histogram sum', async () => {
    await app.inject({ method: 'GET', url: '/status' })

    const sum = (await durationSamples()).find(
      v => v.metricName === 'http_request_duration_seconds_sum'
    )
    expect(sum).toBeDefined()
    expect(sum!.value).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(sum!.value)).toBe(true)
  })
})

describe('scrape endpoint', () => {
  it('does not count /metrics, so the scraper cannot inflate its own numbers', async () => {
    await app.inject({ method: 'GET', url: '/metrics' })
    await app.inject({ method: 'GET', url: '/metrics' })

    expect(await requestSamples()).toHaveLength(0)
    expect(await durationCounts()).toHaveLength(0)
  })

  it('exposes both metric families on the shared registry', async () => {
    await app.inject({ method: 'GET', url: '/status' })

    const exported = await register.metrics()
    expect(exported).toContain('http_requests_total')
    expect(exported).toContain('http_request_duration_seconds')
  })
})

describe('method label', () => {
  it('separates methods on the same route template', async () => {
    const methodApp = Fastify()
    await methodApp.register(registerHttpMetrics)
    methodApp.get('/thing', async () => ({ ok: true }))
    methodApp.post('/thing', async () => ({ ok: true }))
    await methodApp.ready()

    await methodApp.inject({ method: 'GET', url: '/thing' })
    await methodApp.inject({ method: 'POST', url: '/thing' })

    const byMethod = Object.fromEntries(
      (await requestSamples()).map(s => [s.labels.method, s.value])
    )
    expect(byMethod['GET']).toBe(1)
    expect(byMethod['POST']).toBe(1)

    await methodApp.close()
  })
})
