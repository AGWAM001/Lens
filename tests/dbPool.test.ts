import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import {
  buildDatabaseUrl,
  isPoolExhaustionError,
  recordPoolExhaustion,
  updatePoolMetrics,
  pgPool,
} from '../src/db'
import {
  register,
  db_pool_connections_in_use,
  db_pool_connections_idle,
  db_pool_connections_waiting,
  db_pool_exhaustion_errors_total,
  getMetrics,
} from '../src/metrics'

describe('Database Connection Pool (Issue #339)', () => {
  beforeEach(() => {
    db_pool_connections_in_use.reset()
    db_pool_connections_idle.reset()
    db_pool_connections_waiting.reset()
    db_pool_exhaustion_errors_total.reset()
  })

  describe('buildDatabaseUrl', () => {
    it('appends connection_limit and pool_timeout to PostgreSQL URL', () => {
      const base = 'postgresql://lens:lens@localhost:5432/lens'
      const built = buildDatabaseUrl(base, 15, 8000)
      const url = new URL(built)

      expect(url.searchParams.get('connection_limit')).toBe('15')
      expect(url.searchParams.get('pool_timeout')).toBe('8')
    })

    it('enforces minimum pool_timeout of 1 second', () => {
      const base = 'postgresql://lens:lens@localhost:5432/lens'
      const built = buildDatabaseUrl(base, 5, 200)
      const url = new URL(built)

      expect(url.searchParams.get('connection_limit')).toBe('5')
      expect(url.searchParams.get('pool_timeout')).toBe('1')
    })
  })

  describe('isPoolExhaustionError', () => {
    it('identifies Prisma P2024 connection pool timeout', () => {
      const p2024 = new Prisma.PrismaClientKnownRequestError(
        'Timed out fetching a new connection from the connection pool.',
        { code: 'P2024', clientVersion: '5.22.0' }
      )
      expect(isPoolExhaustionError(p2024)).toBe(true)
    })

    it('identifies pg connection acquisition timeouts', () => {
      const timeoutErr = new Error('timeout exceeded when trying to connect')
      expect(isPoolExhaustionError(timeoutErr)).toBe(true)

      const etimedout = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })
      expect(isPoolExhaustionError(etimedout)).toBe(true)
    })

    it('returns false for unrelated query or validation errors', () => {
      const syntaxError = new Error('syntax error at or near SELECT')
      expect(isPoolExhaustionError(syntaxError)).toBe(false)
      expect(isPoolExhaustionError(null)).toBe(false)
      expect(isPoolExhaustionError(undefined)).toBe(false)
    })
  })

  describe('recordPoolExhaustion', () => {
    it('increments db_pool_exhaustion_errors_total metric', async () => {
      const before = await db_pool_exhaustion_errors_total.get()
      const initialVal = before.values[0]?.value ?? 0

      recordPoolExhaustion(new Error('timeout exceeded when trying to connect'), 'test')

      const after = await db_pool_exhaustion_errors_total.get()
      expect(after.values[0].value).toBe(initialVal + 1)
    })
  })

  describe('updatePoolMetrics', () => {
    it('exports in_use, idle, and waiting gauges from pgPool', async () => {
      // Mock counts on pgPool
      vi.spyOn(pgPool, 'totalCount', 'get').mockReturnValue(8)
      vi.spyOn(pgPool, 'idleCount', 'get').mockReturnValue(3)
      vi.spyOn(pgPool, 'waitingCount', 'get').mockReturnValue(2)

      updatePoolMetrics()

      const inUse = await db_pool_connections_in_use.get()
      const idle = await db_pool_connections_idle.get()
      const waiting = await db_pool_connections_waiting.get()

      expect(inUse.values[0].value).toBe(5) // 8 total - 3 idle = 5 in use
      expect(idle.values[0].value).toBe(3)
      expect(waiting.values[0].value).toBe(2)
    })

    it('updates pool metrics during getMetrics() invocation', async () => {
      vi.spyOn(pgPool, 'totalCount', 'get').mockReturnValue(10)
      vi.spyOn(pgPool, 'idleCount', 'get').mockReturnValue(4)
      vi.spyOn(pgPool, 'waitingCount', 'get').mockReturnValue(1)

      const output = await getMetrics()
      expect(output).toMatch(/db_pool_connections_in_use(\{[^}]*\})? 6/)
      expect(output).toMatch(/db_pool_connections_idle(\{[^}]*\})? 4/)
      expect(output).toMatch(/db_pool_connections_waiting(\{[^}]*\})? 1/)
    })
  })

  describe('Fastify error handler on pool exhaustion', () => {
    it('returns 503 DB_POOL_EXHAUSTED and records metric when handler encounters exhaustion', async () => {
      const app: FastifyInstance = Fastify()
      app.setErrorHandler((error, req, reply) => {
        if (isPoolExhaustionError(error)) {
          recordPoolExhaustion(error, `http:${req.method}:${req.url}`)
          return reply.status(503).send({
            error: 'Service Unavailable',
            message: 'Database connection pool exhausted. Please retry shortly.',
            code: 'DB_POOL_EXHAUSTED',
          })
        }
        return reply.send(error)
      })

      app.get('/test-exhaustion', async () => {
        throw new Prisma.PrismaClientKnownRequestError(
          'Timed out fetching a new connection from the connection pool.',
          { code: 'P2024', clientVersion: '5.22.0' }
        )
      })

      await app.ready()

      const res = await app.inject({
        method: 'GET',
        url: '/test-exhaustion',
      })

      expect(res.statusCode).toBe(503)
      const body = res.json()
      expect(body.code).toBe('DB_POOL_EXHAUSTED')
      expect(body.error).toBe('Service Unavailable')

      const metric = await db_pool_exhaustion_errors_total.get()
      expect(metric.values[0].value).toBe(1)

      await app.close()
    })
  })
})
