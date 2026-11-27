import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client'

export const register = new Registry()

// Standard metrics
register.setDefaultLabels({
  app: 'lens'
})
collectDefaultMetrics({ register })

// Ingest metrics are network-scoped. One ingester set runs per enabled network
// against one shared Registry, so without `network` the testnet loop and the
// mainnet loop write to the SAME series for the same pair — the gauge case
// being worse than a merge, because `last_trade_timestamp.set()` is a
// last-writer-wins overwrite rather than an additive increment. That made the
// only staleness signal Lens exports unusable on a dual-network deployment.
//
// `network` is deliberately the ONLY added label. See docs/ingest-metrics.md:
// series count is `pairs x networks`, which is bounded by configuration.
// Do NOT add `issuer` or a raw pool id here — the cardinality notes in that
// doc explain why those labels do not belong on these metrics.

export const ingesterRestarts = new Counter({
  name: 'ingester_restarts_total',
  help: 'Times an ingester crashed and was restarted, by ingester and network',
  // Bounded: one series per (venue, network) pair the process actually runs,
  // the same shape as the metrics below. A crash message is deliberately NOT a
  // label — it is unbounded and arrives from upstream.
  labelNames: ['ingester', 'network'],
  registers: [register]
})

export const trades_ingested_total = new Counter({
  name: 'trades_ingested_total',
  help: 'Total number of trades ingested from SDEX/AMM',
  labelNames: ['pair', 'network'],
  registers: [register]
})

export const price_points_accepted_total = new Counter({
  name: 'price_points_accepted_total',
  help: 'Total number of price points accepted by ingest plausibility checks',
  labelNames: ['source', 'network'],
  registers: [register]
})

export const price_points_quarantined_total = new Counter({
  name: 'price_points_quarantined_total',
  help: 'Total number of price points quarantined by ingest plausibility checks',
  labelNames: ['source', 'network'],
  registers: [register]
})

export const price_points_rejected_total = price_points_quarantined_total

export const amm_snapshots_total = new Counter({
  name: 'amm_snapshots_total',
  help: 'Total number of AMM pool snapshots captured',
  labelNames: ['pool', 'network'],
  registers: [register]
})

export const price_snapshots_total = new Counter({
  name: 'price_snapshots_total',
  help: 'Total number of 1-minute price snapshots appended',
  labelNames: ['network'],
  registers: [register]
})

export const blend_pool_errors_total = new Counter({
  name: 'blend_pool_errors_total',
  help: 'Total number of Blend pool read failures',
  labelNames: ['pool', 'network'],
  registers: [register],
})

export const blend_rates_ingested_total = new Counter({
  name: 'blend_rates_ingested_total',
  help: 'Total number of Blend pool rate records ingested',
  labelNames: ['pool', 'network'],
  registers: [register],
})

export const ingester_abandoned_cycles_total = new Counter({
  name: 'ingester_abandoned_cycles_total',
  help: 'Total number of ingester cycles abandoned after exceeding their per-cycle deadline',
  // `venue` is the ingester loop's own name (SDEX, AMM, Soroswap, Aquarius,
  // Snapshot) — a bounded set hard-coded in the adapter registry, exactly like
  // the network factor above. Together they give `venues x networks` series:
  // this is the label #351 asks for, so an on-call can tell WHICH loop is
  // stalling on WHICH network without an unbounded dimension ever appearing.
  labelNames: ['venue', 'network'],
  registers: [register]
})

export const price_points_pruned_total = new Counter({
  name: 'price_points_pruned_total',
  help: 'Total number of old price points pruned from the database',
  labelNames: ['network'],
  registers: [register]
})

export const price_points_rolled_up_total = new Counter({
  name: 'price_points_rolled_up_total',
  help: 'Total number of old price points rolled up into aggregates before pruning',
  labelNames: ['network'],
  registers: [register]
})

export const price_requests_total = new Counter({
  name: 'price_requests_total',
  help: 'Total number of price API requests served',
  registers: [register]
})

