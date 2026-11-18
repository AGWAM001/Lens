import type { FastifyRequest } from 'fastify'
import type { FastifyCorsOptions } from '@fastify/cors'

/**
 * Route classification categories for CORS and security boundary enforcement.
 *
 * - `public`: Open read-only endpoints (prices, market data, health, discovery).
 *   CORS is open to all origins, credentials: false.
 * - `credentialed`: Endpoints requiring caller identity (API keys, bearer tokens).
 *   CORS is restricted to explicitly allowed origins, credentials: true.
 * - `admin`: Operator-only management routes protected by ADMIN_TOKEN.
 *   CORS is closed to cross-origin browsers by default.
 */
export type RouteClass = 'public' | 'credentialed' | 'admin'

/**
 * Note on route inventories: there is deliberately no hard-coded list of admin,
 * credentialed or public paths here. {@link classifyRoute} decides from the path
 * prefix and the request's own credential headers, so a route added later is
 * classified without anyone remembering to append it to an array. A parallel
 * list that nothing enforces is exactly how the README's venue table went stale.
 */

export interface CorsConfig {
  /**
   * Allowed origins for credentialed routes.
   * Can be configured via CORS_ALLOWED_ORIGINS environment variable (comma-separated).
   */
  credentialedAllowedOrigins?: string[]
  /**
   * Allowed origins for admin routes.
   * Defaults to empty (closed). Can be configured via CORS_ADMIN_ALLOWED_ORIGINS.
   */
  adminAllowedOrigins?: string[]
  /**
   * Optional blocked origins for public routes.
   * Can be configured via CORS_PUBLIC_BLOCKED_ORIGINS.
   */
  publicBlockedOrigins?: string[]
}

/**
 * Parses comma-separated origin strings from an environment variable.
 */
export function parseOrigins(envVal: string | undefined): string[] {
  if (!envVal || typeof envVal !== 'string') return []
  return envVal
    .split(',')
    .map(o => o.trim())
    .filter(o => o.length > 0)
}

/**
 * Resolves the configured allowed origins for credentialed routes.
 */
export function getCredentialedAllowedOrigins(config?: CorsConfig): string[] {
  if (config?.credentialedAllowedOrigins !== undefined) {
    return config.credentialedAllowedOrigins
  }
  return parseOrigins(process.env.CORS_ALLOWED_ORIGINS)
}

/**
 * Resolves the configured allowed origins for admin routes.
 */
export function getAdminAllowedOrigins(config?: CorsConfig): string[] {
  if (config?.adminAllowedOrigins !== undefined) {
    return config.adminAllowedOrigins
  }
  return parseOrigins(process.env.CORS_ADMIN_ALLOWED_ORIGINS)
}

/**
 * Resolves the configured blocked origins for public routes.
 */
export function getPublicBlockedOrigins(config?: CorsConfig): string[] {
  if (config?.publicBlockedOrigins !== undefined) {
    return config.publicBlockedOrigins
  }
  return parseOrigins(process.env.CORS_PUBLIC_BLOCKED_ORIGINS)
}

/**
 * Whether an origin matches any entry in an allow-list.
 *
 * `allowWildcard` is false for the credentialed and admin classes. A bare `*`
 * there would echo whatever `Origin` the request carried back as
 * `Access-Control-Allow-Origin` alongside `credentials: true` — a policy no
 * operator means to write, because it lets any site drive an authenticated
 * cross-origin call with the browser's credentials attached. Public reads may
 * use it: they are open to every origin anyway and send no credentials.
 *
 * A wildcard entry must also match the scheme. `https://*.example.com` had its
 * scheme stripped before comparison, so it matched `http://evil.example.com`
 * too — an https-only allow-list that silently permitted plaintext.
 */
export function isOriginAllowed(
  origin: string,
  allowedOrigins: readonly string[],
  allowWildcard = true
): boolean {
  if (allowedOrigins.length === 0) return false

  let requested: URL
  try {
    requested = new URL(origin.trim())
  } catch {
    return false
  }
  const normalizedOrigin = origin.trim().toLowerCase()
  const requestedHost = requested.hostname.toLowerCase()
  const requestedScheme = requested.protocol.toLowerCase()

  return allowedOrigins.some(allowed => {
    const norm = allowed.trim().toLowerCase()
    if (norm === '*') return allowWildcard
    if (norm === normalizedOrigin) return true

    const schemed = /^(https?:)\/\/\*\.(.+)$/.exec(norm)
    if (schemed) {
      const [, scheme, domainPart] = schemed
      if (scheme !== requestedScheme) return false
      return requestedHost === domainPart || requestedHost.endsWith(`.${domainPart}`)
    }

    // A scheme-less `*.example.com` matches either scheme, which is what an
    // operator who wrote no scheme asked for.
    if (norm.startsWith('*.')) {
      const domainPart = norm.slice(2)
      return requestedHost === domainPart || requestedHost.endsWith(`.${domainPart}`)
    }

    return false
  })
}

