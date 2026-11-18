import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { activeNetwork, type NetworkName } from '../config'

import { apiError } from '../errors'
const VALID_NETWORKS: readonly NetworkName[] = ['testnet', 'mainnet']

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The Stellar network this request targets, resolved from the `network`
     * query param / `x-network` header (see {@link resolveNetworkName}).
     * Defaults to `activeNetwork` when the request specifies nothing.
     */
    network: NetworkName
  }
}

/**
 * Resolves a raw `network` value (query param or header) into a validated
 * {@link NetworkName}. An absent/empty value resolves to `activeNetwork`
 * (this deployment's configured default) rather than being an error — only
 * an explicit, unrecognised value is rejected.
 */
export function resolveNetworkName(
  raw: string | undefined | null
): { ok: true; network: NetworkName } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, network: activeNetwork }
  const lower = raw.trim().toLowerCase()
  if ((VALID_NETWORKS as string[]).includes(lower)) {
    return { ok: true, network: lower as NetworkName }
  }
  return {
    ok: false,
    error: `Invalid network "${raw}" — expected one of: ${VALID_NETWORKS.join(', ')}`,
  }
}

function rawNetworkFromRequest(req: FastifyRequest): string | undefined {
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.network
  if (typeof fromQuery === 'string') return fromQuery

  const fromHeader = req.headers['x-network']
  if (typeof fromHeader === 'string') return fromHeader

  return undefined
}

/**
 * Fastify plugin that resolves the per-request Stellar network from a
 * `?network=` query param or `x-network` header, validates it, and attaches
 * it to `req.network`. An unrecognised value gets a 400 before any route
 * handler or downstream middleware (x402, WebSocket auth) runs.
 *
 * Must be registered early (`onRequest`) so `req.network` is populated
 * before `middleware/x402.ts`'s `preHandler` hook and any route handler.
 */
async function networkSelectorPlugin(app: FastifyInstance) {
  app.decorateRequest('network', activeNetwork)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const resolved = resolveNetworkName(rawNetworkFromRequest(req))
    if (!resolved.ok) {
      reply.status(400).send(apiError('bad_network', resolved.error))
      return
    }
    req.network = resolved.network
  })
}

export const registerNetworkSelector = fp(networkSelectorPlugin, { name: 'network-selector' })
