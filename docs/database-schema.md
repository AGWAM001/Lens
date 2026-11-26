# Database Schema

Lens uses PostgreSQL accessed through Prisma (`prisma/schema.prisma`) and raw `pgPool` queries for high-volume time-series reads and batched maintenance.

## Migration History & Startup Verification

Every early Lens database was initialized with `prisma db push` and therefore carried the live tables without a `_prisma_migrations` history. Lens now uses committed SQL migrations under `prisma/migrations/` executed at boot by `applyMigrations()` in `src/db/migrate.ts` (which adopts pre-existing `db push` baselines once via `prisma migrate resolve` before running `prisma migrate deploy`); see [database-migrations.md](./database-migrations.md) for the full workflow and operator procedures.

At startup, `verifyDatabaseSchema()` and `assertSchemaValid()` in `src/db/schemaVerify.ts` query `information_schema.tables` and `information_schema.columns` once against `EXPECTED_SCHEMA` (`price_points`, `pool_snapshots`, `price_aggregates`, `price_snapshots`, `indexer_state`), throwing `DatabaseSchemaMismatchError` immediately if any required table or column is missing.

## Table Inventory

All 17 tables mapped in `prisma/schema.prisma` (`@@map`) are listed below, grouped by role. Every table except `webhook_delivery_failures` and `api_keys` carries a `network` column (`testnet` or `mainnet`) so queries, caches, and retention jobs isolate networks cleanly.

### Core Time-Series & Ingestion

| Table | Row Meaning | Writers | Readers | PK & Indexes | `network` Scoped | Retention / Partitioning |
| --- | --- | --- | --- | --- | --- | --- |
| `price_points` | Single normalized price and volume observation from SDEX, Classic AMM, or external venue adapters | `src/db.ts` (`insertPricePoints`), `src/jobs/pricePointsRetention.ts` | `src/aggregator/*`, `src/pricing/*`, `src/routes/*`, `src/api/graphql.ts`, `src/backfill/gaps.ts`, `src/ingest/*`, `src/publish/publisher.ts`, `src/reconciliation/dispersion.ts`, `src/services/*` | PK `(id, timestamp)`; Unique `(network, source, event_id)`; Indexes `(network, pair_key, timestamp DESC)`, `(network, pair_key, observed_at DESC)`, `(network, pair_key, source, observed_at DESC)` | Yes | Partitioned by `timestamp` (`src/partitioning/pricePoints.ts`, `src/jobs/pricePointsPartitionJob.ts`, default 7d pre-create); `src/jobs/pricePointsRetention.ts` rolls >30d rows (`PRICE_POINTS_RETENTION_DAYS`) into 1h `price_aggregates` and prunes in batches |
| `quarantined_price_points` | Price point rejected by ingest plausibility checks, with reference median and rejection metadata | `src/db.ts` (`insertPricePoints` via `partitionPricePointsByPlausibility` in `src/ingest/plausibility.ts`) | None (audit/forensics table) | PK `id` (`uuid`); Indexes `(network, pair_key, timestamp DESC)`, `(network, pair_key, quarantined_at DESC)` | Yes | None |
| `pool_snapshots` | Point-in-time reserve, spot price, share count, and fee snapshot for a Stellar liquidity pool | `src/ingest/venues/amm.ts` | `src/aggregator/bestRoute.ts`, `src/aggregator/vwap.ts`, `src/pricing/depth.ts`, `src/routes/book.ts`, `src/routes/pools.ts`, `src/routes/snapshot.ts`, `src/routes/tvl.ts`, `src/services/screener.ts` | PK `(id, timestamp)`; Index `(network, pool_id, timestamp DESC)` | Yes | None |
| `lending_rates` | Point-in-time Blend pool supply/borrow APY, utilization, and TVL observation per asset | `src/db.ts` (`insertLendingRates`, called from `src/ingest/venues/blend.ts`) | `src/db.ts`, `src/routes/rates.ts` | PK `(id, timestamp)`; Indexes `(network, asset, timestamp DESC)`, `(network, asset, venue, timestamp DESC)`, `(network, pool_id, asset, timestamp DESC)` | Yes | `src/jobs/lendingRateRetention.ts` prunes rows >30 days (`RATE_RETENTION_DAYS`, hourly BullMQ/fallback) |
| `price_aggregates` | Pre-computed OHLCV + VWAP candle/window rollup for a pair (`1m`, `5m`, `1h`, `24h`) | `src/jobs/aggregateRefresh.ts`, `src/jobs/pricePointsRetention.ts` | `src/api/rest.ts`, `src/api/graphql.ts`, `src/services/screener.ts` | PK `(network, pair_key, window, bucket)` | Yes | None (rollup target preserving long-term OHLCV/VWAP history) |
| `price_snapshots` | Periodic spot price snapshot (`spot_price` / `vwap`) taken by the snapshot ingester | `src/ingest/snapshot.ts` | `src/api/history.ts` | PK `(network, pair, ts)`; Index `(network, pair, ts)` | Yes | `src/jobs/snapshotRetention.ts` prunes rows >30 days (`SNAPSHOT_RETENTION_DAYS`, hourly BullMQ/fallback) |
| `indexer_state` | Horizon ledger and paging cursor watermark for resilient ingestion restarts | `src/db.ts` (`getIndexerState`, `updateIndexerState`) | `src/db.ts`, `src/api/rest.ts` | PK `(network, id)` | Yes | Single/bounded watermark row per `(network, id)` |

