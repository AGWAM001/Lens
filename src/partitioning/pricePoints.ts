export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>
}

export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_PRECREATE_DAYS = 7

export interface PartitionCreationResult {
  created: string[]
  existing: string[]
}

export interface PartitionRetentionResult {
  dropped: string[]
  retained: string[]
}

export interface MigrationResult {
  migrated: boolean
  alreadyPartitioned?: boolean
  rowCount: number
  checksum: string
}

export interface PruningAnalysis {
  isPruned: boolean
  scannedPartitions: string[]
  totalPartitions: number
  rawPlan?: any
}

/** Formats a Date into UTC YYYY-MM-DD */
export function formatUtcDate(date: Date): { year: string; month: string; day: string; ymd: string } {
  const d = new Date(date)
  const year = String(d.getUTCFullYear())
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return { year, month, day, ymd: `${year}-${month}-${day}` }
}

/** Returns the standardized partition table name for a UTC date, e.g. price_points_y2026m10d16 */
export function getPartitionName(date: Date): string {
  const { year, month, day } = formatUtcDate(date)
  return `price_points_y${year}m${month}d${day}`
}

/** Parses the UTC date from a partition table name */
export function parseDateFromPartitionName(name: string): Date | null {
  // Matches price_points_y2026m10d16
  const match1 = name.match(/^price_points_y(\d{4})m(\d{2})d(\d{2})$/)
  if (match1) {
    const [, y, m, d] = match1
    return new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10)))
  }
  // Matches price_points_2026_10_16 or price_points_p20261016
  const match2 = name.match(/^price_points_(\d{4})_(\d{2})_(\d{2})$/)
  if (match2) {
    const [, y, m, d] = match2
    return new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10)))
  }
  return null
}

/**
 * Checks whether the `price_points` table in PostgreSQL is declarative partitioned
 * by querying `pg_class.relkind` (`'p'` indicates partitioned table, `'r'` regular table).
 */
export async function isPricePointsPartitioned(
  client: PgClientLike,
  tableName: string = 'price_points'
): Promise<boolean> {
  const res = await client.query(
    `SELECT c.relkind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1`,
    [tableName]
  )
  if (!res.rows || res.rows.length === 0) return false
  return res.rows[0].relkind === 'p'
}

/**
 * Ensures daily range partitions exist for price_points from `startDate - daysBack`
 * through `startDate + precreateDays`.
 *
 * Each partition is created with bounds:
 * FOR VALUES FROM ('YYYY-MM-DD 00:00:00+00') TO ('YYYY-MM-DD+1 00:00:00+00')
 */
export async function ensurePricePointsPartitions(
  client: PgClientLike,
  options?: {
    startDate?: Date
    precreateDays?: number
    daysBack?: number
    targetTable?: string
  }
): Promise<PartitionCreationResult> {
  const baseDate = options?.startDate ?? new Date()
  const precreateDays = options?.precreateDays ?? DEFAULT_PRECREATE_DAYS
  const daysBack = options?.daysBack ?? 0
  const targetTable = options?.targetTable ?? 'price_points'

  // Query existing partition tables
  const existingTablesRes = await client.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public' AND tablename LIKE 'price_points_%'`
  )
  const existingSet = new Set((existingTablesRes.rows || []).map(r => r.tablename))

  const created: string[] = []
  const existing: string[] = []

  // Iterate day by day from -daysBack to +precreateDays
  for (let offset = -daysBack; offset <= precreateDays; offset++) {
    const dayStart = new Date(Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth(),
      baseDate.getUTCDate() + offset,
      0, 0, 0, 0
    ))
    const dayEnd = new Date(Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth(),
      baseDate.getUTCDate() + offset + 1,
      0, 0, 0, 0
    ))

    const partitionName = getPartitionName(dayStart)
    const { ymd: startYmd } = formatUtcDate(dayStart)
    const { ymd: endYmd } = formatUtcDate(dayEnd)

    if (existingSet.has(partitionName)) {
      existing.push(partitionName)
      continue
    }

    const ddl = `CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF ${targetTable} FOR VALUES FROM ('${startYmd} 00:00:00+00') TO ('${endYmd} 00:00:00+00');`
    await client.query(ddl)
    existingSet.add(partitionName)
    created.push(partitionName)
  }

  return { created, existing }
}

/**
 * Drops expired daily partitions of price_points whose range is strictly older
 * than the retention window.
 *
 * Uses `DROP TABLE IF EXISTS <partition>`, preventing disk bloat and WAL overhead,
 * and NEVER runs delete queries against price_points.
 */
