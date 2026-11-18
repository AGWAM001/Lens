import type { FastifyInstance } from 'fastify'
import {
  isInternalRoute,
  isVersionedPath,
  toBarePath,
  toOpenApiPath,
  toVersionedPath,
} from '../openapi/coverage'

/**
 * API surfacing policy, in code.
 *
 * Lens mounts every route once, at its bare path, and serves it in two places:
 *
 *   - `/v1/<path>` — the canonical, versioned path. `openapi.yaml` documents
 *     this form and new clients should use it.
 *   - `/<path>` — an unversioned alias kept so callers integrated before `/v1`
 *     existed keep working. It is deprecated and every response carries the
 *     warning headers described in `docs/api-versioning.md`.
 *
 * Rather than registering each route twice (which would double the surface and,
 * more importantly, let the two copies drift in middleware behaviour — x402
 * gating, auth and rate limits all key off the *routed* path), the version
 * segment is stripped before Fastify routes the request. Both URLs therefore
 * resolve to the exact same route definition and answer identically by
 * construction.
 *
 * See `docs/api-versioning.md` for the deprecation window and warning contract.
 */

/** Splits a URL into its path and its query string (everything from the first `?`). */
function splitPath(url: string): { path: string; query: string } {
  const questionMark = url.indexOf('?')
  if (questionMark === -1) return { path: url, query: '' }
  return { path: url.slice(0, questionMark), query: url.slice(questionMark) }
}

/**
 * Fastify `rewriteUrl`: resolves the versioned and unversioned forms onto the
 * single bare route that is actually registered.
 *
 * `/v1/price/XLM/USDC?network=mainnet` → `/price/XLM/USDC?network=mainnet`
 *
 * A request that already used the bare path is returned unchanged; the caller
 * who used the deprecated alias is identified later from the original URL that
 * Fastify records (`req.raw.originalUrl`) before calling this function.
 */
export function rewriteVersionedApiUrl(req: { url?: string }): string {
  const url = req.url ?? '/'
  const { path, query } = splitPath(url)
  if (!isVersionedPath(path)) return url
  return `${toBarePath(path)}${query}`
}

/**
 * Registers the deprecation warning for the unversioned aliases.
 *
 * Every request that arrived without the `/v1` prefix and resolved to a public
 * (non-internal) route gets:
 *
 *   - `Deprecation: true` — RFC 8594 signal that this resource is deprecated.
 *   - `Link: </v1/...>; rel="successor-version"` — the versioned path to use
 *     instead, for the exact resource the caller asked for.
 *
 * The headers are advisory: the alias keeps answering normally, so a caller
 * that ignores them is not broken. Operator-only and non-HTTP routes (`/metrics`,
 * `/ws`, `/admin/*`, `/graphiql*`) are excluded — they are not part of the
 * versioned public contract and were never intended to move.
 */
export function registerApiVersioning(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    // Fastify records the caller's original URL on the raw request before the
    // rewriteUrl hook (fastify.js `preRouting`), so this is the un-rewritten
    // path even though `req.url` has had the `/v1` segment stripped.
    const rawUrl = (req.raw as { originalUrl?: string } | undefined)?.originalUrl
    const original = rawUrl ?? req.url
    const { path } = splitPath(original)
    if (isVersionedPath(path)) return

    const routedPath = req.routeOptions?.url
    if (!routedPath || isInternalRoute(toOpenApiPath(routedPath))) return

    reply.header('Deprecation', 'true')
    reply.header('Link', `<${toVersionedPath(path)}>; rel="successor-version"`)
  })
}
