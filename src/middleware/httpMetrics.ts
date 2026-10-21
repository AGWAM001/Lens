import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { http_requests_total, http_request_duration_seconds } from '../metrics'

/** Symbol key for the per-request start time, kept off the public request shape. */
const START_TIME = Symbol('lens.httpMetrics.start')

interface TimedRequest extends FastifyRequest {
  [START_TIME]?: bigint
}

/**
 * Routes excluded from HTTP metrics. `/metrics` is scraped on a fixed interval,
 * so counting it would have the scraper continuously inflate the very numbers
 * it is reading — request rate would never fall to zero on an idle service.
 *
 * `/live` and `/ready` are excluded for the same reason with a different
 * poller: a platform probes them on a timer, so counting them would put a floor
 * under the request rate that no amount of real traffic dropping could go
 * below — and a real outage could not move the number it is meant to reveal.
 */
const EXCLUDED_ROUTES = new Set(['/metrics', '/live', '/ready'])

/**
 * Bucket a status code into a class label. Keeping 2xx/4xx/5xx rather than the
 * exact code bounds the series count at (methods x routes x 5) instead of
 * (methods x routes x ~60).
 */
export function statusClass(statusCode: number): string {
  if (statusCode >= 500) return '5xx'
  if (statusCode >= 400) return '4xx'
  if (statusCode >= 300) return '3xx'
  if (statusCode >= 200) return '2xx'
  return '1xx'
}

/**
 * The route-template label for a request.
 *
 * Fastify exposes the matched route on `req.routeOptions.url` — that is the
 * TEMPLATE (`/price/:assetA/:assetB`), which is what we want. `req.url` is the
 * resolved path and must never be used as a label: every distinct asset pair,
 * address or cursor would become its own time series.
 *
 * When nothing matched (404, or a request rejected before routing resolved) we
 * emit the literal `unmatched` rather than the raw path, so a scanner probing
 * a thousand URLs produces one series, not a thousand.
 */
export function routeLabel(req: FastifyRequest): string {
  return req.routeOptions?.url ?? 'unmatched'
}

async function httpMetricsPlugin(app: FastifyInstance) {
  // onRequest is the earliest hook in the lifecycle, so the timer starts before
  // auth, rate limiting and x402 run — their rejections are real latency the
  // caller experienced and belong in the histogram.
  app.addHook('onRequest', async (req: TimedRequest) => {
    req[START_TIME] = process.hrtime.bigint()
  })

  // onResponse fires for EVERY response that is sent, including ones produced
  // by an error handler, by a `reply.send()` inside an onRequest hook (401 from
  // auth, 402 from x402, 429 from the rate limiter) and by the default 404
  // handler. That is why the observation lives here and not in onSend or in a
  // route wrapper — a 500 that escaped the counter is the exact case this
  // exists to catch.
  app.addHook('onResponse', async (req: TimedRequest, reply: FastifyReply) => {
    const route = routeLabel(req)
    if (EXCLUDED_ROUTES.has(route)) return

    const method = req.method
    const code = reply.statusCode

    http_requests_total.inc({ method, route, status_class: statusClass(code) })

    const start = req[START_TIME]
    if (start !== undefined) {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9
      http_request_duration_seconds.observe({ method, route }, seconds)
    }
  })
}

/**
 * Exports `http_requests_total` and `http_request_duration_seconds` on the
 * shared Prometheus registry.
 *
 * Registration order matters: this plugin must be registered BEFORE the x402,
 * auth and rate-limit plugins. All four attach `onRequest` hooks and Fastify
 * runs them in registration order, so registering later would mean a request
 * rejected by auth or x402 short-circuits before the timer starts and goes
 * uncounted — losing exactly the 401/402/429 traffic an operator most wants to
 * see. `onResponse` still fires for those rejections either way; it is the
 * start timestamp that would be missing.
 */
export const registerHttpMetrics = fp(httpMetricsPlugin, { name: 'http-metrics' })
