import type { FastifyRequest } from 'fastify'

export type DecimalFormat = 'number' | 'string'

/**
 * Resolves the client's requested decimal format.
 * Defaults to 'number' so that unversioned / unnegotiated requests remain 100% backward-compatible.
 *
 * Supported negotiation methods:
 * 1. Request header:
 *    - `X-Decimal-Format: string`
 *    - `X-Decimals: string`
 * 2. Content negotiation (Accept header):
 *    - `Accept: application/json; decimals=strings` (or `decimals=string`, `decimal=string`)
 * 3. Query parameter fallback:
 *    - `?decimals=strings` (or `?decimals=string`, `?decimalFormat=string`)
 */
export function resolveDecimalFormat(req: FastifyRequest): DecimalFormat {
  const query = req.query as Record<string, unknown> | undefined
  const decimalsQuery = typeof query?.decimals === 'string'
    ? query.decimals.toLowerCase()
    : typeof query?.decimalFormat === 'string'
      ? query.decimalFormat.toLowerCase()
      : undefined

  if (decimalsQuery === 'string' || decimalsQuery === 'strings') {
    return 'string'
  }

  const headerVal = req.headers['x-decimal-format'] ?? req.headers['x-decimals']
  if (typeof headerVal === 'string') {
    const lower = headerVal.toLowerCase().trim()
    if (lower === 'string' || lower === 'strings') {
      return 'string'
    }
  }

  const accept = req.headers['accept']
  if (typeof accept === 'string') {
    // Parse MIME types and parameters: e.g. "application/json; decimals=strings"
    const mediaTypes = accept.split(',')
    for (const mediaType of mediaTypes) {
      const parts = mediaType.split(';').map(p => p.trim().toLowerCase())
      for (let i = 1; i < parts.length; i++) {
        const [k, v] = parts[i].split('=').map(s => s.trim())
        if ((k === 'decimals' || k === 'decimal') && (v === 'string' || v === 'strings')) {
          return 'string'
        }
      }
    }
  }

  return 'number'
}

/**
 * Format a numeric or decimal quantity according to the negotiated format.
 * If format is 'string', preserves raw DB string or converts value to string.
 * If format is 'number', converts to float number.
 */
export function formatDecimal<T extends number | string | null | undefined>(
  val: T,
  format: DecimalFormat
): T extends null | undefined ? null : number | string {
  if (val === null || val === undefined) {
    return null as any
  }
  if (format === 'string') {
    return String(val) as any
  }
  return (typeof val === 'number' ? val : parseFloat(String(val))) as any
}
