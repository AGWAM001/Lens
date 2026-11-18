/**
 * Backpressure for slow websocket consumers.
 *
 * The bug this covers: `send()` neither blocks nor throws when a peer stops
 * reading, it queues. With nothing inspecting `bufferedAmount`, one subscriber
 * on a bad mobile connection could grow the process until it was OOM-killed —
 * taking every other subscriber with it. The assertions below drive a socket
 * that accepts data and never flushes it, and check that what it holds stays
 * bounded, that it eventually gets dropped, and that nothing it does affects
 * any other client.
 *
 * Metrics are read from the real registry (no mock) because the
 * counts themselves are the point: a truncated feed that is not counted is
 * indistinguishable from a healthy one.
 *
 * The thresholds are set in the environment *before* the module is imported —
 * they are resolved once at import, because they are read on the price-update
 * path. They are deliberately tiny here so a handful of updates reaches them;
 * `resolveBackpressureLimits` is unit-tested separately against the shipped
 * defaults.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { register } from '../metrics'

const { mockIoredis } = vi.hoisted(() => ({
  mockIoredis: vi.fn(),
}))

vi.mock('ioredis', () => {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
  }
  // A `function`, not an arrow: fanout constructs it with `new`.
  mockIoredis.mockImplementation(function () {
    return client
  })
  return { default: mockIoredis }
})

vi.mock('../redis', () => ({
  redis: { publish: vi.fn().mockResolvedValue(1), on: vi.fn() },
}))

// Small enough that a stalled socket reaches them in a handful of ticks, and a
// coalesce window of 0 so every update attempts a send instead of being held by
// the rate limiter.
const SOFT_LIMIT = 1024
const HARD_LIMIT = 4096
const MAX_CONGESTED_MS = 300

process.env.WS_COALESCE_INTERVAL_MS = '0'
process.env.WS_SLOW_CLIENT_BUFFER_BYTES = String(SOFT_LIMIT)
process.env.WS_MAX_BUFFERED_BYTES = String(HARD_LIMIT)
process.env.WS_MAX_CONGESTED_MS = String(MAX_CONGESTED_MS)
process.env.WS_BUFFER_SWEEP_INTERVAL_MS = '25'

const fanout = await import('../ws/fanout')
const { priceEmitter, PRICE_UPDATE } = await import('../events')
const { resolveBackpressureLimits, DEFAULT_BACKPRESSURE_LIMITS } = await import('../ws/backpressure')

/** Aggregate (`*`) total of a counter. */
async function counterTotal(name: string): Promise<number> {
  const metric = (await register.getSingleMetric(name))!.get()
  return metric.then(res =>
    res.values
      .filter(v => v.labels.pair === '*')
      .reduce((sum, v) => sum + v.value, 0)
  )
}

/** Current value of the aggregate buffered-bytes gauge. */
async function bufferedGauge(): Promise<number> {
  const metric = (await register.getSingleMetric('ws_buffered_bytes'))!.get()
  return metric.then(res =>
    res.values
      .filter(v => v.labels.pair === '*')
      .reduce((max, v) => Math.max(max, v.value), 0)
  )
}

interface StalledSocket {
  id: string
  send: (data: string, cb?: (err?: Error | null) => void) => void
  close: (code?: number, reason?: string) => void
  bufferedAmount: () => number
  /** Bytes the fake OS receive window is holding. */
  bytesHeld: number
  /** Frames handed to `send`, i.e. queued in the socket's buffer. */
  framesQueued: number
  closeCalls: Array<{ code?: number; reason?: string }>
  /** Let the peer drain, as a real socket does once a reader reappears. */
  drain: (bytes: number) => void
}

/**
 * A socket that accepts frames and never writes them out — the stalled-peer
 * case. `bytesHeld` grows by the frame size on every send and only falls when
 * `drain()` is called, which is how `ws`' `bufferedAmount` behaves for a peer
 * that has stopped reading.
 */
function stalledSocket(id: string, initialHeld = 0): StalledSocket {
  const socket: StalledSocket = {
    id,
    bytesHeld: initialHeld,
    framesQueued: 0,
    closeCalls: [],
    send(data: string) {
      socket.framesQueued++
      socket.bytesHeld += Buffer.byteLength(data)
      // Never calls `cb` — the write never completes.
    },
    close(code?: number, reason?: string) {
      socket.closeCalls.push({ code, reason })
    },
    bufferedAmount: () => socket.bytesHeld,
    drain(bytes: number) {
      socket.bytesHeld = Math.max(0, socket.bytesHeld - bytes)
    },
  }
  return socket
}

