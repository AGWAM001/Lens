/**
 * Crash and restart bookkeeping for the ingester loops.
 *
 * Extracted from `main()` so the state can be read by `/status` and asserted in
 * tests. A crash-looping ingester that restarts successfully is otherwise
 * invisible: the process is up, the port answers, and "it is running" is not
 * the same as "it has been running".
 *
 * State is keyed by `${name}/${network}` and deliberately per (venue, network)
 * pair, matching the isolation the restart logic promises — a crash in the
 * Soroswap ingester on mainnet must not affect SDEX on testnet, and sharing
 * counters between them would quietly break that.
 *
 * In-process only. This is a liveness signal for the instance answering the
 * request, not a durable record; `ingester_restarts_total` is the metric to
 * aggregate across instances and over time.
 */
import { ingesterRestarts } from '../metrics'
import type { NetworkName } from '../config'

export interface IngesterCrash {
  name: string
  network: string
  /** The error's message. Never the stack — this is served over HTTP. */
  message: string
  at: Date
}

export interface IngesterState {
  failures: number
  lastCrashAt: Date | null
  lastCrashMessage: string | null
}

const ingesterState = new Map<string, IngesterState>()

const key = (name: string, network: string): string => `${name}/${network}`

/** The state for one ingester on one network, created on first use. */
export function getIngesterState(name: string, network: string): IngesterState {
  const existing = ingesterState.get(key(name, network))
  if (existing) return existing
  const fresh: IngesterState = { failures: 0, lastCrashAt: null, lastCrashMessage: null }
  ingesterState.set(key(name, network), fresh)
  return fresh
}

/**
 * Record a crash: increments the failure count that drives the backoff, stamps
 * the last crash for `/status`, and advances the Prometheus counter.
 */
export function recordCrash(name: string, network: string, err: unknown): IngesterState {
  const state = getIngesterState(name, network)
  state.failures += 1
  state.lastCrashAt = new Date()
  state.lastCrashMessage = err instanceof Error ? err.message : String(err)
  ingesterRestarts.inc({ ingester: name, network })
  return state
}

/**
 * Clear the failure count after a run that lasted long enough to be healthy.
 *
 * Deliberately not called on every success: a loop that exits immediately and
 * "succeeds" must not reset the backoff, or a fast crash-loop never backs off
 * at all. The last crash is kept, because it is still the last thing that
 * happened and `/status` should keep saying so.
 */
export function markHealthy(name: string, network: string): void {
  getIngesterState(name, network).failures = 0
}

/** Every ingester that has crashed at least once, newest first. */
export function listCrashes(network?: NetworkName | string): IngesterCrash[] {
  const crashes: IngesterCrash[] = []
  for (const [k, state] of ingesterState) {
    if (!state.lastCrashAt || !state.lastCrashMessage) continue
    const slash = k.lastIndexOf('/')
    const name = k.slice(0, slash)
    const net = k.slice(slash + 1)
    if (network && net !== network) continue
    crashes.push({ name, network: net, message: state.lastCrashMessage, at: state.lastCrashAt })
  }
  return crashes.sort((a, b) => b.at.getTime() - a.at.getTime())
}

/** Test-only: drops all recorded state between cases. */
export function resetIngesterState(): void {
  ingesterState.clear()
}
