# Lens Data Quality Guarantees

This document formally states the data quality guarantees provided by Lens: freshness, completeness, precision, venue inclusion, and the explicit system behaviors when any guarantee is violated. Every numerical bound documented below links directly to the code or configuration that enforces it.

---

## Freshness Guarantees

Lens continuously aggregates order book trades and AMM liquidity pool snapshots across Stellar networks. The following freshness bounds are enforced:

### Live Pricing Staleness Bound
A price response is considered fresh when its newest underlying trade observation occurred within [`300`](../src/aggregator/vwap.ts#L4) seconds ([`5`](../src/aggregator/vwap.ts#L4) minutes). When the newest observation age exceeds [`300`](../src/aggregator/vwap.ts#L4) seconds, the response explicitly sets `stale: true`.

- **Enforcing Code**: [`src/aggregator/vwap.ts`](../src/aggregator/vwap.ts#L4) (`STALENESS_THRESHOLD_SECONDS`)
- **Violation Behavior**: The engine returns the last observed price alongside `stale: true` and `lastTradeAgeSeconds: <age>` (exceeding [`300`](../src/aggregator/vwap.ts#L4) seconds). Confidence rating degrades to `'low'`.

### Confidence Rating Freshness Tiers
Every pricing response carries a categorical `confidence` rating derived from observation age and venue diversity:
- **High Confidence**: Requires an observation age under [`30`](../src/aggregator/vwap.ts#L5) seconds across at least [`2`](../src/aggregator/vwap.ts#L187) distinct sources with positive [`24`](../src/aggregator/vwap.ts#L181)h volume.
- **Medium Confidence**: Requires an observation age under [`300`](../src/aggregator/vwap.ts#L6) seconds.
- **Low Confidence**: Assigned when observation age equals or exceeds [`300`](../src/aggregator/vwap.ts#L6) seconds.
- **Unknown Confidence**: Assigned when no trades have ever been recorded (`lastTradeAgeSeconds === null`).
- **Enforcing Code**: [`src/aggregator/vwap.ts`](../src/aggregator/vwap.ts#L4)

### Venue Ingestion Liveness Window
Venue adapters report network liveness on `/venues/registry`. A venue is marked `'live'` if a price point has been ingested within the last [`300000`](../src/routes/venues.ts#L7) ms ([`5`](../src/routes/venues.ts#L7) minutes).
- **Enforcing Code**: [`src/routes/venues.ts`](../src/routes/venues.ts#L7) (`LIVE_WINDOW_MS`)
- **Violation Behavior**: If no price points are observed within [`300000`](../src/routes/venues.ts#L7) ms, venue liveness transitions to `'stale'`. Disabled venues report `'disabled'`.

### Ingestion Polling Intervals
- **SDEX Order Book & AMM Trades**: Horizon ingestion polls every [`5000`](../src/config.ts#L266) ms with a batch page size of [`200`](../src/config.ts#L267) records for SDEX and [`200`](../src/config.ts#L268) records for AMM pools.
- **Soroswap AMM Reserves**: Contract reserves poll via Soroban RPC every [`60000`](../src/config.ts#L178) ms.
- **Enforcing Code**: [`src/config.ts`](../src/config.ts#L266) (`pollIntervalMs`, `soroswapPollMs`)

### Cache Expiration & Network Timeouts
- **Redis Price Cache TTL**: Aggregate prices are cached in Redis with a TTL of [`10`](../src/config.ts#L271) seconds.
- **Outbound HTTP Timeout**: External HTTP requests enforce a deadline timeout of [`10000`](../src/config.ts#L274) ms.
- **Enforcing Code**: [`src/config.ts`](../src/config.ts#L271) (`priceTtl`, `timeoutMs`)
- **Violation Behavior**: Outbound calls abort upon reaching [`10000`](../src/config.ts#L274) ms; ingester logs errors and retries on subsequent poll ticks.

### Snapshot and Partition Retention
- **Pool Snapshot Pruning**: Historical liquidity pool snapshots older than [`30`](../src/jobs/snapshotRetention.ts#L12) days are pruned hourly in batches of [`1000`](../src/jobs/snapshotRetention.ts#L14) rows.
- **Price Point Partition Dropping**: Daily `price_points` partitions older than [`30`](../src/partitioning/pricePoints.ts#L5) days are dropped.
- **Enforcing Code**: [`src/jobs/snapshotRetention.ts`](../src/jobs/snapshotRetention.ts#L12), [`src/partitioning/pricePoints.ts`](../src/partitioning/pricePoints.ts#L5)

---

## Completeness Guarantees

### Multi-Venue Liquidity Aggregation
High confidence requires price observations from at least [`2`](../src/aggregator/vwap.ts#L187) distinct liquidity sources (e.g. SDEX and AMM pools). When only [`1`](../src/aggregator/vwap.ts#L187) source is active, confidence is limited to `'medium'`.

### Statistical Outlier Rejection Thresholds
TWAP and VWAP computations apply statistical filtering to reject manipulation spikes:
- **Minimum Sample Count**: Outlier filtering requires at least [`4`](../src/pricing/twap.ts#L288) sample points.
- **Interquartile Range (IQR)**: Rejects samples beyond Q1 - [`1.5`](../src/pricing/twap.ts#L289) * IQR or Q3 + [`1.5`](../src/pricing/twap.ts#L289) * IQR.
- **Modified Z-Score**: Rejects samples with absolute score exceeding [`3.5`](../src/pricing/twap.ts#L290), using a consistency factor of [`0.6745`](../src/pricing/twap.ts#L291).
- **Enforcing Code**: [`src/pricing/twap.ts`](../src/pricing/twap.ts#L288)
- **Violation Behavior**: If fewer than [`4`](../src/pricing/twap.ts#L288) samples exist, filtering is bypassed (`outlierRejected` is zero). If [`0`](../src/pricing/twap.ts#L78) samples exist in the window, endpoints return zero TWAP and sample count.

### Request Window & Parameter Bounds
- **TWAP Windows**: Window ranges from [`1`](../src/routes/price.ts#L8) to [`1440`](../src/routes/price.ts#L9) minutes (default [`60`](../src/routes/price.ts#L10) minutes). Sample intervals range from [`1`](../src/routes/price.ts#L11) to [`3600`](../src/routes/price.ts#L12) seconds (default [`60`](../src/routes/price.ts#L13) seconds).
- **VWAP Windows**: Window ranges from [`1`](../src/routes/price.ts#L15) to [`1440`](../src/routes/price.ts#L16) minutes (default [`60`](../src/routes/price.ts#L17) minutes).
- **Price History Limits**: Bucket count is capped at [`1000`](../src/api/rest.ts#L25) buckets (default [`100`](../src/api/rest.ts#L24) buckets).
- **Screener Pair Limits**: Pair count defaults to [`20`](../src/services/screener.ts#L16) and is clamped between [`1`](../src/services/screener.ts#L109) and [`100`](../src/services/screener.ts#L17).
- **Spread Observations**: Venues must quote at least [`2`](../src/routes/spreads.ts#L20) observations in the window to report a spread.
- **Violation Behavior**: Inputs outside allowed ranges trigger HTTP [`400`](../src/routes/price.ts#L55) Bad Request with validation details.

---

## Precision Guarantees

### Database Storage Precision
- **Prices and VWAPs**: Stored as PostgreSQL `DECIMAL(`[`36`](../prisma/schema.prisma#L20)`, `[`18`](../prisma/schema.prisma#L20)`)` with [`18`](../prisma/schema.prisma#L20) decimal digits of fractional scale.
- **Stellar Native Reserves & Volumes**: Stored as PostgreSQL `DECIMAL(`[`36`](../prisma/schema.prisma#L21)`, `[`7`](../prisma/schema.prisma#L21)`)` matching Stellar's native [`7`](../prisma/schema.prisma#L21) decimal place stroop scale ([`1`](../prisma/schema.prisma#L21) stroop = [`0.0000001`](../prisma/schema.prisma#L21) XLM).
- **Enforcing Code**: [`prisma/schema.prisma`](../prisma/schema.prisma#L20)

### API Boundary Serialization
- **Standard Default Mode**: Returns numbers as IEEE-[`754`](../src/types.ts#L20) double precision floating-point numbers (~[`15`](../src/types.ts#L20)-[`17`](../src/types.ts#L20) significant digits).
- **Exact String Representation Mode**: When negotiated via `X-Decimal-Format: string`, `Accept: application/json; decimals=strings`, or `?decimals=strings`, all decimal quantities serialise as exact strings without floating-point truncation.
- **Enforcing Code**: [`prisma/schema.prisma`](../prisma/schema.prisma#L20), [`src/types.ts`](../src/types.ts#L20)
- **Violation Behavior**: Consumers that require exact [`18`](../prisma/schema.prisma#L20)-decimal precision must negotiate string format; unnegotiated requests receive standard JSON numbers for backward compatibility.

---

## Venue Inclusion Guarantees

Lens integrates [`4`](../src/ingest/venues/index.ts#L19) registered venue adapters:

| Venue | Identifier | Kind | Testnet | Mainnet | Included In | Enforcing Code |
|---|---|---|---|---|---|---|
| **Stellar Decentralized Exchange (SDEX)** | `sdex` | `orderbook` | Enabled | Enabled | VWAP, Best Route, Depth, Book, Volumes, Spreads | [`src/ingest/venues/sdex.ts`](../src/ingest/venues/sdex.ts#L174) |
| **Stellar Native Liquidity Pools (AMM)** | `stellar-amm` | `amm` | Enabled | Enabled | Spot, Pools, Best Route, Depth, Book, Volumes | [`src/ingest/venues/amm.ts`](../src/ingest/venues/amm.ts#L237) |
| **Soroswap AMM** | `soroswap` | `amm` | Enabled | Enabled | Price aggregation, multi-venue pools | [`src/ingest/venues/soroswap.ts`](../src/ingest/venues/soroswap.ts#L326) |
| **Aquarius AMM** | `aquarius` | `amm` | Disabled | Enabled | Mainnet liquidity pool aggregation | [`src/ingest/venues/aquarius.ts`](../src/ingest/venues/aquarius.ts#L111) |

- **Reflector Oracle**: Used optionally for oracle benchmark comparison (`/compare/:asset`) and GraphQL oracle resolution. Disabled by default unless configured.
- **Enforcing Code**: [`src/ingest/venues/index.ts`](../src/ingest/venues/index.ts#L19), [`src/config.ts`](../src/config.ts#L171)

---

## Violation Semantics Summary

When a data quality guarantee is breached, Lens behaves deterministically:

- **Stale Observation (age >= [`300`](../src/aggregator/vwap.ts#L4) s)**: Returns the last known price marked with `stale: true` and downgraded confidence (`low`), preserving availability while warning callers.
- **Missing Ingestion / Empty Window (trades = [`0`](../src/aggregator/vwap.ts#L185))**: Returns `confidence: "unknown"` with `lastTradeAgeSeconds: null`, falling back through VWAP [`1`](../src/aggregator/vwap.ts#L198)h -> VWAP [`24`](../src/aggregator/vwap.ts#L198)h -> AMM Spot -> [`0`](../src/aggregator/vwap.ts#L198).
- **Unwatched Pair**: Returns HTTP [`404`](../src/api/rest.ts#L111) Not Found with `{ "error": "Pair <A>/<B> not watched on <network>" }`.
- **Invalid Query Parameters**: Returns HTTP [`400`](../src/routes/price.ts#L55) Bad Request with structured Zod validation errors.
- **Outbound Failure / Ingestion Silence (>= [`300000`](../src/routes/venues.ts#L7) ms)**: Venue liveness degrades from `'live'` to `'stale'`.
- **Rate Limit Exceeded**: Returns HTTP [`429`](../src/app.ts#L107) Too Many Requests.

---

## Summary of Enforced Bounds

| Parameter | Bound | Units | Enforcing Code | Description |
|---|---|---|---|---|
| `staleness_threshold` | [`300`](../src/aggregator/vwap.ts#L4) | seconds | [`src/aggregator/vwap.ts:4`](../src/aggregator/vwap.ts#L4) | Ingestion age after which a price is flagged stale |
| `high_confidence_max_age` | [`30`](../src/aggregator/vwap.ts#L5) | seconds | [`src/aggregator/vwap.ts:5`](../src/aggregator/vwap.ts#L5) | Max trade age for high confidence rating |
| `medium_confidence_max_age` | [`300`](../src/aggregator/vwap.ts#L6) | seconds | [`src/aggregator/vwap.ts:6`](../src/aggregator/vwap.ts#L6) | Max trade age for medium confidence rating |
| `venue_liveness_window` | [`300000`](../src/routes/venues.ts#L7) | ms | [`src/routes/venues.ts:7`](../src/routes/venues.ts#L7) | Silence interval after which a venue is marked stale |
| `indexer_poll_interval` | [`5000`](../src/config.ts#L266) | ms | [`src/config.ts:266`](../src/config.ts#L266) | Polling interval for SDEX / Horizon trades |
| `sdex_page_size` | [`200`](../src/config.ts#L267) | rows | [`src/config.ts:267`](../src/config.ts#L267) | Maximum trade records fetched per Horizon request |
| `amm_page_size` | [`200`](../src/config.ts#L268) | rows | [`src/config.ts:268`](../src/config.ts#L268) | Maximum pool snapshot records fetched per page |
| `soroswap_poll_interval` | [`60000`](../src/config.ts#L178) | ms | [`src/config.ts:178`](../src/config.ts#L178) | Polling interval for Soroswap smart contract reserves |
| `price_cache_ttl` | [`10`](../src/config.ts#L271) | seconds | [`src/config.ts:271`](../src/config.ts#L271) | Redis cache TTL for pricing responses |
| `http_timeout_ms` | [`10000`](../src/config.ts#L274) | ms | [`src/config.ts:274`](../src/config.ts#L274) | Outbound deadline timeout for external network requests |
| `snapshot_retention_days` | [`30`](../src/jobs/snapshotRetention.ts#L12) | days | [`src/jobs/snapshotRetention.ts:12`](../src/jobs/snapshotRetention.ts#L12) | Retention window for historical pool snapshots |
| `snapshot_retention_batch_size` | [`1000`](../src/jobs/snapshotRetention.ts#L14) | rows | [`src/jobs/snapshotRetention.ts:14`](../src/jobs/snapshotRetention.ts#L14) | Row limit for batch snapshot pruning statements |
| `price_points_retention_days` | [`30`](../src/partitioning/pricePoints.ts#L5) | days | [`src/partitioning/pricePoints.ts:5`](../src/partitioning/pricePoints.ts#L5) | Retention window before daily partition drops |
| `min_outlier_samples` | [`4`](../src/pricing/twap.ts#L288) | samples | [`src/pricing/twap.ts:288`](../src/pricing/twap.ts#L288) | Minimum samples required for statistical outlier rejection |
| `iqr_multiplier` | [`1.5`](../src/pricing/twap.ts#L289) | factor | [`src/pricing/twap.ts:289`](../src/pricing/twap.ts#L289) | Interquartile range multiplier for outlier fence |
| `modified_z_score_threshold` | [`3.5`](../src/pricing/twap.ts#L290) | factor | [`src/pricing/twap.ts:290`](../src/pricing/twap.ts#L290) | Modified Z-Score deviation threshold |
| `modified_z_score_factor` | [`0.6745`](../src/pricing/twap.ts#L291) | factor | [`src/pricing/twap.ts:291`](../src/pricing/twap.ts#L291) | Consistency adjustment factor for MAD normal distribution |
| `twap_window_min` | [`1`](../src/routes/price.ts#L8) | minutes | [`src/routes/price.ts:8`](../src/routes/price.ts#L8) | Minimum allowed TWAP calculation window |
| `twap_window_max` | [`1440`](../src/routes/price.ts#L9) | minutes | [`src/routes/price.ts:9`](../src/routes/price.ts#L9) | Maximum allowed TWAP calculation window (24h) |
| `twap_window_default` | [`60`](../src/routes/price.ts#L10) | minutes | [`src/routes/price.ts:10`](../src/routes/price.ts#L10) | Default TWAP window |
| `twap_sample_interval_min` | [`1`](../src/routes/price.ts#L11) | seconds | [`src/routes/price.ts:11`](../src/routes/price.ts#L11) | Minimum sample interval for TWAP calculation |
| `twap_sample_interval_max` | [`3600`](../src/routes/price.ts#L12) | seconds | [`src/routes/price.ts:12`](../src/routes/price.ts#L12) | Maximum sample interval for TWAP calculation |
| `twap_sample_interval_default` | [`60`](../src/routes/price.ts#L13) | seconds | [`src/routes/price.ts:13`](../src/routes/price.ts#L13) | Default sample interval for TWAP calculation |
| `vwap_window_min` | [`1`](../src/routes/price.ts#L15) | minutes | [`src/routes/price.ts:15`](../src/routes/price.ts#L15) | Minimum allowed VWAP calculation window |
| `vwap_window_max` | [`1440`](../src/routes/price.ts#L16) | minutes | [`src/routes/price.ts:16`](../src/routes/price.ts#L16) | Maximum allowed VWAP calculation window (24h) |
| `vwap_window_default` | [`60`](../src/routes/price.ts#L17) | minutes | [`src/routes/price.ts:17`](../src/routes/price.ts#L17) | Default VWAP window |
| `history_default_limit` | [`100`](../src/api/rest.ts#L24) | buckets | [`src/api/rest.ts:24`](../src/api/rest.ts#L24) | Default bucket limit for historical aggregates |
| `history_max_limit` | [`1000`](../src/api/rest.ts#L25) | buckets | [`src/api/rest.ts:25`](../src/api/rest.ts#L25) | Upper ceiling for historical aggregates |
| `screener_default_limit` | [`20`](../src/services/screener.ts#L16) | pairs | [`src/services/screener.ts:16`](../src/services/screener.ts#L16) | Default limit of pairs returned by screener |
| `screener_max_limit` | [`100`](../src/services/screener.ts#L17) | pairs | [`src/services/screener.ts:17`](../src/services/screener.ts#L17) | Maximum clamped limit of pairs returned by screener |
| `spread_min_observations` | [`2`](../src/routes/spreads.ts#L20) | observations | [`src/routes/spreads.ts:20`](../src/routes/spreads.ts#L20) | Minimum observations required before a venue spread is reported |
| `registered_venues_count` | [`6`](../src/ingest/venues/index.ts#L23) | adapters | [`src/ingest/venues/index.ts:23`](../src/ingest/venues/index.ts#L23) | Total number of registered venue adapters |
| `database_price_precision` | [`36`](../prisma/schema.prisma#L20) | digits | [`prisma/schema.prisma:20`](../prisma/schema.prisma#L20) | Total numeric precision in PostgreSQL decimal columns |
| `database_price_scale` | [`18`](../prisma/schema.prisma#L20) | decimals | [`prisma/schema.prisma:20`](../prisma/schema.prisma#L20) | Decimal places stored for pricing in PostgreSQL |
| `stellar_native_scale` | [`7`](../prisma/schema.prisma#L21) | decimals | [`prisma/schema.prisma:21`](../prisma/schema.prisma#L21) | Native Stellar stroop scale (one stroop equals ten to the negative seven XLM) |
