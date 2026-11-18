/**
 * Which sources failed, per (source, network, subject) — #329.
 *
 * A fetch that fails records itself here; the next successful fetch for the
 * same (source, network, subject) clears it. The aggregate reads this to
 * exclude a failed source instead of counting it as contributing nothing, and
 * `/status` reads it so the failure is visible rather than only logged.
 *
 * `source` is the value written to `price_points.source` ('AMM',
 * 'soroswap_amm', 'aquarius_amm'), or the oracle's name ('reflector'), so the
 * aggregate can match it against the rows it reads. `subject` is the pair key
 * for a venue and the asset code for an oracle.
 *
 * In-process only, like the crash bookkeeping in `ingester/restart.ts`: it
 * describes the instance answering the request, not a durable record.
 */
import type { NetworkName } from '../config'

export interface SourceFailure {
  source: string
  network: string
  subject: string
  /**
   * The error's message, for in-process callers and tests. Deliberately not
   * served on `/status`: an RPC or HTTP client error can carry the upstream
   * URL, and that route is public. The full error is in the log line the
   * failing fetch wrote.
   */
  message: string
  at: Date
}

const failures = new Map<string, SourceFailure>()

const key = (source: string, network: string, subject: string): string =>
  `${source}\u0000${network}\u0000${subject}`

export function recordSourceFailure(
  source: string,
  network: NetworkName | string,
  subject: string,
  err: unknown
): SourceFailure {
  const raw = err instanceof Error ? err.message : String(err)
  const failure: SourceFailure = {
    source,
    network,
    subject,
    message: raw || 'unknown error',
    at: new Date(),
  }
  failures.set(key(source, network, subject), failure)
  return failure
}

/** A successful fetch: the source answered, so it is no longer failed. */
export function clearSourceFailure(
  source: string,
  network: NetworkName | string,
  subject: string
): void {
  failures.delete(key(source, network, subject))
}

/** Every recorded failure, optionally for one network and/or subject, newest first. */
export function listSourceFailures(
  network?: NetworkName | string,
  subject?: string
): SourceFailure[] {
  return [...failures.values()]
    .filter((f) => (network === undefined || f.network === network) &&
      (subject === undefined || f.subject === subject))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
}

/** The distinct source names currently failed for a network (and subject, if given). */
export function getFailedSources(network: NetworkName | string, subject?: string): string[] {
  return [...new Set(listSourceFailures(network, subject).map((f) => f.source))].sort()
}

/** Test-only: drops all recorded failures between cases. */
export function resetSourceFailures(): void {
  failures.clear()
}
