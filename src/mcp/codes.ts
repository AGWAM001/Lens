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

/**
 * Classify a paid-call error by structured signals first, falling back to
 * best-effort text matching only when nothing structured is available.
 *
 * Ordering is deliberate:
 *   1. structured  — Horizon `result_codes` / explicit error codes win outright
 *   2. text-fallback — only when no structured signal exists
 *   3. unclassified — original message preserved
 */
export function classifyPaidCallError(
  err: unknown
): { code: McpErrorCode; reason: string; classification: McpErrorClassification } {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);

  const structured = extractStructuredSignal(err);
  if (structured) {
    return {
      code: structured.code,
      reason: structured.signal,
      classification: { method: 'structured', signal: structured.signal }
    };
  }

  const text = classifyByText(message);
  if (text) {
    return {
      code: text.code,
      reason: message,
      classification: { method: 'text-fallback', signal: text.signal }
    };
  }

  return {
    code: MCP_ERROR_CODES.ERR_INTERNAL_FAILURE,
    reason: message,
    classification: { method: 'unclassified' }
  };
}

function extractStructuredSignal(
  err: unknown
): { code: McpErrorCode; signal: string } | null {
  if (!err || typeof err !== 'object') return null;
  const resultCodes = (err as { result_codes?: unknown }).result_codes;
  if (!resultCodes || typeof resultCodes !== 'object') return null;

  const transaction = (resultCodes as { transaction?: unknown }).transaction;
  const operations = (resultCodes as { operations?: unknown }).operations;
  const opList = Array.isArray(operations) ? operations.map(String) : [];

  if (opList.includes('op_underfunded')) {
    return {
      code: MCP_ERROR_CODES.ERR_INSUFFICIENT_BALANCE,
      signal: 'op_underfunded'
    };
  }
  if (opList.includes('op_no_trust')) {
    return {
      code: MCP_ERROR_CODES.ERR_MISSING_TRUSTLINE,
      signal: 'op_no_trust'
    };
  }
  if (opList.includes('op_src_no_trust')) {
    return {
      code: MCP_ERROR_CODES.ERR_MISSING_TRUSTLINE,
      signal: 'op_src_no_trust'
    };
  }
  if (opList.includes('op_not_authorized')) {
    return {
      code: MCP_ERROR_CODES.ERR_EXPIRED_AUTHORISATION,
      signal: 'op_not_authorized'
    };
  }
  if (opList.includes('op_malformed')) {
    return {
      code: MCP_ERROR_CODES.ERR_BAD_REQUEST,
      signal: 'op_malformed'
    };
  }
  if (typeof transaction === 'string' && transaction.length > 0) {
    return {
      code: MCP_ERROR_CODES.ERR_PAYMENT_REJECTED,
      signal: transaction
    };
  }
  return null;
}

function classifyByText(
  message: string
): { code: McpErrorCode; signal: string } | null {
  const msg = message.toLowerCase();
  if (msg.includes('insufficient') || msg.includes('underfunded')) {
    return { code: MCP_ERROR_CODES.ERR_INSUFFICIENT_BALANCE, signal: 'insufficient' };
  }
  if (msg.includes('trustline') || msg.includes('no trust')) {
    return { code: MCP_ERROR_CODES.ERR_MISSING_TRUSTLINE, signal: 'trustline' };
  }
  if (msg.includes('expired') || msg.includes('authorisation') || msg.includes('authorization')) {
    return { code: MCP_ERROR_CODES.ERR_EXPIRED_AUTHORISATION, signal: 'expired' };
  }
  if (msg.includes('invalid asset') || msg.includes('asset issuer')) {
    return { code: MCP_ERROR_CODES.ERR_INVALID_ASSET, signal: 'invalid asset' };
  }
  if (msg.includes('bad request') || msg.includes('malformed')) {
    return { code: MCP_ERROR_CODES.ERR_BAD_REQUEST, signal: 'bad request' };
  }
  if (msg.includes('no results') || msg.includes('not found')) {
    return { code: MCP_ERROR_CODES.ERR_NO_RESULTS, signal: 'no results' };
  }
  if (msg.includes('unreachable') || msg.includes('econnrefused') || msg.includes('enotfound')) {
    return { code: MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE, signal: 'unreachable' };
  }
  return null;
}
