# HTTP metrics

Lens exports Prometheus metrics for the HTTP layer on the existing public
`/metrics` route, alongside the ingestion and database metrics defined in
[`src/metrics.ts`](../src/metrics.ts). The ingestion metrics have their own doc
— [`ingest-metrics.md`](ingest-metrics.md) — because the label constraint there
is different: they are labelled by `network` so the per-network ingester loops
cannot overwrite each other's series.

These three signals — request rate, error rate and p95 latency — are what answer
"is the API healthy". The pre-existing `price_requests_total` counts price calls
specifically and cannot answer that question; it is unchanged and still means
what it always meant.

The same cardinality rule applies to every metric family: labels must come from
fixed buckets or server-defined values. Never put raw request paths, asset
codes, issuer addresses, query values or websocket subscription strings in a
Prometheus label.

## What is exported

### `http_requests_total`

Counter. Labels: `method`, `route`, `status_class`.

| Label | Values | Notes |
| --- | --- | --- |
| `method` | `GET`, `POST`, … | The HTTP method. |
| `route` | `/price/:assetA/:assetB`, `/status`, … | The matched Fastify route **template**, never the resolved URL. Unrouted requests get the literal `unmatched`. |
| `status_class` | `2xx`, `3xx`, `4xx`, `5xx` | The status class, not the exact code. |

### `http_request_duration_seconds`

Histogram. Labels: `method`, `route`.

Buckets: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`.

Observed for every request that produces a response, successful or not.

## Why the labels look like this

Cardinality is the whole design constraint. A histogram labelled by `req.url`
would mint a new time series for every asset pair, every address and every
cursor Lens is asked about — an unbounded set driven by callers, which
eventually degrades the Prometheus instance scraping it.

So:

- **`route` is the route template.** Fastify exposes the matched route on
  `req.routeOptions.url`; that is what is used. 100 requests to 100 distinct
  addresses produce **one** series, not 100 — asserted in
  [`tests/httpMetrics.test.ts`](../tests/httpMetrics.test.ts).
- **Unmatched requests collapse to `unmatched`.** A 404 uses the literal string
  rather than the raw path, so a scanner probing a thousand URLs cannot mint a
  thousand series.
- **`status_class`, not `status`.** This bounds the series count at
  `methods x routes x 5` rather than `methods x routes x ~60`. If a concrete
  need for an exact code appears, add it then — it is easy to add a label and
  painful to remove one dashboards depend on.
- **Websocket pairs use fixed buckets.** `ws_clients_total`,
  `ws_messages_sent_total` and `ws_messages_dropped_total` retain their `pair`
  label, but pair-specific subscriptions are recorded as `other`; `*` remains
  the aggregate across all subscriptions. Arbitrary pair names and issuer
  addresses stay in fanout state only and cannot create Prometheus series.

## Bucket choice

The prom-client defaults cluster below 1s and suit fast in-process handlers.
Lens handlers are not that: a request does a Redis cache lookup (single-digit
ms) or, on a miss, a Postgres aggregate query plus — for `/price` and `/route` —
Horizon/Soroswap network round-trips.

The buckets therefore give resolution in two regions:

- **5ms–50ms** — cache hits, the common fast path. Enough granularity to see the
  Redis path regress before users notice.
- **100ms–2.5s** — DB aggregates and upstream venue calls. This is where p95
  actually lives and where an SLO would be set.

The 5s and 10s buckets catch upstream stalls short of a timeout. Anything slower
lands in `+Inf` and surfaces as a saturated p99.

## Registration order

The hook is registered **first** in [`src/index.ts`](../src/index.ts) — ahead of
the network selector, API-key auth, the rate limiter and x402.

This matters. All of those reject requests from an `onRequest` hook, and Fastify
runs `onRequest` hooks in registration order. Registering the metrics plugin
later would mean a request rejected by auth or x402 short-circuits before the
timer starts, losing exactly the 401/402/429 traffic an operator most wants to
see.

`/metrics` itself is excluded from counting. It is scraped on a fixed interval,
so counting it would have the scraper continuously inflate the numbers it is
reading — request rate would never fall to zero on an idle service.

## Queries

```promql
# Request rate (per second, 5m window)
sum(rate(http_requests_total[5m])) by (route)

# Error rate as a fraction of all requests
sum(rate(http_requests_total{status_class="5xx"}[5m]))
  / sum(rate(http_requests_total[5m]))

# p95 latency across the service
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le))

# p95 latency per route — find which endpoint is slow
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
```

## Suggested alerts

These are starting points; tune the thresholds against observed traffic before
paging anyone with them.

```yaml
groups:
  - name: lens-http
    rules:
      - alert: LensHighErrorRate
        expr: |
          sum(rate(http_requests_total{status_class="5xx"}[5m]))
            / sum(rate(http_requests_total[5m])) > 0.05
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "Lens is serving over 5% 5xx"

      - alert: LensHighLatencyP95
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 2.5
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "Lens p95 latency above 2.5s"

      - alert: LensNoTraffic
        expr: sum(rate(http_requests_total[10m])) == 0
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "Lens is serving no requests — check ingress or the scraper"
```

A note on `LensHighErrorRate`: the ratio is undefined when there is no traffic,
which is why `LensNoTraffic` exists separately rather than trying to make one
rule cover both. A service serving zero requests is a real problem that an error
*ratio* will never fire on.
