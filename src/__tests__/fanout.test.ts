import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { metricLabelValues } = vi.hoisted(() => ({
  metricLabelValues: [] as Array<{ metric: string; value: string }>,
}))

vi.mock('ioredis', () => {
  const mockRedis = {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  }
  return {
    default: vi.fn(() => mockRedis),
  }
})

vi.mock('../redis', () => ({
  redis: {
    publish: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  },
}))

// `fanout.ts` reads `config.pairs` once at module load to build the bounded
// label domain. The test environment configures no pairs, so stub one here —
// otherwise the watched-pair branch is unreachable and the assertion below
// would pass for the wrong reason.
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>()
  return {
    ...actual,
    config: { ...actual.config, pairs: [{ pairKey: 'XLM/USDC' }] },
  }
})

vi.mock('../events', () => ({
  priceEmitter: {
    on: vi.fn(),
    off: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  },
  PRICE_UPDATE: 'price:update',
  PriceUpdateEvent: class {},
}))

vi.mock('prom-client', () => {
  function MockMetric(options: { name: string }) {
    const metricName = options.name
    this.inc = vi.fn()
    this.dec = vi.fn()
    this.set = vi.fn()
    this.labels = vi.fn((value: string) => {
      metricLabelValues.push({ metric: metricName, value })
      return this
    })
    this.observe = vi.fn()
    this.startTimer = vi.fn(() => vi.fn())
  }
  return {
    register: { metrics: vi.fn().mockResolvedValue('') },
    // src/metrics.ts builds its own Registry; src/ws/fanout.ts registers the
    // websocket metrics on it so /metrics actually exports them.
    Registry: class {
      setDefaultLabels() {}
      registerMetric() {}
      metrics() { return Promise.resolve('') }
      getSingleMetric() { return undefined }
      resetMetrics() { return Promise.resolve('') }
    },
    Gauge: MockMetric,
    Counter: MockMetric,
    Histogram: MockMetric,
  }
})

import { fanOutManager } from '../ws/fanout'

// The pair this deployment "watches" for the purposes of these tests. A real
// deployment gets this from configuration; the test environment configures no
// pairs at all, so without a stub the watched-pair branch below would never be
// exercised and would silently rot.
const WATCHED_PAIR = 'XLM/USDC'

describe('FanOutManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    metricLabelValues.length = 0
  })

  afterEach(async () => {
    await fanOutManager.destroy()
  })

  it('registers a client and returns an unsubscribe function', () => {
    const mockSocket = {
      id: 'client-1',
      send: vi.fn(),
      close: vi.fn(),
    }

    const unsubscribe = fanOutManager.register('XLM/USDC', mockSocket)
    expect(unsubscribe).toBeInstanceOf(Function)

    unsubscribe()
    unsubscribe()
  })

  it('handles client disconnection gracefully', () => {
    const mockSocket = {
      id: 'client-3',
      send: vi.fn(),
      close: vi.fn(),
    }

    const unsubscribe = fanOutManager.register('XLM/USDC', mockSocket)
    unsubscribe()
  })

  it('multiple clients on different pairs register correctly', () => {
    const client1 = { id: 'client-5', send: vi.fn(), close: vi.fn() }
    const client2 = { id: 'client-6', send: vi.fn(), close: vi.fn() }

    const unsub1 = fanOutManager.register('XLM/USDC', client1)
    const unsub2 = fanOutManager.register('BTC/USDT', client2)

    expect(unsub1).toBeInstanceOf(Function)
    expect(unsub2).toBeInstanceOf(Function)
  })

  it('uses bounded metric labels for arbitrary pair subscriptions and keeps the aggregate', () => {
    const unsubscribers: Array<() => void> = []
    for (let i = 0; i < 100; i++) {
      unsubscribers.push(fanOutManager.register(`TOKEN${i}/ISSUER${i}`, {
        id: `unknown-pair-${i}`,
        send: vi.fn(),
        close: vi.fn(),
      }))
    }

    const clientLabels = metricLabelValues
      .filter(({ metric }) => metric === 'ws_clients_total')
      .map(({ value }) => value)
    expect(new Set(clientLabels)).toEqual(new Set(['other', '*']))
    expect(clientLabels.filter(value => value === 'other')).toHaveLength(100)
    expect(clientLabels.filter(value => value === '*')).toHaveLength(100)

    unsubscribers.forEach(unsubscribe => unsubscribe())
  })

  it('keeps a watched pair as its own label, so per-pair subscribers stay visible', () => {
    // `config.pairs` is operator-defined and fixed for the process, so it is a
    // bounded label domain. Collapsing it into `other` would be safe but would
    // make "which pair has subscribers" unanswerable on the dashboard.
    const unsubscribe = fanOutManager.register(WATCHED_PAIR, {
      id: 'watched-pair-client',
      send: vi.fn(),
      close: vi.fn(),
    })

    const clientLabels = metricLabelValues
      .filter(({ metric }) => metric === 'ws_clients_total')
      .map(({ value }) => value)

    expect(clientLabels).toContain(WATCHED_PAIR)
    expect(clientLabels).not.toContain('other')

    unsubscribe()
  })

  it('counts a wildcard subscriber once in the aggregate series', () => {
    fanOutManager.register('*', { id: 'wildcard-client', send: vi.fn(), close: vi.fn() })

    expect(metricLabelValues.filter(({ metric, value }) =>
      metric === 'ws_clients_total' && value === '*'
    )).toHaveLength(1)
  })

  it('destroy cleans up all state idempotently', async () => {
    const mockSocket = {
      id: 'client-cleanup',
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('XLM/USDC', mockSocket)
    await fanOutManager.destroy()
    await fanOutManager.destroy() // Idempotent second call
    expect(mockSocket.close).toHaveBeenCalledWith(1001, 'Server shutting down')
  })

  it('sends deliberate close code 1001 to all connected clients on shutdown (#347)', async () => {
    const socketA = { id: 'client-a', send: vi.fn(), close: vi.fn() }
    const socketB = { id: 'client-b', send: vi.fn(), close: vi.fn() }

    fanOutManager.register('XLM/USDC', socketA)
    fanOutManager.register('BTC/USDC', socketB)

    await fanOutManager.destroy(1001, 'Server shutting down')

    expect(socketA.close).toHaveBeenCalledWith(1001, 'Server shutting down')
    expect(socketB.close).toHaveBeenCalledWith(1001, 'Server shutting down')
  })

  it('respects flush window during shutdown before closing clients (#347)', async () => {
    const socket = { id: 'flush-client', send: vi.fn(), close: vi.fn() }
    fanOutManager.register('XLM/USDC', socket)

    const start = Date.now()
    await fanOutManager.destroy(1001, 'Server shutting down', 50)
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(socket.close).toHaveBeenCalledWith(1001, 'Server shutting down')
  })
})

describe('FanOutClient per-pair subscription', () => {
  it('registers clients for pair-specific broadcasting', () => {
    const mockSocket = {
      id: 'client-pair',
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('ETH/USDC', mockSocket)
  })
})