/** A socket that writes everything through, as a healthy client does. */
function healthySocket(id: string) {
  const received: string[] = []
  return {
    id,
    received,
    send: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      received.push(data)
      cb?.()
    }),
    close: vi.fn(),
    bufferedAmount: () => 0,
  }
}

function priceUpdate(price: number) {
  return {
    assetA: 'XLM',
    assetB: 'USDC',
    previousPrice: price,
    currentPrice: price + 0.001,
    timestamp: new Date(0),
  }
}

function emit(count: number, from = 0): void {
  for (let i = 0; i < count; i++) priceEmitter.emit(PRICE_UPDATE, priceUpdate(from + i))
}

beforeEach(async () => {
  // Each test starts from an empty manager: a client left registered by the
  // previous test keeps receiving updates and quietly doubles every count here.
  // destroy() also clears the emitter subscription, so the next initialize()
  // installs exactly one.
  await fanout.fanOutManager.destroy()
  priceEmitter.removeAllListeners(PRICE_UPDATE)
  await fanout.fanOutManager.initialize()
  for (const metric of [
    'ws_messages_sent_total',
    'ws_messages_dropped_total',
    'ws_clients_dropped_total',
    'ws_buffered_bytes',
  ]) {
    const found = await register.getSingleMetric(metric)
    found?.reset()
  }
})

afterAll(async () => {
  await fanout.fanOutManager.destroy()
})

describe('memory stays bounded for a stalled peer', () => {
  it('never queues past the soft limit, however many updates arrive', async () => {
    const stalled = stalledSocket('stalled-1')
    const unsubscribe = fanout.fanOutManager.register('*', stalled)

    // 2 000 updates, each ~190 bytes of JSON, into a peer that never reads.
    emit(2000)

    // Before this fix the socket held all of it. Coalescing stops the queue at
    // the soft limit instead: the backlog is truncated, not drained.
    expect(stalled.bytesHeld).toBeLessThan(SOFT_LIMIT * 2)
    expect(stalled.bytesHeld).toBeLessThanOrEqual(HARD_LIMIT)
    expect(stalled.framesQueued).toBeLessThan(2000)

    unsubscribe()
  })

  it('holds at the soft limit rather than climbing with every update', async () => {
    const stalled = stalledSocket('stalled-2')
    fanout.fanOutManager.register('*', stalled)

    emit(50)
    const afterFirstBurst = stalled.bytesHeld

    emit(2000, 100)

    // Two thousand more updates changed nothing: the client is congested and
    // the newest update replaced the previous newest one each time.
    expect(stalled.bytesHeld).toBe(afterFirstBurst)
    expect(afterFirstBurst).toBeGreaterThan(0)
    expect(afterFirstBurst).toBeLessThanOrEqual(HARD_LIMIT)
  })

  it('releases the retained payload when the client is dropped', async () => {
    const stalled = stalledSocket('stalled-3')
    fanout.fanOutManager.register('*', stalled)

    emit(10)
    expect(stalled.framesQueued).toBeGreaterThan(0)

    // Cross the hard limit so the client is evicted with an update still held.
    stalled.bytesHeld = HARD_LIMIT
    priceEmitter.emit(PRICE_UPDATE, priceUpdate(11))

    expect(stalled.closeCalls).toEqual([{ code: 1013, reason: 'buffer limit exceeded' }])

    // Unregistered: further updates reach nobody and change nothing.
    const queuedAfterDrop = stalled.framesQueued
    emit(100, 200)
    expect(stalled.framesQueued).toBe(queuedAfterDrop)
    expect(stalled.bytesHeld).toBe(HARD_LIMIT)
  })

  it('coalesces to the newest update while congested, and counts what it dropped', async () => {
    const stalled = stalledSocket('stalled-4', SOFT_LIMIT)
    fanout.fanOutManager.register('*', stalled)

    emit(50)

    expect(stalled.framesQueued).toBe(0)
    expect(await counterTotal('ws_messages_dropped_total')).toBe(49)
  })

  it('reports queued bytes on the aggregate gauge', async () => {
    const stalled = stalledSocket('stalled-5')
    fanout.fanOutManager.register('*', stalled)

    emit(20)
    await new Promise(resolve => setTimeout(resolve, 120))

    expect(await bufferedGauge()).toBe(stalled.bytesHeld)
  })
})

