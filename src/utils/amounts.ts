const POSITIVE_DECIMAL_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Parses a positive, finite decimal query parameter.
 *
 * Rejects trailing non-numeric characters (e.g. `100abc`, `1e3xyz`),
 * non-finite values (`Infinity`, `NaN`, `1e999`), hex literals (`0x10`),
 * empty strings, zero, and negatives.
 */
export function parsePositiveAmount(
  raw: string | undefined,
  defaultValue = '1000',
  label = 'amount'
): { value: number } | { error: string } {
  const candidate = raw === undefined ? defaultValue : raw.trim()
  if (!POSITIVE_DECIMAL_PATTERN.test(candidate)) {
    return { error: `${label} must be a positive number` }
  }
  const value = Number(candidate)
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `${label} must be a positive number` }
  }
  return { value }
}
