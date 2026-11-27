import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { pgPool } from '../db'
import { pruneOldPoolSnapshots, PRUNE_BATCH_SQL, POOL_SNAPSHOT_PRUNE_BATCH_SIZE } from '../jobs/poolSnapshotRetention'

/**
 * Runs the real prune SQL against a real, migrated Postgres.
 *
 * Opt-in, like the docker-compose e2e suite: set LENS_DB_TESTS=1 and point
 * DATABASE_URL at a THROWAWAY database. CI does this in the "Migration drift &
 * deploy" job, against the Postgres service it has just migrated. Without the
 * flag the suite is skipped, so `npm test` never touches a database.
 *
 * The prune deletes by network and age, not by fixture id, so the suite
 * refuses to run if pool_snapshots holds any row it did not insert.
 */
const runDbTests = process.env.LENS_DB_TESTS === '1'

const POOL_PREFIX = 'retention-test-'

interface Fixture {
  key: string
  network: 'testnet' | 'mainnet'
  pool: string
  daysAgo: number
}

async function insert(rows: Fixture[]): Promise<void> {
  for (const row of rows) {
    await pgPool.query(
      `INSERT INTO pool_snapshots
         (id, network, pool_id, asset_a, asset_b, reserve_a, reserve_b, spot_price, total_shares, fee_bp, ledger, timestamp)
       VALUES ($1, $2, $3, 'XLM', 'USDC', 1000, 2000, 2, 100, 30, 1, NOW() - make_interval(days => $4))`,
      [row.key, row.network, POOL_PREFIX + row.pool, row.daysAgo]
    )
  }
}

async function remainingKeys(network?: string): Promise<string[]> {
  const { rows } = await pgPool.query<{ id: string }>(
    `SELECT id FROM pool_snapshots
      WHERE pool_id LIKE $1 AND ($2::text IS NULL OR network = $2)
      ORDER BY id`,
    [`${POOL_PREFIX}%`, network ?? null]
  )
  return rows.map(r => r.id)
}

async function clearFixtures(): Promise<void> {
  await pgPool.query(`DELETE FROM pool_snapshots WHERE pool_id LIKE $1`, [`${POOL_PREFIX}%`])
}

