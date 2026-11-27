import {
  job_runs_total,
  job_duration_seconds,
  job_last_success_timestamp,
  job_rows_deleted_total,
} from '../metrics'
import type { NetworkName } from '../config'

/**
 * The background jobs Lens runs, one name per BullMQ queue in src/jobs/.
 * This is a closed set — the `job` label on the job metrics can only ever
 * take these values, so the series count stays at `jobs x networks`
 * (see docs/ingest-metrics.md). Do not derive a job name from runtime data
 * such as a pair key or a pool id.
 */
export const JOB_NAMES = [
  'aggregate-refresh',
  'snapshot-retention',
  'venue-reconciliation',
  'rate-retention',
  'oracle-retention',
  'price-points-retention',
  'price-points-partition',
] as const

export type JobName = (typeof JOB_NAMES)[number]

/**
 * Wraps one run of a background job and records it in the job metrics
 * (job_runs_total, job_duration_seconds, job_last_success_timestamp).
 *
 * Success and failure are both recorded — duration is observed for both,
 * and the last-success timestamp only moves on success, so a job that
 * starts failing goes stale instead of looking healthy.
 *
 * On failure the error is rethrown after recording, so the BullMQ worker
 * handler that called this rejects and BullMQ stores the job as failed
 * (and its `worker.on('failed')` handler can actually fire). Before #696
 * every worker caught its own errors and logged them, so the handler never
 * threw and BullMQ recorded every failed run as completed. Callers must
 * NOT swallow the rethrown error in the worker path — the in-process
 * fallback timers in src/index.ts are the one place that catches it, and
 * only because a timer has no BullMQ to report to.
 */
export async function runJob<T>(
  job: JobName,
  network: NetworkName,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await fn()
    job_runs_total.inc({ job, network, outcome: 'success' })
    job_last_success_timestamp.set({ job, network }, Math.floor(Date.now() / 1000))
    return result
  } catch (err) {
    job_runs_total.inc({ job, network, outcome: 'failure' })
    throw err
  } finally {
    job_duration_seconds.observe({ job, network }, (Date.now() - startedAt) / 1000)
  }
}

/**
 * Records rows deleted by a retention job. Called per batch inside the
 * prune loop rather than once at the end, so a run that fails part-way
 * still reports the rows it already deleted. Zero-row batches are skipped
 * so idle runs do not create series.
 */
export function recordJobRowsDeleted(job: JobName, network: NetworkName, rows: number): void {
  if (rows > 0) {
    job_rows_deleted_total.inc({ job, network }, rows)
  }
}
