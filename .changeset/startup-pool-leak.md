---
'lens': patch
---

Start-up no longer leaks a Postgres pool client. The reachability check now
runs `SELECT 1` on a checked-out client and releases it in a `finally`
(`checkDatabaseReachable()` in `src/db.ts`), so all `DB_POOL_SIZE` connections
are available and `db_pool_connections_in_use` can return to zero. An
unreachable database still fails start-up, with a `postgresql unreachable` log.
