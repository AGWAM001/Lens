import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted Mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  prisma: {
    venueDispersion: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    webhook: {
      findMany: vi.fn(),
    },
  },
  pgPool: {
    query: vi.fn(),
  },
  deliverJsonWithRetries: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../db', () => ({
  prisma: mocks.prisma,
  pgPool: mocks.pgPool,
}))

vi.mock('../alerts/delivery', () => ({
  deliverJsonWithRetries: mocks.deliverJsonWithRetries,
}))

import {
  calculateMedian,
  computeDispersion,
  fetchLatestVenueQuotes,
  recordDispersionRun,
  queryDispersionHistory,
  type VenueQuote,
} from '../reconciliation/dispersion'
import {
  _resetDispersionAlertCooldown,
  isAlertSuppressed,
  recordAlertFired,
  clearAlertState,
  dispatchDispersionAlert,
} from '../alerts/dispersion'
import { reconcilePair, reconcileAllPairs } from '../jobs/venueReconciliation'

describe('Venue Price Dispersion Reconciliation (#239)', () => {
  const baseTime = new Date('2026-10-17T12:00:00Z')

  beforeEach(() => {
    vi.clearAllMocks()
    _resetDispersionAlertCooldown()
    mocks.prisma.venueDispersion.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'disp-1', ...args.data })
    )
    mocks.prisma.webhook.findMany.mockResolvedValue([])
  })

  // ── 1. Pure Calculation & Dispersion Metric Tests ───────────────────────────
  describe('computeDispersion', () => {
    it('calculates median correctly for odd and even number of values', () => {
      expect(calculateMedian([10])).toBe(10)
      expect(calculateMedian([10, 20, 30])).toBe(20)
      expect(calculateMedian([10, 30, 20])).toBe(20)
      expect(calculateMedian([10, 20, 30, 40])).toBe(25)
      expect(() => calculateMedian([])).toThrow()
    })

    it('Agreement: venues quote nearly the same price -> small dispersion, no outlier alert', () => {
      const quotes: VenueQuote[] = [
        { venue: 'SDEX', price: 1.000, timestamp: new Date(baseTime.getTime() - 10_000) },
        { venue: 'AMM', price: 1.001, timestamp: new Date(baseTime.getTime() - 20_000) },
        { venue: 'Soroswap', price: 0.999, timestamp: new Date(baseTime.getTime() - 30_000) },
      ]

      const result = computeDispersion('XLM/USDC', quotes, 300, baseTime)

      expect(result.status).toBe('ok')
      expect(result.venueCount).toBe(3)
      expect(result.median).toBe(1)
      // Max deviation is |1.001 - 1| / 1 * 100 = 0.1%
      expect(result.dispersionPct).toBeCloseTo(0.1, 2)
      expect(result.spreadBps).toBeCloseTo(20, 0)
      expect(result.minPrice).toBe(0.999)
      expect(result.maxPrice).toBe(1.001)
      expect(result.staleVenues).toEqual([])
      expect(result.freshVenues).toEqual(['AMM', 'SDEX', 'Soroswap'])
    })

    it('One outlier: one venue is far from the rest -> correctly identifies the outlying venue', () => {
      const quotes: VenueQuote[] = [
        { venue: 'SDEX', price: 0.100, timestamp: new Date(baseTime.getTime() - 10_000) },
        { venue: 'AMM', price: 0.101, timestamp: new Date(baseTime.getTime() - 15_000) },
        { venue: 'Aquarius', price: 0.115, timestamp: new Date(baseTime.getTime() - 20_000) },
      ]

      const result = computeDispersion('XLM/USDC', quotes, 300, baseTime)

      expect(result.status).toBe('ok')
      expect(result.venueCount).toBe(3)
      // Median of [0.100, 0.101, 0.115] is 0.101
      expect(result.median).toBe(0.101)
      // Deviation for Aquarius: |0.115 - 0.101| / 0.101 * 100 = 13.8614%
      // Deviation for SDEX: |0.100 - 0.101| / 0.101 * 100 = 0.9901%
      expect(result.outlierVenue).toBe('Aquarius')
      expect(result.dispersionPct).toBeCloseTo(13.86, 1)
      expect(result.outlierDeviationPct).toBeCloseTo(13.86, 1)
      expect(result.isAmbiguous).toBe(false)
    })

    it('Single-venue pair: recorded explicitly as insufficient_venues, no fake zero or alert', () => {
      const quotes: VenueQuote[] = [
        { venue: 'SDEX', price: 0.100, timestamp: new Date(baseTime.getTime() - 10_000) },
      ]

      const result = computeDispersion('XLM/USDC', quotes, 300, baseTime)

      expect(result.status).toBe('insufficient_venues')
      expect(result.venueCount).toBe(1)
      expect(result.median).toBeNull()
      expect(result.dispersionPct).toBeNull()
      expect(result.spreadBps).toBeNull()
      expect(result.outlierVenue).toBeNull()
      expect(result.outlierDeviationPct).toBeNull()
      expect(result.freshVenues).toEqual(['SDEX'])
      expect(result.staleVenues).toEqual([])
    })

    it('Stale venue: excluded from median & dispersion calculation and recorded in staleVenues', () => {
      const quotes: VenueQuote[] = [
        { venue: 'SDEX', price: 0.100, timestamp: new Date(baseTime.getTime() - 10_000) }, // fresh (10s old)
        { venue: 'AMM', price: 0.102, timestamp: new Date(baseTime.getTime() - 20_000) },  // fresh (20s old)
        { venue: 'Aquarius', price: 0.200, timestamp: new Date(baseTime.getTime() - 400_000) }, // STALE (400s old, limit is 300s)
      ]

      const result = computeDispersion('XLM/USDC', quotes, 300, baseTime)

      expect(result.status).toBe('ok')
      expect(result.venueCount).toBe(2) // Only 2 fresh
      expect(result.freshVenues).toEqual(['AMM', 'SDEX'])
      expect(result.staleVenues).toEqual(['Aquarius'])
      // Median calculated from fresh [0.100, 0.102] = 0.101, NOT including 0.200
      expect(result.median).toBe(0.101)
      expect(result.dispersionPct).toBeCloseTo(0.99, 1)
    })

    it('Two-venue pair: median sits in the middle; deterministic alphabetical tie-breaking and isAmbiguous set', () => {
      const quotes: VenueQuote[] = [
        { venue: 'SDEX', price: 100, timestamp: new Date(baseTime.getTime() - 10_000) },
        { venue: 'AMM', price: 110, timestamp: new Date(baseTime.getTime() - 10_000) },
      ]

      const result = computeDispersion('XLM/USDC', quotes, 300, baseTime)

      expect(result.status).toBe('ok')
      expect(result.venueCount).toBe(2)
      expect(result.median).toBe(105)
      // Deviation for both is |100 - 105| / 105 * 100 = 4.7619%
      expect(result.dispersionPct).toBeCloseTo(4.76, 2)
      // Deterministic tie-breaker selects AMM alphabetically before SDEX
      expect(result.outlierVenue).toBe('AMM')
      expect(result.isAmbiguous).toBe(true)
    })

    it('Defensive handling: ignores non-finite, zero, or negative prices', () => {
      const quotes: VenueQuote[] = [
        { venue: 'SDEX', price: 100, timestamp: new Date(baseTime.getTime() - 10_000) },
        { venue: 'AMM', price: 102, timestamp: new Date(baseTime.getTime() - 10_000) },
        { venue: 'BadVenue1', price: 0, timestamp: new Date(baseTime.getTime() - 10_000) },
        { venue: 'BadVenue2', price: -50, timestamp: new Date(baseTime.getTime() - 10_000) },
        { venue: 'BadVenue3', price: NaN, timestamp: new Date(baseTime.getTime() - 10_000) },
        { venue: 'BadVenue4', price: Infinity, timestamp: new Date(baseTime.getTime() - 10_000) },
      ]

      const result = computeDispersion('XLM/USDC', quotes, 300, baseTime)

      expect(result.status).toBe('ok')
      expect(result.venueCount).toBe(2)
      expect(result.freshVenues).toEqual(['AMM', 'SDEX'])
      expect(result.median).toBe(101)
      expect(result.staleVenues).toContain('BadVenue1')
    })
  })

  // ── 2. Storage & Database Query Tests ───────────────────────────────────────
  describe('recordDispersionRun & queryDispersionHistory', () => {
    it('persists a complete reconciliation run to the database', async () => {
      const quotes: VenueQuote[] = [
        { venue: 'SDEX', price: 100, timestamp: baseTime },
        { venue: 'AMM', price: 105, timestamp: baseTime },
      ]
      const result = computeDispersion('XLM/USDC', quotes, 300, baseTime)

      await recordDispersionRun(result, 'testnet')

      expect(mocks.prisma.venueDispersion.create).toHaveBeenCalledTimes(1)
      const data = mocks.prisma.venueDispersion.create.mock.calls[0][0].data
      expect(data.pairKey).toBe('XLM/USDC')
      expect(data.network).toBe('testnet')
      expect(data.venueCount).toBe(2)
      expect(data.median).toBe('102.5')
      expect(data.outlierVenue).toBe('AMM')
      expect(data.status).toBe('ok')
      expect(data.isAmbiguous).toBe(true)
    })

    it('queries dispersion over time range with pair filter and bounded limits', async () => {
      const fakeRecords = [
        {
          id: '1',
          network: 'testnet',
          pairKey: 'XLM/USDC',
          timestamp: new Date('2026-10-17T11:00:00Z'),
          venueCount: 3,
          median: '100',
          dispersionPct: '1.5',
          spreadBps: '25',
          minPrice: '99',
          maxPrice: '101',
          outlierVenue: 'AMM',
          outlierDeviation: '1.5',
          status: 'ok',
          isAmbiguous: false,
          freshVenues: ['AMM', 'SDEX', 'Soroswap'],
          staleVenues: [],
          venues: [],
        },
      ]
      mocks.prisma.venueDispersion.findMany.mockResolvedValue(fakeRecords)

      const from = new Date('2026-10-17T10:00:00Z')
      const to = new Date('2026-10-17T12:00:00Z')

      const res = await queryDispersionHistory({
        pairKey: 'XLM/USDC',
        network: 'testnet',
        from,
        to,
        limit: 10,
      })

      expect(mocks.prisma.venueDispersion.findMany).toHaveBeenCalledWith({
        where: {
          network: 'testnet',
          pairKey: 'XLM/USDC',
          timestamp: { gte: from, lte: to },
        },
        orderBy: { timestamp: 'desc' },
        take: 10,
      })
      expect(res.length).toBe(1)
      expect(res[0].pairKey).toBe('XLM/USDC')
      expect(res[0].dispersionPct).toBe(1.5)
    })

    it('fetchLatestVenueQuotes executes query against price_points index', async () => {
      mocks.pgPool.query.mockResolvedValue({
        rows: [
          { venue: 'SDEX', price: '0.105', timestamp: baseTime.toISOString() },
          { venue: 'AMM', price: '0.106', timestamp: baseTime.toISOString() },
        ],
      })

      const quotes = await fetchLatestVenueQuotes('XLM/USDC', 'testnet')

      expect(mocks.pgPool.query).toHaveBeenCalledWith(
        expect.stringContaining('DISTINCT ON (source)'),
        ['testnet', 'XLM/USDC']
      )
      expect(quotes).toHaveLength(2)
      expect(quotes[0].venue).toBe('SDEX')
      expect(quotes[0].price).toBe(0.105)
    })
  })

  // ── 3. Orchestration, Threshold Alerting & Cooldown Suppression Tests ────────
  describe('reconcilePair orchestration and alerts', () => {
    it('Threshold configurability: alerts when threshold is low, does not alert when high', async () => {
      const quotes: VenueQuote[] = [
        { venue: 'SDEX', price: 100, timestamp: baseTime },
        { venue: 'AMM', price: 100, timestamp: baseTime },
        { venue: 'Aquarius', price: 104, timestamp: baseTime }, // ~4% dispersion
      ]

      mocks.prisma.webhook.findMany.mockResolvedValue([
        { url: 'https://webhook.example.com/alert', secret: 'wh-secret', assetA: 'XLM', assetB: 'USDC' },
      ])

      // 1. Threshold = 2.0% -> Dispersion (~4%) exceeds threshold -> ALERT RAISED
      const resLow = await reconcilePair('XLM/USDC', 'testnet', {
        quotesOverride: quotes,
        thresholdPct: 2.0,
        referenceTime: baseTime,
      })
      expect(resLow.alerted).toBe(true)
      expect(resLow.alertPayload?.outlyingVenue).toBe('Aquarius')
      expect(mocks.deliverJsonWithRetries).toHaveBeenCalledTimes(1)

      vi.clearAllMocks()
      _resetDispersionAlertCooldown()

      // 2. Threshold = 10.0% -> Dispersion (~4%) below threshold -> NO ALERT
      const resHigh = await reconcilePair('XLM/USDC', 'testnet', {
        quotesOverride: quotes,
        thresholdPct: 10.0,
        referenceTime: baseTime,
      })
      expect(resHigh.alerted).toBe(false)
      expect(mocks.deliverJsonWithRetries).not.toHaveBeenCalled()
    })

    it('Single-venue pair does not trigger alert', async () => {
      const singleQuote: VenueQuote[] = [
        { venue: 'SDEX', price: 100, timestamp: baseTime },
      ]

      const res = await reconcilePair('XLM/USDC', 'testnet', {
        quotesOverride: singleQuote,
        thresholdPct: 0.1, // Even with a super low threshold
        referenceTime: baseTime,
      })

      expect(res.result.status).toBe('insufficient_venues')
      expect(res.alerted).toBe(false)
      expect(mocks.deliverJsonWithRetries).not.toHaveBeenCalled()
    })

    it('Alert suppression: repeated runs while condition persists do NOT spam alerts', async () => {
      const outlierQuotes: VenueQuote[] = [
        { venue: 'SDEX', price: 100, timestamp: baseTime },
        { venue: 'AMM', price: 100, timestamp: baseTime },
        { venue: 'Aquarius', price: 110, timestamp: baseTime }, // 10% dispersion
      ]

      mocks.prisma.webhook.findMany.mockResolvedValue([
        { url: 'https://webhook.example.com/hook', secret: 'secret', assetA: 'XLM', assetB: 'USDC' },
      ])

      // Run 1: High dispersion -> First alert fires!
      const run1 = await reconcilePair('XLM/USDC', 'testnet', {
        quotesOverride: outlierQuotes,
        thresholdPct: 2.0,
        cooldownSeconds: 300,
        referenceTime: new Date(baseTime.getTime()),
      })
      expect(run1.alerted).toBe(true)
      expect(mocks.deliverJsonWithRetries).toHaveBeenCalledTimes(1)

      vi.clearAllMocks()

      // Run 2 (60s later, within 300s cooldown): High dispersion persists -> SUPPRESSED!
      const run2 = await reconcilePair('XLM/USDC', 'testnet', {
        quotesOverride: outlierQuotes,
        thresholdPct: 2.0,
        cooldownSeconds: 300,
        referenceTime: new Date(baseTime.getTime() + 60_000),
      })
      expect(run2.alerted).toBe(false)
      expect(mocks.deliverJsonWithRetries).not.toHaveBeenCalled()

      // Run 3: Condition clears (Aquarius price returns to normal, dispersion = 0)
      const healthyQuotes: VenueQuote[] = [
        { venue: 'SDEX', price: 100, timestamp: baseTime },
        { venue: 'AMM', price: 100, timestamp: baseTime },
        { venue: 'Aquarius', price: 100, timestamp: baseTime },
      ]
      const run3 = await reconcilePair('XLM/USDC', 'testnet', {
        quotesOverride: healthyQuotes,
        thresholdPct: 2.0,
        cooldownSeconds: 300,
        referenceTime: new Date(baseTime.getTime() + 120_000),
      })
      expect(run3.alerted).toBe(false)

      // Run 4: New spike occurs -> Alert fires immediately because state cleared!
      const run4 = await reconcilePair('XLM/USDC', 'testnet', {
        quotesOverride: outlierQuotes,
        thresholdPct: 2.0,
        cooldownSeconds: 300,
        referenceTime: new Date(baseTime.getTime() + 180_000),
      })
      expect(run4.alerted).toBe(true)
      expect(mocks.deliverJsonWithRetries).toHaveBeenCalledTimes(1)
    })
  })
})