export const active_subscriptions = new Gauge({
  name: 'active_subscriptions',
  help: 'Currently active GraphQL priceUpdated subscriptions, by pair',
  // Deliberately the only label. `pair` is what the subscriber asked for, so
  // the distribution across pairs is visible; `network` stays out because the
  // gauge would double the series for the same routing decision (#373).
  // Unlike the ws_* metrics in ws/fanout.ts this label is subscriber-supplied
  // and theoretically unbounded — a client can mint one series per distinct
  // pair string. Guarded in practice: only registered deployments accept
  // subscriptions, and a pair that is not watched never receives data.
  labelNames: ['pair'],
  registers: [register]
})

export const price_rejected_total = new Counter({
  name: 'price_rejected_total',
  help: 'Total number of prices rejected due to plausibility sanity bounds',
  labelNames: ['pair', 'network', 'venue', 'reason'],
  registers: [register]
})

export const api_key_auth_failures_total = new Counter({
  name: 'api_key_auth_failures_total',
  help: 'Total number of API key authentication failures, by bounded reason',
  labelNames: ['reason'],
  registers: [register]
})

export const admin_auth_failures_total = new Counter({
  name: 'admin_auth_failures_total',
  help: 'Total number of admin authentication failures',
  registers: [register]
})

export const api_key_cache_lookups_total = new Counter({
  name: 'api_key_cache_lookups_total',
  help: 'API key auth cache lookups by result. Hit rate = hit / (hit + miss).',
  // `result` is bounded to hit|miss, so cardinality is fixed at two series.
  // A hit is served entirely from the in-process cache with no Postgres query;
  // a miss falls through to `prisma.apiKey.findUnique`.
  labelNames: ['result'],
  registers: [register]
})

export const cache_requests_total = new Counter({
  name: 'cache_requests_total',
  help: 'Redis cache reads by cache and outcome',
  labelNames: ['cache', 'result'],
  registers: [register]
})

export const cache_write_errors_total = new Counter({
  name: 'cache_write_errors_total',
  help: 'Failed writes to Redis caches',
  labelNames: ['cache'],
  registers: [register]
})

export const rate_limit_rejections_total = new Counter({
  name: 'rate_limit_rejections_total',
  help: 'Total number of requests rejected by the per-key or fallback IP rate limiter',
  labelNames: ['scope'],
  registers: [register]
})

export const global_shed_requests_total = new Counter({
  name: 'global_shed_requests_total',
  help: 'Total number of requests shed by the per-instance global request ceiling',
  registers: [register]
})

export const x402_payments_received_total = new Counter({
  name: 'x402_payments_received_total',
  help: 'Total number of valid x402 payments received',
  registers: [register]
})

export const webhook_delivery_failures_total = new Counter({
  name: 'webhook_delivery_failures_total',
  help: 'Permanent webhook delivery failures by bounded failure category',
  labelNames: ['category'],
  registers: [register]
})

export const process_crashes_total = new Counter({
  name: 'process_crashes_total',
  help: 'Total number of fatal process errors, by event',
  labelNames: ['event'],
  registers: [register]
})

export const last_trade_timestamp = new Gauge({
  name: 'last_trade_timestamp',
  help: 'Unix timestamp of the last trade ingested for a pair',
  labelNames: ['pair', 'network'],
  registers: [register]
})

export const horizon_rate_limit_remaining = new Gauge({
  name: 'horizon_rate_limit_remaining',
  help: 'Remaining Horizon API requests in the current rate-limit window',
  labelNames: ['network'],
  registers: [register],
})

// Ingestion health is labelled only by the finite adapter registry and the
// two supported networks. Do not add pair or pool identifiers here: they make
// the series count grow with user configuration and on-chain pool creation.
export const ingest_last_success_timestamp = new Gauge({
  name: 'ingest_last_success_timestamp',
  help: 'Unix timestamp of the last successful price write by venue and network',
  labelNames: ['venue', 'network'],
  registers: [register],
})