export async function dropExpiredPricePointsPartitions(
  client: PgClientLike,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
  parentTable: string = 'price_points'
): Promise<PartitionRetentionResult> {
  const now = Date.now()
  const cutoffTime = now - retentionDays * 24 * 60 * 60 * 1000

  // Query all attached child partitions of parentTable
  const res = await client.query(
    `SELECT c.relname AS partition_name
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE p.relname = $1 AND n.nspname = 'public'`,
    [parentTable]
  )

  const dropped: string[] = []
  const retained: string[] = []

  for (const row of res.rows || []) {
    const name = row.partition_name as string
    const partitionDate = parseDateFromPartitionName(name)
    if (!partitionDate) {
      retained.push(name)
      continue
    }

    // Partition covers [partitionDate .. partitionDate + 1 day]
    const partitionEndTime = Date.UTC(
      partitionDate.getUTCFullYear(),
      partitionDate.getUTCMonth(),
      partitionDate.getUTCDate() + 1,
      0, 0, 0, 0
    )

    if (partitionEndTime <= cutoffTime) {
      await client.query(`DROP TABLE IF EXISTS ${name};`)
      dropped.push(name)
    } else {
      retained.push(name)
    }
  }

  return { dropped, retained }
}

/**
 * Computes deterministic row count and column-level checksum for a table.
 * Used for pre- and post-migration verification.
 */
export async function computeTableChecksum(
  client: PgClientLike,
  tableName: string
): Promise<{ rowCount: number; checksum: string }> {
  const sql = `
    SELECT
      COUNT(*)::bigint AS count,
      COALESCE(
        MD5(
          STRING_AGG(
            MD5(
              id || '|' ||
              network || '|' ||
              asset_a || '|' ||
              asset_b || '|' ||
              pair_key || '|' ||
              source || '|' ||
              COALESCE(pool_id, '') || '|' ||
              price::text || '|' ||
              base_volume::text || '|' ||
              counter_volume::text || '|' ||
              ledger::text || '|' ||
              to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' ||
              COALESCE(event_id, '')
            ),
            ',' ORDER BY id, timestamp
          )
        ),
        'empty'
      ) AS checksum
    FROM ${tableName}
  `
  const res = await client.query(sql)
  const row = res.rows?.[0]
  const rowCount = row ? parseInt(row.count, 10) : 0
  const checksum = row?.checksum ?? 'empty'
  return { rowCount, checksum }
}

/**
 * Zero-regression migration script for price_points:
 * 1. Verifies if already partitioned (idempotent).
 * 2. Checks existing row count and calculates pre-migration checksum.
 * 3. Creates `price_points_partitioned` partitioned by RANGE (timestamp).
 * 4. Pre-creates all needed partitions covering existing data range + precreateDays into future.
 * 5. Copies all rows from `price_points` to `price_points_partitioned`.
 * 6. Verifies exact row count and checksum match between old and new tables.
 * 7. Creates indexes on the partitioned parent table.
 * 8. Atomically swaps tables via ALTER TABLE RENAME.
 */
