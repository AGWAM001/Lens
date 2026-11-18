import { afterEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { registerGlobalRateLimit } from '../middleware/globalRateLimit'
import { global_shed_requests_total } from '../metrics'

async function buildApp(globalMax: number, perKeyMax = 10) {
  const app = Fastify()
  await app.register(rateLimit, {
    max: perKeyMax,
    timeWindow: '1 minute',
    keyGenerator: () => 'test-key',
    allowList: (req) => ['/status', '/live', '/ready'].includes(req.url),
  })
  registerGlobalRateLimit(app, globalMax)
  app.get('/work', async () => ({ ok: true }))
  app.get('/cheap', async () => ({ ok: true }))
  app.get('/price/test', async () => ({ ok: true }))
  app.get('/status', async () => ({ ok: true }))
  app.get('/live', async () => ({ ok: true }))
  app.get('/ready', async () => ({ ok: true }))
  await app.ready()
  return app
}

describe('global request ceiling', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns a distinct global response while the caller remains within its per-key quota', async () => {
    app = await buildApp(1, 10)
    const before = (await global_shed_requests_total.get()).values[0]?.value ?? 0

    expect((await app.inject({ method: 'GET', url: '/work' })).statusCode).toBe(200)
    const shed = await app.inject({ method: 'GET', url: '/work' })

    expect(shed.statusCode).toBe(503)
    expect(shed.json()).toMatchObject({ code: 'GLOBAL_RATE_LIMITED' })
    expect(shed.headers['retry-after']).toBeDefined()
    expect((await global_shed_requests_total.get()).values[0]?.value).toBe(before + 1)
  })

  it('sheds expensive routes before cheap routes as the ceiling approaches', async () => {
    app = await buildApp(5)

    for (let i = 0; i < 4; i++) {
      expect((await app.inject({ method: 'GET', url: '/cheap' })).statusCode).toBe(200)
    }
    expect((await app.inject({ method: 'GET', url: '/price/test' })).json()).toMatchObject({
      code: 'GLOBAL_RATE_LIMITED',
    })
    expect((await app.inject({ method: 'GET', url: '/cheap' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/cheap' })).statusCode).toBe(503)
  })

  it('never sheds health endpoints', async () => {
    app = await buildApp(1)
    expect((await app.inject({ method: 'GET', url: '/work' })).statusCode).toBe(200)

    for (const path of ['/status', '/live', '/ready']) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(200)
    }
  })
})