export const ingest_cycle_duration_seconds = new Histogram({
  name: 'ingest_cycle_duration_seconds',
  help: 'Duration of a venue ingestion cycle in seconds',
  labelNames: ['venue', 'network'],
  // Venue polls are mostly sub-second, but Horizon and Soroswap requests can
  // take several seconds. These buckets expose normal cycles and slow calls.
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
})

export const ingest_errors_total = new Counter({
  name: 'ingest_errors_total',
  help: 'Ingestion cycle errors by venue, network and bounded error category',
  labelNames: ['venue', 'network', 'category'],
  registers: [register],
})

/** Record a successful persisted price write without high-cardinality labels. */
export function markIngestSuccess(venue: string, network: string): void {
  ingest_last_success_timestamp.set({ venue, network }, Math.floor(Date.now() / 1000))
}

export const snapshot_retention_path = new Gauge({
  name: 'snapshot_retention_path',
  help: 'Active snapshot retention scheduler (one-hot path labels)',
  labelNames: ['path'],
  registers: [register],
})

// Background job metrics (#696). Every worker in src/jobs/ records its runs
// through runJob() in src/jobs/jobMetrics.ts, for the queue path and for the
// in-process fallback timers in src/index.ts alike, so a failed run is
// visible instead of looking like a success.
//
// Labels are `job` and `network` only — the same bounded-label rule as the
// ingest metrics above. `job` is one of the seven queue names in src/jobs/
// (see JobName in src/jobs/jobMetrics.ts); `network` is testnet|mainnet.
// Do NOT add `pair` or a pool id here: the aggregate-refresh worker runs
// once per watched pair, and a pair label would mint a series per pair per
// network for a question ("is the job failing?") that does not need it.
export const job_runs_total = new Counter({
  name: 'job_runs_total',
  help: 'Background job runs by outcome (success or failure), by job and network',
  labelNames: ['job', 'network', 'outcome'],
  registers: [register],
})

export const job_duration_seconds = new Histogram({
  name: 'job_duration_seconds',
  help: 'Duration of a background job run in seconds, by job and network',
  labelNames: ['job', 'network'],
  // Jobs run from sub-second (partition pre-creation) to minutes (a large
  // retention prune), so these buckets are wider at the top than the ingest
  // cycle buckets; anything slower lands in +Inf and shows up as a
  // saturated p99.
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [register],
})

export const job_last_success_timestamp = new Gauge({
  name: 'job_last_success_timestamp',
  help: 'Unix timestamp of the last successful background job run, by job and network',
  labelNames: ['job', 'network'],
  registers: [register],
})

// Rows deleted by the retention jobs, by job and network. The pre-existing
// price_points_pruned_total stays as-is for the price-points retention job;
// this counter is the uniform one, so one query covers every retention job.
export const job_rows_deleted_total = new Counter({
  name: 'job_rows_deleted_total',
  help: 'Rows deleted by a background retention job, by job and network',
  labelNames: ['job', 'network'],
  registers: [register],
})

// SEP-40 publisher metrics (#772). The publisher is the only path in Lens that
// signs a transaction and spends a fee; before this it exported nothing, so a
// feed that stopped writing and a feed that was blocked on every pair looked
// identical from /metrics.
//
// As with the ingest and job metrics above, only bounded labels are allowed:
// `network` is the network of the publisher loop, `trigger` is one of the three
// codes in src/publish/trigger.ts, and `guard` is the closed set of guard codes
// there plus the publisher's own orientation/provenance codes. Unknown codes
// collapse to `other`. Never add a pair, asset or contract id: a cycle decides
// once per pair, so those labels would grow with configuration.
export const publisher_reports_written_total = new Counter({
  name: 'publisher_reports_written_total',
  help: 'On-chain reports written by the SEP-40 publisher, by network and trigger',
  labelNames: ['network', 'trigger'],
  registers: [register],
})

