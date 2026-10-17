-- #237 — Nothing stops the same trade being written twice.
--
-- Makes price-point identity (network, source, event_id) unique so a retried
-- ingest batch, or two ingester instances overlapping during a deploy, can no
-- longer store the same observation twice (duplicates inflate volume and skew
-- the volume-weighted VWAP).
--
-- The application layer creates this index through prisma as part of
-- @@unique([network, source, eventId], map: "price_point_identity") on the
-- PricePoint model (`npx prisma db push`). This script is for databases that
-- already contain rows: db push would fail adding the unique index over a
-- table with duplicates, so run this first, then db push — it will see the
-- index (identical name and columns) and leave it alone.
--
--   psql "$DIRECT_DATABASE_URL" -f scripts/migrations/2026-10-17-price-point-identity.sql
--
-- Semantics, matching the schema:
--   * event_id IS NULL rows are untouched. Postgres treats NULLs as distinct
--     in a unique index, so they cannot violate it. They are also the shape of
--     the bug this migration closes: from #237 onward src/db.ts never writes a
--     null event_id (sources without a natural id get a key synthesized
--     deterministically from the row's content), so no new row can hide from
--     the constraint. Pre-existing null rows are left in place rather than
--     backfilled — there is no content in the stored row that reliably
--     reproduces the id the live ingester would derive today (e.g. snapshot
--     rows stored with a wall-clock timestamp), and a guess that differs would
--     let the same trade be re-written under the guessed id.
--   * Among duplicates, the EARLIEST row is kept (lowest timestamp, ties
--     broken by id) — the one the original writer inserted.

BEGIN;

-- 1. Remove duplicates already in the table: everything past the first row of
--    each (network, source, event_id) group.
DELETE FROM price_points pp
USING (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY network, source, event_id
           ORDER BY timestamp ASC, id ASC
         ) AS rn
  FROM price_points
  WHERE event_id IS NOT NULL
) dup
WHERE pp.ctid = dup.ctid
  AND dup.rn > 1;

-- 2. Create the identity index. IF NOT EXISTS keeps this script and
--    `prisma db push` idempotent against each other in either order.
--    Matches prisma's generated DDL for map: "price_point_identity".
CREATE UNIQUE INDEX IF NOT EXISTS price_point_identity
  ON price_points (network, source, event_id);

COMMIT;
