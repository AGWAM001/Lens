import { fetchWithTimeout } from '../../fetch'
import { horizon_rate_limit_remaining } from '../../metrics'
import type { NetworkName } from '../../config'

export class HorizonRateLimitError extends Error {
  readonly status = 429

  constructor(url: string) {
    super(`Horizon rate limit persisted after retries for ${new URL(url).pathname}`)
    this.name = 'HorizonRateLimitError'
  }
}

/**
 * How long to wait before retrying a 429.
 *
 * Horizon's own `Retry-After` wins when it sends one — it knows when the window
 * resets and we do not. Otherwise exponential with full jitter in the 0.75–1.25
 * band: every ingester polls on the same interval, so a fixed backoff makes
 * four venues retry in lockstep and rate-limit each other again.
 */
function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  const exponential = Math.min(1_000 * 2 ** attempt, 30_000)
  return Math.round(exponential * (0.75 + Math.random() * 0.5))
}

/** Sleep that gives up as soon as the cycle is abandoned. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export interface FetchHorizonJsonOptions {
  /** Total attempts, including the first. */
  attempts?: number
  /**
   * The cycle deadline's signal (#351). Passed to every request and to the
   * backoff sleep, so an abandoned cycle does not sit out a 30-second retry
   * wait after it has been told to stop.
   */
  signal?: AbortSignal
}

/**
 * Fetch and validate Horizon JSON, retrying a 429 instead of treating it as
 * empty data (#348).
 *
 * The bug this fixes is quiet: a rate-limited `liquidity_pools` call returned a
 * body with no `_embedded.records`, the caller read that as "this pair has no
 * pools", and the venue silently stopped producing prices until the next cycle
 * happened to land outside the window. A 429 is now either retried or raised.
 *
 * Every request goes through `fetchWithTimeout`, so it carries both the
 * configured HTTP timeout and the caller's abort signal — a bare `fetch` here
 * would be a request with no upper bound on how long it can hang, inside a loop
 * whose whole purpose is to have one.
 */
export async function fetchHorizonJson<T>(
  url: string,
  network: NetworkName,
  options: FetchHorizonJsonOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3
  const { signal } = options

  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetchWithTimeout(url, { signal })
    const remaining = response.headers.get('x-ratelimit-remaining')
    if (remaining !== null && Number.isFinite(Number(remaining))) {
      horizon_rate_limit_remaining.set({ network }, Number(remaining))
    }

    if (response.status === 429) {
      if (attempt + 1 === attempts) throw new HorizonRateLimitError(url)
      await sleep(retryDelay(response, attempt), signal)
      // The deadline fired while we were waiting out the window: stop rather
      // than spend another request the cycle no longer wants.
      if (signal?.aborted) throw new HorizonRateLimitError(url)
      continue
    }
    if (!response.ok) {
      throw new Error(`Horizon request failed with HTTP ${response.status} for ${new URL(url).pathname}`)
    }
    return await response.json() as T
  }
  throw new HorizonRateLimitError(url)
}
