// Tests for the background job metrics (#696).
//
// Before this change the workers in src/jobs/ caught their own errors, so a
// failed run was recorded by BullMQ as completed and worker.on('failed')
// could never fire. runJob() in src/jobs/jobMetrics.ts records the run and
// rethrows, so the failure is both counted and stored as failed. These
// tests drive the real helper (and one real worker) rather than poking the
// registry, so a call site that forgets to record — or swallows the error
// again — fails here too.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery, queueOptions, workers } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  queueOptions: [] as any[],
  workers: [] as Array<{ name: string; processor: (job: any) => Promise<void> }>,
}))

vi.mock('../src/db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

// bullmq pulls in ioredis at import time; stub it so the unit under test
// loads without a live Redis connection. The stub captures the processor
// each worker registers and the options each queue is created with, so the
// tests can drive a worker by hand and check the attempts pinning.
vi.mock('bullmq', () => {
  class Queue {
    name: string
    constructor(name: string, options?: any) {
      this.name = name
      queueOptions.push(options)
    }
    async add() {
      return { id: '1' }
    }
    async close() {}
  }
  class Worker {
    processor: (job: any) => Promise<void>
    constructor(name: string, processor: (job: any) => Promise<void>) {
      this.processor = processor
      workers.push({ name, processor })
    }
    on() {}
    async close() {}
  }
  return { Queue, Worker }
})

// The retention job logs batch progress through the structured logger;
// capture those calls without touching stdout.
const { retentionLogger } = vi.hoisted(() => ({
  retentionLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}))

vi.mock('../src/logger', () => ({
  createLogger: () => retentionLogger,
  logger: retentionLogger,
  loggerOptions: () => ({}),
  createDestination: () => ({ write: () => {} }),
}))

import {
  register,
  job_runs_total,
  job_duration_seconds,
  job_last_success_timestamp,
  job_rows_deleted_total,
} from '../src/metrics'
import { runJob, recordJobRowsDeleted, JOB_NAMES } from '../src/jobs/jobMetrics'
import {
  createSnapshotRetentionQueue,
  startSnapshotRetentionWorker,
} from '../src/jobs/snapshotRetention'
import { activeNetwork } from '../src/config'

/** Every sample of a metric, keyed by its label set. */
async function samples(name: string) {
  const metric = await register.getSingleMetric(name)!.get()
  return metric.values
}

/** The value of one counter series, or 0 when the series does not exist. */
function seriesValue(
  values: { labels?: Record<string, string | number>; value: number }[],
  wanted: Record<string, string>
): number {
  const found = values.find(v =>
    Object.entries(wanted).every(([key, value]) => String((v.labels as Record<string, string>)[key]) === value)
  )
  return found?.value ?? 0
}

beforeEach(() => {
  vi.clearAllMocks()
  mockQuery.mockReset()
  queueOptions.length = 0
  workers.length = 0
  // The Registry is a module singleton shared by everything in this file, so
  // every metric touched here is reset between cases.
  job_runs_total.reset()
  job_duration_seconds.reset()
  job_last_success_timestamp.reset()
  job_rows_deleted_total.reset()
})

describe('runJob', () => {
  it('counts a success, stamps last success, observes duration, and returns the value', async () => {
    const before = Math.floor(Date.now() / 1000)
    const result = await runJob('snapshot-retention', 'testnet', async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return 42
    })

    expect(result).toBe(42)
    expect(seriesValue(await samples('job_runs_total'), { job: 'snapshot-retention', network: 'testnet', outcome: 'success' })).toBe(1)
    expect(seriesValue(await samples('job_runs_total'), { job: 'snapshot-retention', network: 'testnet', outcome: 'failure' })).toBe(0)

    const lastSuccess = seriesValue(await samples('job_last_success_timestamp'), { job: 'snapshot-retention', network: 'testnet' })
    expect(lastSuccess).toBeGreaterThanOrEqual(before)
    expect(lastSuccess).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))

    // One observation, of a run that actually took time.
    const exposition = await register.metrics()
    expect(exposition).toMatch(/job_duration_seconds_count\{[^}]*job="snapshot-retention",network="testnet"[^}]*\} 1/)
    const sumLine = exposition
      .split('\n')
      .find(line => line.startsWith('job_duration_seconds_sum{') && line.includes('job="snapshot-retention"'))
    expect(sumLine).toBeDefined()
    expect(parseFloat(sumLine!.split('}')[1])).toBeGreaterThan(0)
  })

  it('counts a failure, leaves last success untouched, still observes duration, and rethrows', async () => {
    const failure = new Error('prune exploded')

    await expect(
      runJob('snapshot-retention', 'testnet', async () => {
        throw failure
      })
    ).rejects.toThrow('prune exploded')

    expect(seriesValue(await samples('job_runs_total'), { job: 'snapshot-retention', network: 'testnet', outcome: 'failure' })).toBe(1)
    expect(seriesValue(await samples('job_runs_total'), { job: 'snapshot-retention', network: 'testnet', outcome: 'success' })).toBe(0)
    // No success ever happened, so there is no last-success series at all —
    // a failing job goes stale instead of looking healthy.
    expect(seriesValue(await samples('job_last_success_timestamp'), { job: 'snapshot-retention', network: 'testnet' })).toBe(0)

    const exposition = await register.metrics()
    expect(exposition).toMatch(/job_duration_seconds_count\{[^}]*job="snapshot-retention",network="testnet"[^}]*\} 1/)
  })

  it('keeps one series per network for the same job', async () => {
    await runJob('venue-reconciliation', 'testnet', async () => undefined)
    await runJob('venue-reconciliation', 'mainnet', async () => undefined)

    const values = await samples('job_runs_total')
    expect(seriesValue(values, { job: 'venue-reconciliation', network: 'testnet', outcome: 'success' })).toBe(1)
    expect(seriesValue(values, { job: 'venue-reconciliation', network: 'mainnet', outcome: 'success' })).toBe(1)
  })
})