export const publisher_pairs_blocked_total = new Counter({
  name: 'publisher_pairs_blocked_total',
  help: 'Pairs blocked by a publication guard, by network and bounded guard code',
  labelNames: ['network', 'guard'],
  registers: [register],
})

export const publisher_writes_failed_total = new Counter({
  name: 'publisher_writes_failed_total',
  help: 'Failed SEP-40 publication attempts, by network',
  labelNames: ['network'],
  registers: [register],
})

export const publisher_cycles_failed_total = new Counter({
  name: 'publisher_cycles_failed_total',
  help: 'SEP-40 publication cycles that aborted before completing, by network',
  labelNames: ['network'],
  registers: [register],
})

export const publisher_last_success_timestamp = new Gauge({
  name: 'publisher_last_success_timestamp',
  help: 'Unix timestamp of the last successful on-chain publication, by network',
  labelNames: ['network'],
  registers: [register],
})

export const publisher_cycle_duration_seconds = new Histogram({
  name: 'publisher_cycle_duration_seconds',
  help: 'Duration of a SEP-40 publication cycle in seconds, by network',
  labelNames: ['network'],
  // A cycle can be a sub-millisecond no-op or an RPC call plus a signed
  // transaction. Failed cycles are observed too: failing fast and failing
  // after a timeout are different problems.
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
})

export const http_requests_total = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests served, by method, route template and status class',
  // `route` is the matched Fastify route TEMPLATE (e.g. /price/:assetA/:assetB),
  // never the resolved URL — resolving it would mint a new time series per
  // asset pair, address and cursor and eventually overwhelm Prometheus.
  // `status_class` is 2xx/4xx/5xx rather than the exact code for the same
  // reason; add an exact-status label only if a concrete need appears.
  labelNames: ['method', 'route', 'status_class'],
  registers: [register]
})

export const http_request_duration_seconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds, by method and route template',
  labelNames: ['method', 'route'],
  // Buckets are chosen for THIS service, not prom-client's defaults. The
  // defaults top out at 10s and cluster below 1s, which suits fast in-process
  // handlers; Lens handlers are not that. A typical request does a Redis cache
  // lookup (single-digit ms) or, on a miss, a Postgres aggregate query plus —
  // for /price and /route — Horizon/Soroswap network round-trips. So we want
  // fine resolution across two regions:
  //   5ms–50ms   cache hits, the common fast path; enough granularity to see
  //              the Redis path regress before users notice.
  //   100ms–2.5s DB aggregates and upstream venue calls, where p95 actually
  //              lives and where an SLO would be set.
  // The 5s and 10s buckets exist to catch upstream stalls short of a timeout;
  // anything slower falls in +Inf and shows up as a saturated p99.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
})

export const db_query_duration_seconds = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
})

// Database connection pool utilisation metrics
export const db_pool_connections_in_use = new Gauge({
  name: 'db_pool_connections_in_use',
  help: 'Number of database connections currently checked out / in use',
  registers: [register],
})

export const db_pool_connections_idle = new Gauge({
  name: 'db_pool_connections_idle',
  help: 'Number of idle database connections available in the pool',
  registers: [register],
})

export const db_pool_connections_waiting = new Gauge({
  name: 'db_pool_connections_waiting',
  help: 'Number of queued requests currently waiting for a database connection',
  registers: [register],
})

export const db_pool_exhaustion_errors_total = new Counter({
  name: 'db_pool_exhaustion_errors_total',
  help: 'Total number of database pool acquisition timeouts or exhaustion errors',
  registers: [register],
})

let _poolMetricsUpdater: (() => void) | null = null

export function setPoolMetricsUpdater(updater: () => void) {
  _poolMetricsUpdater = updater
}

export async function getMetrics() {
  if (_poolMetricsUpdater) {
    try {
      _poolMetricsUpdater()
    } catch {
      // Best-effort metric collection
    }
  }
  return await register.metrics()
}
