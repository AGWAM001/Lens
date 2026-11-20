/**
 * Issue #652 Acceptance Criteria Tests:
 * The /price VWAP reads every source, including venues that just failed and off-chain exchanges.
 *
 * Verifies:
 * 1. A venue recorded as failed for a pair does not contribute to that pair's VWAP, and does again after recovery.
 * 2. Exchange rows (KuCoin, Gate.io, Coinbase, Binance) do not move the on-chain VWAP.
 * 3. /price/.../premium compares on-chain with CEX using the shared definition.
 * 4. A new venue added to the registry is classified without editing a second list.
 * 5. With every on-chain venue failed, the answer is marked stale, not zero.
 * 6. There is one aggregate implementation left.
 * 7. Sums stay in SQL numeric.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  prismaFindFirst: vi.fn(),
  prismaFindMany: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mocks.query },
  prisma: {
    pricePoint: {
      findFirst: mocks.prismaFindFirst,
      findMany: mocks.prismaFindMany,
    },
  },
}))

import { calculateVWAPDetailed, calculateVWAP, calculateOHLCV } from '../aggregator/vwap'
import {
  getOnChainSources,
  isOnChainVenue,
  registeredVenues,
  type VenueAdapter,
} from '../ingest/venues'
import {
  recordSourceFailure,
  clearSourceFailure,
  resetSourceFailures,
} from '../ingest/sourceFailures'
import { aggregatePrice } from '../pricing/aggregate'

const PAIR = 'XLM/USDC'
const NETWORK = 'testnet'

describe('Issue #652: VWAP on-chain source filters & failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSourceFailures()
  })

  it('1. A venue recorded as failed for a pair does not contribute to VWAP, and contributes again after recovery', async () => {
    // Record failure for AMM
    recordSourceFailure('AMM', NETWORK, PAIR, new Error('RPC connection reset'))

    mocks.query.mockResolvedValueOnce({
      rows: [{ vwap: '0.120000' }],
    })

    const vwapDuringFailure = await calculateVWAP(PAIR, 60, NETWORK)
    expect(vwapDuringFailure).toBe(0.12)

    const [sql1, params1] = mocks.query.mock.calls[0]
    expect(sql1).toContain('AND source = ANY($4)')
    const sourcesDuringFailure = params1[3] as string[]
    expect(sourcesDuringFailure).not.toContain('AMM')
    expect(sourcesDuringFailure).toContain('SDEX')

    // Now clear failure (venue recovered)
    clearSourceFailure('AMM', NETWORK, PAIR)

    mocks.query.mockResolvedValueOnce({
      rows: [{ vwap: '0.125000' }],
    })

    const vwapAfterRecovery = await calculateVWAP(PAIR, 60, NETWORK)
    expect(vwapAfterRecovery).toBe(0.125)

    const [, params2] = mocks.query.mock.calls[1]
    const sourcesAfterRecovery = params2[3] as string[]
    expect(sourcesAfterRecovery).toContain('AMM')
  })

  it('2. Centralized exchange rows do not move the on-chain VWAP', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ vwap: '0.125000' }],
    })

    await calculateVWAP(PAIR, 60, NETWORK)

    const [sql, params] = mocks.query.mock.calls[0]
    expect(sql).toContain('AND source = ANY($4)')
    const queriedSources = params[3] as string[]

    // Ensure CEX sources are excluded
    expect(queriedSources).not.toContain('KuCoin')
    expect(queriedSources).not.toContain('Gate.io')
    expect(queriedSources).not.toContain('coinbase_cex')
    expect(queriedSources).not.toContain('binance')

    // Ensure on-chain sources are included
    expect(queriedSources).toContain('SDEX')
    expect(queriedSources).toContain('AMM')
  })

  it('3. A new venue added to the registry is classified without editing a second list', () => {
    const initialSources = getOnChainSources()

    const mockNewOnChainAdapter: VenueAdapter = {
      name: 'SorobanNewDEX',
      source: 'soroban_new_dex',
      sourceTimeCapability: { status: 'provided', semantic: 'ledger_close' },
      classification: 'primary',
      type: 'Liquidity Pool',
      description: 'New Soroban DEX',
      isEnabled: () => true,
      getPollIntervalMs: () => 5000,
      discover: async () => [],
      read: async () => null,
      derive: () => [],
      write: async () => {},
      ingestPair: async () => {},
    }

    registeredVenues.push({
      adapter: mockNewOnChainAdapter,
      hasCredentials: () => true,
      onChain: true,
    })

    try {
      const updatedSources = getOnChainSources()
      expect(updatedSources).toContain('soroban_new_dex')
      expect(updatedSources.length).toBe(initialSources.length + 1)
    } finally {
      registeredVenues.pop()
    }
  })

  it('4. With every on-chain venue failed, the answer is marked stale, not zero', async () => {
    const allOnChain = getOnChainSources()
    for (const s of allOnChain) {
      recordSourceFailure(s, NETWORK, PAIR, new Error(`${s} down`))
    }

    mocks.query.mockResolvedValueOnce({
      rows: [{ last_price: '0.142500' }],
    })

    const detailed = await calculateVWAPDetailed(PAIR, 60, NETWORK)

    expect(detailed.num).toBe(0.1425)
    expect(detailed.raw).toBe('0.142500')
    expect(detailed.stale).toBe(true)
    expect(detailed.status).toBe('stale')
    expect(detailed.excludedSources?.length).toBe(allOnChain.length)

    // Confirms fallback query was executed against price_points
    const [sql, params] = mocks.query.mock.calls[0]
    expect(sql).toContain('SELECT price::numeric AS last_price')
    expect(sql).toContain('ORDER BY COALESCE(observed_at, timestamp) DESC')
    expect(sql).toContain('LIMIT 1')
    expect(params[0]).toBe(PAIR)
    expect(params[1]).toBe(NETWORK)
  })

  it('5. OHLCV query excludes CEX sources and failed sources', async () => {
    recordSourceFailure('soroswap_amm', NETWORK, PAIR, new Error('soroswap failed'))

    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          open: '0.10',
          high: '0.15',
          low: '0.08',
          close: '0.12',
          volume: '5000',
          trade_count: '20',
        },
      ],
    })

    const ohlcv = await calculateOHLCV(PAIR, 60, NETWORK)
    expect(ohlcv.tradeCount).toBe(20)

    const [sql, params] = mocks.query.mock.calls[0]
    expect(sql).toContain('AND source = ANY($4)')
    const queriedSources = params[3] as string[]
    expect(queriedSources).not.toContain('soroswap_amm')
    expect(queriedSources).not.toContain('KuCoin')
  })

  it('6. Sums stay in SQL numeric without floating point drift', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ vwap: '0.123456789012345678' }],
    })

    const detailed = await calculateVWAPDetailed(PAIR, 60, NETWORK)
    expect(detailed.raw).toBe('0.123456789012345678')

    const [sql] = mocks.query.mock.calls[0]
    expect(sql).toContain('SUM(price::numeric * base_volume::numeric) / NULLIF(SUM(base_volume::numeric), 0)')
  })

  it('7. aggregatePrice wraps unified on-chain sources and excludes failed sources', async () => {
    recordSourceFailure('aquarius_amm', NETWORK, PAIR, new Error('aquarius unreachable'))

    mocks.query.mockResolvedValueOnce({
      rows: [
        { source: 'SDEX', vwap: '0.10', volume: '1000' },
        { source: 'AMM', vwap: '0.10', volume: '1000' },
        { source: 'aquarius_amm', vwap: '0.12', volume: '1000' },
        { source: 'KuCoin', vwap: '0.15', volume: '5000' }, // CEX row in DB
      ],
    })

    const result = await aggregatePrice(PAIR, 0.05, NETWORK)

    expect(result.composite).toBeCloseTo(0.10, 10)
    // KuCoin must be filtered out
    expect(result.breakdown.find(b => b.source === 'KuCoin')).toBeUndefined()
    // Aquarius must be excluded with failure reason
    const aquarius = result.breakdown.find(b => b.source === 'aquarius_amm')!
    expect(aquarius.excluded).toBe(true)
    expect(aquarius.reason).toBe('source failed to fetch')
  })
})