describe('slow-client policy', () => {
  it('closes a client past the hard limit with 1013 and counts it', async () => {
    const stalled = stalledSocket('stalled-6', HARD_LIMIT)
    fanout.fanOutManager.register('*', stalled)

    priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))

    expect(stalled.closeCalls).toEqual([{ code: 1013, reason: 'buffer limit exceeded' }])
    expect(await counterTotal('ws_clients_dropped_total')).toBe(1)
  })

  it('closes a client that stays congested past WS_MAX_CONGESTED_MS', async () => {
    // Congested but nowhere near the hard limit: coalescing already holds the
    // memory, so the only thing left to bound is the time.
    const stalled = stalledSocket('stalled-7', SOFT_LIMIT)
    fanout.fanOutManager.register('*', stalled)

    priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))
    expect(stalled.closeCalls).toHaveLength(0)

    await new Promise(resolve => setTimeout(resolve, MAX_CONGESTED_MS + 100))
    priceEmitter.emit(PRICE_UPDATE, priceUpdate(2))

    expect(stalled.closeCalls).toEqual([{ code: 1013, reason: 'congested too long' }])
    expect(await counterTotal('ws_clients_dropped_total')).toBe(1)
  })

  it('keeps a congested client that recovers before the deadline, and delivers to it', async () => {
    const stalled = stalledSocket('stalled-8', SOFT_LIMIT)
    fanout.fanOutManager.register('*', stalled)

    priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))
    expect(stalled.framesQueued).toBe(0)

    // The peer starts reading again. Coalescing must not have cost it the
    // subscription, and the update it missed must still reach it.
    stalled.drain(SOFT_LIMIT)
    priceEmitter.emit(PRICE_UPDATE, priceUpdate(2))

    expect(stalled.closeCalls).toHaveLength(0)
    expect(stalled.framesQueued).toBe(1)
  })
})

describe('threshold configuration', () => {
  it('reads every limit from the environment', () => {
    const limits = resolveBackpressureLimits({
      WS_COALESCE_INTERVAL_MS: '250',
      WS_SLOW_CLIENT_BUFFER_BYTES: '1024',
      WS_MAX_BUFFERED_BYTES: '8192',
      WS_MAX_CONGESTED_MS: '5000',
    } as NodeJS.ProcessEnv)

    expect(limits).toEqual({
      coalesceIntervalMs: 250,
      slowClientBufferBytes: 1024,
      maxBufferedBytes: 8192,
      maxCongestedMs: 5000,
    })
  })

  it('ships defaults that coalesce at 256 KiB and disconnect at 1 MiB', () => {
    expect(resolveBackpressureLimits({} as NodeJS.ProcessEnv)).toEqual(
      DEFAULT_BACKPRESSURE_LIMITS
    )
    expect(DEFAULT_BACKPRESSURE_LIMITS.slowClientBufferBytes).toBeLessThan(
      DEFAULT_BACKPRESSURE_LIMITS.maxBufferedBytes
    )
  })

  it('clamps the soft limit below the hard one so coalescing always has a window', () => {
    // Otherwise a client past the soft limit is disconnected on its first
    // update over it, and the tier that keeps a slow client connected never runs.
    const limits = resolveBackpressureLimits({
      WS_SLOW_CLIENT_BUFFER_BYTES: '999999',
      WS_MAX_BUFFERED_BYTES: '4096',
    } as NodeJS.ProcessEnv)

    expect(limits.slowClientBufferBytes).toBe(2048)
    expect(limits.maxBufferedBytes).toBe(4096)
  })

  it('falls back to the defaults for unusable values, and allows disabling via 0', () => {
    expect(resolveBackpressureLimits({ WS_MAX_BUFFERED_BYTES: 'lots' } as NodeJS.ProcessEnv))
      .toMatchObject({ maxBufferedBytes: DEFAULT_BACKPRESSURE_LIMITS.maxBufferedBytes })
    expect(resolveBackpressureLimits({ WS_COALESCE_INTERVAL_MS: '0', WS_MAX_CONGESTED_MS: '0' } as NodeJS.ProcessEnv))
      .toMatchObject({ coalesceIntervalMs: 0, maxCongestedMs: 0 })
  })
})

