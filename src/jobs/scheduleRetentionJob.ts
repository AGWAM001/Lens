import type { Queue } from 'bullmq'

/** Default repeat interval for a retention job: hourly. */
export const RETENTION_JOB_INTERVAL_MS = 60 * 60 * 1000

export interface ScheduleRetentionJobOptions {
  /** BullMQ job name, e.g. 'prune' or 'maintain'. */
  jobName: string
  /**
   * Stable id for the repeatable job, e.g. 'snapshot-retention:prune'.
   * BullMQ keys repeatable jobs by this id, so it must not change between
   * deploys or the old schedule is orphaned and the new one added alongside.
   */
  jobId: string
  /** Repeat interval in milliseconds. Defaults to hourly. */
  intervalMs?: number
  /**
   * Also enqueue one run immediately, so a freshly booted service prunes
   * without waiting for the first interval tick. Defaults to true — every
   * retention job scheduled this way has always done it.
   */
  runImmediately?: boolean
}

/**
 * Schedules a retention job on a BullMQ queue: one repeatable job on the
 * interval, plus (by default) one immediate run.
 *
 * Every retention job in src/jobs/ used to hand-roll this exact pair of
 * `queue.add` calls — snapshot, lending-rate, oracle, price-points and
 * audit retention each carried their own copy, and new jobs kept adding
 * more. They all delegate here now, so the scheduling shape (job name,
 * repeat options, immediate run) lives in exactly one place.
 */
export async function scheduleRetentionJob(
  queue: Queue,
  { jobName, jobId, intervalMs = RETENTION_JOB_INTERVAL_MS, runImmediately = true }: ScheduleRetentionJobOptions
): Promise<void> {
  await queue.add(jobName, {}, { repeat: { every: intervalMs }, jobId })
  if (runImmediately) {
    await queue.add(jobName, {})
  }
}
