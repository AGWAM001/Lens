---
'lens': patch
---

Make duplicate price points impossible to store (#237). `price_points` had no
uniqueness on the trade identity, so an ingester retrying after a partial
failure — or two instances briefly overlapping during a deploy — wrote the same
trade again, inflating volume and skewing the volume-weighted VWAP.

`PricePoint` now declares `@@unique([network, source, eventId])`
(index `price_point_identity`), and `upsertPricePoints` writes as an idempotent
insert (`skipDuplicates` → `ON CONFLICT DO NOTHING`), so a replayed batch is
absorbed rather than stored twice.

Postgres treats NULLs as distinct in a unique index, so a row stored without an
event id could never be recognized as a duplicate. Writes therefore never store
a null: venues with a natural id (SDEX/AMM trade TOIDs) pass it through,
snapshot venues without one derive their key from pool STATE (AMM: pool id +
`last_modified_ledger`; Soroswap: pool address + reserves) instead of the
previous `Date.now()` ids, which minted a fresh identity per attempt. Sources
that supply no id at all (Aquarius, future venues) get a SHA-256 synthesized
deterministically from the row's content — never a clock, never random.

`scripts/migrations/2026-10-17-price-point-identity.sql` removes rows already
duplicated on this identity (keeping the earliest per group) before creating
the index, for databases where `prisma db push` would otherwise fail. Rows
predating the change with a NULL `event_id` are left untouched; from here on no
new row can have one.
