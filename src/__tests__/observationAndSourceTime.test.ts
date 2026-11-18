import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'

// Hoisted mocks for database
const { mockQuery, mockCreateMany, mockPoolSnapshotCreate, mockUpsertPricePoints } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCreateMany: vi.fn(),
  mockPoolSnapshotCreate: vi.fn().mockResolvedValue({}),
  mockUpsertPricePoints: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {
    poolSnapshot: {
      create: mockPoolSnapshotCreate,
    },
    pricePoint: {
      createMany: mockCreateMany,
    },
  },
  pgPool: { query: mockQuery },
  upsertPricePoints: mockUpsertPricePoints,
}))

import { sdexAdapter, deriveSdexPricePoints } from '../ingest/venues/sdex'
import { ammAdapter, snapshotPool } from '../ingest/venues/amm'
import { soroswapAdapter } from '../ingest/venues/soroswap'
import { aquariusAdapter, deriveAquariusPricePoints } from '../ingest/venues/aquarius'
import { startVenueAdapter, type VenueAdapter } from '../ingest/venues/runner'
import { MockCexAdapter } from '../ingest/cex/mock'
import { registerCandleRoutes } from '../routes/candles'
import type { WatchedPair } from '../types'

describe('Observation and Source Time Separation (#240)', () => {
  const dummyPair: WatchedPair = {
    pairKey: 'USDC/XLM',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockUpsertPricePoints.mockResolvedValue(1)
  })

  describe('1. Adapter Capability Declarations', () => {
    it('declares provided ledger_close for SDEX', () => {
      expect(sdexAdapter.sourceTimeCapability).toEqual({
        status: 'provided',
        semantic: 'ledger_close',
      })
    })

    it('declares provided ledger_close for AMM', () => {
      expect(ammAdapter.sourceTimeCapability).toEqual({
        status: 'provided',
        semantic: 'ledger_close',
      })
    })

    it('declares unavailable for Soroswap AMM', () => {
      expect(soroswapAdapter.sourceTimeCapability).toEqual({
        status: 'unavailable',
      })
    })

    it('declares unavailable for Aquarius AMM', () => {
      expect(aquariusAdapter.sourceTimeCapability).toEqual({
        status: 'unavailable',
      })
    })

    it('declares provided exchange_timestamp for CEX adapters', () => {
      const mockCex = new MockCexAdapter('test_cex')
      expect(mockCex.sourceTimeCapability).toEqual({
        status: 'provided',
        semantic: 'exchange_timestamp',
      })
    })

    it('throws if an adapter attempts to start without declaring sourceTimeCapability', async () => {
      const invalidAdapter = {
        name: 'NoCapabilityDEX',
        source: 'no_cap_dex',
        isEnabled: () => true,
        getPollIntervalMs: () => 1000,
        discover: async () => [],
        read: async () => null,
        derive: () => [],
        write: async () => {},
        ingestPair: async () => {},
      } as unknown as VenueAdapter

      await expect(startVenueAdapter(invalidAdapter, 'testnet')).rejects.toThrow(
        /must declare sourceTimeCapability/
      )
    })
  })

  describe('2. Source with Native Timestamp (SDEX & AMM trades, CEX tickers)', () => {
    it('SDEX trade populates observedAt as wall-clock and sourceTime as Horizon ledger_close_time', () => {
      const ledgerCloseIso = '2026-03-01T10:00:00.000Z'
      const rawTrades = {
        records: [
          {
            id: '123456789-1',
            paging_token: '123456789-1',
            ledger_close_time: ledgerCloseIso,
            base_asset_type: 'native',
            base_amount: '100',
            counter_asset_type: 'credit_alphanum4',
            counter_asset_code: 'USDC',
            counter_amount: '12',
            price: { n: '12', d: '100' },
          },
        ],
        cursor: '0',
        stateId: 'sdex-state',
        lastLedger: 100,
      }

      const before = Date.now()
      const derived = deriveSdexPricePoints(rawTrades as any, dummyPair)
      const after = Date.now()

      expect(derived).not.toBeNull()
      expect(derived!.points).toHaveLength(1)

      const point = derived!.points[0]
      // sourceTime must match ledger_close_time
      expect(point.sourceTime).toEqual(new Date(ledgerCloseIso))
      // observedAt must be the current wall-clock Date
      expect(point.observedAt).toBeInstanceOf(Date)
      expect(point.observedAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(point.observedAt.getTime()).toBeLessThanOrEqual(after)
      // They must NOT be conflated
      expect(point.sourceTime!.getTime()).not.toBe(point.observedAt.getTime())
      // ledger must be tracked separately
      expect(typeof point.ledger).toBe('number')
    })

    it('CEX adapter provides exchange timestamp as source time', async () => {
      const before = Date.now()
      const mockCex = new MockCexAdapter('test_cex')
      const ticker = await mockCex.fetchTicker('XLM', 'USDC')
      const after = Date.now()

      expect(ticker).not.toBeNull()
      expect(ticker!.timestamp).toBeInstanceOf(Date)
      expect(ticker!.timestamp.getTime()).toBeGreaterThanOrEqual(before)
      expect(ticker!.timestamp.getTime()).toBeLessThanOrEqual(after)
      expect(mockCex.sourceTimeCapability.status).toBe('provided')
      expect(mockCex.sourceTimeCapability.semantic).toBe('exchange_timestamp')
    })
  })

  describe('3. Source with No Native Timestamp (Soroswap, Aquarius, AMM reserve snapshots)', () => {
    it('Soroswap AMM pool derive sets sourceTime to null and observedAt to wall-clock', () => {
      const poolEntry = {
        poolAddress: 'CBXYZ123',
        tokenA: { address: 'CA1', symbol: 'XLM', name: 'Stellar Lumens', decimals: 7 },
        tokenB: { address: 'CA2', symbol: 'USDC', name: 'USD Coin', decimals: 7 },
      }

      const before = Date.now()
      const points = soroswapAdapter.derive(
        [100_000_000n, 10_000_000n],
        poolEntry,
        dummyPair,
        'testnet'
      )
      const after = Date.now()

      expect(points).toHaveLength(1)
      const point = points[0]
      // sourceTime must be null (NEVER wall-clock time)
      expect(point.sourceTime).toBeNull()
      // observedAt is wall-clock
      expect(point.observedAt).toBeInstanceOf(Date)
      expect(point.observedAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(point.observedAt.getTime()).toBeLessThanOrEqual(after)
    })

    it('Aquarius AMM pool derive sets sourceTime to null and observedAt to wall-clock', () => {
      const pools = [
        {
          pool_hash: 'aquarius-pool-1',
          reserves: ['1000.0', '150.0'],
        },
      ]

      const before = Date.now()
      const points = deriveAquariusPricePoints(pools as any, dummyPair)
      const after = Date.now()

      expect(points).toHaveLength(1)
      const point = points[0]
      expect(point.sourceTime).toBeNull()
      expect(point.observedAt).toBeInstanceOf(Date)
      expect(point.observedAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(point.observedAt.getTime()).toBeLessThanOrEqual(after)
    })

    it('AMM reserve reader snapshotPool sets sourceTime to null', async () => {
      const mockPool = {
        id: 'amm-pool-id-1',
        reserves: [
          { asset: 'native', amount: '1000' },
          { asset: `USDC:${dummyPair.assetB.issuer}`, amount: '120' },
        ],
        fee_bp: 30,
        total_shares: '500',
        last_modified_ledger: 12345,
      }

      const before = Date.now()
      await snapshotPool(mockPool as any, dummyPair, 'testnet')
      const after = Date.now()

      expect(mockUpsertPricePoints).toHaveBeenCalled()
      const [savedPoints] = mockUpsertPricePoints.mock.calls[0]
      expect(savedPoints).toHaveLength(1)

      const point = savedPoints[0]
      expect(point.sourceTime).toBeNull()
      expect(point.observedAt).toBeInstanceOf(Date)
      expect(point.observedAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(point.observedAt.getTime()).toBeLessThanOrEqual(after)
    })
  })

  describe('4. Consistent Bucketing on Observation Time (observed_at)', () => {
    async function buildCandlesApp() {
      const app = Fastify({ logger: false })
      await registerCandleRoutes(app)
      await app.ready()
      return app
    }

    it('candle route queries group by and filter strictly on observed_at', async () => {
      const app = await buildCandlesApp()
      mockQuery.mockResolvedValue({ rows: [] })

      await app.inject({
        method: 'GET',
        url: '/candles/XLM/USDC?interval=1h&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
      })

      expect(mockQuery).toHaveBeenCalled()
      const [sql] = mockQuery.mock.calls[0]

      // Verify bucketing expression uses observed_at
      expect(sql).toMatch(/to_timestamp\(floor\(EXTRACT\(EPOCH FROM observed_at\) \/ \$1\) \* \$1\) AS time/)
      // Verify filtering bounds use observed_at
      expect(sql).toMatch(/observed_at >= \$3/)
      expect(sql).toMatch(/observed_at < \$4/)
      // Verify ordering uses observed_at
      expect(sql).toMatch(/ORDER BY observed_at ASC/)
      expect(sql).toMatch(/ORDER BY observed_at DESC/)
      // Must NOT bucket on source_time or timestamp
      expect(sql).not.toMatch(/EXTRACT\(EPOCH FROM source_time\)/)
      expect(sql).not.toMatch(/EXTRACT\(EPOCH FROM timestamp\)/)
    })

    it('demonstrates bucket separation: sample with old source_time falls into observed_at bucket', () => {
      // Simulate a trade that happened on-chain 30 minutes ago, but was ingested/observed now.
      const intervalSecs = 3600 // 1-hour candle
      const sourceTime = new Date('2026-03-01T10:05:00.000Z') // Bucket 10:00
      const observedAt = new Date('2026-03-01T11:20:00.000Z') // Bucket 11:00

      // Bucketing function replicating PostgreSQL to_timestamp(floor(EXTRACT(EPOCH FROM t) / interval) * interval)
      const computeBucketTime = (d: Date, interval: number): number => {
        const epochSecs = Math.floor(d.getTime() / 1000)
        return Math.floor(epochSecs / interval) * interval * 1000
      }

      const bucketFromSource = new Date(computeBucketTime(sourceTime, intervalSecs)).toISOString()
      const bucketFromObserved = new Date(computeBucketTime(observedAt, intervalSecs)).toISOString()

      expect(bucketFromSource).toBe('2026-03-01T10:00:00.000Z')
      expect(bucketFromObserved).toBe('2026-03-01T11:00:00.000Z')

      // Lens candle bucketing keys on observedAt, ensuring cross-venue consistency with state snapshots
      const assignedCandleBucket = new Date(computeBucketTime(observedAt, intervalSecs)).toISOString()
      expect(assignedCandleBucket).toBe('2026-03-01T11:00:00.000Z')
    })

    it('sources without native source_time (sourceTime=null) bucket cleanly on observed_at', () => {
      const intervalSecs = 900 // 15-minute candle
      const observedAt = new Date('2026-03-01T10:14:30.000Z')
      const sourceTime = null

      expect(sourceTime).toBeNull()

      const computeBucketTime = (d: Date, interval: number): number => {
        const epochSecs = Math.floor(d.getTime() / 1000)
        return Math.floor(epochSecs / interval) * interval * 1000
      }

      const assignedCandleBucket = new Date(computeBucketTime(observedAt, intervalSecs)).toISOString()
      expect(assignedCandleBucket).toBe('2026-03-01T10:00:00.000Z')
    })
  })

  describe('5. Migration and Backfill Integrity', () => {
    it('migration script correctly separates observation time and source time backfill', () => {
      const migrationPath = path.resolve(
        __dirname,
        '../../prisma/migrations/20261023150000_separate_observation_and_source_time/migration.sql'
      )
      expect(fs.existsSync(migrationPath)).toBe(true)

      const sql = fs.readFileSync(migrationPath, 'utf8')

      // 1. Adds observed_at and source_time columns
      expect(sql).toMatch(/ALTER TABLE "price_points" ADD COLUMN IF NOT EXISTS "observed_at"/)
      expect(sql).toMatch(/ALTER TABLE "price_points" ADD COLUMN IF NOT EXISTS "source_time"/)

      // 2. Only backfills source_time for SDEX and AMM trades with real ledger times
      expect(sql).toMatch(/WHERE "source" IN \('SDEX', 'AMM'\)/)
      expect(sql).toMatch(/AND \("event_id" IS NULL OR "event_id" NOT LIKE 'amm-snapshot-%'\)/)

      // 3. Leaves synthetic snapshots and contract simulation venues (Soroswap, Aquarius) with NULL source_time
      expect(sql).toMatch(/Non-native venues .* retain source_time = NULL/i)

      // 4. Backfills observed_at from existing timestamp for historical continuity
      expect(sql).toMatch(/UPDATE "price_points"\s+SET "observed_at" = "timestamp"/)

      // 5. Creates index on observed_at
      expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "price_points_network_pair_key_observed_at_idx"/)
    })
  })
})
