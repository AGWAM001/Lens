#!/usr/bin/env bash
#
# #233 — General schema/migration drift guard.
#
# The DB-free vitest test (tests/prisma-migrations.test.ts) proves the baseline
# reproduces the schema while there is a single migration. This script is the
# general check: it replays *all* committed migrations against a real database
# and diffs the result against schema.prisma, so it stays correct no matter how
# many migrations the repo accumulates. Exits non-zero on drift, which is what
# makes CI fail when schema.prisma and prisma/migrations disagree.
#
# Needs a live Postgres (CI service container, or `docker compose up postgres`).
#   DATABASE_URL            app connection (used to deploy the migrations)
#   DIRECT_DATABASE_URL     direct/pooler-bypassing URL
#   SHADOW_DATABASE_URL     an EMPTY database Prisma uses to replay migrations
#
# Usage: bash scripts/db-drift-check.sh
set -euo pipefail

PRISMA="node node_modules/prisma/build/index.js"

for v in DATABASE_URL DIRECT_DATABASE_URL SHADOW_DATABASE_URL; do
  if [ -z "${!v:-}" ]; then
    echo "ERROR: $v is required (point it at a scratch Postgres, or run 'docker compose up -d postgres')." >&2
    exit 2
  fi
done

echo "==> Deploying committed migrations to DATABASE_URL"
$PRISMA migrate deploy

echo "==> Replaying migrations and diffing against schema.prisma (no drift expected)"
# --from-migrations replays prisma/migrations into the shadow DB;
# --exit-code makes the command fail (exit 1) if the replayed shape differs from
# the schema datamodel. --script is intentionally absent: exit code is the signal.
$PRISMA migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code

echo "OK: prisma/migrations and schema.prisma agree."
