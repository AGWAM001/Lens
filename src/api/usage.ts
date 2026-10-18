import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { getUsageSummary, getAllUsageSummaries } from '../x402/metering'
import { admin_auth_failures_total, api_key_auth_failures_total } from '../metrics'

function isAdminAuthorized(req: FastifyRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  const supplied =
    (req.headers['x-admin-token'] as string | undefined) ??
    req.headers['authorization']?.replace(/^Bearer\s+/i, '')
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(adminToken)
  // Constant-time comparison (timingSafeEqual requires equal-length buffers).
  return a.length === b.length && require('crypto').timingSafeEqual(a, b)
}

export async function registerUsageRoutes(app: FastifyInstance) {
  app.get<{ Params: { keyId: string } }>(
    '/admin/usage/:keyId',
    { config: { public: true } },
    async (req, reply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }
      const { keyId } = req.params
      const summary = await getUsageSummary(keyId)
      return reply.send(summary)
    }
  )

  app.get(
    '/admin/usage',
    { config: { public: true } },
    async (req, reply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }
      const summaries = await getAllUsageSummaries()
      return reply.send({ keys: summaries })
    }
  )

  app.get(
    '/usage/me',
    async (req, reply) => {
      const apiKey = (req as any).apiKey as { id: string } | undefined
      if (!apiKey) {
        api_key_auth_failures_total.inc({ reason: 'missing' })
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'missing',
          message: 'Missing API key. Provide an Authorization: Bearer <key> header.',
        })
      }
      const summary = await getUsageSummary(apiKey.id)
      return reply.send(summary)
    }
  )
}
