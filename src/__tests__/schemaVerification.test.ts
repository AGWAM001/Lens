import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  verifyDatabaseSchema,
  assertSchemaValid,
  DatabaseSchemaMismatchError,
  EXPECTED_SCHEMA,
} from '../db/schemaVerify'

describe('Database Schema Startup Verification (#352)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes when all expected tables and columns exist', async () => {
    const mockQuery = vi.fn()
      // First query: tables in information_schema
      .mockResolvedValueOnce({
        rows: [
          { table_name: 'price_points' },
          { table_name: 'pool_snapshots' },
          { table_name: 'price_aggregates' },
          { table_name: 'price_snapshots' },
          { table_name: 'indexer_state' },
        ],
      })
      // Second query: columns in information_schema
      .mockResolvedValueOnce({
        rows: [
          ...EXPECTED_SCHEMA.price_points.map(col => ({ table_name: 'price_points', column_name: col })),
          ...EXPECTED_SCHEMA.pool_snapshots.map(col => ({ table_name: 'pool_snapshots', column_name: col })),
          ...EXPECTED_SCHEMA.price_aggregates.map(col => ({ table_name: 'price_aggregates', column_name: col })),
          ...EXPECTED_SCHEMA.price_snapshots.map(col => ({ table_name: 'price_snapshots', column_name: col })),
          ...EXPECTED_SCHEMA.indexer_state.map(col => ({ table_name: 'indexer_state', column_name: col })),
        ],
      })

    const pool = { query: mockQuery } as any
    const result = await verifyDatabaseSchema(pool)

    expect(result.valid).toBe(true)
    expect(result.missingTables).toEqual([])
    expect(result.missingColumns).toEqual([])
  })

  it('fails and identifies missing tables', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        { table_name: 'price_points' },
        // pool_snapshots missing
        { table_name: 'price_aggregates' },
        { table_name: 'price_snapshots' },
        { table_name: 'indexer_state' },
      ],
    }).mockResolvedValueOnce({
      rows: [
        ...EXPECTED_SCHEMA.price_points.map(col => ({ table_name: 'price_points', column_name: col })),
        ...EXPECTED_SCHEMA.price_aggregates.map(col => ({ table_name: 'price_aggregates', column_name: col })),
        ...EXPECTED_SCHEMA.price_snapshots.map(col => ({ table_name: 'price_snapshots', column_name: col })),
        ...EXPECTED_SCHEMA.indexer_state.map(col => ({ table_name: 'indexer_state', column_name: col })),
      ],
    })

    const pool = { query: mockQuery } as any
    const result = await verifyDatabaseSchema(pool)

    expect(result.valid).toBe(false)
    expect(result.missingTables).toContain('pool_snapshots')
  })

  it('fails and identifies missing columns within existing tables', async () => {
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { table_name: 'price_points' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          // Omits 'network' and 'source' columns
          { table_name: 'price_points', column_name: 'id' },
          { table_name: 'price_points', column_name: 'asset_a' },
          { table_name: 'price_points', column_name: 'asset_b' },
          { table_name: 'price_points', column_name: 'pair_key' },
          { table_name: 'price_points', column_name: 'price' },
          { table_name: 'price_points', column_name: 'timestamp' },
        ],
      })

    const testSchema = {
      price_points: ['id', 'network', 'asset_a', 'asset_b', 'pair_key', 'source', 'price', 'timestamp'],
    }

    const pool = { query: mockQuery } as any
    const result = await verifyDatabaseSchema(pool, testSchema)

    expect(result.valid).toBe(false)
    expect(result.missingColumns).toContain('price_points.network')
    expect(result.missingColumns).toContain('price_points.source')
  })

  it('assertSchemaValid throws DatabaseSchemaMismatchError with detailed entity names on mismatch', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({
      rows: [], // completely empty database
    })

    const pool = { query: mockQuery } as any

    await expect(assertSchemaValid(pool)).rejects.toThrowError(DatabaseSchemaMismatchError)
    await expect(assertSchemaValid(pool)).rejects.toThrowError(/missing tables/)
  })
})
