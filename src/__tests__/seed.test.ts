import { describe, it, expect, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'

/**
 * Tests for the seed script:
 * - StrKey validation of hard-coded Stellar keys
 * - CLI argument parsing
 * - Shape, determinism, and network-tagging of fixture data
 * - Pool ID generation (64-character lowercase hex string)
 * - Deterministic timestamp layout without SDEX / AMM collisions
 * - Idempotency contract ("converges to the same rows" via deleteMany + createMany)
 * - Network isolation and network flag filtering
 */

import {
  TESTNET_USDC_ISSUER,
  MAINNET_USDC_ISSUER,
  PAIRS,
  ANCHOR,
  getAnchor,
  hoursAgo,
  makeDeterministicPoolId,
  parseArgs,
  makePricePoints,
  makePoolSnapshots,
  makePriceAggregates,
  seedNetwork,
  seed,
} from '../../scripts/seed'

describe('seed fixtures', () => {
  // ── StrKey validation ────────────────────────────────────────────────────

  describe('Stellar address validation', () => {
    it('validates testnet USDC issuer is a valid Ed25519 public key', () => {
      expect(StrKey.isValidEd25519PublicKey(TESTNET_USDC_ISSUER)).toBe(true)
    })

    it('validates mainnet USDC issuer is a valid Ed25519 public key', () => {
      expect(StrKey.isValidEd25519PublicKey(MAINNET_USDC_ISSUER)).toBe(true)
    })

    it('rejects malformed public keys', () => {
      expect(StrKey.isValidEd25519PublicKey('G_NOT_A_VALID_KEY')).toBe(false)
      expect(StrKey.isValidEd25519PublicKey('')).toBe(false)
    })
  })

  // ── CLI argument parsing ─────────────────────────────────────────────────

  describe('parseArgs', () => {
    it('parses --network testnet as separate tokens', () => {
      expect(parseArgs(['--network', 'testnet'])).toEqual({ network: 'testnet' })
    })

    it('parses --network=testnet syntax', () => {
      expect(parseArgs(['--network=testnet'])).toEqual({ network: 'testnet' })
    })

    it('returns empty object when no flags provided', () => {
      expect(parseArgs([])).toEqual({ network: undefined })
    })

    it('throws descriptive error when --network flag has no value', () => {
      expect(() => parseArgs(['--network'])).toThrow(
        /Missing value for --network flag\. Expected "testnet" or "mainnet"\./
      )
    })
  })

  // ── Pair definitions ─────────────────────────────────────────────────────

  describe('PAIRS', () => {
    it('defines testnet and mainnet pairs', () => {
      expect(PAIRS).toHaveProperty('testnet')
      expect(PAIRS).toHaveProperty('mainnet')
    })

    it('uses valid USDC issuers matching the constants', () => {
      expect(PAIRS.testnet.pairKey).toContain(TESTNET_USDC_ISSUER)
      expect(PAIRS.mainnet.pairKey).toContain(MAINNET_USDC_ISSUER)
    })

    it('generates 64-character lowercase hex pool IDs per network', () => {
      expect(PAIRS.testnet.poolId).toMatch(/^[0-9a-f]{64}$/)
      expect(PAIRS.mainnet.poolId).toMatch(/^[0-9a-f]{64}$/)
      expect(PAIRS.testnet.poolId).not.toBe(PAIRS.mainnet.poolId)
    })

    it('makeDeterministicPoolId returns deterministic 64-hex string', () => {
      const id1 = makeDeterministicPoolId('testnet', 'USDC:X/XLM')
      const id2 = makeDeterministicPoolId('testnet', 'USDC:X/XLM')
      expect(id1).toBe(id2)
      expect(id1).toHaveLength(64)
    })

    it('pairKeys are alphabetically sorted (USDC before XLM)', () => {
      expect(PAIRS.testnet.pairKey).toMatch(/^USDC:.*\/XLM$/)
      expect(PAIRS.mainnet.pairKey).toMatch(/^USDC:.*\/XLM$/)
    })
  })

  // ── Price points ─────────────────────────────────────────────────────────

  describe('makePricePoints', () => {
    const anchor = getAnchor()
    const testnetPoints = makePricePoints('testnet', PAIRS.testnet, anchor)
    const mainnetPoints = makePricePoints('mainnet', PAIRS.mainnet, anchor)

    it('produces 36 points per network (24 SDEX + 12 AMM)', () => {
      expect(testnetPoints).toHaveLength(36)
      expect(mainnetPoints).toHaveLength(36)
    })

    it('tags every point with the correct network', () => {
      for (const p of testnetPoints) expect(p.network).toBe('testnet')
      for (const p of mainnetPoints) expect(p.network).toBe('mainnet')
    })

    it('generates deterministic IDs containing the network name and source', () => {
      for (const p of testnetPoints) {
        expect(p.id).toMatch(/^seed-testnet-(sdex|amm)-\d+$/)
      }
      for (const p of mainnetPoints) {
        expect(p.id).toMatch(/^seed-mainnet-(sdex|amm)-\d+$/)
      }
    })

    it('produces identical output on repeated calls with the same anchor', () => {
      const second = makePricePoints('testnet', PAIRS.testnet, anchor)
      expect(second).toEqual(testnetPoints)
    })

    it('assigns SDEX points a null poolId and AMM points a non-null 64-hex poolId', () => {
      const sdex = testnetPoints.filter(p => p.source === 'SDEX')
      const amm = testnetPoints.filter(p => p.source === 'AMM')
      expect(sdex.length).toBe(24)
      expect(amm.length).toBe(12)
      for (const p of sdex) expect(p.poolId).toBeNull()
      for (const p of amm) {
        expect(p.poolId).toBe(PAIRS.testnet.poolId)
        expect(p.poolId).toMatch(/^[0-9a-f]{64}$/)
      }
    })

    it('generates prices near the base price (within ±5%)', () => {
      for (const p of testnetPoints) {
        const price = Number(p.price)
        expect(price).toBeGreaterThan(PAIRS.testnet.basePrice * 0.95)
        expect(price).toBeLessThan(PAIRS.testnet.basePrice * 1.05)
      }
    })

    it('generates positive volumes', () => {
      for (const p of testnetPoints) {
        expect(Number(p.baseVolume)).toBeGreaterThan(0)
        expect(Number(p.counterVolume)).toBeGreaterThan(0)
      }
    })

    it('all timestamps are <= anchor and within the last 24 hours of anchor', () => {
      const dayBeforeAnchor = anchor.getTime() - 24 * 60 * 60 * 1000
      for (const p of testnetPoints) {
        expect(p.timestamp.getTime()).toBeLessThanOrEqual(anchor.getTime())
        expect(p.timestamp.getTime()).toBeGreaterThanOrEqual(dayBeforeAnchor)
      }
    })

    it('timestamps are fresh relative to Date.now() (within last 24 hours)', () => {
      const now = Date.now()
      const dayAgo = now - 24 * 60 * 60 * 1000
      const defaultPoints = makePricePoints('testnet', PAIRS.testnet)
      for (const p of defaultPoints) {
        expect(p.timestamp.getTime()).toBeLessThanOrEqual(now + 1000)
        expect(p.timestamp.getTime()).toBeGreaterThanOrEqual(dayAgo - 3600 * 1000)
      }
    })

    it('no timestamp collision between SDEX and AMM points', () => {
      const sdexTimestamps = new Set(
        testnetPoints.filter(p => p.source === 'SDEX').map(p => p.timestamp.getTime())
      )
      const ammTimestamps = testnetPoints
        .filter(p => p.source === 'AMM')
        .map(p => p.timestamp.getTime())

      for (const ts of ammTimestamps) {
        expect(sdexTimestamps.has(ts)).toBe(false)
      }
    })

    it('latest price point is deterministically SDEX i=23 landing on anchor', () => {
      const sorted = [...testnetPoints].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      const latest = sorted[0]
      expect(latest.source).toBe('SDEX')
      expect(latest.id).toBe('seed-testnet-sdex-23')
      expect(latest.timestamp.getTime()).toBe(anchor.getTime())
      expect(Number(latest.price)).toBe(0.11906825)
    })

    it('IDs are unique across all points for a given network', () => {
      const ids = testnetPoints.map(p => p.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('testnet and mainnet IDs never collide', () => {
      const allIds = [...testnetPoints, ...mainnetPoints].map(p => p.id)
      expect(new Set(allIds).size).toBe(allIds.length)
    })
  })

  // ── Pool snapshots ───────────────────────────────────────────────────────

  describe('makePoolSnapshots', () => {
    const anchor = getAnchor()
    const snaps = makePoolSnapshots('testnet', PAIRS.testnet, anchor)

    it('produces 6 snapshots', () => {
      expect(snaps).toHaveLength(6)
    })

    it('tags every snapshot with the correct network', () => {
      for (const s of snaps) expect(s.network).toBe('testnet')
    })

    it('generates deterministic IDs', () => {
      for (const s of snaps) {
        expect(s.id).toMatch(/^seed-testnet-snap-\d+$/)
      }
    })

    it('produces identical output on repeated calls with the same anchor', () => {
      const second = makePoolSnapshots('testnet', PAIRS.testnet, anchor)
      expect(second).toEqual(snaps)
    })

    it('assigns the correct 64-hex poolId', () => {
      for (const s of snaps) {
        expect(s.poolId).toBe(PAIRS.testnet.poolId)
        expect(s.poolId).toMatch(/^[0-9a-f]{64}$/)
      }
    })

    it('generates positive reserves', () => {
      for (const s of snaps) {
        expect(Number(s.reserveA)).toBeGreaterThan(0)
        expect(Number(s.reserveB)).toBeGreaterThan(0)
      }
    })

    it('latest snapshot (i=5) lands on anchor with spot_price 0.12', () => {
      const latest = snaps[snaps.length - 1]
      expect(latest.timestamp.getTime()).toBe(anchor.getTime())
      expect(Number(latest.reserveA)).toBe(550000)
      expect(Number(latest.reserveB)).toBe(66000)
      expect(Number(latest.spotPrice)).toBe(0.12)
    })

    it('IDs are unique', () => {
      const ids = snaps.map(s => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  // ── Price aggregates ─────────────────────────────────────────────────────

  describe('makePriceAggregates', () => {
    const anchor = getAnchor()
    const aggs = makePriceAggregates('testnet', PAIRS.testnet, anchor)

    it('produces aggregates for all four windows (1m, 5m, 1h, 24h)', () => {
      const windows = new Set(aggs.map(a => a.window))
      expect(windows).toEqual(new Set(['1m', '5m', '1h', '24h']))
    })

    it('tags every aggregate with the correct network', () => {
      for (const a of aggs) expect(a.network).toBe('testnet')
    })

    it('produces identical output on repeated calls with the same anchor', () => {
      const second = makePriceAggregates('testnet', PAIRS.testnet, anchor)
      expect(second).toEqual(aggs)
    })

    it('has valid OHLCV data (high >= low, volumes > 0)', () => {
      for (const a of aggs) {
        expect(Number(a.highPrice)).toBeGreaterThanOrEqual(Number(a.lowPrice))
        expect(Number(a.volume)).toBeGreaterThan(0)
        expect(a.tradeCount).toBeGreaterThan(0)
      }
    })

    it('composite keys are unique per (network, pairKey, window, bucket)', () => {
      const keys = aggs.map(a => `${a.network}|${a.pairKey}|${a.window}|${a.bucket.toISOString()}`)
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('generates expected bucket counts per window', () => {
      const byWindow = new Map<string, number>()
      for (const a of aggs) byWindow.set(a.window, (byWindow.get(a.window) ?? 0) + 1)
      expect(byWindow.get('1m')).toBe(12)
      expect(byWindow.get('5m')).toBe(12)
      expect(byWindow.get('1h')).toBe(24)
      expect(byWindow.get('24h')).toBe(1)
    })
  })

  // ── Cross-network isolation ──────────────────────────────────────────────

  describe('network isolation', () => {
    it('testnet and mainnet price points have different pairKeys', () => {
      const testnet = makePricePoints('testnet', PAIRS.testnet)
      const mainnet = makePricePoints('mainnet', PAIRS.mainnet)
      const testnetKeys = new Set(testnet.map(p => p.pairKey))
      const mainnetKeys = new Set(mainnet.map(p => p.pairKey))
      for (const k of testnetKeys) expect(mainnetKeys.has(k)).toBe(false)
    })

    it('testnet and mainnet snapshots use different poolIds', () => {
      const testnet = makePoolSnapshots('testnet', PAIRS.testnet)
      const mainnet = makePoolSnapshots('mainnet', PAIRS.mainnet)
      const testnetPools = new Set(testnet.map(s => s.poolId))
      const mainnetPools = new Set(mainnet.map(s => s.poolId))
      for (const p of testnetPools) expect(mainnetPools.has(p)).toBe(false)
    })
  })

  // ── Database interaction & Idempotency contract ───────────────────────────

  describe('seedNetwork and idempotency', () => {
    it('deletes seed-owned rows first to guarantee convergence across runs', async () => {
      const mockPrisma = {
        pairConfig: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        pricePoint: {
          deleteMany: vi.fn().mockResolvedValue({ count: 36 }),
          createMany: vi.fn().mockResolvedValue({ count: 36 }),
        },
        poolSnapshot: {
          deleteMany: vi.fn().mockResolvedValue({ count: 6 }),
          createMany: vi.fn().mockResolvedValue({ count: 6 }),
        },
        priceAggregate: {
          deleteMany: vi.fn().mockResolvedValue({ count: 49 }),
          createMany: vi.fn().mockResolvedValue({ count: 49 }),
        },
      } as any

      const result = await seedNetwork(mockPrisma, 'testnet', PAIRS.testnet)

      expect(mockPrisma.pricePoint.deleteMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'seed-testnet-' }, network: 'testnet' },
      })
      expect(mockPrisma.poolSnapshot.deleteMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'seed-testnet-' }, network: 'testnet' },
      })
      expect(mockPrisma.priceAggregate.deleteMany).toHaveBeenCalledWith({
        where: { network: 'testnet', pairKey: PAIRS.testnet.pairKey },
      })

      expect(mockPrisma.pairConfig.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      )
      expect(mockPrisma.pricePoint.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      )
      expect(mockPrisma.poolSnapshot.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      )
      expect(mockPrisma.priceAggregate.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      )

      expect(result.pairConfigs.inserted).toBe(1)
      expect(result.pricePoints.inserted).toBe(36)
      expect(result.poolSnapshots.inserted).toBe(6)
      expect(result.priceAggregates.inserted).toBe(49)
    })

    it('guarantees fixture-level stability: identical (id, timestamp) tuples across calls', () => {
      const anchor = getAnchor()
      const run1 = makePricePoints('testnet', PAIRS.testnet, anchor)
      const run2 = makePricePoints('testnet', PAIRS.testnet, anchor)

      expect(run1.length).toBe(run2.length)
      for (let i = 0; i < run1.length; i++) {
        expect(run1[i].id).toBe(run2[i].id)
        expect(run1[i].timestamp.getTime()).toBe(run2[i].timestamp.getTime())
        expect(run1[i].price.toString()).toBe(run2[i].price.toString())
        expect(run1[i].baseVolume.toString()).toBe(run2[i].baseVolume.toString())
      }
    })

    it('guarantees pool snapshots and price aggregates stability across calls', () => {
      const anchor = getAnchor()
      const snaps1 = makePoolSnapshots('testnet', PAIRS.testnet, anchor)
      const snaps2 = makePoolSnapshots('testnet', PAIRS.testnet, anchor)
      expect(snaps1).toEqual(snaps2)

      const aggs1 = makePriceAggregates('testnet', PAIRS.testnet, anchor)
      const aggs2 = makePriceAggregates('testnet', PAIRS.testnet, anchor)
      expect(aggs1).toEqual(aggs2)
    })
  })

  // ── Seed CLI options ──────────────────────────────────────────────────────

  describe('seed function with network filter', () => {
    it('seeds both networks when no filter is specified', async () => {
      const mockPrisma = {
        pairConfig: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
          count: vi.fn().mockResolvedValue(1),
        },
        pricePoint: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 36 }),
          count: vi.fn().mockResolvedValue(36),
        },
        poolSnapshot: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 6 }),
          count: vi.fn().mockResolvedValue(6),
        },
        priceAggregate: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 49 }),
          count: vi.fn().mockResolvedValue(49),
        },
      } as any

      const results = await seed({ client: mockPrisma })
      expect(results).toHaveProperty('testnet')
      expect(results).toHaveProperty('mainnet')
      expect(mockPrisma.pairConfig.createMany).toHaveBeenCalledTimes(2)
      expect(mockPrisma.pricePoint.createMany).toHaveBeenCalledTimes(2)
    })

    it('seeds only testnet when network filter is "testnet"', async () => {
      const mockPrisma = {
        pairConfig: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
          count: vi.fn().mockResolvedValue(1),
        },
        pricePoint: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 36 }),
          count: vi.fn().mockResolvedValue(36),
        },
        poolSnapshot: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 6 }),
          count: vi.fn().mockResolvedValue(6),
        },
        priceAggregate: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 49 }),
          count: vi.fn().mockResolvedValue(49),
        },
      } as any

      const results = await seed({ network: 'testnet', client: mockPrisma })
      expect(results).toHaveProperty('testnet')
      expect(results).not.toHaveProperty('mainnet')
      expect(mockPrisma.pairConfig.createMany).toHaveBeenCalledTimes(1)
      expect(mockPrisma.pricePoint.createMany).toHaveBeenCalledTimes(1)
    })

    it('seeds only mainnet when network filter is "mainnet"', async () => {
      const mockPrisma = {
        pairConfig: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
          count: vi.fn().mockResolvedValue(1),
        },
        pricePoint: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 36 }),
          count: vi.fn().mockResolvedValue(36),
        },
        poolSnapshot: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 6 }),
          count: vi.fn().mockResolvedValue(6),
        },
        priceAggregate: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 49 }),
          count: vi.fn().mockResolvedValue(49),
        },
      } as any

      const results = await seed({ network: 'mainnet', client: mockPrisma })
      expect(results).toHaveProperty('mainnet')
      expect(results).not.toHaveProperty('testnet')
      expect(mockPrisma.pairConfig.createMany).toHaveBeenCalledTimes(1)
      expect(mockPrisma.pricePoint.createMany).toHaveBeenCalledTimes(1)
    })

    it('rejects an invalid network filter', async () => {
      const mockPrisma = {} as any
      await expect(seed({ network: 'invalid-net', client: mockPrisma })).rejects.toThrow(
        /Invalid --network value/
      )
    })
  })
})
