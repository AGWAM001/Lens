import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

export const INTERNAL_ERROR_CODE = 'internal_error'
export const INTERNAL_ERROR_MESSAGE = 'An internal server error occurred.'

export interface InternalErrorResponse {
  code: typeof INTERNAL_ERROR_CODE
  message: typeof INTERNAL_ERROR_MESSAGE
  correlationId: string
}

export function getCorrelationId(req?: FastifyRequest): string {
  const headerId = req?.headers?.['x-correlation-id'] || req?.headers?.['x-request-id']
  if (typeof headerId === 'string' && headerId.length > 0) {
    return headerId
  }
  if (typeof req?.id === 'string' && req.id.length > 0) {
    return req.id
  }
  return randomUUID()
}

export function createInternalErrorBody(correlationId: string): InternalErrorResponse {
  return {
    code: INTERNAL_ERROR_CODE,
    message: INTERNAL_ERROR_MESSAGE,
    correlationId,
  }
}

export function sendInternalError(
  reply: FastifyReply,
  req: FastifyRequest,
  err: unknown,
  logMessage = 'Internal server error',
): FastifyReply {
  const correlationId = getCorrelationId(req)
  const log = req?.log ?? reply?.log
  if (log && typeof log.error === 'function') {
    log.error({ err, correlationId }, logMessage)
  }

  return reply.status(500).send(createInternalErrorBody(correlationId))
}

/**
 * The single, enumerated set of stable machine-readable error codes.
 *
 * Every JSON error response the API emits carries a `code` beside its existing
 * `error` string. `error` stays human-readable and may be reworded at any time;
 * `code` is a contract a client branches on. Codes are declared here (and
 * mirrored in `openapi.yaml`) rather than invented at each call site, so the set
 * can be audited in one place and a typo fails to compile instead of shipping.
 *
 * Lowercase snake_case is deliberate: it matches the codes the Bazaar and x402
 * surfaces already expose (`rate_limited`, `unexpected_settle_error`, ...).
 */
export const ERROR_CODES = {
  /** A required query/body/path parameter was not supplied. */
  missing_parameter: 'missing_parameter',
  /** A supplied parameter was present but malformed, out of range, or unknown. */
  invalid_parameter: 'invalid_parameter',
  /** `network` was not one of the supported networks (testnet, mainnet). */
  bad_network: 'bad_network',
  /** An interval was not one of the supported values for the endpoint. */
  bad_interval: 'bad_interval',
  /** A window was not one of the supported values for the endpoint. */
  bad_window: 'bad_window',
  /** The request named something the API recognises but deliberately does not serve. */
  unsupported: 'unsupported',
  /** No price/data exists for the requested pair or asset. */
  unknown_pair: 'unknown_pair',
  /** The requested pair is not in the set this instance watches. */
  unwatched_pair: 'unwatched_pair',
  /** The pair is already being watched (conflict). */
  pair_already_watched: 'pair_already_watched',
  /** Credentials were missing or invalid. */
  unauthorized: 'unauthorized',
  /** A referenced resource (e.g. an API key) does not exist. */
  not_found: 'not_found',
  /** A dependency the endpoint relies on (database, venue, oracle) was unreachable. */
  upstream_unavailable: 'upstream_unavailable',
  /** An unexpected server-side fault. */
  internal_error: 'internal_error',
  /** The request was throttled by a quota or rate limit. */
  rate_limited: 'rate_limited',
  /** Payment is required before the resource can be served. */
  payment_required: 'payment_required',
  /** The supplied payment was rejected. */
  payment_invalid: 'payment_invalid',
  /** The payment could not be verified because verification itself failed. */
  payment_verification_failed: 'payment_verification_failed',
  /** The caller's quota is exhausted and further payment is required. */
  quota_exceeded: 'quota_exceeded',

  // Codes routes already emitted before this set existed. Clients may branch on
  // them, so they are enumerated as-is rather than renamed.
  /** Admin surface is disabled because ADMIN_TOKEN is not configured. */
  admin_not_configured: 'admin_not_configured',
  /** The X-Admin-Token header was missing or wrong. */
  admin_unauthorized: 'admin_unauthorized',
  /** API-key auth: no Authorization header. */
  missing: 'missing',
  /** API-key auth: the Authorization header was not a Bearer token. */
  malformed: 'malformed',
  /** API-key auth: the key does not exist. */
  unknown: 'unknown',
  /** API-key auth: the key has been revoked. */
  revoked: 'revoked',
  /** API-key auth: the key has expired. */
  expired: 'expired',
  /** API-key auth: the key lacks the scope the route requires. */
  insufficient_scope: 'insufficient_scope',
  /** The discovery search database query failed. */
  discovery_database_unavailable: 'discovery_database_unavailable',
  /** Zod validation failure from `formatValidationError`. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** A parameter the endpoint recognises but does not support (e.g. screener market cap). */
  UNSUPPORTED_PARAMETER: 'UNSUPPORTED_PARAMETER',
  /** /premium: `network` was not testnet or mainnet. */
  INVALID_NETWORK: 'INVALID_NETWORK',
  /** /premium: a price input was too old to use. */
  STALE_DATA: 'STALE_DATA',
  /** /premium: the on-chain price was not positive. */
  INVALID_PRICE: 'INVALID_PRICE',
  /** /premium: an unexpected server-side fault. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** The database connection pool was exhausted. */
  DB_POOL_EXHAUSTED: 'DB_POOL_EXHAUSTED',
} as const

/** A member of {@link ERROR_CODES}. */
export type ErrorCode = keyof typeof ERROR_CODES

/** Every code as a plain string array, for validation and spec generation. */
export const ERROR_CODE_VALUES: readonly ErrorCode[] = Object.values(ERROR_CODES)

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODE_VALUES)

/** Narrows an unknown value to an {@link ErrorCode}. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value)
}

/** The JSON body of every non-2xx error response. */
export interface ApiError {
  /** Human-readable message. Do not branch on this — branch on `code`. */
  error: string
  /** Stable code from {@link ERROR_CODES}. */
  code: ErrorCode
}

/**
 * Builds an error body from the enumerated set.
 *
 * Typing `code` as {@link ErrorCode} is what stops a route inventing its own
 * code: an unknown value is a compile error, not a runtime surprise.
 */
export function apiError(code: ErrorCode, message: string): ApiError {
  return { error: message, code }
}
