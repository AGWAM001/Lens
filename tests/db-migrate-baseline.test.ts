import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyMigrations,
  baselineMigration,
  needsBaselineAdoption,
  readMigrationState,
  MIGRATION_STATE_SQL,
  PRISMA_CLI,
  type MigrationQueryable,
} from '../src/db/migrate'

/**
 * #233 — adopting `prisma migrate` on a database that `db push` built.
 *
 * The baseline test (tests/prisma-migrations.test.ts) proves the committed SQL
 * reproduces schema.prisma, and the CI `db-migrations` job proves the
 * migrations apply to an empty Postgres. Neither covers the state production is
 * actually in: full schema, no `_prisma_migrations` table. There,
 * `migrate deploy` runs the baseline's CREATE TABLEs against tables that exist
 * and errors — and because src/index.ts ends in `process.exit(1)`, that is a
 * crash loop rather than a failed migration.
 *
 * So these tests pin the command sequence for each of the three states a
 * database can be in. They are DB-free: the queryable and the command runner
 * are both injected, so what is under test is the decision, not Postgres.
 */

/** A database in a given state, which records the SQL it was asked. */
function fakeDb(state: { has_history: boolean; has_schema: boolean }): MigrationQueryable & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async query<R>(sql: string) {
      asked.push(sql)
      return { rows: [state] as unknown as R[] }
    },
  }
}

/** A migrations directory on disk with the given folders, each holding SQL. */
function migrationsDirWith(...names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'lens-migrations-'))
  for (const name of names) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'migration.sql'), '-- noop')
  }
  return root
}

describe('baselineMigration', () => {
  it('is the first migration by sort order, not the newest', () => {
    const dir = migrationsDirWith('20261101120000_add_scopes', '0_init', '20260301090000_webhooks')
    expect(baselineMigration(dir)).toBe('0_init')
  })

  it('ignores a folder with no migration.sql, so a stray directory is not adopted', () => {
    const dir = migrationsDirWith('0_init')
    mkdirSync(join(dir, '0000_notes'), { recursive: true })
    expect(baselineMigration(dir)).toBe('0_init')
  })

  it('is null when there is no migrations directory at all', () => {
    expect(baselineMigration(join(tmpdir(), 'lens-migrations-does-not-exist'))).toBeNull()
  })
})

describe('needsBaselineAdoption', () => {
  it('is true only for a populated schema with no history', () => {
    expect(needsBaselineAdoption({ hasHistory: false, hasSchema: true })).toBe(true)
    expect(needsBaselineAdoption({ hasHistory: false, hasSchema: false })).toBe(false)
    expect(needsBaselineAdoption({ hasHistory: true, hasSchema: true })).toBe(false)
    expect(needsBaselineAdoption({ hasHistory: true, hasSchema: false })).toBe(false)
  })
})

describe('readMigrationState', () => {
  it('reads both flags from one query and treats a missing row as neither', async () => {
    const db = fakeDb({ has_history: true, has_schema: true })
    expect(await readMigrationState(db)).toEqual({ hasHistory: true, hasSchema: true })
    expect(db.asked).toEqual([MIGRATION_STATE_SQL])

    const empty: MigrationQueryable = { async query() { return { rows: [] } } }
    expect(await readMigrationState(empty)).toEqual({ hasHistory: false, hasSchema: false })
  })

  it('probes price_points rather than the shared indexer_state name, unqualified', () => {
    expect(MIGRATION_STATE_SQL).toContain("to_regclass('price_points')")
    expect(MIGRATION_STATE_SQL).toContain("to_regclass('_prisma_migrations')")
    expect(MIGRATION_STATE_SQL).not.toContain('indexer_state')
    expect(MIGRATION_STATE_SQL).not.toContain('public.')
  })
})

describe('applyMigrations', () => {
  const resolve = `${PRISMA_CLI} migrate resolve --applied 0_init`
  const deploy = `${PRISMA_CLI} migrate deploy`

  it('adopts the baseline on a pre-migrate database, then deploys', async () => {
    const run: string[] = []
    const warned: Array<Record<string, unknown>> = []
    const db = fakeDb({ has_history: false, has_schema: true })

    await applyMigrations({
      db,
      baseline: '0_init',
      run: command => void run.push(command),
      warn: context => void warned.push(context),
    })

    // resolve BEFORE deploy, and resolve exactly once: the order is the whole
    // point, and resolve records the baseline without executing its SQL.
    expect(run).toEqual([resolve, deploy])
    expect(warned).toEqual([{ baseline: '0_init' }])
  })

  it('does not adopt anything on an empty database — deploy creates the schema', async () => {
    const run: string[] = []
    const db = fakeDb({ has_history: false, has_schema: false })

    await applyMigrations({ db, baseline: '0_init', run: command => void run.push(command) })

    expect(run).toEqual([deploy])
  })

  it('does not re-adopt once _prisma_migrations exists', async () => {
    const run: string[] = []
    const db = fakeDb({ has_history: true, has_schema: true })

    await applyMigrations({ db, baseline: '0_init', run: command => void run.push(command) })

    expect(run).toEqual([deploy])
  })

  it('never touches the database when the repo has no migrations to adopt', async () => {
    const run: string[] = []
    const db = fakeDb({ has_history: false, has_schema: true })

    await applyMigrations({ db, baseline: null, run: command => void run.push(command) })

    // No baseline means nothing to resolve, so there is nothing to ask the
    // database either — and `deploy` with an empty history is a no-op.
    expect(db.asked).toEqual([])
    expect(run).toEqual([deploy])
  })

  it('resolves whatever the baseline is actually called, not a hard-coded 0_init', async () => {
    const run: string[] = []
    const db = fakeDb({ has_history: false, has_schema: true })

    await applyMigrations({ db, baseline: '0_baseline', run: command => void run.push(command) })

    expect(run).toEqual([`${PRISMA_CLI} migrate resolve --applied 0_baseline`, deploy])
  })
})
