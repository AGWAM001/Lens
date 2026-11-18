/**
 * Per-cycle deadline for ingester loops. Issue: #351.
 *
 * Every ingester is an infinite loop (`startVenueAdapter`, the snapshot
 * ingester) restarted on crash by `restartIngester`. Each pass of such a loop
 * is one *cycle*: for a venue adapter that is one round over all active pairs,
 * for the snapshot ingester one minute-append. Before this module a single
 * slow upstream call could stretch a cycle arbitrarily long. The loop has not
 * "crashed", so nothing restarts it, and every monitoring signal the service
 * has still reports the ingester as healthy while it silently stops producing.
 *
 * This module bounds one cycle:
 *
 * 1. The cycle races a timer of `deadlineMs`. When the timer wins, the cycle's
 *    `AbortSignal` fires and the cycle is **abandoned**: counted in
 *    `ingester_abandoned_cycles_total` (labels: `venue`, `network`) and logged.
 *    It is abandoned, not awaited indefinitely — the abandoned cycle stops at
 *    its next checkpoint instead of grinding through every remaining pair or
 *    pool, so the loop resumes after teardown rather than after the slow work.
 * 2. Cycles stay strictly sequential. The abandoned cycle is always awaited
 *    until it *unwinds* before the next one may start, so abandoning a cycle
 *    never starts a second concurrent cycle against the same venue.
 * 3. Checkpoints are placed **before a unit's write sequence starts, never in
 *    the middle of one** — that is the "check how each ingester writes before
 *    changing the control flow" part of #351. Writes in Lens are already
 *    atomic units: `upsertPricePoints` is one `createMany(skipDuplicates)`, the
 *    SDEX/AMM cursor advance rides together with its page upsert, the snapshot
 *    append is one `INSERT … ON CONFLICT … DO NOTHING`. So an abandoned cycle
 *    either has not started a unit — the unit is skipped and its data re-read
 *    next cycle, where `skipDuplicates` makes the replay idempotent — or it
 *    runs the unit whole. A partial write cannot survive abandonment because
 *    no checkpoint sits between statements a unit commits together.
 */

import type { NetworkName } from '../config'
import { createLogger } from '../logger'
import { ingester_abandoned_cycles_total } from '../metrics'

const log = createLogger('cycle-deadline')

/**
 * Default cycle deadline (ms) when no environment override is set.
 *
 * 60s: a healthy cycle is sub-second (pairs come from an in-memory registry,
 * upstream calls are individually bounded by `fetchWithTimeout`'s default
 * timeout), so a minute means something is genuinely stuck, while staying
 * generous enough that a cold Horizon/RPC can never trip it under normal load.
 */
export const DEFAULT_CYCLE_DEADLINE_MS = 60_000

/**
 * After an abandoned cycle is aborted, how long its unwind may take before we
 * escalate to an error log. The loop still never starts an overlapping cycle —
 * it waits — but a cycle that fails to unwind within this window means one
 * in-flight call ignored its own timeout, and that must be visible in logs
 * rather than an ingester that quietly stopped ticking.
 */
export const CYCLE_UNWIND_GRACE_MS = 10_000

/** The abort reason attached to a cycle's signal when its deadline fires. */
export class CycleDeadlineExceeded extends Error {
  constructor(venue: string, network: NetworkName, deadlineMs: number) {
    super(`${venue}/${network} cycle exceeded its ${deadlineMs}ms deadline`)
    this.name = 'CycleDeadlineExceeded'
  }
}

export type CycleStatus = 'completed' | 'abandoned'

export interface CycleResult {
  status: CycleStatus
  /** Wall time from cycle start to the outcome being decided. */
  durationMs: number
}

type CycleSettled =
  | { outcome: 'fulfilled' }
  | { outcome: 'rejected'; error: unknown }

/**
 * Parse one deadline environment value.
 *
 * Returns `undefined` for unset/empty so the next candidate in the precedence
 * chain is tried. An unparseable value never silently disables the deadline —
 * it is warned about and skipped, so the fallback still bounds the cycle.
 * `0` is valid and means "deadline disabled": an explicit operator decision,
 * unlike a typo, which must not become one.
 */
function readDeadlineMs(raw: string | undefined, envKey: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn(
      { envKey, value: raw },
      'cycle deadline override is not a non-negative number of milliseconds; ignoring it'
    )
    return undefined
  }
  return parsed
}

/**
 * Resolve the cycle deadline for one ingester ("venue" means the loop
 * identity here: `SDEX`, `AMM`, `Soroswap`, `Aquarius`, `Snapshot`).
 *
 * Precedence, most specific first — mirroring the paired-var convention used
 * everywhere else in `src/config.ts`:
 *
 *   1. `INGEST_CYCLE_DEADLINE_MS_<VENUE>_<NETWORK>`  e.g. `INGEST_CYCLE_DEADLINE_MS_SOROSWAP_MAINNET`
 *   2. `INGEST_CYCLE_DEADLINE_MS_<VENUE>`            e.g. `INGEST_CYCLE_DEADLINE_MS_SOROSWAP`
 *   3. `INGEST_CYCLE_DEADLINE_MS_<NETWORK>`          `INGEST_CYCLE_DEADLINE_MS_TESTNET` / `INGEST_CYCLE_DEADLINE_MS_MAINNET`
 *   4. `INGEST_CYCLE_DEADLINE_MS`
 *   5. `DEFAULT_CYCLE_DEADLINE_MS`
 *
 * Venue names are upper-cased with non-alphanumeric characters folded to `_`,
 * so `Aquarius` → `AQUARIUS` and any future adapter follows the same rule.
 * `.env.example` documents levels 1, 3 and 4 — level 1 as the documented
 * pattern, because the venue dimension is bounded by the adapter registry but
 * cannot be enumerated by the env drift guard the way per-network suffixes can.
 */
