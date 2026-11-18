/**
 * Applying committed migrations to a database that predates them.
 *
 * #233 replaced `prisma db push` at startup with `prisma migrate deploy`, which
 * is the right call: it runs only the migrations in `prisma/migrations`, which a
 * reviewer read, rather than diffing the live schema and applying whatever the
 * diff produced at that instant.
 *
 * The catch is that every Lens database that exists today was created by
 * `db push`. It has the full schema and no `_prisma_migrations` table, and
 * Prisma's baselining guidance is explicit about what `migrate deploy` does
 * then: it tries to run the baseline's `CREATE TABLE`s against tables that are
 * already there, and errors. From `src/index.ts` that is not a failed
 * migration — `main()` ends in `process.exit(1)` — so it is a crash loop, and
 * the API stays down until someone runs a command by hand against production.
 *
 * So the one-time adoption lives here rather than in a runbook: when the schema
 * is populated but Prisma has no history, record the baseline as applied
 * *without executing it*, exactly as docs/database-migrations.md describes, then
 * deploy. Three states have to come out right, and all three are tested:
 *
 *   - **Empty database** (CI, a fresh local Postgres) — no adoption; `migrate
 *     deploy` creates everything from the migrations.
 *   - **Pre-migrate database** (production today) — adopt once, after which
 *     `deploy` applies nothing, because the baseline is all there is.
 *   - **Already adopted** — skipped on the strength of `_prisma_migrations`, so
 *     this costs one `to_regclass` query per boot and nothing else.
 *
 * A half-created database — a `db push` that died part-way — is adopted here
 * too, and then fails in `assertSchemaValid()` a few lines later with the list
 * of what is missing. That is the better of the two errors: a named missing
 * column beats a `relation already exists` collision on whichever table the
 * baseline happened to reach first.
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const PRISMA_CLI = 'node node_modules/prisma/build/index.js'

/**
 * Lens's own oldest table, used to tell "populated" from "empty".
 *
 * Deliberately not `indexer_state`, whose name Lens and the sibling indexer
 * both use — a probe has to be unambiguous about whose schema it found. The
 * identifier is left unqualified so the query follows the connection's
 * search_path instead of assuming `public`.
 */
const SCHEMA_PROBE_TABLE = 'price_points'

export const MIGRATION_STATE_SQL = `select to_regclass('_prisma_migrations') is not null as has_history,
       to_regclass('${SCHEMA_PROBE_TABLE}') is not null as has_schema`

/** The minimum of a `pg` Pool this module needs, so a test can supply one. */
export type MigrationQueryable = {
  query<R>(sql: string): Promise<{ rows: R[] }>
}

export type MigrationState = { hasHistory: boolean; hasSchema: boolean }

/**
 * The first migration Prisma would replay — the baseline, by sort order.
 *
 * Read from disk rather than hard-coded as `0_init` so that renaming or
 * replacing the baseline cannot leave a stale name behind in a `resolve` call,
 * and so a repo with no migrations yet returns null instead of inventing one.
 */
export function baselineMigration(migrationsDir = join(process.cwd(), 'prisma', 'migrations')): string | null {
  if (!existsSync(migrationsDir)) return null
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, 'migration.sql')))
    .map(entry => entry.name)
    .sort()
  return names[0] ?? null
}

export async function readMigrationState(db: MigrationQueryable): Promise<MigrationState> {
  const { rows } = await db.query<{ has_history: boolean; has_schema: boolean }>(MIGRATION_STATE_SQL)
  const row = rows[0]
  return { hasHistory: row?.has_history === true, hasSchema: row?.has_schema === true }
}

/**
 * Whether the baseline has to be adopted before `migrate deploy` can run: the
 * schema is there, but Prisma has no record of how it got there.
 */
export function needsBaselineAdoption(state: MigrationState): boolean {
  return !state.hasHistory && state.hasSchema
}

export type ApplyMigrationsOptions = {
  db: MigrationQueryable
  /** Warned when the baseline is adopted, so the one-time event is in the logs. */
  warn?: (context: Record<string, unknown>, message: string) => void
  /** Seam for the tests; defaults to running the Prisma CLI. */
  run?: (command: string) => void
  /** Override the discovered baseline name. */
  baseline?: string | null
}

/** Adopt the baseline if this database predates it, then apply what is pending. */
export async function applyMigrations(options: ApplyMigrationsOptions): Promise<void> {
  const { db, warn } = options
  const run = options.run ?? ((command: string) => void execSync(command, { stdio: 'inherit' }))
  const baseline = options.baseline === undefined ? baselineMigration() : options.baseline

  if (baseline) {
    const state = await readMigrationState(db)
    if (needsBaselineAdoption(state)) {
      warn?.(
        { baseline },
        'database predates the migration history; recording the baseline as applied without running it'
      )
      run(`${PRISMA_CLI} migrate resolve --applied ${baseline}`)
    }
  }

  run(`${PRISMA_CLI} migrate deploy`)
}
