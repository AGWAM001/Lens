import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { global_shed_requests_total } from '../metrics'

const WINDOW_MS = 60_000
const EXPENSIVE_ROUTE_PREFIXES = new Set([
  'graphql',
  'price',
  'prices',
  'route',
  'pools',
  'candles',
  'history',
  'screener',
  'benchmark',
  'oracle',
  'compare',
  'basket',
  'venues',
  'spreads',
  'volumes',
  'book',
  'verify',
  'settle',
])
const HEALTH_PATHS = new Set(['/status', '/live', '/ready'])

export function parseGlobalRateLimit(value: string | undefined): number {
  if (value === undefined) return 1000
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('GLOBAL_RATE_LIMIT_MAX must be a positive integer')
  }
  const max = Number(value)
  if (!Number.isSafeInteger(max)) {
    throw new Error('GLOBAL_RATE_LIMIT_MAX must be a positive safe integer')
  }
  return max
}

export function registerGlobalRateLimit(app: FastifyInstance, max: number): void {
  const acceptedAt: number[] = []
  const expensiveThreshold = Math.max(1, Math.ceil(max * 0.8))

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions?.url ?? req.url.split('?')[0]
    if (HEALTH_PATHS.has(route)) return

    const now = Date.now()
    while (acceptedAt.length > 0 && acceptedAt[0] <= now - WINDOW_MS) {
      acceptedAt.shift()
    }

    const expensive = EXPENSIVE_ROUTE_PREFIXES.has(route.split('/')[1])
    if (acceptedAt.length >= max || (expensive && acceptedAt.length >= expensiveThreshold)) {
      global_shed_requests_total.inc()
      const retryAfter = Math.max(1, Math.ceil((acceptedAt[0] + WINDOW_MS - now) / 1000))
      reply.header('Retry-After', String(retryAfter))
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'GLOBAL_RATE_LIMITED',
        message: 'The service request ceiling has been reached. Retry later.',
        retryAfter,
      })
    }

    acceptedAt.push(now)
  })
}
