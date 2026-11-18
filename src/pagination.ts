/**
 * Cursor pagination helpers shared by every list route.
 *
 * The convention is copied verbatim from GET /screener, which was the first
 * paginated route in this codebase and is the reference implementation:
 *
 *   - `limit` is clamped into [1, max] with a per-route default; a non-integer
 *     limit is a 400, never a silent clamp to some arbitrary page size.
 *   - The cursor is an opaque base64 encoding of `JSON.stringify([value, id])`
 *     — the last row's sort value plus its tiebreaker id. Callers must treat it
 *     as opaque; only the shape matters to them.
 *   - Pagination is keyset-based, not offset-based: the predicate is
 *     `(sortCol, idCol) > ($value, $id)` (or `<` for descending order), so a
 *     row inserted while a client is paging can never shift a page boundary
 *     and cause a duplicate or a skipped row.
 *   - Handlers fetch `limit + 1` rows; the extra row is the only hasMore
 *     signal, so no COUNT(*) over the whole table is needed.
 *
 * Routes keep their own response keys (`pools`, `pairs`, `candles`, `points`,
 * screener's `data`) and add `nextCursor` + `hasMore`, so an unpaged caller
 * still gets a sensible first page.
 */

/** Default page size and hard maximum for GET /screener. */
export const SCREENER_DEFAULT_LIMIT = 20
export const SCREENER_MAX_LIMIT = 100

/** Default page size and hard maximum for GET /pools. */
export const POOLS_DEFAULT_LIMIT = 50
export const POOLS_MAX_LIMIT = 200

/** Default page size and hard maximum for GET /pairs. */
export const PAIRS_DEFAULT_LIMIT = 50
export const PAIRS_MAX_LIMIT = 200

/** Default page size and hard maximum for GET /candles/:assetA/:assetB. */
export const CANDLES_DEFAULT_LIMIT = 500
export const CANDLES_MAX_LIMIT = 5_000

/**
 * Default page size for GET /prices/history. The maximum is
 * `MAX_HISTORY_POINTS` (src/api/history.ts) so a page can never exceed the
 * point cap a single window may produce.
 */
export const HISTORY_DEFAULT_LIMIT = 1_000

/**
 * Parse a `limit` query parameter.
 *
 * Returns the clamped integer on success, or `{ error }` for the route to
 * answer 400 with — matching /screener's historical behaviour: absent →
 * `def`, out-of-range values are clamped, non-numeric values are rejected.
 */
export function parseLimit(
  raw: string | undefined,
  def: number,
  max: number,
): { limit: number } | { error: string } {
  if (raw === undefined) return { limit: def }
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed)) return { error: 'limit must be a valid integer' }
  return { limit: Math.min(Math.max(parsed, 1), max) }
}

/**
 * Encode the last row's sort value and tiebreaker id as an opaque cursor.
 *
 * The payload is a 2-tuple — `[sortValue, id]` — regardless of how many
 * columns the route's keyset actually spans, so every route emits the same
 * cursor shape.
 */
export function encodeCursor(value: unknown, id: string | number): string {
  return Buffer.from(JSON.stringify([value, id])).toString('base64')
}

/** Result of {@link decodeCursor}: a payload, a deliberate skip, or malformed. */
export type DecodedCursor = { value: unknown; id: unknown } | 'skip' | null

/**
 * Decode an opaque cursor back into its `[sortValue, id]` payload.
 *
 * Three outcomes, matching /screener's historical behaviour exactly:
 *   - `{ value, id }` — apply the keyset predicate with these values.
 *   - `'skip'` — the cursor is well-formed JSON but its sort value or id is
 *     empty; the route serves the first page instead of erroring, because a
 *     degenerate cursor must not punish a first-page caller.
 *   - `null` — not base64 JSON, or not destructurable at all; the route must
 *     answer 400 "Invalid cursor format".
 */
export function decodeCursor(raw: string): DecodedCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'))
  } catch {
    return null
  }
  let value: unknown
  let id: unknown
  try {
    ;[value, id] = parsed as Iterable<unknown>
  } catch {
    return null
  }
  if (value === null || value === undefined || !id) return 'skip'
  return { value, id }
}

/**
 * Trim a `limit + 1` row fetch down to the page and report whether another
 * page exists. The rows are expected to already be keyset-filtered and
 * ordered by the route's SQL (or, for in-memory lists, by the handler).
 */
export function slicePage<T>(rows: T[], limit: number): { data: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit
  return { data: hasMore ? rows.slice(0, limit) : rows, hasMore }
}
