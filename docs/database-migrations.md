# Database migrations

Issue **#233**. Before this, `prisma/` contained only `schema.prisma` — there was
no `migrations/` directory, and every schema change was applied with
`prisma db push`. Lens now uses **`prisma migrate`**: schema changes are
committed as reviewable SQL, and deployments apply them with `migrate deploy`.

## Why not `db push`

`prisma db push` diffs the *live* database against `schema.prisma` and applies
whatever it decides, on the spot. That gives you none of the things a service
that holds money-moving data needs:

- **Nothing is reviewable.** A schema change is whatever the diff produced at
  that instant, not a file a reviewer read.
- **No reproducible deploy.** Two environments pushed at different times can
  land on different shapes; nothing in the repo describes the live shape.
- **No rollback.** There is no record of what changed, so there is nothing to
  undo. With `--accept-data-loss` a push can silently drop a column.
- **It has already bitten us.** A `db push` in the sibling service half-applied
  and left the database on a shape no commit described. That is exactly the
  failure `prisma migrate` exists to prevent.

So: **do not run `prisma db push` against any environment.** It is no longer a
`package.json` script. The `db push` call at app startup (`src/index.ts`) now
runs `migrate deploy` instead.

## What lives in the repo now

```
prisma/
  schema.prisma                     # the source of truth for the data model
  migrations/
    migration_lock.toml             # provider = "postgresql" (do not hand-edit)
    0_init/
      migration.sql                 # baseline: recreates the production schema exactly
```

`0_init/migration.sql` is the **baseline** — the SQL that reproduces the current
production schema from an empty database. It is generated, not hand-written:

```bash
prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
```

## Daily workflow (local development)

Edit `schema.prisma`, then generate a migration. Do **not** `db push`.

```bash
npm run db:migrate        # prisma migrate dev — creates and applies a new migration
```

`migrate dev` writes a new timestamped folder under `prisma/migrations/`.
**Commit that folder.** It is now the reviewable record of the change.

```bash
npm run db:status         # which migrations are applied / pending
npm run db:reset          # drop schema and re-apply all migrations (NEVER on prod)
```

## Deploying

Deploys apply committed migrations only — they never diff the live database:

```bash
npm run db:deploy         # prisma migrate deploy
```

App startup (`src/index.ts`) runs `migrate deploy` for you, so a container that
starts against a database with pending migrations applies them and only them,
deterministically, or fails loudly if the database is ahead of the code.

### Adopting the baseline on an EXISTING database

Every Lens database that exists today was created by `db push`: it already
matches `schema.prisma` and has no `_prisma_migrations` table. The baseline's
`CREATE TABLE` statements must **not** be re-run there — `migrate deploy` would
collide with the tables that are already present and exit non-zero, which from
`src/index.ts` (`main().catch(… process.exit(1))`) is a crash loop, not a failed
migration.

**Startup does this adoption for you.** `applyMigrations()` in
`src/db/migrate.ts` asks the database one question before deploying — does
`_prisma_migrations` exist, and does `price_points` exist — and when the schema
is there without the history it records the baseline as applied *without
executing it* before deploying:

```bash
prisma migrate resolve --applied <baseline>   # records it; runs no SQL
prisma migrate deploy                          # then applies what is pending
```

So no manual step gates the deploy, and the order in which the merge and the
redeploy happen cannot take the API down. The three states it distinguishes —
empty database, pre-migrate database, already-adopted database — are pinned by
`tests/db-migrate-baseline.test.ts`.

Running `npx prisma migrate resolve --applied 0_init` by hand first is still
perfectly fine; startup then finds the history and skips the adoption. The
baseline is committed separately, rather than generated on deploy, precisely so
that it can be recorded instead of run.

### One-time check before the first deploy

Adoption records "this database matches the baseline" permanently. It is only
true if the database really does match `schema.prisma` — and `db push` is what
used to make that true on every boot, silently. Dropping `db push` means a
column that is in `schema.prisma` but not in the live database **stays
missing**: `migrate deploy` has nothing pending to apply, and
`assertSchemaValid()` only covers the five core tables in
`EXPECTED_SCHEMA` (`src/db/schemaVerify.ts`), so a drifted `api_keys` or
`webhooks` column would not be caught at startup — it would surface as 500s on
the routes that read it.

So run this once against each live database, before the first deploy on this
commit, and read the output rather than the exit code:

```bash
# Differences between the LIVE database and schema.prisma, as SQL.
# Empty output = the database matches the baseline and is safe to adopt.
DIRECT_DATABASE_URL='<direct url for that environment>'   npx prisma migrate diff     --from-schema-datasource prisma/schema.prisma     --to-schema-datamodel prisma/schema.prisma     --script
```

If it prints statements, do not adopt yet. Either apply them as a committed
migration (`npm run db:migrate`, then `migrate deploy`), or converge the
database on the previous commit — the one that still ran `db push` — and
re-check.

Two caveats on reading that output:

- It is **not** wired into startup on purpose. Lens shares a Postgres instance
  with the sibling indexer, and if the two ever land in the same schema this
  diff reports the sibling's tables as drift. A false positive here would be a
  refusal to boot, so the judgement stays with a person.
- The CI `db-migrations` job does not cover this either. It replays the
  migrations against an empty Postgres and diffs *that* against
  `schema.prisma`; it never sees a live database, so it cannot tell you whether
  production matches the baseline. Only the command above can.

## The CI drift guard

The `db-migrations` job in `.github/workflows/ci.yml` brings up a Postgres
service and runs:

- `scripts/db-drift-check.sh` — deploys every committed migration, then
  `migrate diff --from-migrations prisma/migrations --to-schema-datamodel
  prisma/schema.prisma --exit-code` against a shadow database. It exits non-zero
  — failing CI — whenever `schema.prisma` and `prisma/migrations` disagree. This
  is the check that would have caught a half-applied `db push`.
- `scripts/db-migration-cycle.sh` — proves a new migration can be generated,
  applied and rolled back on a clean database, and that the drift guard actually
  fires on an un-migrated schema change.

The DB-free unit test `tests/prisma-migrations.test.ts` (part of `npm test`)
additionally locks the **baseline** to `schema.prisma`: it fails while the repo
has no migration history, and fails if you edit the schema without regenerating
the baseline, so a missing migration is caught even without a database.

Run the database-backed checks locally against the compose Postgres:

```bash
docker compose up -d postgres
# create an empty shadow database alongside `lens`
DATABASE_URL=postgresql://lens:lens@localhost:5432/lens \
DIRECT_DATABASE_URL=postgresql://lens:lens@localhost:5432/lens \
SHADOW_DATABASE_URL=postgresql://lens:lens@localhost:5432/lens_shadow \
  npm run db:drift-check
```

## Rolling back a bad migration

Prisma does not generate down-migrations. In a **non-production** environment,
`npm run db:reset` drops the schema and re-applies every committed migration,
which is the clean, reproducible way to back out of a half-applied change. In
production, roll forward: commit a new migration that reverses the change and
`migrate deploy` it. Either way the history in `prisma/migrations/` is the
source of truth — the thing `db push` never gave us.