export function getCycleDeadlineMs(venue: string, network: NetworkName): number {
  const venueKey = venue.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const suffix = network.toUpperCase() as 'TESTNET' | 'MAINNET'

  const venueNetworkKey = `INGEST_CYCLE_DEADLINE_MS_${venueKey}_${suffix}`
  const venueKeyEnv = `INGEST_CYCLE_DEADLINE_MS_${venueKey}`
  const networkKey = `INGEST_CYCLE_DEADLINE_MS_${suffix}`

  const resolved =
    readDeadlineMs(process.env[venueNetworkKey], venueNetworkKey) ??
    readDeadlineMs(process.env[venueKeyEnv], venueKeyEnv) ??
    readDeadlineMs(process.env[networkKey], networkKey) ??
    readDeadlineMs(process.env.INGEST_CYCLE_DEADLINE_MS, 'INGEST_CYCLE_DEADLINE_MS') ??
    DEFAULT_CYCLE_DEADLINE_MS

  return resolved
}

/**
 * Run exactly one ingester cycle under `deadlineMs` (defaulting to
 * `getCycleDeadlineMs(venue, network)`).
 *
 * - finishes in time → resolves `{ status: 'completed' }`; a cycle error is
 *   rethrown untouched so the caller's existing backoff keeps working.
 * - exceeds it → the cycle's signal aborts, the abandonment is counted and
 *   logged, the cycle is awaited only until it unwinds, then resolves
 *   `{ status: 'abandoned' }`.
 * - `deadlineMs <= 0` → deadline disabled: plain await, no timer.
 *
 * Never resolves while the previous cycle's function is still running, which
 * is what keeps two cycles against the same venue from ever overlapping.
 */
export async function runCycleWithDeadline(opts: {
  venue: string
  network: NetworkName
  /** Override the resolved environment deadline (tests / special callers). */
  deadlineMs?: number
  cycle: (signal: AbortSignal) => Promise<void>
}): Promise<CycleResult> {
  const { venue, network, cycle } = opts
  const deadlineMs = opts.deadlineMs ?? getCycleDeadlineMs(venue, network)
  const startedAt = Date.now()

  if (deadlineMs <= 0) {
    // Deadline disabled by configuration. Hand the cycle a signal anyway so
    // adapter code paths are identical with and without the deadline.
    await cycle(new AbortController().signal)
    return { status: 'completed', durationMs: Date.now() - startedAt }
  }

  const controller = new AbortController()
  const deadlineError = new CycleDeadlineExceeded(venue, network, deadlineMs)

  let timer: NodeJS.Timeout | undefined
  const deadlineFired = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(deadlineError)
      resolve('deadline')
    }, deadlineMs)
  })

  // Bridge the cycle into a promise that is always handled: when the deadline
  // wins the race, a later rejection from the abandoned cycle must not become
  // an unhandled rejection — it is awaited (and discarded) below instead.
  const cycleSettled: Promise<CycleSettled> = cycle(controller.signal).then(
    () => ({ outcome: 'fulfilled' as const }),
    (error) => ({ outcome: 'rejected' as const, error })
  )

  try {
    const first = await Promise.race([cycleSettled, deadlineFired])

    if (first === 'deadline') {
      ingester_abandoned_cycles_total.inc({ venue, network })
      log.error(
        { venue, network, deadlineMs, elapsedMs: Date.now() - startedAt },
        'cycle abandoned after exceeding its deadline'
      )

      // Start the next cycle only once this one has unwound — overlap must
      // remain impossible. This awaits teardown, not the abandoned work: the
      // signal has already stopped every remaining unit at its checkpoint, so
      // what is left is the single in-flight call the current unit sits on
      // (bounded by that call's own timeout). If even that does not settle
      // within the grace window we refuse to overlap anyway — and say so.
      const graceTimer = setTimeout(() => {
        log.error(
          { venue, network, graceMs: CYCLE_UNWIND_GRACE_MS },
          'abandoned cycle has not unwound after its abort — holding the loop open rather than overlapping it; ' +
            'an in-flight upstream call is ignoring its own timeout'
        )
      }, CYCLE_UNWIND_GRACE_MS)

      try {
        await cycleSettled
      } finally {
        clearTimeout(graceTimer)
      }

      return { status: 'abandoned', durationMs: Date.now() - startedAt }
    }

    clearTimeout(timer)

    if (first.outcome === 'rejected') throw first.error
    return { status: 'completed', durationMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}