### Configuration, Auth & Discovery

| Table | Row Meaning | Writers | Readers | PK & Indexes | `network` Scoped | Retention / Partitioning |
| --- | --- | --- | --- | --- | --- | --- |
| `pair_configs` | Runtime-registered watched asset pair persisted across restarts | `src/pairsRegistry.ts` | `src/pairsRegistry.ts`, `src/services/assetMetadata.ts` | PK `(network, pair_key)` | Yes | Bounded config table; manual removal only |
| `api_keys` | Hashed API key credential, tier, scopes, rate-limit override, and rotation/revocation state | `src/api/admin.ts`, `src/api/auth.ts` | `src/api/auth.ts`, `src/api/admin.ts`, `src/metrics.ts`, `src/x402/metering.ts` | PK `id` (`uuid`); Unique `key_hash` | No | Bounded credential table; revocations updated in place |
| `bazaar_resources` | x402 Bazaar-registered HTTP or MCP paid resource with pricing, schema, and health metadata | `src/bazaar/catalog.ts` | `src/bazaar/catalog.ts`, `src/routes/discovery.ts` | PK `id` (`uuid`); Unique `(network, url, http_method)` (`bazaar_http_identity`), Unique `(network, url, mcp_tool_name)` (`bazaar_mcp_identity`); Indexes `(network, type, pay_to, created_at DESC)`, GIN `(extension_keys)` | Yes | Bounded resource catalog; updated/deactivated in place |
| `settlement_attempts` | Idempotent x402 payment facilitator settlement status record keyed by transaction hash | `src/routes/facilitator.ts` | `src/routes/facilitator.ts` | PK `id` (`uuid`); Unique `(network, tx_hash)` (`settlement_attempt_identity`) | Yes | None |

### Alerts, Operations & Oracles

| Table | Row Meaning | Writers | Readers | PK & Indexes | `network` Scoped | Retention / Partitioning |
| --- | --- | --- | --- | --- | --- | --- |
| `webhooks` | Registered alert webhook subscription (`asset_a`, `asset_b`, `target_price`, `condition`, `webhook_url`) | `src/routes/webhooks.ts` | `src/webhookDispatcher.ts`, `src/alerts/dispersion.ts` | PK `id` (`uuid`); Index `(network, asset_a, asset_b)` | Yes | Bounded subscription table |
| `webhook_delivery_failures` | Dead-letter record of a failed webhook delivery attempt (status, error, attempt count, payload) | `src/alerts/delivery.ts` | `src/api/admin.ts` | PK `id` (`uuid`); Index `(created_at DESC)` | No | None |
| `ingestion_gaps` | Detected outage/backfill gap window per `(network, pair, source)` and its recovery status | `src/backfill/gaps.ts` | `src/backfill/gaps.ts` | PK `id` (`uuid`); Indexes `(network, pair, source, status)`, `(network, pair, start, end)` | Yes | None |
| `venue_dispersions` | Computed cross-venue price spread percentage (`max_spread_pct`, per-venue prices) and alert flag | `src/reconciliation/dispersion.ts` | `src/reconciliation/dispersion.ts` | PK `id` (`uuid`); Index `(network, pair_key, timestamp DESC)` | Yes | None |
| `oracle_publications` | Audit record of each SEP-40 Soroban on-chain price publication (`tx_hash`, prices JSON, ledger, fee) | `src/publish/publisher.ts` | None (audit/publication log) | PK `id` (`uuid`); Indexes `(network, pair_key, created_at DESC)`, `(network, quoted_asset, feed_timestamp DESC)` | Yes | None |
| `oracle_comparisons` | Comparison sample between Lens price and external oracle (Band, Reflector) with deviation basis points | `src/services/oracleComparison.ts` | `src/services/oracleComparison.ts`, `src/jobs/oracleRetention.ts` | PK `id` (`uuid`); Indexes `(network, asset, timestamp DESC)`, `(network, asset, oracle, timestamp DESC)` | Yes | `src/jobs/oracleRetention.ts` prunes rows >30 days (`ORACLE_COMPARISON_RETENTION_DAYS`, hourly BullMQ/fallback) |

## Growth & Storage Profile

- **High-frequency append tables with active retention**: `price_points` (daily/period partitioning + 30-day rollup into 1h `price_aggregates` and batched prune), `price_snapshots` (30-day batched prune), `lending_rates` (30-day batched prune), and `oracle_comparisons` (30-day batched prune).
- **High-frequency append / telemetry tables without automated retention yet**: `pool_snapshots`, `price_aggregates`, `venue_dispersions`, `quarantined_price_points`, `webhook_delivery_failures`, `ingestion_gaps`, `settlement_attempts`, and `oracle_publications`. Among these, `pool_snapshots` and `venue_dispersions` grow continuously on ingester/reconciliation cadence, while failure/quarantine/publication tables grow proportionally to incident or publication frequency.
- **Bounded / low-cardinality tables**: `indexer_state`, `pair_configs`, `api_keys`, `bazaar_resources`, and `webhooks`.
