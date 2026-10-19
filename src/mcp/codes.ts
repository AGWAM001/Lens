export const MCP_ERROR_CODES = {
  ERR_PAYMENT_REJECTED: 'ERR_PAYMENT_REJECTED',
  ERR_INSUFFICIENT_BALANCE: 'ERR_INSUFFICIENT_BALANCE',
  ERR_EXPIRED_AUTHORISATION: 'ERR_EXPIRED_AUTHORISATION',
  ERR_MISSING_TRUSTLINE: 'ERR_MISSING_TRUSTLINE',
  ERR_SERVICE_UNREACHABLE: 'ERR_SERVICE_UNREACHABLE',
  ERR_NO_RESULTS: 'ERR_NO_RESULTS',
  ERR_BAD_REQUEST: 'ERR_BAD_REQUEST',
  ERR_INVALID_ASSET: 'ERR_INVALID_ASSET',
  ERR_PAIR_NOT_WATCHED: 'ERR_PAIR_NOT_WATCHED',
  ERR_ASSET_ISSUER_MISMATCH: 'ERR_ASSET_ISSUER_MISMATCH',
  // Refused before any request was made, for two different reasons:
  //   ERR_URL_BLOCKED      the target resolves somewhere we will never fetch
  //                        (private, loopback, link-local, metadata) — #488
  //   ERR_HOST_NOT_ALLOWED the host is reachable but is not on the operator's
  //                        paid_call allow-list — #487
  ERR_URL_BLOCKED: 'ERR_URL_BLOCKED',
  ERR_HOST_NOT_ALLOWED: 'ERR_HOST_NOT_ALLOWED',
  ERR_INTERNAL_FAILURE: 'ERR_INTERNAL_FAILURE'
} as const;

export type McpErrorCode = keyof typeof MCP_ERROR_CODES;

export interface McpErrorResponse {
  isError: true;
  code: McpErrorCode;
  reason: string;
}

/**
 * How a given error was classified. This is exposed so callers (and tests)
 * can tell structured-signal classification apart from the best-effort text
 * fallback. The text fallback is the only path that depends on library
 * message wording, so it is marked explicitly.
 */
export type McpErrorClassification =
  | { method: 'structured'; signal: string }
  | { method: 'text-fallback'; signal: string }
  | { method: 'unclassified' };