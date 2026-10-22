import { Registry, Counter, Gauge, Histogram } from 'prom-client'

export const register = new Registry()

// Standard metrics
register.setDefaultLabels({
  app: 'lens'
})

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

export const price_requests_total = new Counter({
  name: 'price_requests_total',
  help: 'Total number of price API requests served',
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

export const last_trade_timestamp = new Gauge({
  name: 'last_trade_timestamp',
  help: 'Unix timestamp of the last trade ingested for a pair',
  labelNames: ['pair', 'network'],
  registers: [register]
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

export async function getMetrics() {
  return await register.metrics()
}
