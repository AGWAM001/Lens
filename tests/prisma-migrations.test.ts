import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * #233 — There is no migration history, only `db push`.
 *
 * The defect this guards against is invisible to every other test in the repo:
 * `prisma/` shipped only `schema.prisma`, and every schema change was applied
 * with `prisma db push`, which diffs the live DB against the schema and applies
 * whatever it decides. Nothing in the codebase could detect a schema that had
 * drifted away from any committed, reviewable migration.
 *
 * These tests are the "fails first" proof. Before adoption `prisma/migrations`
 * does not exist, so `has a committed migration history` fails; the moment the
 * baseline lands it passes. The drift test then locks `schema.prisma` and the
 * baseline together: edit the schema without regenerating a migration and the
 * two diverge, exactly the failure mode #233 exists to prevent.
 *
 * They are deliberately DB-free: they only run
 * `prisma migrate diff --from-empty --to-schema-datamodel`, which reads the
 * schema file and never opens a connection, so they run inside plain `npm test`
 * and the CI build job with no Postgres present. The general, multi-migration
 * drift guard (replaying every migration against a real database) lives in the
 * `db-migrations` CI job and scripts/db-drift-check.sh, both of which need a
 * live database. Adopting the baseline on a database that predates the history
 * is a third, separate concern: tests/db-migrate-baseline.test.ts.
 */

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const migrationsDir = join(repoRoot, 'prisma', 'migrations')
const schemaFile = join(repoRoot, 'prisma', 'schema.prisma')

/** Prisma's engines need the datasource env vars defined, but
 *  `--from-empty --to-schema-datamodel` never connects, so point them at a
 *  closed port: if the command ever *did* try to reach the DB it fails loudly
 *  instead of silently touching someone's real database. */
const OFFLINE_ENV = {
  DATABASE_URL: 'postgresql://off:off@127.0.0.1:1/off',
  DIRECT_DATABASE_URL: 'postgresql://off:off@127.0.0.1:1/off',
  PRISMA_HIDE_UPDATE_MESSAGE: '1',
  CHECKPOINT_DISABLE: '1',
}

function prismaMigrateDiffToSchemaScript(): string {
  return execFileSync(
    'node',
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      schemaFile,
      '--script',
    ],
    { cwd: repoRoot, env: { ...process.env, ...OFFLINE_ENV }, encoding: 'utf8' },
  )
}

/** Migration folders, in the order Prisma would replay them (sorted). */
function committedMigrations(): string[] {
  if (!existsSync(migrationsDir)) return []
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(migrationsDir, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort()
}

function readMigrationSql(name: string): string {
  return readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8')
}

/** Reduce a migration script to its meaningful DDL: drop `--` comment banners
 *  and blank lines, trim trailing whitespace so formatting differences that
 *  carry no schema meaning do not masquerade as drift. */
function normalizeSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('--'))
    .join('\n')
    .trim()
}

describe('#233 Prisma migration history replaces db push', () => {
  it('has a committed migration history (fails while the repo only db-pushes)', () => {
    expect(existsSync(migrationsDir), 'prisma/migrations/ must exist — schema changes must be reviewable').toBe(true)

    const migrations = committedMigrations()
    expect(migrations.length, 'prisma/migrations/ must contain at least one migration folder').toBeGreaterThan(0)
  })

  it('pins the migration lock to the Postgres provider', () => {
    const lock = readFileSync(join(migrationsDir, 'migration_lock.toml'), 'utf8')
    expect(lock).toMatch(/provider\s*=\s*"postgresql"/)
  })

  it('has an init/baseline migration that reproduces schema.prisma exactly', () => {
    const migrations = committedMigrations()
    expect(migrations.length).toBeGreaterThan(0)

    const initName = migrations.find((m) => /init|baseline/i.test(m)) ?? migrations[0]

    // This comparison only means anything while the baseline is the whole
    // history. Once a second migration lands, the baseline is deliberately
    // *behind* schema.prisma — the later migration carries the difference — so
    // asserting equality here would demand the baseline be regenerated, and a
    // regenerated baseline plus an incremental migration for the same change
    // collide on a fresh database: `0_init` creates the column and the ALTER
    // then adds it again. The authoritative general guard replays every
    // migration against a real Postgres and diffs *that* against the schema
    // (scripts/db-drift-check.sh, the `db-migrations` CI job); it is the only
    // check that stays correct as the history grows, and it needs a database,
    // which is why this file stops short of it.
    if (migrations.length > 1) {
      expect(
        migrations[0],
        'the baseline must still sort first, so migrate deploy replays it before anything else',
      ).toBe(initName)
      return
    }

    const baselineSql = readMigrationSql(initName)
    const expected = normalizeSql(prismaMigrateDiffToSchemaScript())
    const actual = normalizeSql(baselineSql)

    expect(
      actual,
      `schema.prisma and prisma/migrations/${initName}/migration.sql have drifted: regenerate the baseline (or add a new migration) so they agree`,
    ).toBe(expected)
  }, 120_000)

  it('gives every migration after the baseline a name that sorts after it', () => {
    // Prisma replays migrations in lexicographic order, so a folder that sorts
    // before `0_init` would run against an empty database and fail. The
    // timestamp prefix `migrate dev` generates sorts after `0_` naturally;
    // this catches a hand-created folder that does not.
    const migrations = committedMigrations()
    const initName = migrations.find((m) => /init|baseline/i.test(m)) ?? migrations[0]

    const beforeBaseline = migrations.filter((name) => name !== initName && name < initName)
    expect(beforeBaseline, `these migrations sort before the baseline ${initName}`).toEqual([])
  })

  it('carries the money table and its network-leading indexes into the baseline', () => {
    // A query without a network predicate reads both chains and the planner
    // cannot use the index properly, so losing these from the migration is both
    // wrong and slow — guard that the committed baseline keeps them.
    const allSql = committedMigrations().map(readMigrationSql).join('\n')

    expect(allSql).toMatch(/CREATE TABLE "price_points"/)
    expect(allSql).toMatch(/"price_points"\("network", "pair_key", "timestamp" DESC\)/)
    expect(allSql).toMatch(/"price_points"\("network", "pair_key", "source", "timestamp" DESC\)/)
  })
})
