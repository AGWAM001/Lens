/**
 * Issue #351 — per-cycle deadline acceptance tests.
 *
 * The headline case is the one the issue exists for: a slow upstream must not
 * stall an ingester loop. The loop keeps ticking, cycles that overrun their
 * deadline are abandoned and counted (`venue`, `network`), no two cycles
 * against the same venue ever overlap, and an abandoned cycle never gets to
 * start a write it would leave half-done.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  upsertPricePoints: vi.fn(),
  getIndexerState: vi.fn(),
  setIndexerCursor: vi.fn(),
  getActivePairs: vi.fn(),
  dispatchPriceUpdate: vi.fn(),
  publishPriceUpdate: vi.fn(),
  sdexCall: vi.fn(),
}))

vi.mock('../db', () => ({
  upsertPricePoints: mocks.upsertPricePoints,
  getIndexerState: mocks.getIndexerState,
  setIndexerCursor: mocks.setIndexerCursor,
  prisma: { poolSnapshot: { create: vi.fn() } },
  pgPool: { query: vi.fn() },
}))
vi.mock('../pairsRegistry', () => ({ getActivePairs: mocks.getActivePairs }))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: mocks.dispatchPriceUpdate }))
vi.mock('../events', () => ({ publishPriceUpdate: mocks.publishPriceUpdate }))
vi.mock('../network/clients', () => {
  const server: any = {
    trades: () => server,
    forAssetPair: () => server,
    cursor: () => server,
    limit: () => server,
    order: () => server,
    call: () => mocks.sdexCall(),
  }
  return { getHorizonServer: () => server, getRpcServer: () => ({}) }
})

import {
  runCycleWithDeadline,
  getCycleDeadlineMs,
  DEFAULT_CYCLE_DEADLINE_MS,
} from '../ingest/cycleDeadline'
import { startVenueAdapter, type VenueAdapter } from '../ingest/venues/runner'
import { ingestPair as sdexIngestPair } from '../ingest/venues/sdex'
import { ingester_abandoned_cycles_total } from '../metrics'

// Full issuer — never elide an address in a fixture (#351 house rule).
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const pair = {
  pairKey: 'XLM/USDC',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: USDC_ISSUER },
}

/** One Horizon SDEX trade record; synthetic paging tokens fall back to the stored ledger. */
function trade(iso: string, id: string) {
  return {
    id,
    paging_token: `p-${id}`,
    base_asset_type: 'native',
    base_asset_code: 'XLM',
    base_amount: '100.0',
    counter_amount: '20.0',
    price: { n: 1, d: 5 },
    ledger_close_time: iso,
  }
}

/** Sum of all samples on the abandoned-cycle counter (0 if it never fired). */
async function abandonedTotal(): Promise<number> {
  const metric = await ingester_abandoned_cycles_total.get()
  return metric.values.reduce((sum, v) => sum + v.value, 0)
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ingester_abandoned_cycles_total.reset()
  mocks.getIndexerState.mockResolvedValue({ cursor: '0', ledger: 64702061 })
  mocks.getActivePairs.mockReturnValue([pair])
  mocks.upsertPricePoints.mockResolvedValue(1)
  mocks.setIndexerCursor.mockResolvedValue(undefined)
  mocks.dispatchPriceUpdate.mockResolvedValue(undefined)
})

describe('slow upstream (#351 acceptance)', () => {
  it('keeps the loop making progress when an upstream is slower than the cycle deadline', async () => {
    // Per-ingester deadline through the real resolution path: venue key
    // SLOWDEX (adapter name SlowDEX), testnet network.
    process.env.INGEST_CYCLE_DEADLINE_MS_SLOWDEX = '50'

    const stop = new AbortController()
    let started = 0
    let active = 0
    let maxActive = 0

    const slowAdapter: VenueAdapter = {
      name: 'SlowDEX',
      source: 'slow_dex',
      sourceTimeCapability: { status: 'unavailable' },
      isEnabled: () => true,
      getPollIntervalMs: () => 10,
      discover: async () => [],
      read: async () => null,
      derive: () => [],
      write: async () => {},
      ingestPair: async () => {
        started++
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 250))
        active--
      },
    }

    const loop = startVenueAdapter(slowAdapter, 'testnet', { stopSignal: stop.signal })

    // Cycle 1 abandons at 50ms but the loop must resume and start cycle 2,
    // then cycle 3: progress with an upstream that is 5x over its deadline.
    await waitFor(() => started >= 3, 5_000)

    stop.abort()
    await loop

    expect(started).toBeGreaterThanOrEqual(3)
    // Abandonment must be strictly sequential — never two at once.
    expect(maxActive).toBe(1)
    expect(await abandonedTotal()).toBeGreaterThanOrEqual(2)

    const metric = await ingester_abandoned_cycles_total.get()
    expect(metric.values.length).toBeGreaterThan(0)
    for (const v of metric.values) {
      // The labels #351 asks for: which loop, on which network.
      expect(v.labels).toMatchObject({ venue: 'SlowDEX', network: 'testnet' })
    }
  }, 15_000)

  it('never lets an abandoned cycle start a write, and never splits a unit that did start', async () => {
    // (a) The round trip is still in flight when the deadline fires. When it
    // finally returns, the write checkpoint must skip the whole unit: no
    // upsert, no cursor advance — nothing partial, nothing post-abandon.
    mocks.sdexCall.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ records: [trade('2024-06-01T00:00:00Z', 't-1')] }), 200)
        )
    )

    const slow = await runCycleWithDeadline({
      venue: 'SDEX',
      network: 'testnet',
      deadlineMs: 50,
      cycle: (signal) => sdexIngestPair(pair as never, 'testnet', signal),
    })

    expect(slow.status).toBe('abandoned')
    expect(await abandonedTotal()).toBe(1)
    // The unit's write sequence commits upsert + cursor together or not at all.
    expect(mocks.upsertPricePoints).not.toHaveBeenCalled()
    expect(mocks.setIndexerCursor).not.toHaveBeenCalled()

    // (b) A unit that starts before its deadline commits both statements —
    // cursor advance included, never one without the other.
    mocks.sdexCall.mockResolvedValue({ records: [trade('2024-06-01T00:00:00Z', 't-2')] })

    const fast = await runCycleWithDeadline({
      venue: 'SDEX',
      network: 'testnet',
      deadlineMs: 5_000,
      cycle: (signal) => sdexIngestPair(pair as never, 'testnet', signal),
    })

    expect(fast.status).toBe('completed')
    expect(mocks.upsertPricePoints).toHaveBeenCalledTimes(1)
    expect(mocks.setIndexerCursor).toHaveBeenCalledTimes(1)
    expect(await abandonedTotal()).toBe(1) // (b) must not count as abandoned
  }, 10_000)
})

