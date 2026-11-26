# Redis cache metrics

The Prometheus registry exports two counters on `/metrics`:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `cache_requests_total` | `cache`, `result` | One increment per read. The outcome is `hit`, `miss`, or `error`. |
| `cache_write_errors_total` | `cache` | One increment per failed best-effort write. |

The `cache` label is `price`, `snapshot`, or `asset`. Cache keys and
payloads are excluded from the labels. A read error still falls back like a
cache miss, but operators can see the difference in the metrics.

This PromQL query shows the share of completed reads served from cache over
five minutes, grouped by cache. Track errors separately from this ratio.

```promql
sum by (cache) (rate(cache_requests_total{app="lens",result="hit"}[5m]))
/
sum by (cache) (rate(cache_requests_total{app="lens",result=~"hit|miss"}[5m]))
```
