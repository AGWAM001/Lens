#!/usr/bin/env bash
#
# #233 — Prove a migration can be generated, applied and rolled back on a clean
# database, and that the drift guard actually fires. This is the acceptance
# check for "A new migration can be generated, applied and rolled back in a
# clean database" and "CI fails on drift between schema and migrations."
#
# Runs entirely against throwaway databases (CI service container, or
# `docker compose up -d postgres` + a second empty DB). It never leaves the repo
# dirty: the scratch migration it generates is removed before it exits.
#
#   DATABASE_URL           empty-ish app DB (reset to a clean state here)
#   DIRECT_DATABASE_URL    direct URL
#   SHADOW_DATABASE_URL    empty database for Prisma to replay migrations
#
# Usage: bash scripts/db-migration-cycle.sh
set -euo pipefail

PRISMA="node node_modules/prisma/build/index.js"
SCRATCH_DIR="prisma/migrations/29990101000000_drift_canary"
SCRATCH_SCHEMA="$(mktemp -t drift-canary-XXXXXX).prisma"
trap 'rm -rf "$SCRATCH_DIR" "$SCRATCH_SCHEMA"' EXIT

for v in DATABASE_URL DIRECT_DATABASE_URL SHADOW_DATABASE_URL; do
  if [ -z "${!v:-}" ]; then
    echo "ERROR: $v is required." >&2
    exit 2
  fi
done

# Assert a table exists (1) or does not (0) in DATABASE_URL, via the app's pg dep.
table_exists() {
  node -e '
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const { rows } = await c.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
        [process.argv[1]],
      );
      await c.end();
      process.exit(rows.length ? 0 : 1);
    })().catch(() => process.exit(1));
  ' "$1"
}

require_true() { # $? == 0 already checked by caller; used for readable failures
  if [ "$1" -ne 0 ]; then echo "FAIL: $2" >&2; exit 1; fi
}

echo "==> 1. Start from a clean database: drop everything, apply the committed baseline"
$PRISMA migrate reset --force --skip-seed

echo "==> 2. Generate a NEW migration from a schema change (add a canary table)"
cp prisma/schema.prisma "$SCRATCH_SCHEMA"
cat >> "$SCRATCH_SCHEMA" <<'PRISMA_EOF'

model DriftCanary {
  id String @id
  @@map("drift_canary")
}
PRISMA_EOF

mkdir -p "$SCRATCH_DIR"
$PRISMA migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel "$SCRATCH_SCHEMA" \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script > "$SCRATCH_DIR/migration.sql"

if grep -q 'CREATE TABLE "drift_canary"' "$SCRATCH_DIR/migration.sql"; then
  echo "    generated migration creates drift_canary — good"
else
  echo "FAIL: generated migration did not create the canary table" >&2
  cat "$SCRATCH_DIR/migration.sql" >&2
  exit 1
fi

echo "==> 3. Apply it to the clean database"
$PRISMA migrate deploy
table_exists "drift_canary"; require_true $? "canary table should exist after apply"
echo "    drift_canary present after migrate deploy — good"

echo "==> 4. Roll it back on the clean database (drop scratch, reset re-applies only the baseline)"
rm -rf "$SCRATCH_DIR"
$PRISMA migrate reset --force --skip-seed
if table_exists "drift_canary"; then
  echo "FAIL: drift_canary survived the rollback — migrate reset did not drop it" >&2
  exit 1
fi
echo "    drift_canary gone after reset — generate/apply/rollback cycle verified"

echo "==> 5. Negative proof: an un-migrated schema change must be flagged as drift"
cp prisma/schema.prisma "$SCRATCH_SCHEMA"
cat >> "$SCRATCH_SCHEMA" <<'PRISMA_EOF'

model DriftCanary {
  id String @id
  @@map("drift_canary")
}
PRISMA_EOF
# --exit-code returns 1 when the replayed migrations differ from the schema.
set +e
$PRISMA migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel "$SCRATCH_SCHEMA" \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code
drift_exit=$?
set -e
if [ "$drift_exit" -eq 0 ]; then
  echo "FAIL: drift guard did NOT fire on an un-migrated schema change" >&2
  exit 1
fi
echo "    drift guard fired (exit $drift_exit) on the un-migrated schema — CI would fail — good"

echo "OK: migration generate/apply/rollback works on a clean DB and drift is detected."