describe('recordJobRowsDeleted', () => {
  it('adds deleted rows to the counter', async () => {
    recordJobRowsDeleted('snapshot-retention', 'mainnet', 12)
    recordJobRowsDeleted('snapshot-retention', 'mainnet', 3)

    expect(seriesValue(await samples('job_rows_deleted_total'), { job: 'snapshot-retention', network: 'mainnet' })).toBe(15)
  })

  it('does not create a series for zero rows', async () => {
    recordJobRowsDeleted('snapshot-retention', 'mainnet', 0)

    expect(await samples('job_rows_deleted_total')).toHaveLength(0)
  })
})

describe('label cardinality', () => {
  it('labels job metrics by job and network only — never pair or pool', async () => {
    await runJob('aggregate-refresh', 'testnet', async () => undefined)
    await runJob('price-points-retention', 'mainnet', async () => undefined)
    recordJobRowsDeleted('price-points-retention', 'mainnet', 7)

    for (const name of ['job_runs_total', 'job_duration_seconds', 'job_last_success_timestamp', 'job_rows_deleted_total']) {
      for (const sample of await samples(name)) {
        // `app` is the registry-wide default label, `le` is prom-client's
        // own histogram-bucket label; every other label must be job,
        // network or (on the runs counter) outcome — never pair or pool.
        for (const label of Object.keys(sample.labels ?? {})) {
          expect(['app', 'job', 'network', 'outcome', 'le']).toContain(label)
        }
        expect(JOB_NAMES as readonly string[]).toContain(String((sample.labels as Record<string, string>).job))
        expect(['testnet', 'mainnet']).toContain(String((sample.labels as Record<string, string>).network))
      }
    }
  })
})

describe('snapshot retention worker (#696)', () => {
  it('pins one attempt on its queue, so a failed run is stored as failed, not retried forever', () => {
    createSnapshotRetentionQueue()

    expect(queueOptions).toHaveLength(1)
    expect(queueOptions[0]?.defaultJobOptions).toEqual({ attempts: 1 })
  })

  it('rejects when the prune throws, so BullMQ stores the run as failed, and counts the failure', async () => {
    mockQuery.mockRejectedValue(new Error('boom'))
    startSnapshotRetentionWorker()

    // The processor rejecting is what BullMQ records as a failed job; the
    // old handler resolved here, which is exactly the bug.
    await expect(workers[0].processor({})).rejects.toThrow(`${activeNetwork}: boom`)
    expect(seriesValue(await samples('job_runs_total'), { job: 'snapshot-retention', network: activeNetwork, outcome: 'failure' })).toBe(1)
    expect(seriesValue(await samples('job_runs_total'), { job: 'snapshot-retention', network: activeNetwork, outcome: 'success' })).toBe(0)
  })

  it('resolves and counts a success when the prune completes', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 })
    startSnapshotRetentionWorker()

    await expect(workers[0].processor({})).resolves.toBeUndefined()
    expect(seriesValue(await samples('job_runs_total'), { job: 'snapshot-retention', network: activeNetwork, outcome: 'success' })).toBe(1)
  })
})
