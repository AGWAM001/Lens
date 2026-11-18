import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'

const mockQuery = vi.fn()
vi.mock('../db', () => ({
  pgPool: {
    query: (...args: any[]) => mockQuery(...args),
  },
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
    },
  },
}))

import { buildApp } from '../app'
import { markBootComplete, resetHealthState } from '../health'

describe('GET /status contract & health separation (#273)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    mockQuery.mockReset()
    // `/status` reports process health from boot state, so a test that means
    // "a healthy process" has to say so. Without this the app is mid-boot —
    // listening, ingesters not all up — which is exactly the degraded process
    // the dedicated test below asserts.
    resetHealthState()
    markBootComplete()
    app = await buildApp()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    resetHealthState()
  })

  it('returns 200 with separate process and data health fields when healthy', async () => {
    const recentDate = new Date(Date.now() - 30 * 1000) // 30s ago
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          last_ledger: 123456,
          last_processed_at: recentDate,
        },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('healthy')
    expect(body.health).toBeDefined()
    expect(body.health.process).toBe('healthy')
    expect(body.health.data).toBe('healthy')
    expect(body.process.status).toBe('healthy')
    expect(typeof body.process.uptimeSeconds).toBe('number')
    expect(typeof body.process.memoryUsageMb).toBe('number')
    expect(body.data.isStale).toBe(false)
    expect(body.data.lastIndexedLedger).toBe(123456)
  })

  it('distinguishes process health from data health when data is stale', async () => {
    const staleDate = new Date(Date.now() - 600 * 1000) // 10 minutes ago (> 300s)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          last_ledger: 100000,
          last_processed_at: staleDate,
        },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('degraded')
    expect(body.health.process).toBe('healthy') // Process is still running fine
    expect(body.health.data).toBe('stale') // Data ingestion is stale
    expect(body.data.isStale).toBe(true)
    expect(body.data.ingestLagSeconds).toBeGreaterThan(300)
  })

  it('reports a degraded process while the service is still booting', async () => {
    // Between `listen()` and `markBootComplete()` the port answers but the
    // ingesters are not all running. That is a degraded process with
    // perfectly fresh data, which is the distinction this endpoint exists to
    // draw — and the case that proves `health.process` is measured rather
    // than hard-coded.
    resetHealthState()
    mockQuery.mockResolvedValueOnce({
      rows: [{ last_ledger: 123456, last_processed_at: new Date(Date.now() - 5 * 1000) }],
    })

    const res = await app.inject({ method: 'GET', url: '/status' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.health.process).toBe('degraded')
    expect(body.process.status).toBe('degraded')
    expect(body.health.data).toBe('healthy')
    expect(body.status).toBe('degraded')
  })

  it('returns 503 with DATABASE_DOWN paging condition when database fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))

    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.status).toBe('unhealthy')
    expect(body.pagingCondition).toBe('DATABASE_DOWN')
    expect(body.error).toBe('Database unavailable')
  })

  it('never puts the driver message in the 503 body', async () => {
    // A pg connection failure carries the host, the user and sometimes the
    // whole connection string. `/status` is public and unauthenticated and is
    // the most-polled surface Lens has, so the driver's own text must not
    // reach the response — the detail belongs in the log, which pipes through
    // redactSecrets. Lens has already rotated a database password over this
    // exact shape of leak on another route.
    mockQuery.mockRejectedValueOnce(
      new Error(
        'connect ECONNREFUSED: password authentication failed for user "lens_admin" ' +
          '(postgresql://lens_admin:hunter2@db.internal.example:5432/lens)'
      )
    )

    const res = await app.inject({ method: 'GET', url: '/status' })

    expect(res.statusCode).toBe(503)
    const raw = res.body
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('lens_admin')
    expect(raw).not.toContain('db.internal.example')
    expect(raw).not.toContain('postgresql://')
    expect(res.json().error).toBe('Database unavailable')
  })
})
