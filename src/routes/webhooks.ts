import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { resolveNetworkName } from '../middleware/network'

function isValidHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

export async function registerWebhookRoutes(app: FastifyInstance) {
  // POST /webhooks — subscribe to a price threshold event
  app.post<{
    Body: { url: string; assetA: string; assetB: string; threshold: number; direction: string; network?: string }
  }>('/webhooks', async (req, reply) => {
    const { url, assetA, assetB, threshold, direction, network: bodyNetwork } = req.body ?? {}

    if (!url || !isValidHttpsUrl(url)) {
      return reply.status(400).send({ error: 'url must be a valid HTTPS URL' })
    }
    if (!assetA || typeof assetA !== 'string') {
      return reply.status(400).send({ error: 'assetA is required' })
    }
    if (!assetB || typeof assetB !== 'string') {
      return reply.status(400).send({ error: 'assetB is required' })
    }
    if (typeof threshold !== 'number' || isNaN(threshold)) {
      return reply.status(400).send({ error: 'threshold must be a number' })
    }
    if (direction !== 'above' && direction !== 'below') {
      return reply.status(400).send({ error: 'direction must be "above" or "below"' })
    }

    let targetNetwork: NetworkName = req.network ?? activeNetwork
    if (bodyNetwork !== undefined) {
      const resolved = resolveNetworkName(bodyNetwork)
      if (!resolved.ok) {
        return reply.status(400).send({ error: resolved.error })
      }
      targetNetwork = resolved.network
    }

    const secret = randomBytes(32).toString('hex')

    const webhook = await prisma.webhook.create({
      data: {
        network: targetNetwork,
        url,
        assetA: assetA.toUpperCase(),
        assetB: assetB.toUpperCase(),
        threshold,
        direction,
        secret,
      },
    })

    return reply.status(201).send({ id: webhook.id, secret: webhook.secret })
  })

  // DELETE /webhooks/:id — unsubscribe
  app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req, reply) => {
    const { id } = req.params

    try {
      await prisma.webhook.delete({ where: { id } })
    } catch (err: any) {
      // P2025 = record not found — idempotent, treat as success
      if (err?.code !== 'P2025') throw err
    }

    return reply.status(204).send()
  })
}
