import { describe, it, expect, vi } from 'vitest'

import { scheduleRetentionJob, RETENTION_JOB_INTERVAL_MS } from '../jobs/scheduleRetentionJob'

function fakeQueue() {
  return { add: vi.fn(async () => {}) } as any
}

describe('scheduleRetentionJob', () => {
  it('adds an hourly repeatable job and one immediate run by default', async () => {
    const queue = fakeQueue()

    await scheduleRetentionJob(queue, { jobName: 'prune', jobId: 'snapshot-retention:prune' })

    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'prune',
      {},
      { repeat: { every: RETENTION_JOB_INTERVAL_MS }, jobId: 'snapshot-retention:prune' }
    )
    expect(queue.add).toHaveBeenNthCalledWith(2, 'prune', {})
  })

  it('honours a custom job name, job id and interval', async () => {
    const queue = fakeQueue()

    await scheduleRetentionJob(queue, {
      jobName: 'maintain',
      jobId: 'price-points-partition:maintain',
      intervalMs: 5_000,
    })

    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'maintain',
      {},
      { repeat: { every: 5_000 }, jobId: 'price-points-partition:maintain' }
    )
  })

  it('skips the immediate run when runImmediately is false', async () => {
    const queue = fakeQueue()

    await scheduleRetentionJob(queue, { jobName: 'prune', jobId: 'x:prune', runImmediately: false })

    expect(queue.add).toHaveBeenCalledTimes(1)
  })
})
