import type { Pool } from 'pg'
import { pgPool } from '../db'

export interface SchemaVerificationResult {
  valid: boolean
  missingTables: string[]
  missingColumns: string[]
  checkedAt: string
}

export const EXPECTED_SCHEMA: Record<string, string[]> = {
  price_points: ['id', 'network', 'asset_a', 'asset_b', 'pair_key', 'source', 'price', 'timestamp'],
  pool_snapshots: ['id', 'network', 'pool_id', 'asset_a', 'asset_b', 'spot_price', 'timestamp'],
  price_aggregates: ['pair_key', 'network', 'window', 'bucket', 'vwap'],
  price_snapshots: ['pair', 'network', 'ts', 'price'],
  indexer_state: ['id', 'network', 'last_cursor', 'last_ledger'],
}

let cachedVerification: SchemaVerificationResult | null = null

/**
 * Verifies that the connected database contains the expected tables and columns (#352).
 * Runs efficiently via single information_schema queries on startup.
 */
export async function verifyDatabaseSchema(
  pool: Pick<Pool, 'query'> = pgPool,
  expected: Record<string, string[]> = EXPECTED_SCHEMA
): Promise<SchemaVerificationResult> {
  const missingTables: string[] = []
  const missingColumns: string[] = []

  try {
    const tableRes = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'`
    )
    const existingTables = new Set(tableRes.rows.map((r: any) => r.table_name))

    for (const table of Object.keys(expected)) {
      if (!existingTables.has(table)) {
        missingTables.push(table)
      }
    }

    // Only query columns for existing tables to avoid unnecessary joins
    const tablesToQuery = Object.keys(expected).filter(t => existingTables.has(t))
    if (tablesToQuery.length > 0) {
      const colRes = await pool.query(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ANY($1)`,
        [tablesToQuery]
      )
      const existingCols = new Set(colRes.rows.map((r: any) => `${r.table_name}.${r.column_name}`))

      for (const table of tablesToQuery) {
        for (const col of expected[table]) {
          if (!existingCols.has(`${table}.${col}`)) {
            missingColumns.push(`${table}.${col}`)
          }
        }
      }
    }
  } catch (_err) {
    // If database connection fails or queries error, report invalid schema
    const result: SchemaVerificationResult = {
      valid: false,
      missingTables: Object.keys(expected),
      missingColumns: [],
      checkedAt: new Date().toISOString(),
    }
    cachedVerification = result
    return result
  }

  const result: SchemaVerificationResult = {
    valid: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    checkedAt: new Date().toISOString(),
  }

  cachedVerification = result
  return result
}

export function getCachedSchemaVerification(): SchemaVerificationResult | null {
  return cachedVerification
}

export function resetSchemaVerificationCache(): void {
  cachedVerification = null
}

export class DatabaseSchemaMismatchError extends Error {
  constructor(public readonly result: SchemaVerificationResult) {
    const details = [
      result.missingTables.length > 0 ? `missing tables [${result.missingTables.join(', ')}]` : '',
      result.missingColumns.length > 0 ? `missing columns [${result.missingColumns.join(', ')}]` : '',
    ].filter(Boolean).join('; ')
    super(`Database schema mismatch at startup: ${details}`)
    this.name = 'DatabaseSchemaMismatchError'
  }
}

/**
 * Asserts that the database schema matches expected models (#352).
 * Fails fast and throws DatabaseSchemaMismatchError if any table or column is missing.
 */
export async function assertSchemaValid(
  pool: Pick<Pool, 'query'> = pgPool,
  expected: Record<string, string[]> = EXPECTED_SCHEMA
): Promise<SchemaVerificationResult> {
  const result = await verifyDatabaseSchema(pool, expected)
  if (!result.valid) {
    throw new DatabaseSchemaMismatchError(result)
  }
  return result
}