/**
 * Classifies a request path and headers into one of three security classes:
 * - `admin`: /admin/* routes
 * - `credentialed`: /usage/me or requests carrying Authorization / Cookie credentials
 * - `public`: unauthenticated reads and open endpoints
 */
export function classifyRoute(
  path: string,
  headers?: Record<string, string | string[] | undefined>
): RouteClass {
  // Decode before testing the prefix. The router percent-decodes a path before
  // matching, so `/%61dmin/keys` reaches the admin handler while a raw-string
  // test for '/admin' says it is something else — which would hand an admin
  // route the wide-open public policy. Repeated until stable so a double
  // encoding (`%2561dmin`) cannot survive a single pass; a malformed escape
  // leaves the path as it was rather than throwing.
  let decoded = (path || '/').split('?')[0]
  for (let i = 0; i < 3; i++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      break
    }
    if (next === decoded) break
    decoded = next
  }
  const normalizedPath = decoded.replace(/\/+$/, '') || '/'

  // 1. Admin endpoints
  if (normalizedPath === '/admin' || normalizedPath.startsWith('/admin/')) {
    return 'admin'
  }

  // 2. Credentialed endpoints
  if (normalizedPath === '/usage/me' || normalizedPath.startsWith('/usage/')) {
    return 'credentialed'
  }

  // Requests carrying credentials in headers
  if (headers) {
    const authHeader = headers['authorization']
    const cookieHeader = headers['cookie']
    if (authHeader || cookieHeader) {
      return 'credentialed'
    }

    const requestHeaders = headers['access-control-request-headers']
    if (typeof requestHeaders === 'string') {
      const lower = requestHeaders.toLowerCase()
      if (lower.includes('authorization') || lower.includes('cookie')) {
        return 'credentialed'
      }
    }
  }

  // 3. Public endpoints
  return 'public'
}

/**
 * Evaluates the CORS configuration for an incoming request based on its classification.
 */
export function getCorsOptionsForRequest(
  req: FastifyRequest,
  config?: CorsConfig
): FastifyCorsOptions {
  const origin = req.headers.origin
  const routeClass = classifyRoute(req.url, req.headers)

  if (routeClass === 'admin') {
    // Admin routes: closed by default unless explicitly configured
    const adminAllowed = getAdminAllowedOrigins(config)
    if (origin && adminAllowed.length > 0 && isOriginAllowed(origin, adminAllowed, false)) {
      return {
        origin: origin,
        credentials: false,
        methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-Admin-Token', 'Authorization'],
      }
    }
    return {
      origin: false,
      credentials: false,
    }
  }

  if (routeClass === 'credentialed') {
    // Credentialed routes: restricted to allowed origins
    const allowed = getCredentialedAllowedOrigins(config)
    if (origin && isOriginAllowed(origin, allowed, false)) {
      return {
        origin: origin,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'X-Admin-Token',
          'x-network',
          'X-PAYMENT',
        ],
      }
    }
    return {
      origin: false,
      credentials: false,
    }
  }

  // Public reads: open to any origin
  const blocked = getPublicBlockedOrigins(config)
  if (origin && blocked.length > 0 && isOriginAllowed(origin, blocked)) {
    return {
      origin: false,
      credentials: false,
    }
  }

  return {
    origin: true,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'x-network',
      'X-PAYMENT',
    ],
  }
}

/**
 * Creates the delegator function for `@fastify/cors`.
 */
export function createCorsDelegator(config?: CorsConfig) {
  return async (req: FastifyRequest): Promise<FastifyCorsOptions> => {
    const options = await getCorsOptionsForRequest(req, config)
    return {
      ...options,
      // `Deprecation` and `Link` are set on the unversioned aliases (see
      // src/api/versioning.ts). A custom response header is hidden from a
      // cross-origin reader unless it is exposed, so without this a browser
      // client would never see the deprecation warning. Added here rather than
      // in each per-route branch so no policy can forget it; on a denied
      // origin it is inert, because the response carries no allow-origin.
      exposedHeaders: ['Deprecation', 'Link'],
    }
  }
}
