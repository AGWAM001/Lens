---
'lens': minor
---

Adopt Prisma migrate: commit a baseline migration (`prisma/migrations/0_init`), make CI fail on drift between `schema.prisma` and the migrations, switch app startup and deploys to `prisma migrate deploy`, and remove the `db push` path.

Startup adopts the baseline by itself on a database that predates the migration history — it records the baseline as applied without running it, rather than colliding with tables that are already there — so the order of a merge and a redeploy cannot take the API down. Dropping `db push` also means schema drift is no longer self-healed at boot: `docs/database-migrations.md` has the one-time check to run against a live database before the first deploy.
