/**
 * Serialization precision standards for Lens prices and volumes.
 *
 * Background (Issue #230):
 * PostgreSQL schema (`prisma/schema.prisma`) declares:
 * - Prices: `Decimal(36, 18)` (18 decimal places of fractional precision)
 * - Volumes: `Decimal(36, 7)` (7 decimal places of fractional precision, matching Stellar stroops)
 *
 * Intermediate aggregations (SUM, AVG, MIN, MAX, array_agg) are computed in PostgreSQL
 * using exact arbitrary-precision `numeric` arithmetic rather than IEEE-754 `float8`.
 * This prevents order-dependent floating-point accumulation errors and precision loss
 * on small fractions (such as 1e-7 prices or multi-venue volume totals).
 *
 * At the serialization edge the value becomes a JavaScript number, and that is
 * where the exactness stops. A JS number is an IEEE-754 double: it carries
 * about 15-17 significant decimal digits in total, not 18 fractional ones, so
 * these helpers cannot preserve a `Decimal(36, 18)` price in full. What they do
 * is narrow once, at a single known place, instead of once per row inside an
 * aggregate — the `toFixed` round-trip strips the representation artifact that
 * makes a double print as 0.30000000000000004, and nothing more.
 *
 * The constants below are therefore the schema's scale, used as a rounding
 * point, not a promise about what survives:
 * - `PRICE_DECIMAL_PLACES = 18` — the column's scale.
 * - `VOLUME_DECIMAL_PLACES = 7` — the column's scale, one Stellar stroop.
 *
 * A caller that genuinely needs the exact decimal has to receive a string.
 * `src/utils/decimals.ts` already does that for the REST routes, negotiated
 * per request with `X-Decimal-Format`, `Accept` or `?decimals=`. These helpers
 * exist for GraphQL, whose schema declares these fields as `Float` and so
 * cannot carry one.
 */

export const PRICE_DECIMAL_PLACES = 18
export const VOLUME_DECIMAL_PLACES = 7

/**
 * Narrow a price to a JSON number at the serialization edge.
 *
 * Lossy by construction — see the module comment. Returns `null` for `null`,
 * `undefined` or a value that does not parse, so a missing price is never
 * reported as 0.
 */
export function formatPrice(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return null
  return Number(num.toFixed(PRICE_DECIMAL_PLACES))
}

/**
 * Narrow a volume to a JSON number at the serialization edge.
 *
 * Rounded at the column's scale of 7 decimal places, one Stellar stroop.
 * Returns `0` rather than `null` for an absent value, because callers sum
 * volumes and a null would poison the total.
 */
export function formatVolume(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return 0
  return Number(num.toFixed(VOLUME_DECIMAL_PLACES))
}