describe.skipIf(!runDbTests)('pool snapshot retention against Postgres', () => {
  beforeAll(async () => {
    const { rows } = await pgPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pool_snapshots WHERE pool_id NOT LIKE $1`,
      [`${POOL_PREFIX}%`]
    )
    if (rows[0].n > 0) {
      throw new Error(
        `pool_snapshots has ${rows[0].n} rows this suite did not create; refusing to prune. ` +
          'Point DATABASE_URL at a throwaway database.'
      )
    }
  })

  beforeEach(clearFixtures)

  afterAll(async () => {
    await clearFixtures()
    await pgPool.end()
  })

  it('keeps each pool\'s newest row and every row inside the window, and deletes the rest', async () => {
    await insert([
      // Dormant for 45 days: its only row is also its newest, so it stays.
      { key: 'dormant-45', network: 'testnet', pool: 'dormant', daysAgo: 45 },
      // Two expired rows: the older goes, the newest stays.
      { key: 'stale-50', network: 'testnet', pool: 'stale', daysAgo: 50 },
      { key: 'stale-40', network: 'testnet', pool: 'stale', daysAgo: 40 },
      // Active: both expired rows go, the fresh one stays.
      { key: 'active-40', network: 'testnet', pool: 'active', daysAgo: 40 },
      { key: 'active-35', network: 'testnet', pool: 'active', daysAgo: 35 },
      { key: 'active-1', network: 'testnet', pool: 'active', daysAgo: 1 },
      // Entirely inside the 30-day window: nothing goes.
      { key: 'recent-10', network: 'testnet', pool: 'recent', daysAgo: 10 },
      { key: 'recent-2', network: 'testnet', pool: 'recent', daysAgo: 2 },
    ])

    // Batch size 1 so the run spans several batches and pools via the cursor.
    const pruned = await pruneOldPoolSnapshots(30, 'testnet', { batchSize: 1, pauseMs: 0 })

    expect(pruned).toBe(3)
    expect(await remainingKeys()).toEqual(['active-1', 'dormant-45', 'recent-10', 'recent-2', 'stale-40'])
    // A second run has nothing left to do.
    expect(await pruneOldPoolSnapshots(30, 'testnet', { batchSize: 1, pauseMs: 0 })).toBe(0)
  })

  it('only touches the network it is pruning, even for the same pool id', async () => {
    await insert([
      { key: 'test-60', network: 'testnet', pool: 'shared', daysAgo: 60 },
      { key: 'test-1', network: 'testnet', pool: 'shared', daysAgo: 1 },
      // On mainnet the same pool id's newest row is old; it must survive, and
      // the testnet row at 1 day must not count as "newer" for it.
      { key: 'main-60', network: 'mainnet', pool: 'shared', daysAgo: 60 },
      { key: 'main-50', network: 'mainnet', pool: 'shared', daysAgo: 50 },
    ])

    expect(await pruneOldPoolSnapshots(30, 'testnet', { pauseMs: 0 })).toBe(1)
    expect(await remainingKeys('testnet')).toEqual(['test-1'])
    expect(await remainingKeys('mainnet')).toEqual(['main-50', 'main-60'])

    expect(await pruneOldPoolSnapshots(30, 'mainnet', { pauseMs: 0 })).toBe(1)
    expect(await remainingKeys('mainnet')).toEqual(['main-50'])
  })

  it('honors the age cutoff it is given', async () => {
    await insert([
      { key: 'p-20', network: 'testnet', pool: 'cutoff', daysAgo: 20 },
      { key: 'p-8', network: 'testnet', pool: 'cutoff', daysAgo: 8 },
      { key: 'p-3', network: 'testnet', pool: 'cutoff', daysAgo: 3 },
    ])

    expect(await pruneOldPoolSnapshots(30, 'testnet', { pauseMs: 0 })).toBe(0)
    expect(await pruneOldPoolSnapshots(7, 'testnet', { pauseMs: 0 })).toBe(2)
    expect(await remainingKeys()).toEqual(['p-3'])
  })

  it('keeps every row tied for a pool\'s newest timestamp', async () => {
    // Same statement, same NOW(): both rows share one timestamp.
    await pgPool.query(
      `INSERT INTO pool_snapshots
         (id, network, pool_id, asset_a, asset_b, reserve_a, reserve_b, spot_price, total_shares, fee_bp, ledger, timestamp)
       SELECT k, 'testnet', $1, 'XLM', 'USDC', 1000, 2000, 2, 100, 30, 1, NOW() - interval '45 days'
         FROM unnest(ARRAY['tie-a', 'tie-b']) AS k`,
      [`${POOL_PREFIX}tie`]
    )

    expect(await pruneOldPoolSnapshots(30, 'testnet', { pauseMs: 0 })).toBe(0)
    expect(await remainingKeys()).toEqual(['tie-a', 'tie-b'])
  })

  it('stops at the per-run batch cap and finishes on the next run', async () => {
    await insert([
      { key: 'cap-50', network: 'testnet', pool: 'cap', daysAgo: 50 },
      { key: 'cap-45', network: 'testnet', pool: 'cap', daysAgo: 45 },
      { key: 'cap-40', network: 'testnet', pool: 'cap', daysAgo: 40 },
      { key: 'cap-1', network: 'testnet', pool: 'cap', daysAgo: 1 },
    ])

    expect(await pruneOldPoolSnapshots(30, 'testnet', { batchSize: 1, maxBatches: 2, pauseMs: 0 })).toBe(2)
    expect(await remainingKeys()).toHaveLength(2)
    expect(await pruneOldPoolSnapshots(30, 'testnet', { batchSize: 1, maxBatches: 2, pauseMs: 0 })).toBe(1)
    expect(await remainingKeys()).toEqual(['cap-1'])
  })

  it('plans a batch on the (network, pool_id, timestamp DESC) index and a TID delete: no sequential scan, no sort', async () => {
    // The case that matters is a backlog far larger than one batch (a first
    // run against a never-pruned table). 30,000 rows over 50 pools, two
    // networks and 60 days, then fresh stats, planned at the default batch
    // size. (With a backlog smaller than one batch the planner may sort the
    // few hundred eligible rows instead, which is cheap and fine.)
    await pgPool.query(
      `INSERT INTO pool_snapshots
         (id, network, pool_id, asset_a, asset_b, reserve_a, reserve_b, spot_price, total_shares, fee_bp, ledger, timestamp)
       SELECT 'plan-' || g,
              CASE WHEN g % 3 = 0 THEN 'mainnet' ELSE 'testnet' END,
              $1 || 'plan-' || (g % 50),
              'XLM', 'USDC', 1000, 2000, 2, 100, 30, 1,
              NOW() - make_interval(hours => g % 1440)
         FROM generate_series(1, 30000) AS g`,
      [POOL_PREFIX]
    )
    await pgPool.query('ANALYZE pool_snapshots')

    const { rows } = await pgPool.query(`EXPLAIN (FORMAT JSON) ${PRUNE_BATCH_SQL}`, [
      'testnet',
      30,
      POOL_SNAPSHOT_PRUNE_BATCH_SIZE,
      '',
    ])
    const nodes: Array<Record<string, unknown>> = []
    const walk = (node: Record<string, unknown>) => {
      nodes.push(node)
      for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child)
    }
    walk((rows[0]['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)[0].Plan)
    const nodeTypes = nodes.map(n => n['Node Type'])

    expect(nodeTypes).not.toContain('Seq Scan')
    expect(nodeTypes).not.toContain('Sort')
    expect(nodeTypes).toContain('Tid Scan')
    expect(nodes.map(n => n['Index Name'])).toContain('pool_snapshots_network_pool_id_timestamp_idx')

    // And the statement itself runs: one full batch.
    expect(await pruneOldPoolSnapshots(30, 'testnet', { batchSize: 1000, maxBatches: 1, pauseMs: 0 })).toBe(1000)
  })
})