export async function migratePricePointsToPartitioned(
  client: PgClientLike,
  options?: {
    precreateDays?: number
    backupTableName?: string
  }
): Promise<MigrationResult> {
  const precreateDays = options?.precreateDays ?? DEFAULT_PRECREATE_DAYS
  const backupTableName = options?.backupTableName ?? 'price_points_unpartitioned_backup'

  // 1. Check if already partitioned
  const already = await isPricePointsPartitioned(client, 'price_points')
  if (already) {
    return {
      migrated: false,
      alreadyPartitioned: true,
      rowCount: 0,
      checksum: '',
    }
  }

  // 2. Query min, max timestamp and count of current table
  const boundsRes = await client.query(
    `SELECT MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts, COUNT(*)::bigint AS count
     FROM price_points`
  )
  const boundsRow = boundsRes.rows?.[0]
  const originalCount = boundsRow ? parseInt(boundsRow.count, 10) : 0
  const minTs = boundsRow?.min_ts ? new Date(boundsRow.min_ts) : new Date()
  const maxTs = boundsRow?.max_ts ? new Date(boundsRow.max_ts) : new Date()

  // 3. Compute baseline checksum
  const { rowCount: preCount, checksum: preChecksum } = await computeTableChecksum(client, 'price_points')

  // 4. Create partitioned table definition
  await client.query(`
    CREATE TABLE IF NOT EXISTS price_points_partitioned (
      id TEXT NOT NULL,
      network TEXT NOT NULL DEFAULT 'testnet',
      asset_a TEXT NOT NULL,
      asset_b TEXT NOT NULL,
      pair_key TEXT NOT NULL,
      source TEXT NOT NULL,
      pool_id TEXT,
      price DECIMAL(36, 18) NOT NULL,
      base_volume DECIMAL(36, 7) NOT NULL,
      counter_volume DECIMAL(36, 7) NOT NULL,
      ledger INTEGER NOT NULL,
      timestamp TIMESTAMP(3) NOT NULL,
      event_id TEXT,
      PRIMARY KEY (id, timestamp)
    ) PARTITION BY RANGE (timestamp);
  `)

  // 5. Pre-create all partitions from minTs through maxTs + precreateDays
  const startDay = new Date(Date.UTC(minTs.getUTCFullYear(), minTs.getUTCMonth(), minTs.getUTCDate()))
  const endDay = new Date(Date.UTC(maxTs.getUTCFullYear(), maxTs.getUTCMonth(), maxTs.getUTCDate()))
  const diffDays = Math.ceil((endDay.getTime() - startDay.getTime()) / (24 * 60 * 60 * 1000))
  const totalDays = Math.max(diffDays, 0) + precreateDays

  await ensurePricePointsPartitions(client, {
    startDate: startDay,
    daysBack: 0,
    precreateDays: totalDays,
    targetTable: 'price_points_partitioned',
  })

  // 6. Copy all rows
  if (originalCount > 0) {
    await client.query(`
      INSERT INTO price_points_partitioned (
        id, network, asset_a, asset_b, pair_key, source, pool_id,
        price, base_volume, counter_volume, ledger, timestamp, event_id
      )
      SELECT
        id, network, asset_a, asset_b, pair_key, source, pool_id,
        price, base_volume, counter_volume, ledger, timestamp, event_id
      FROM price_points;
    `)
  }

  // 7. Verify row count and checksum
  const { rowCount: postCount, checksum: postChecksum } = await computeTableChecksum(
    client,
    'price_points_partitioned'
  )

  if (postCount !== preCount) {
    throw new Error(`Migration verification failed: Row count mismatch (original: ${preCount}, partitioned: ${postCount})`)
  }
  if (postChecksum !== preChecksum) {
    throw new Error(`Migration verification failed: Checksum mismatch (original: ${preChecksum}, partitioned: ${postChecksum})`)
  }

  // 8. Create indexes on parent partitioned table
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_price_points_part_network_pair_ts
    ON price_points_partitioned (network, pair_key, timestamp DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_price_points_part_network_pair_source_ts
    ON price_points_partitioned (network, pair_key, source, timestamp DESC);
  `)

  // 9. Atomic swap
  await client.query(`
    DO $$
    BEGIN
      ALTER TABLE price_points RENAME TO ${backupTableName};
      ALTER TABLE price_points_partitioned RENAME TO price_points;
    END $$;
  `)

  return {
    migrated: true,
    rowCount: postCount,
    checksum: postChecksum,
  }
}

/**
 * Analyzes an EXPLAIN plan string or object to determine whether partition pruning occurred.
 */
export function analyzePartitionPruning(explainOutput: string | object): PruningAnalysis {
  const text = typeof explainOutput === 'string' ? explainOutput : JSON.stringify(explainOutput)

  // Find all matched partitions
  const matches = text.match(/price_points_y\d{4}m\d{2}d\d{2}|price_points_\d{4}_\d{2}_\d{2}/g) || []
  const scannedPartitions = Array.from(new Set(matches))

  // In PostgreSQL EXPLAIN output, partition pruning shows:
  // "Subplans Removed: N" or "Partitions Removed: N", or scanning fewer than all historical partitions
  const hasSubplansRemoved = /Subplans Removed:\s*[1-9]\d*/i.test(text)
  const hasPartitionsRemoved = /Partitions Removed:\s*[1-9]\d*/i.test(text)

  const isPruned = hasSubplansRemoved || hasPartitionsRemoved || scannedPartitions.length === 1

  return {
    isPruned,
    scannedPartitions,
    totalPartitions: scannedPartitions.length + (hasSubplansRemoved ? 1 : 0),
    rawPlan: explainOutput,
  }
}
