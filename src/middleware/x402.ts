import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { x402_payments_received_total } from '../metrics'
import { checkQuota, recordUsage, parseCents, getQuotaConfig } from '../x402/metering'
import { X402_NETWORK_LABEL, paymentAddressFor, isX402Configured, getX402ResourceServer } from '../x402/network'
import fp from 'fastify-plugin'
import './network' // declares req.network on the FastifyRequest type

export interface GatedRoute {
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly price: string
  readonly description: string
}

// Routes gated by x402 and their prices, declared in deliberate order
export const GATED_ROUTES: readonly GatedRoute[] = [
  {
    path: '/price',
    method: 'GET',
    price: '$0.10',
    description: 'Unified SDEX+AMM price with VWAP and best route',
  },
  {
    path: '/pools',
    method: 'GET',
    price: '$0.05',
    description: 'AMM liquidity pool reserves and spot prices',
  },
  {
    path: '/candles',
    method: 'GET',
    price: '$0.05',
    description: 'OHLCV candle data for trading charts',
  },
  {
    path: '/graphql',
    method: 'POST',
    price: '$0.10',
    description: 'GraphQL queries for price data and market information',
  },
] as const

/**
 * Checks whether `routedPath` matches `prefix` at a path-segment boundary.
 *
 * Query strings and fragments are stripped so they cannot affect whether a route
 * matches. A path matches at a segment boundary if each segment of the prefix
 * matches the corresponding segment of the path.
 *
 * For example:
 *   - '/price' matches '/price'
 *   - '/price/test' matches '/price'
 *   - '/pricing' does NOT match '/price' (segment 'pricing' !== 'price')
 *   - '/poolsize' does NOT match '/pools' (segment 'poolsize' !== 'pools')
 */
export function matchesPathSegment(routedPath: string, prefix: string): boolean {
  const cleanPath = routedPath.split('?')[0].split('#')[0]
  const cleanPrefix = prefix.split('?')[0].split('#')[0]

  const pathSegments = cleanPath.split('/').filter(Boolean)
  const prefixSegments = cleanPrefix.split('/').filter(Boolean)

  if (pathSegments.length < prefixSegments.length) {
    return false
  }

  return prefixSegments.every((seg, i) => pathSegments[i] === seg)
}

/**
 * Finds the first matching gated route definition for a given path and HTTP method.
 * Matches on the routed path at a path-segment boundary, never on raw URLs with query strings.
 */
export function matchGatedRoute(
  path: string,
  method: string,
  routes: readonly GatedRoute[] = GATED_ROUTES,
): GatedRoute | undefined {
  const upperMethod = method.toUpperCase()
  return routes.find(
    route => route.method.toUpperCase() === upperMethod && matchesPathSegment(path, route.path)
  )
}

/**
 * Fastify plugin that gates matching routes behind x402 USDC micropayments.
 * Only active when ORACLE_PAYMENT_ADDRESS is set in env.
 */
async function x402Plugin(app: FastifyInstance) {
  // Read at plugin init time (not module load) so tests can inject env vars before app.register()
  const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator'

  if (!isX402Configured()) {
    app.log.warn('[oracle] ORACLE_PAYMENT_ADDRESS not set — x402 gating disabled')
    return
  }

  app.log.info('[oracle] x402 payment gating enabled')

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // Gate requests matching declared gated routes at path-segment boundaries
    const routedPath = req.routeOptions?.url ?? req.url
    const matchedRoute = matchGatedRoute(routedPath, req.method)
    if (!matchedRoute) return

    // Falls back to testnet when the network selector plugin isn't
    // registered (e.g. isolated unit tests that build the app directly).
    const network = req.network ?? 'testnet'
    const paymentAddress = paymentAddressFor(network)
    if (!paymentAddress) {
      reply.status(402).send({ error: `x402 payments are not configured for network "${network}"` })
      return
    }

    const { price, description } = matchedRoute
    const paymentHeader = req.headers['x-payment'] as string | undefined

    const requirements = {
      scheme: 'exact' as const,
      price,
      network: X402_NETWORK_LABEL[network],
      payTo: paymentAddress,
    }

    // No payment header — return 402 with requirements
    if (!paymentHeader) {
      reply.status(402).send({
        x402Version: 1,
        accepts: [requirements],
        error: 'Payment required',
        description,
      })
      return
    }

    // Verify the payment with the facilitator
    try {
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())
      } catch {
        payload = JSON.parse(paymentHeader)
      }

      const resourceServer = await getX402ResourceServer(network, FACILITATOR_URL)
      const result = await resourceServer.verify(payload, requirements)
      if (!result.isValid) {
        reply.status(402).send({ error: 'Payment invalid', reason: result.invalidReason })
        return
      }

      // Valid — increment metric
      x402_payments_received_total.inc()

      // Valid — enforce quota if the request carries an API key
      const apiKeyId = (req as any).apiKey?.id as string | undefined
      if (apiKeyId) {
        const quotaOk = await checkQuota(apiKeyId)
        if (!quotaOk.allowed) {
          const config = await getQuotaConfig(apiKeyId)
          if (config.overagePolicy === 'allow_overage') {
            // Record usage and let through (overage billing applies)
            await recordUsage(apiKeyId, parseCents(price))
          } else if (config.overagePolicy === 'charge_402') {
            reply.status(402).send({
              error: 'Quota exceeded — additional payment required',
              policy: 'charge_402',
            })
            return
          } else {
            // default: block
            reply.status(402).send({
              error: 'Quota exceeded',
              policy: 'block',
            })
            return
          }
        } else {
          await recordUsage(apiKeyId, parseCents(price))
        }
      }

      // Valid — settle asynchronously and let the request through
      resourceServer.settle(payload, requirements).catch((err: unknown) => {
        app.log.error({ err }, '[oracle] x402 settle error')
      })
    } catch (err) {
      reply.status(402).send({ error: 'Payment verification failed', reason: (err as Error).message })
    }
  })
}

export const registerX402 = fp(x402Plugin, { name: 'x402' })
