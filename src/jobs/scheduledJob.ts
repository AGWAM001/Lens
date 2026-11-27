import { Queue, Worker } from 'bullmq'
import { createLogger } from '../logger'

/**
 * A recurring background job, described once and started with
 * `startScheduledJob()`.
 *
 * Each retention job used to carry its own copy of the same scaffolding: a
 * Redis connection helper, a Queue with one pinned attempt, a Worker with
 * concurrency 1, an hourly repeat plus a run on boot, and in src/index.ts a
 * try/catch that falls back to an in-process `setInterval` when Redis is away.
 * This is that scaffolding in one place, so a new job only has to say what it
 * runs and how often.
 */
export interface ScheduledJobDefinition {
  /** Stable job name, e.g. `pool-snapshot-retention`. Used for the BullMQ job name and the log component. */
  name: string
  /** Full BullMQ queue name, normally `${activeNetwork}:${name}`. */
  queueName: string
  /** Interval between runs, in milliseconds. */
  everyMs: number
  /**
   * Delay before the first run after boot, in milliseconds. The first run is
   * never awaited by the caller; the delay also keeps it from competing with
   * the ingesters' first cycle.
   */
  firstRunDelayMs: number
  /**
   * One run of the job. It must reject on failure: the BullMQ worker relies on
   * that to store the job as failed (see src/jobs/jobMetrics.ts).
   */
  run: () => Promise<void>
}

export type ScheduledJobPath = 'redis_queue' | 'in_process'

export interface ScheduledJobHandle {
  /** Which path is running the job. */
  path: ScheduledJobPath
  /** Stops the schedule (closes the queue and worker, or clears the timers). */
  stop: () => Promise<void>
}

/** BullMQ connection options: `REDIS_URL` when set, a local Redis otherwise. */
export function redisConnection(): { url: string } | { host: string; port: number } {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

/**
 * Starts `job` on a BullMQ repeatable schedule, or on an in-process timer if
 * the queue cannot be set up (Redis down or misconfigured). Never rejects, and
 * never waits for a run: the promise resolves once the schedule is in place.
 *
 * In-process runs never overlap within this process; a tick that fires while
 * the previous run is still going is skipped.
 */
export async function startScheduledJob(job: ScheduledJobDefinition): Promise<ScheduledJobHandle> {
  const log = createLogger(`job:${job.name}`)
  let queue: Queue | undefined
  let worker: Worker | undefined

  try {
    // One attempt, pinned: a failed run is stored as failed, not retried
    // forever; the next repeat fires on schedule.
    queue = new Queue(job.queueName, {
      connection: redisConnection(),
      defaultJobOptions: { attempts: 1 },
    })
    worker = new Worker(
      job.queueName,
      async () => {
        await job.run()
      },
      { connection: redisConnection(), concurrency: 1 }
    )
    worker.on('failed', (_job, err) => {
      log.error({ err }, `${job.name} job failed`)
    })

    await queue.add(job.name, {}, { repeat: { every: job.everyMs }, jobId: `${job.name}:repeat` })
    await queue.add(job.name, {}, { delay: job.firstRunDelayMs })

    log.info({ everyMs: job.everyMs, firstRunDelayMs: job.firstRunDelayMs }, `${job.name} worker started`)
    const startedQueue = queue
    const startedWorker = worker
    return {
      path: 'redis_queue',
      stop: async () => {
        await Promise.allSettled([startedQueue.close(), startedWorker.close()])
      },
    }
  } catch (err) {
    // BullMQ opens its own ioredis connections; close whatever got created so
    // they do not reconnect and log forever.
    await Promise.allSettled([queue?.close(), worker?.close()])
    log.warn({ err }, `${job.name} worker unavailable; falling back to an in-process timer`)
    return startInProcess(job, log)
  }
}

function startInProcess(
  job: ScheduledJobDefinition,
  log: ReturnType<typeof createLogger>
): ScheduledJobHandle {
  let running = false

  const tick = async () => {
    if (running) {
      log.warn(`${job.name} previous run still in progress; skipping this tick`)
      return
    }
    running = true
    try {
      await job.run()
    } catch (err) {
      // A timer has no BullMQ to report the failure to, so it is logged here.
      log.error({ err }, `${job.name} run failed`)
    } finally {
      running = false
    }
  }

  const firstRun = setTimeout(() => { void tick() }, job.firstRunDelayMs)
  firstRun.unref()
  const interval = setInterval(() => { void tick() }, job.everyMs)
  interval.unref()

  return {
    path: 'in_process',
    stop: async () => {
      clearTimeout(firstRun)
      clearInterval(interval)
    },
  }
}
