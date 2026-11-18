import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { createHash } from 'node:crypto'

/**
 * Route patterns that emit strong ETags for conditional polling (issue #267).
 *
 * List routes:
 * - /pairs: watched trading pairs and latest prints; changes rarely.
 * - /pools: registered pools and reserves.
 * - /screener: market-wide pair metrics.
 *
 * Historical routes:
 * - /price/:assetA/:assetB/history: aggregated historical buckets.
 * - /prices/history: historical prices snapshot/CSV export.
 * - /candles/:assetA/:assetB: OHLCV candle windows.
 * - /price/twap/:assetA/:assetB: time-weighted average price over a window.
 * - /price/vwap/:assetA/:assetB: volume-weighted average price over a window.
 */
export const LIST_AND_HISTORICAL_ROUTES = new Set([
  '/pairs',
  '/pools',
  '/screener',
  '/price/:assetA/:assetB/history',
  '/prices/history',
  '/candles/:assetA/:assetB',
  '/price/twap/:assetA/:assetB',
  '/price/vwap/:assetA/:assetB',
])

export interface ETagRouteConfig {
  etag?: boolean
}

/**
 * Pure predicate: should this route emit an ETag?
 */
export function isETagEligible(
  method: string,
  statusCode: number,
  routePath: string | undefined,
  config?: ETagRouteConfig
): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  if (statusCode !== 200) return false
  if (config?.etag === false) return false
  if (config?.etag === true) return true
  if (!routePath) return false

  const normalized = routePath.endsWith('/') && routePath.length > 1 ? routePath.slice(0, -1) : routePath
  if (LIST_AND_HISTORICAL_ROUTES.has(normalized)) return true
  if (normalized.endsWith('/history')) return true
  if (normalized.startsWith('/candles/')) return true

  return false
}

/**
 * Generates a strong ETag from response content bytes.
 *
 * Formatted as a quoted SHA-256 hexadecimal digest: `"<hash>"`.
 * Pure function of content bytes, completely independent of the clock.
 */
export function generateETag(content: string | Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex')
  return `"${hash}"`
}

/**
 * Checks whether an incoming `If-None-Match` header matches the entity tag.
 *
 * Supports wildcard `*`, single or comma-separated quoted tags, and weak comparison
 * per RFC 7232 section 3.2.
 */
export function matchesIfNoneMatch(ifNoneMatchHeader: string | undefined, etag: string): boolean {
  if (!ifNoneMatchHeader) return false
  const trimmed = ifNoneMatchHeader.trim()
  if (trimmed === '*') return true

  const unquotedEtag = etag.replace(/^W\//, '').replace(/^"|"$/g, '')
  const candidates = trimmed.split(',').map((s) => s.trim())

  for (const candidate of candidates) {
    if (candidate === '*') return true
    if (candidate === etag) return true
    const unquotedCandidate = candidate.replace(/^W\//, '').replace(/^"|"$/g, '')
    if (unquotedCandidate === unquotedEtag) return true
  }

  return false
}

async function etagPlugin(app: FastifyInstance) {
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const routePath = req.routeOptions?.url
    const config = req.routeOptions?.config as ETagRouteConfig | undefined

    if (!isETagEligible(req.method, reply.statusCode, routePath, config)) {
      return payload
    }

    // Only string and Buffer payloads can be deterministically hashed
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
      return payload
    }

    const etag = generateETag(payload)
    reply.header('ETag', etag)

    // Pair with Cache-Control: if no Cache-Control header has been set, ensure
    // clients and proxies know they can store the response and must revalidate.
    if (!reply.getHeader('cache-control')) {
      reply.header('Cache-Control', 'public, no-cache')
    }

    const ifNoneMatch = req.headers['if-none-match']
    if (matchesIfNoneMatch(ifNoneMatch, etag)) {
      reply.code(304)
      reply.removeHeader('content-length')
      return ''
    }

    return payload
  })
}

export const registerETag = fp(etagPlugin, { name: 'etag' })
