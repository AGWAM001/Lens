/**
 * #237 — synthesized event ids must be deterministic from the row's content.
 *
 * The AMM-snapshot and Soroswap ingesters used to mint `...-${Date.now()}`
 * event ids. A Date.now()-derived id is a random id one floor removed: an
 * ingester retrying the same poll (or two instances overlapping during a
 * deploy) produces a *different* id for the *same* pool state every time, so
 * the unique index on (network, source, event_id) can never catch the replay.
 *
 * These tests pin both venues to content-derived ids: same pool state, any
 * wall-clock time, same event id — and a changed pool state still yields a
 * new id.
 */
vi.mock('../db', () => ({
  prisma: {
    poolSnapshot: { create: vi.fn().mockResolvedValue({}) },
  },
  upsertPricePoints: vi.fn().mockResolvedValue(1),
  getIndexerState: vi.fn(),
  setIndexerCursor: vi.fn(),
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../events', () => ({
  publishPriceUpdate: vi.fn(),
}))

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { snapshotPool } from '../ingest/venues/amm'
import { soroswapAdapter } from '../ingest/venues/soroswap'
import { upsertPricePoints } from '../db'

const mockPair = {
  pairKey: 'XLM/USDC',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
}

const ammPool = {
  id: '0000a8198b5e25994c1ca5b0556faeb27325ac746296944144e0a7406d501e8a',
  reserves: [
    { asset: 'native', amount: '100.0' },
    { asset: 'USD:GABC...', amount: '20.0' },
  ],
  total_shares: '50',
  last_modified_ledger: 12345,
}

const soroswapTarget = {
  poolAddress: 'CPOOL000000000000000000000000000000000000000000000000001234',
  tokenA: { address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBB', symbol: 'XLM', name: 'Lumens', decimals: 7 },
  tokenB: { address: 'CPOOL000000000000000000000000000000000000000000000000005678', symbol: 'USDC', name: 'USD Coin', decimals: 7 },
}

function lastWrittenEventId(): string {
  const calls = (upsertPricePoints as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0][0].eventId
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AMM snapshot event id is content-derived (#237)', () => {
  it('is identical for the same pool state at different wall-clock times', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-17T08:00:00.000Z'))
      await snapshotPool(ammPool, mockPair as any, 'testnet')
      const first = lastWrittenEventId()

      // A retry 30s later — or an overlapping instance — sees the same pool
      // state (same last_modified_ledger) and must produce the same id.
      vi.setSystemTime(new Date('2026-10-17T08:00:30.000Z'))
      await snapshotPool(ammPool, mockPair as any, 'testnet')
      expect(lastWrittenEventId()).toBe(first)
    } finally {
      vi.useRealTimers()
    }
    expect(upsertPricePoints).toHaveBeenCalledTimes(2)
  })

  it('changes when the pool state changes', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-17T08:00:00.000Z'))
      await snapshotPool(ammPool, mockPair as any, 'testnet')
      const first = lastWrittenEventId()

      await snapshotPool({ ...ammPool, last_modified_ledger: 12346 }, mockPair as any, 'testnet')
      expect(lastWrittenEventId()).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Soroswap snapshot event id is content-derived (#237)', () => {
  it('is identical for the same reserves at different wall-clock times', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-17T08:00:00.000Z'))
      const [first] = soroswapAdapter.derive([10_000_000n, 2_000_000n], soroswapTarget, mockPair as any, 'testnet')

      vi.setSystemTime(new Date('2026-10-17T08:00:30.000Z'))
      const [second] = soroswapAdapter.derive([10_000_000n, 2_000_000n], soroswapTarget, mockPair as any, 'testnet')

      expect(second.eventId).toBe(first.eventId)
      expect(first.eventId).toEqual(expect.any(String))
    } finally {
      vi.useRealTimers()
    }
  })

  it('changes when the reserves change', () => {
    const [a] = soroswapAdapter.derive([10_000_000n, 2_000_000n], soroswapTarget, mockPair as any, 'testnet')
    const [b] = soroswapAdapter.derive([10_000_000n, 2_100_000n], soroswapTarget, mockPair as any, 'testnet')
    expect(b.eventId).not.toBe(a.eventId)
  })
})
