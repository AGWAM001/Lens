import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import {
  isPricePointsPartitioned,
  ensurePricePointsPartitions,
  dropExpiredPricePointsPartitions,
  migratePricePointsToPartitioned,
  computeTableChecksum,
  analyzePartitionPruning,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_PRECREATE_DAYS,
} from '../partitioning/pricePoints'

describe('price_points partitioning and retention', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  describe('1. Partition detection (relkind check)', () => {
    it('returns false when price_points is an unpartitioned regular heap table (relkind = r)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ relkind: 'r' }],
      })

      const isPartitioned = await isPricePointsPartitioned({ query: mockQuery } as any)
      expect(isPartitioned).toBe(false)
      expect(mockQuery.mock.calls[0][0]).toMatch(/pg_class/)
      expect(mockQuery.mock.calls[0][1]).toEqual(['price_points'])
    })

    it('returns true when price_points is a partitioned table (relkind = p)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ relkind: 'p' }],
      })

      const isPartitioned = await isPricePointsPartitioned({ query: mockQuery } as any)
      expect(isPartitioned).toBe(true)
    })

    it('returns false when table does not exist', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
      })

      const isPartitioned = await isPricePointsPartitioned({ query: mockQuery } as any)
      expect(isPartitioned).toBe(false)
    })
  })

  describe('2. Automatic creation of future partitions ahead of need', () => {
    it('creates partitions for today and precreateDays into the future', async () => {
      const fixedNow = new Date('2026-10-16T12:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(fixedNow)

      // Mock pg_catalog query for existing tables (none exist initially)
      mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('tablename')) {
          return { rows: [] }
        }
        return { rows: [] }
      })

      const result = await ensurePricePointsPartitions({ query: mockQuery } as any, {
        startDate: fixedNow,
        precreateDays: 7,
      })

      vi.useRealTimers()

      // Today (2026-10-16) + 7 days into future = 8 daily partitions
      expect(result.created.length).toBe(8)
      expect(result.created).toContain('price_points_y2026m10d16')
      expect(result.created).toContain('price_points_y2026m10d23')

      // Verify SQL statements contain PARTITION OF price_points FOR VALUES FROM ... TO ...
      const ddlCalls = mockQuery.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('PARTITION OF price_points')
      )
      expect(ddlCalls.length).toBe(8)
      expect(ddlCalls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS price_points_y2026m10d16/)
      expect(ddlCalls[0][0]).toMatch(/FOR VALUES FROM \('2026-10-16 00:00:00\+00'\) TO \('2026-10-17 00:00:00\+00'\)/)
    })

    it('skips creating partitions that already exist', async () => {
      const fixedNow = new Date('2026-10-16T12:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(fixedNow)

      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('tablename')) {
          return {
            rows: [
              { tablename: 'price_points_y2026m10d16' },
              { tablename: 'price_points_y2026m10d17' },
            ],
          }
        }
        return { rows: [] }
      })

      const result = await ensurePricePointsPartitions({ query: mockQuery } as any, {
        startDate: fixedNow,
        precreateDays: 2,
      })

      vi.useRealTimers()

      // 3 days total (16, 17, 18), 2 already exist
      expect(result.existing).toEqual(['price_points_y2026m10d16', 'price_points_y2026m10d17'])
      expect(result.created).toEqual(['price_points_y2026m10d18'])
    })
  })

  describe('3. Retention drops expired partitions rather than running delete queries', () => {
    it('drops expired partitions via DROP TABLE and NEVER issues DELETE FROM price_points', async () => {
      const fixedNow = new Date('2026-10-16T12:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(fixedNow)

      // Partitions:
      // - 40 days ago: 2026-09-06 (expired)
      // - 31 days ago: 2026-09-15 (expired)
      // - 20 days ago: 2026-09-26 (active)
      // - today: 2026-10-16 (active)
      // - future: 2026-10-20 (future active)
      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('inhrelid')) {
          return {
            rows: [
              { partition_name: 'price_points_y2026m09d06' },
              { partition_name: 'price_points_y2026m09d15' },
              { partition_name: 'price_points_y2026m09d26' },
              { partition_name: 'price_points_y2026m10d16' },
              { partition_name: 'price_points_y2026m10d20' },
            ],
          }
        }
        return { rows: [] }
      })

      const retentionDays = 30
      const result = await dropExpiredPricePointsPartitions({ query: mockQuery } as any, retentionDays)

      vi.useRealTimers()

      expect(result.dropped).toEqual(['price_points_y2026m09d06', 'price_points_y2026m09d15'])
      expect(result.retained).toEqual([
        'price_points_y2026m09d26',
        'price_points_y2026m10d16',
        'price_points_y2026m10d20',
      ])

      // CRITICAL ACCEPTANCE CRITERIA: Verify DROP TABLE was called
      const dropCalls = mockQuery.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('DROP TABLE')
      )
      expect(dropCalls.length).toBe(2)
      expect(dropCalls[0][0]).toMatch(/DROP TABLE IF EXISTS price_points_y2026m09d06/)
      expect(dropCalls[1][0]).toMatch(/DROP TABLE IF EXISTS price_points_y2026m09d15/)

      // CRITICAL ACCEPTANCE CRITERIA: Verify NO DELETE query was issued on price_points
      const deleteCalls = mockQuery.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].toUpperCase().includes('DELETE FROM PRICE_POINTS')
      )
      expect(deleteCalls.length).toBe(0)
    })
  })

  describe('4. Migration script preserves every row with row count and checksum comparison', () => {
    it('computes table checksum deterministically', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '1500', checksum: 'a1b2c3d4e5f6' }],
      })

      const res = await computeTableChecksum({ query: mockQuery } as any, 'price_points')
      expect(res.rowCount).toBe(1500)
      expect(res.checksum).toBe('a1b2c3d4e5f6')
      expect(mockQuery.mock.calls[0][0]).toMatch(/MD5/)
      expect(mockQuery.mock.calls[0][0]).toMatch(/COUNT\(\*\)/)
    })

    it('migrates unpartitioned table to partitioned with verification and cutover', async () => {
      let phase = 0
      mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        const s = typeof sql === 'string' ? sql : ''

        // 1. isPricePointsPartitioned check
        if (s.includes('pg_class') && params?.[0] === 'price_points') {
          return { rows: [{ relkind: 'r' }] } // currently unpartitioned
        }

        // 2. min/max timestamp query
        if (s.includes('MIN(timestamp)')) {
          return {
            rows: [{
              min_ts: new Date('2026-10-10T00:00:00Z'),
              max_ts: new Date('2026-10-16T12:00:00Z'),
              count: '250',
            }],
          }
        }

        // 3. computeTableChecksum on price_points
        if (s.includes('FROM price_points') && s.includes('MD5')) {
          return { rows: [{ count: '250', checksum: 'checksum-hash-xyz' }] }
        }

        // 4. computeTableChecksum on price_points_partitioned
        if (s.includes('FROM price_points_partitioned') && s.includes('MD5')) {
          return { rows: [{ count: '250', checksum: 'checksum-hash-xyz' }] }
        }

        // 5. Existing partitions check
        if (s.includes('tablename')) {
          return { rows: [] }
        }

        return { rows: [] }
      })

      const migration = await migratePricePointsToPartitioned({ query: mockQuery } as any)

      expect(migration.migrated).toBe(true)
      expect(migration.rowCount).toBe(250)
      expect(migration.checksum).toBe('checksum-hash-xyz')

      // Verify that data was copied from price_points into price_points_partitioned
      const copyCall = mockQuery.mock.calls.find(c =>
        typeof c[0] === 'string' &&
        c[0].includes('INSERT INTO price_points_partitioned') &&
        c[0].includes('SELECT') &&
        c[0].includes('FROM price_points')
      )
      expect(copyCall).toBeDefined()

      // Verify atomic cutover rename happened in a transaction
      const renameCall = mockQuery.mock.calls.find(c =>
        typeof c[0] === 'string' &&
        c[0].includes('ALTER TABLE price_points RENAME TO') &&
        c[0].includes('ALTER TABLE price_points_partitioned RENAME TO price_points')
      )
      expect(renameCall).toBeDefined()
    })

    it('aborts migration if row count or checksum does not match', async () => {
      mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        const s = typeof sql === 'string' ? sql : ''

        if (s.includes('pg_class') && params?.[0] === 'price_points') {
          return { rows: [{ relkind: 'r' }] }
        }
        if (s.includes('MIN(timestamp)')) {
          return {
            rows: [{
              min_ts: new Date('2026-10-10T00:00:00Z'),
              max_ts: new Date('2026-10-16T12:00:00Z'),
              count: '250',
            }],
          }
        }
        // Corrupted copy: checksum mismatch
        if (s.includes('FROM price_points_partitioned') && s.includes('MD5')) {
          return { rows: [{ count: '250', checksum: 'corrupted-checksum' }] }
        }
        if (s.includes('FROM price_points') && s.includes('MD5')) {
          return { rows: [{ count: '250', checksum: 'original-checksum' }] }
        }
        return { rows: [] }
      })

      await expect(
        migratePricePointsToPartitioned({ query: mockQuery } as any)
      ).rejects.toThrow(/Checksum mismatch/)
    })

    it('returns alreadyPartitioned if table is already partitioned', async () => {
      mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        const s = typeof sql === 'string' ? sql : ''
        if (s.includes('pg_class') && params?.[0] === 'price_points') {
          return { rows: [{ relkind: 'p' }] }
        }
        return { rows: [] }
      })

      const res = await migratePricePointsToPartitioned({ query: mockQuery } as any)
      expect(res.alreadyPartitioned).toBe(true)
      expect(res.migrated).toBe(false)
    })
  })

  describe('5. Partition pruning verification in query plans', () => {
    it('detects partition pruning from PostgreSQL EXPLAIN output', () => {
      // Realistic PostgreSQL EXPLAIN output with partition pruning
      const explainText = `
        Append  (cost=0.00..45.12 rows=10 width=128)
          ->  Seq Scan on price_points_y2026m10d16 price_points_1  (cost=0.00..22.50 rows=5 width=128)
                Filter: ((timestamp > (now() - '01:00:00'::interval)) AND (pair_key = 'XLM/USDC'::text))
          Subplans Removed: 29
      `

      const analysis = analyzePartitionPruning(explainText)
      expect(analysis.isPruned).toBe(true)
      expect(analysis.scannedPartitions).toContain('price_points_y2026m10d16')
      expect(analysis.scannedPartitions).not.toContain('price_points_y2026m10d15')
    })

    it('detects unpruned scan across all partitions', () => {
      const explainText = `
        Append  (cost=0.00..120.00 rows=30 width=128)
          ->  Seq Scan on price_points_y2026m10d14 price_points_1
          ->  Seq Scan on price_points_y2026m10d15 price_points_2
          ->  Seq Scan on price_points_y2026m10d16 price_points_3
      `

      const analysis = analyzePartitionPruning(explainText)
      expect(analysis.isPruned).toBe(false)
      expect(analysis.scannedPartitions.length).toBe(3)
    })
  })
})
