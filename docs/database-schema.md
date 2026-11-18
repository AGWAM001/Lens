# Database Schema & Migration Strategy

## Current state: `prisma migrate`

> **Superseded (#233).** `prisma/` now contains a `migrations/` directory with a
> committed baseline, CI fails on drift between `schema.prisma` and the
> migrations, and both startup and deploys run `prisma migrate deploy`.
> `prisma db push` is no longer a `package.json` script and must not be run
> against any environment. See
> [`docs/database-migrations.md`](database-migrations.md). The rest of this
> section records why `db push` was used during early development.

### Architectural Rationale

1. **Rapid DeFi Primitive Prototyping:**
   During the initial development of the multi-venue aggregator (covering SDEX orderbooks, AMM liquidity pools, Soroswap factory pairs, and Reflector oracles), data models evolved rapidly across iterations. `prisma db push` allowed agile schema prototyping without accumulating redundant migration step churn.

2. **Zero In-Process Migrations on Container Boot:**
   Running complex automated migrations inside container entrypoints poses locking hazards when running horizontally scaled nodes against shared PostgreSQL databases. Decoupling schema validation from schema migration prevents distributed boot race conditions.

3. **Time-Series Partitioning Compatibility:**
   Lens's high-frequency tables (such as `price_points` and `price_aggregates`) require composite primary keys (e.g. `[id, timestamp]`) and time-series optimizations.

## Startup Verification Guard (#352)

To ensure that running code never crashes at request time due to missing columns or unapplied schema changes:
- `src/db/schemaVerify.ts` runs on boot via `assertSchemaValid()` / `verifyDatabaseSchema()`.
- It performs a low-overhead inspection against PostgreSQL `information_schema.tables` and `information_schema.columns`.
- If an expected table or column is absent, it fails fast and names the missing entities.
- `/ready` and `/status` can query `verifyDatabaseSchema()` to isolate instances before they receive live traffic.

## Path Forward: Transitioning to `prisma migrate`

When moving to formal multi-region enterprise production deployments:
1. Generate baseline migration from the current production database: `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`.
2. Mark baseline as applied: `npx prisma migrate resolve --applied 0_init`.
3. Enforce CI/CD pipeline validation using Prisma Migrate with the schema startup verification guard serving as the runtime barrier.
