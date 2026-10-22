/**
 * Route ↔ OpenAPI coverage bookkeeping.
 *
 * `openapi.yaml` is published to GitHub Pages on every push, so it is a public
 * contract. Nothing used to stop it drifting behind the routes Fastify actually
 * registers — it documented seven of roughly thirty. `tests/openapi.test.ts`
 * now boots the app, enumerates every registered route and fails when a route
 * has no matching `openapi.yaml` entry, so the gap cannot silently widen again.
 *
 * That test needs to know which routes are deliberately *not* part of the
 * public contract. Rather than silently skipping them (which is how a public
 * route gets forgotten), every exception is listed in `INTERNAL_ROUTES` below
 * with a reason. Anything not listed there must appear in the spec.
 */

/**
 * Routes that are intentionally excluded from the public OpenAPI contract.
 *
 * Entries are OpenAPI-style paths (path parameters in `{braces}`), not the
 * Fastify `:param` form — see {@link toOpenApiPath}. Adding a route here is a
 * deliberate statement that it is not part of the published API; if you only
 * want to skip documenting something, don't — document it instead.
 */
export const INTERNAL_ROUTES: readonly string[] = [
  // Prometheus scrape endpoint. Infrastructure, not a client-facing API: it
  // speaks the Prometheus text exposition format, not JSON.
  '/metrics',

  // GraphiQL is the browser IDE for /graphql. It returns an HTML document
  // assembled by Mercurius, not data.
  '/graphiql',

  // WebSocket price stream. OpenAPI 3.0 has no way to describe a websocket
  // protocol; the equivalent GraphQL subscription is documented instead.
  '/ws',

  // Operator-only API-key issuance, rotation, and revocation. Authenticated with a shared
  // ADMIN_TOKEN rather than a client API key (see src/api/admin.ts).
  '/admin/keys',
  '/admin/keys/{id}',
  '/admin/keys/{id}/rotate',

  // Operator-only usage/quota reporting for minted keys.
  '/admin/usage',
  '/admin/usage/{keyId}',
  '/admin/webhook-delivery-failures',
] as const

/**
 * Route prefixes that are internal, for paths whose exact set is owned by a
 * dependency rather than by us. Kept separate from `INTERNAL_ROUTES` (which is
 * exact-match) so an accidental broad prefix cannot quietly excuse a real
 * public route: the only entry today is GraphiQL's static assets, registered
 * by Mercurius alongside `/graphiql`.
 */
export const INTERNAL_ROUTE_PREFIXES: readonly string[] = [
  // Mercurius serves /graphiql/main.js, /graphiql/sw.js, /graphiql/config.js
  // and friends from this namespace. They are part of the GraphiQL IDE, which
  // is already allow-listed above.
  '/graphiql/',
] as const

/**
 * Individual operations that cannot be expressed in this spec, as
 * `METHOD /path` pairs.
 *
 * Kept separate from {@link INTERNAL_ROUTES} because the path here *is* public
 * and *is* documented — it is one method on it that OpenAPI cannot describe.
 * Excluding the whole path instead would stop the coverage test noticing if
 * `GET /graphql` were ever dropped from the spec.
 */
export const UNDOCUMENTABLE_OPERATIONS: readonly string[] = [
  // Mercurius registers the HTTP QUERY method on /graphql, from the
  // GraphQL-over-HTTP spec. `query` only became a valid OpenAPI operation key
  // in 3.2 and this document declares 3.0.0, so there is nowhere to put it.
  // `GET /graphql` and `POST /graphql` are documented and carry the same
  // semantics; QUERY differs in being a safe, cacheable method with a body.
  // Remove this entry if the spec is ever raised to 3.2.
  'QUERY /graphql',
] as const

const UNDOCUMENTABLE_OPERATION_SET = new Set<string>(UNDOCUMENTABLE_OPERATIONS)

/**
 * Whether a single operation is one OpenAPI 3.0 cannot express.
 *
 * `method` is matched case-insensitively, since Fastify reports it uppercase
 * and OpenAPI keys it lowercase.
 */
export function isUndocumentableOperation(method: string, openApiPath: string): boolean {
  return UNDOCUMENTABLE_OPERATION_SET.has(`${method.toUpperCase()} ${openApiPath}`)
}

const INTERNAL_ROUTE_SET = new Set<string>(INTERNAL_ROUTES)

/**
 * Rewrites a Fastify route template into its OpenAPI path equivalent:
 * `/price/:assetA/:assetB` → `/price/{assetA}/{assetB}`.
 *
 * Both frameworks use the same path syntax otherwise, so a single substitution
 * of `:name` for `{name}` is all that is needed.
 */
export function toOpenApiPath(fastifyUrl: string): string {
  return fastifyUrl.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

/** Whether a route (in OpenAPI path form) is on the internal allow-list. */
export function isInternalRoute(openApiPath: string): boolean {
  return (
    INTERNAL_ROUTE_SET.has(openApiPath) ||
    INTERNAL_ROUTE_PREFIXES.some(prefix => openApiPath.startsWith(prefix))
  )
}
