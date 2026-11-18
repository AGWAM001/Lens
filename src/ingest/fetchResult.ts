/**
 * The one result shape for an upstream read that can fail (#329).
 *
 * A venue or oracle that answered with nothing and one that could not be
 * reached used to come back identical — `[]` or `null` — so the caller could
 * not tell them apart, and the aggregate quietly reweighted onto whichever
 * venues did answer. Every fetch that #329 covers (Horizon AMM pools, the
 * Soroswap token list, Aquarius pools, the Reflector oracle) now returns this
 * instead:
 *
 * - `{ ok: true, data }` — the upstream answered. `data` may be empty (`[]`,
 *   `null`): that is a real, reportable "there is nothing here".
 * - `{ ok: false, error }` — the upstream did not answer. The caller must not
 *   treat this as empty; it records the failure (see `sourceFailures.ts`) so
 *   the source is excluded from the aggregate and reported on `/status`.
 */
export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: Error }

export function fetchOk<T>(data: T): FetchResult<T> {
  return { ok: true, data }
}

export function fetchFailed<T = never>(err: unknown): FetchResult<T> {
  return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
}