describe('getCycleDeadlineMs — configurable per ingester (#351)', () => {
  it('falls back to the default with no env set', () => {
    expect(getCycleDeadlineMs('SDEX', 'testnet')).toBe(DEFAULT_CYCLE_DEADLINE_MS)
  })

  it('resolves venue, network and global overrides with documented precedence', () => {
    process.env.INGEST_CYCLE_DEADLINE_MS = '1000'
    expect(getCycleDeadlineMs('SDEX', 'testnet')).toBe(1000)

    process.env.INGEST_CYCLE_DEADLINE_MS_TESTNET = '2000'
    expect(getCycleDeadlineMs('SDEX', 'testnet')).toBe(2000)
    // The other network still sees the global value.
    expect(getCycleDeadlineMs('SDEX', 'mainnet')).toBe(1000)

    process.env.INGEST_CYCLE_DEADLINE_MS_SDEX = '3000'
    expect(getCycleDeadlineMs('SDEX', 'testnet')).toBe(3000)

    process.env.INGEST_CYCLE_DEADLINE_MS_SDEX_TESTNET = '4000'
    expect(getCycleDeadlineMs('SDEX', 'testnet')).toBe(4000)
  })

  it('folds adapter names into env-safe keys', () => {
    process.env.INGEST_CYCLE_DEADLINE_MS_AQUARIUS = '777'
    expect(getCycleDeadlineMs('Aquarius', 'mainnet')).toBe(777)
  })

  it('falls through on an invalid value instead of disabling the deadline', () => {
    // The behaviour is what matters: a typo must not read as "no deadline",
    // which would restore the unbounded cycle this module exists to prevent.
    // The warning goes through the house logger (so it is redacted like every
    // other line) rather than console.warn, which is why this asserts the
    // fallback rather than spying on a call.
    process.env.INGEST_CYCLE_DEADLINE_MS = 'soon'
    expect(getCycleDeadlineMs('SDEX', 'testnet')).toBe(DEFAULT_CYCLE_DEADLINE_MS)
  })

  it('ignores an invalid specific override and uses the next one that parses', () => {
    // Precedence still applies around a bad value: a broken venue-level
    // override must not shadow a good global one.
    process.env.INGEST_CYCLE_DEADLINE_MS_SDEX = 'whenever'
    process.env.INGEST_CYCLE_DEADLINE_MS = '7000'
    expect(getCycleDeadlineMs('SDEX', 'testnet')).toBe(7_000)
  })

  it('treats 0 as an explicit opt-out that runs the cycle unbounded and uncounted', async () => {
    const result = await runCycleWithDeadline({
      venue: 'SDEX',
      network: 'testnet',
      deadlineMs: 0,
      cycle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
      },
    })
    expect(result.status).toBe('completed')
    expect(await abandonedTotal()).toBe(0)
  })
})

describe('error propagation', () => {
  it('rethrows cycle errors untouched so the runner keeps its backoff', async () => {
    await expect(
      runCycleWithDeadline({
        venue: 'AMM',
        network: 'testnet',
        deadlineMs: 5_000,
        cycle: async () => {
          throw new Error('upstream exploded')
        },
      })
    ).rejects.toThrow('upstream exploded')
    // A failing cycle is a failure, not an abandonment — no metric, no backoff change.
    expect(await abandonedTotal()).toBe(0)
  })
})