describe('sent accounting', () => {
  it('counts a message only once the socket reports the write', async () => {
    const healthy = healthySocket('healthy-1')
    fanout.fanOutManager.register('*', healthy)

    priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))

    expect(healthy.send).toHaveBeenCalledTimes(1)
    expect(await counterTotal('ws_messages_sent_total')).toBe(1)
  })

  it('does not count a message that was queued but never written', async () => {
    const stalled = stalledSocket('stalled-9')
    fanout.fanOutManager.register('*', stalled)

    priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))

    // `send()` returned, so the old code counted this. The write never
    // completed, so it was not delivered and must not be counted as sent.
    expect(stalled.framesQueued).toBe(1)
    expect(await counterTotal('ws_messages_sent_total')).toBe(0)
  })

  it('unregisters a client whose write fails, without counting it as sent', async () => {
    const send = vi.fn((_data: string, cb?: (err?: Error | null) => void) => cb?.(new Error('EPIPE')))
    fanout.fanOutManager.register('*', { id: 'failing-1', send, close: vi.fn(), bufferedAmount: () => 0 })

    priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))
    priceEmitter.emit(PRICE_UPDATE, priceUpdate(2))

    expect(await counterTotal('ws_messages_sent_total')).toBe(0)
    // Unregistered after the failed write, so the second update went nowhere.
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('survives a client whose send throws synchronously', async () => {
    const client = {
      id: 'throwing-1',
      send: () => {
        throw new Error('socket destroyed')
      },
      close: vi.fn(),
      bufferedAmount: () => 0,
    }
    fanout.fanOutManager.register('*', client)
    const healthy = healthySocket('healthy-2')
    fanout.fanOutManager.register('*', healthy)

    priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))

    expect(await counterTotal('ws_messages_sent_total')).toBe(1)
    expect(healthy.received).toHaveLength(1)
  })

  it('treats a client that cannot report its buffer as unbuffered', () => {
    const client = { id: 'opaque-1', send: vi.fn(), close: vi.fn() }
    expect(() => fanout.fanOutManager.register('*', client)).not.toThrow()
    expect(() => priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))).not.toThrow()
  })
})

describe('scrape visibility', () => {
  it('exports the backpressure metrics on the registry /metrics renders', async () => {
    // They used to be created on prom-client's global default registry, which
    // `/metrics` does not render — so a slow client was counted somewhere
    // Prometheus never looks.
    const healthy = healthySocket('healthy-6')
    fanout.fanOutManager.register('*', healthy)
    priceEmitter.emit(PRICE_UPDATE, priceUpdate(1))

    const scrape = await register.metrics()
    for (const name of [
      'ws_clients_total',
      'ws_messages_sent_total',
      'ws_messages_dropped_total',
      'ws_clients_dropped_total',
      'ws_buffered_bytes',
    ]) {
      expect(scrape, name).toContain(name)
    }
    expect(scrape).toMatch(/ws_messages_sent_total\{[^}]*pair="\*"[^}]*\} 1/)
  })
})

describe('one slow client cannot affect another', () => {
  it('keeps delivering to healthy clients while a stalled one is dropped', async () => {
    const healthy = healthySocket('healthy-3')
    const stalled = stalledSocket('stalled-10', HARD_LIMIT)
    const otherHealthy = healthySocket('healthy-4')
    fanout.fanOutManager.register('*', healthy)
    fanout.fanOutManager.register('*', stalled)
    fanout.fanOutManager.register('*', otherHealthy)

    emit(20)

    expect(stalled.closeCalls).toHaveLength(1)
    expect(healthy.received).toHaveLength(20)
    expect(otherHealthy.received).toHaveLength(20)
    expect(await counterTotal('ws_messages_sent_total')).toBe(40)
  })

  it('delivers every update to a healthy client while a congested one is coalescing', async () => {
    const healthy = healthySocket('healthy-5')
    const stalled = stalledSocket('stalled-11', SOFT_LIMIT)
    fanout.fanOutManager.register('*', healthy)
    fanout.fanOutManager.register('*', stalled)

    emit(100)

    expect(healthy.received).toHaveLength(100)
    expect(stalled.framesQueued).toBe(0)
    expect(stalled.closeCalls).toHaveLength(0)
  })
})