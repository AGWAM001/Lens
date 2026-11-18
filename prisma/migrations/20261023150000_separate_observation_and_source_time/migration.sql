-- Migration: Separate observation time and source time (Issue #240)
-- 
-- 1. observed_at: The non-nullable timestamp when Lens observed/ingested the sample (Lens wall-clock).
-- 2. source_time: The nullable timestamp claimed natively by the source itself (e.g. ledger close time
--    for SDEX/AMM trades, exchange timestamp for CEX tickers). Null for sources with no native time
--    (Soroswap AMM, Aquarius AMM, AMM reserve snapshots).
--
-- Backfill / Default Handling for Existing Rows:
-- Prior to this migration, 'timestamp' held ledger close times for SDEX/AMM trades, but held wall-clock
-- observation times for synthetic snapshots and contract simulation venues (Soroswap, Aquarius).
-- To prevent silently relabeling historical data in a misleading way:
--   - SDEX and AMM trade rows (with real ledger close times) have source_time populated from timestamp.
--   - Synthetic AMM snapshots and non-native venues (soroswap_amm, aquarius_amm) leave source_time as NULL,
--     truthfully reflecting that no native source timestamp existed for them.
--   - observed_at is set to timestamp for existing rows (since that was the recorded temporal anchor).

-- Added nullable first, backfilled, then constrained. Adding it NOT NULL
-- DEFAULT CURRENT_TIMESTAMP and then matching rows with
-- `WHERE observed_at = CURRENT_TIMESTAMP` does work, because CURRENT_TIMESTAMP
-- is transaction-stable and Prisma runs a migration in one transaction -- but
-- it is correct only for that reason, and if the backfill ever failed to match,
-- every historical row would silently carry the migration time instead of its
-- own. On the money table that is not a subtlety worth depending on.
ALTER TABLE "price_points" ADD COLUMN IF NOT EXISTS "observed_at" TIMESTAMP(3);
ALTER TABLE "price_points" ADD COLUMN IF NOT EXISTS "source_time" TIMESTAMP(3);

-- Populate source_time only for sources that actually emitted native ledger close times
UPDATE "price_points"
SET "source_time" = "timestamp"
WHERE "source" IN ('SDEX', 'AMM')
  AND ("event_id" IS NULL OR "event_id" NOT LIKE 'amm-snapshot-%')
  AND "source_time" IS NULL;

-- Non-native venues (soroswap_amm, aquarius_amm, and synthetic AMM snapshots) retain source_time = NULL

-- Backfill observed_at from existing timestamp for historical continuity.
-- NULL is unambiguous: only rows that predate the column match.
UPDATE "price_points"
SET "observed_at" = "timestamp"
WHERE "observed_at" IS NULL;

-- Only now constrain it, so the end state matches schema.prisma exactly.
ALTER TABLE "price_points" ALTER COLUMN "observed_at" SET NOT NULL;
ALTER TABLE "price_points" ALTER COLUMN "observed_at" SET DEFAULT CURRENT_TIMESTAMP;

-- Create indexes on observed_at
CREATE INDEX IF NOT EXISTS "price_points_network_pair_key_observed_at_idx"
  ON "price_points" ("network", "pair_key", "observed_at" DESC);

CREATE INDEX IF NOT EXISTS "price_points_network_pair_key_source_observed_at_idx"
  ON "price_points" ("network", "pair_key", "source", "observed_at" DESC);

-- The source-scoped index now leads on observed_at (see schema.prisma); drop the
-- timestamp-based one the baseline created so the migrated database matches the schema.
DROP INDEX IF EXISTS "price_points_network_pair_key_source_timestamp_idx";
