/**
 * `/live` and `/ready` — the two health probes a platform needs.
 *
 * `/status` answers a different question and does not substitute for either:
 * it reads `indexer_state`, so it fails when the database is down, and it says
 * nothing about whether this process has finished booting. A platform needs to
 * distinguish "kill and restart this one" from "stop sending traffic here".
 *
 * Both are public and allow-listed from rate limiting, like `/status`: they are
 * polled by infrastructure, often from several addresses at once, and a 429
 * during an incident would remove the instance from rotation precisely when its
 * health matters most. Both are also excluded from HTTP metrics — a fixed-
 * interval poller would otherwise inflate the very request-rate numbers it is
 * reading (see EXCLUDED_ROUTES in src/middleware/httpMetrics.ts).
 */
import type { FastifyInstance } from 'fastify'
import { checkReadiness } from '../health'
import { liveResponseSchema, readyResponseSchema } from '../api/schemas'

export async function registerHealthRoutes(app: FastifyInstance) {
  /**
   * `GET /live` — is this process wedged?
   *
   * No dependency checks, deliberately. A process that cannot reach Postgres is
   * still a perfectly good process that should keep running and recover when
   * the database comes back; failing liveness here would have the orchestrator
   * restart every instance during a database outage.
   *
   * Answering at all *is* the liveness signal — the handler runs on the event
   * loop, so if the loop is turning this returns. `uptimeSeconds` is here so an
   * operator watching a restart loop can tell restarts apart from a stuck
   * process at a glance.
   */
  app.get(
    '/live',
    { config: { public: true }, schema: { response: { 200: liveResponseSchema } } },
    async () => ({
      ok: true as const,
      uptimeSeconds: Math.floor(process.uptime()),
    }),
  )

  /**
   * `GET /ready` — should this process receive traffic?
   *
   * Unhealthy (503) until the boot sequence in `main()` finishes, and while any
   * checked dependency is unreachable. `/live` stays healthy throughout: a
   * starting instance needs to be *held out of rotation*, not killed.
   */
  app.get(
    '/ready',
    { config: { public: true }, schema: { response: { 200: readyResponseSchema, 503: readyResponseSchema } } },
    async (_req, reply) => {
      const report = await checkReadiness()
      if (!report.ok) reply.status(503)
      return {
        ok: report.ok,
        booted: report.booted,
        checks: report.checks,
        checkedAt: report.checkedAt,
      }
    },
  )
}