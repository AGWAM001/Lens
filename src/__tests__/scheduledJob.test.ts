import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { queues, workers, addImpl } = vi.hoisted(() => ({
  queues: [] as Array<{ name: string; opts: any; add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  workers: [] as Array<{ name: string; processor: () => Promise<unknown>; opts: any; close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }>,
  addImpl: { fn: (..._args: unknown[]): Promise<unknown> => Promise.resolve({}) },
}))

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn((...args: unknown[]) => addImpl.fn(...args))
    close = vi.fn(async () => {})
    constructor(public name: string, public opts: any) {
      queues.push(this as any)
    }
  },
  Worker: class {
    close = vi.fn(async () => {})
    on = vi.fn()
    constructor(public name: string, public processor: () => Promise<unknown>, public opts: any) {
      workers.push(this as any)
    }
  },
}))

const { jobLogger } = vi.hoisted(() => ({
  jobLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => jobLogger,
  logger: jobLogger,
}))

import { startScheduledJob, type ScheduledJobDefinition } from '../jobs/scheduledJob'

function definition(run: () => Promise<void>): ScheduledJobDefinition {
  return { name: 'demo-job', queueName: 'testnet:demo-job', everyMs: 60_000, firstRunDelayMs: 5_000, run }
}

describe('startScheduledJob', () => {
  beforeEach(() => {
    queues.length = 0
    workers.length = 0
    addImpl.fn = () => Promise.resolve({})
    for (const fn of Object.values(jobLogger)) fn.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules a BullMQ repeat plus a delayed first run, without running the job itself', async () => {
    const run = vi.fn(async () => {})

    const handle = await startScheduledJob(definition(run))

    expect(handle.path).toBe('redis_queue')
    expect(run).not.toHaveBeenCalled()
    expect(queues).toHaveLength(1)
    expect(queues[0].name).toBe('testnet:demo-job')
    expect(queues[0].opts.defaultJobOptions).toEqual({ attempts: 1 })
    expect(queues[0].add.mock.calls).toEqual([
      ['demo-job', {}, { repeat: { every: 60_000 }, jobId: 'demo-job:repeat' }],
      ['demo-job', {}, { delay: 5_000 }],
    ])
    expect(workers[0].opts.concurrency).toBe(1)

    await handle.stop()
    expect(queues[0].close).toHaveBeenCalled()
    expect(workers[0].close).toHaveBeenCalled()
  })

  it('lets a failed run reject inside the worker so BullMQ stores the job as failed', async () => {
    const run = vi.fn(async () => { throw new Error('boom') })
    await startScheduledJob(definition(run))

    await expect(workers[0].processor()).rejects.toThrow('boom')
  })

  it('falls back to an in-process timer when the queue cannot be scheduled, closing what BullMQ opened', async () => {
    vi.useFakeTimers()
    addImpl.fn = () => Promise.reject(new Error('ECONNREFUSED'))
    const run = vi.fn(async () => {})

    const handle = await startScheduledJob(definition(run))

    expect(handle.path).toBe('in_process')
    expect(queues[0].close).toHaveBeenCalled()
    expect(workers[0].close).toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)

    await handle.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('logs a failed in-process run instead of throwing, and skips a tick while a run is still going', async () => {
    vi.useFakeTimers()
    addImpl.fn = () => Promise.reject(new Error('ECONNREFUSED'))
    let finish: () => void = () => {}
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
      .mockImplementationOnce(async () => { throw new Error('db down') })

    const handle = await startScheduledJob(definition(run))

    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
    // The hourly tick fires while the first run is still in progress.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(jobLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/still in progress/))

    finish()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(jobLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'demo-job run failed')

    await handle.stop()
  })
})
