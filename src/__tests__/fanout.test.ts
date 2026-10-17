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
    Gauge: MockMetric,
    Counter: MockMetric,
    Histogram: MockMetric,
  }
})

import { fanOutManager } from '../ws/fanout'

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

  it('handles client disconnection gracefully and cleans up both internal maps', () => {
    const mockSocket = {
      id: 'client-3',
      send: vi.fn(),
      close: vi.fn(),
    }

    expect(fanOutManager.getClientCount()).toBe(0)
    expect(fanOutManager.getPairClientCount('XLM/USDC')).toBe(0)

    const unsubscribe = fanOutManager.register('XLM/USDC', mockSocket)
    expect(fanOutManager.getClientCount()).toBe(1)
    expect(fanOutManager.getPairClientCount('XLM/USDC')).toBe(1)
    expect(fanOutManager.hasClient('client-3')).toBe(true)
    expect(fanOutManager.hasPairClient('XLM/USDC', 'client-3')).toBe(true)

    unsubscribe()

    expect(fanOutManager.getClientCount()).toBe(0)
    expect(fanOutManager.getPairClientCount('XLM/USDC')).toBe(0)
    expect(fanOutManager.hasClient('client-3')).toBe(false)
    expect(fanOutManager.hasPairClient('XLM/USDC', 'client-3')).toBe(false)
  })

  it('unregisters client and leaves remaining clients in pairClients correctly', () => {
    const clientA = { id: 'client-a', send: vi.fn(), close: vi.fn() }
    const clientB = { id: 'client-b', send: vi.fn(), close: vi.fn() }

    const unsubA = fanOutManager.register('XLM/USDC', clientA)
    const unsubB = fanOutManager.register('XLM/USDC', clientB)

    expect(fanOutManager.getClientCount()).toBe(2)
    expect(fanOutManager.getPairClientCount('XLM/USDC')).toBe(2)

    unsubA()

    expect(fanOutManager.getClientCount()).toBe(1)
    expect(fanOutManager.getPairClientCount('XLM/USDC')).toBe(1)
    expect(fanOutManager.hasClient('client-a')).toBe(false)
    expect(fanOutManager.hasClient('client-b')).toBe(true)
    expect(fanOutManager.hasPairClient('XLM/USDC', 'client-a')).toBe(false)
    expect(fanOutManager.hasPairClient('XLM/USDC', 'client-b')).toBe(true)

    unsubB()

    expect(fanOutManager.getClientCount()).toBe(0)
    expect(fanOutManager.getPairClientCount('XLM/USDC')).toBe(0)
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

  it('counts a wildcard subscriber once in the aggregate series', () => {
    fanOutManager.register('*', { id: 'wildcard-client', send: vi.fn(), close: vi.fn() })

    expect(metricLabelValues.filter(({ metric, value }) =>
      metric === 'ws_clients_total' && value === '*'
    )).toHaveLength(1)
  })

  it('destroy cleans up all state', async () => {
    const mockSocket = {
      id: 'client-cleanup',
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('XLM/USDC', mockSocket)
    await fanOutManager.destroy()
    await fanOutManager.destroy()
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
