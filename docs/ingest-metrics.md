# Ingest metrics

The ingestion side of `/metrics`, defined in [`src/metrics.ts`](../src/metrics.ts).
The HTTP layer has its own doc — [`http-metrics.md`](http-metrics.md) — because
its label design is a separate problem. Everything here shares one concern:
**Lens runs one ingester set per enabled network against a single Prometheus
registry, so an ingest metric that cannot tell the networks apart is reporting
nonsense on any deployment with more than one.**

## What is exported

| Metric | Type | Labels |
| --- | --- | --- |
| `trades_ingested_total` | Counter | `pair`, `network` |
| `amm_snapshots_total` | Counter | `pool`, `network` |
| `price_snapshots_total` | Counter | `network` |
| `ingester_abandoned_cycles_total` | Counter | `venue`, `network` |
| `last_trade_timestamp` | Gauge | `pair`, `network` |

| Label | Values | Notes |
| --- | --- | --- |
| `network` | `testnet`, `mainnet` | The `NetworkName` of the ingester loop that produced the sample, not the process-wide `STELLAR_NETWORK`. |
| `pair` | `XLM/USDC`, … | The `pairKey` already used everywhere else in Lens. |
| `pool` | Horizon liquidity-pool id | Pre-existing label, only on `amm_snapshots_total`. |
| `venue` | `SDEX`, `AMM`, `Soroswap`, `Aquarius`, `Snapshot` | The ingester loop that abandoned a cycle past its deadline (#351). Bounded by the adapter registry, not by runtime data. |

All five are also emitted with the registry-wide `app="lens"` default label.

## Why `network` is on all five

Before this change, the ingest metrics were network-blind. On a dual-network
deployment the two loops wrote to the same series.

For the counters that is a silent merge — `trades_ingested_total` summed
testnet and mainnet trades together, so a per-network ingest rate was not
queryable at all.

`last_trade_timestamp` was worse. It is a `Gauge.set()`, not an increment, so
whichever loop ticked last won. The testnet loop at
[`src/ingest/venues/sdex.ts`](../src/ingest/venues/sdex.ts) overwrote mainnet's value
for the same pair every poll interval, and the series reported a timestamp
belonging to exactly one network while looking network-agnostic. That is the
only staleness signal Lens exports, and on a dual-network deployment it was
unusable for the job — silently, because the value still looked like a plausible
timestamp.

Each call site now passes the `network` argument it already receives
(`ingestPair(pair, network)`, `snapshotPool(pool, pair, network)`,
`ingestPoolTrades(pool, pair, network)`, `appendSnapshots(now, network)`).
The invariant is the loop's own network, never `activeNetwork` — `activeNetwork`
is a per-process constant and is exactly the value that made this bug invisible.

[`tests/ingestMetrics.test.ts`](../tests/ingestMetrics.test.ts) asserts that two
networks produce two distinct series for the same pair rather than one
overwritten one, and drives the real ingesters so a call site that forgets the
label fails the test.

## Cardinality

Series count is `pairs x networks`:

- `trades_ingested_total` and `last_trade_timestamp` — `pairs x networks`. Both
  factors are bounded by configuration: `WATCHED_PAIRS` and `ENABLED_NETWORKS`
  are single-digit, so this is tens of series, not thousands.
- `amm_snapshots_total` — `pools x networks`. Pools are discovered from Horizon
  for the configured pairs only, so this stays bounded by the same watch list.
- `price_snapshots_total` — `networks`. One series per network, full stop.
- `ingester_abandoned_cycles_total` — `venues x networks`. `venue` is the five
  ingester loops hard-coded in the adapter registry (plus the snapshot
  appender), so this is a single-digit factor like `network`, not an ID
  space: never label it with a pool id, a pair or a contract id.

**Do not add `issuer` to any of these.** It would multiply the series count by
every distinct token in the config for no gain: `pair` is the `pairKey` and
already identifies the instrument, and any question that genuinely needs the
issuer is a database question, not a Prometheus one. An issuer label is also the
label most likely to be added casually — every token *looks* like a useful
dimension until you count them.

**Do not add `pool` to `trades_ingested_total` or `last_trade_timestamp`.**
Pool ids are only known to the AMM loop, and adding them there would mean the
SDEX loop needs a synthetic value; worse, it would turn a per-pair signal into
a per-pool one. If pool-level trade volume is genuinely needed, derive it from
`price_points` in the database, or add a separate metric with a deliberate label
set rather than widening an existing one. It is easy to add a label and painful
to remove one dashboards have come to depend on.

## Queries

```promql
# Ingest rate per network
sum(rate(trades_ingested_total[5m])) by (network)

# Ingest rate for one pair, split by network
sum(rate(trades_ingested_total{pair="XLM/USDC"}[5m])) by (network)

# How stale is the feed, per network? (seconds since the last trade)
time() - last_trade_timestamp

# Staleness for one pair on one network
time() - last_trade_timestamp{pair="XLM/USDC", network="mainnet"}

# Pairs that have gone quiet in the last 15 minutes
time() - last_trade_timestamp > 900

# Which ingester loop is overrunning its cycle deadline, on which network
sum(rate(ingester_abandoned_cycles_total[15m])) by (venue, network)
```

## Suggested alerts

`time() - last_trade_timestamp` needs a threshold per pair, not one global one:
a thin pair legitimately goes hours without a trade. The expression below is a
starting point — tune it against the observed trade frequency of the pairs you
actually watch before paging anyone.

```yaml
groups:
  - name: lens-ingest
    rules:
      - alert: LensIngestStale
        expr: |
          (time() - last_trade_timestamp) > 3600
            and on (pair, network)
          (sum(increase(trades_ingested_total[6h])) by (pair, network) > 0)
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.pair }} on {{ $labels.network }} has seen no trade for over an hour"
```

The `increase(...) > 0` arm is what makes this alertable rather than noisy: it
fires only for pairs that were actually trading recently enough to be expected
to trade again, so a pair that never trades does not page anyone. Adding
`network` to the label set is what makes the `and on (pair, network)` join
correct — without it the two networks' series are indistinguishable and the
threshold can be satisfied or violated by whichever network happens to be
active.

## Background job metrics

The background jobs in [`src/jobs/`](../src/jobs/) report to the same
registry, through the `runJob()` helper in
[`src/jobs/jobMetrics.ts`](../src/jobs/jobMetrics.ts). Before this change
they reported nothing — `src/metrics.ts` had only `snapshot_retention_path`
for jobs — so nobody could answer when snapshot retention last succeeded,
how long a venue reconciliation run takes, or whether the aggregate refresh
was failing.

There was a second problem. Every worker caught its own errors and logged
them, so the handler never threw and BullMQ recorded the job as completed;
the `worker.on('failed')` handler under it could never fire for a real
failure. The workers no longer catch: `runJob()` records the failure and
rethrows, so BullMQ stores the run as failed. The in-process fallback timers
in [`src/index.ts`](../src/index.ts) (`safePrune`, `safeRatePrune`,
`safeMaintainPartitions`) are the one place that still catches — a timer has
no BullMQ to report to, and the run is already counted as a failure by then.

## What is exported

| Metric | Type | Labels |
| --- | --- | --- |
| `job_runs_total` | Counter | `job`, `network`, `outcome` |
| `job_duration_seconds` | Histogram | `job`, `network` |
| `job_last_success_timestamp` | Gauge | `job`, `network` |
| `job_rows_deleted_total` | Counter | `job`, `network` |

| Label | Values | Notes |
| --- | --- | --- |
| `job` | `aggregate-refresh`, `snapshot-retention`, `venue-reconciliation`, `rate-retention`, `oracle-retention`, `price-points-retention`, `price-points-partition` | The BullMQ queue name (minus the network prefix) of the job that ran. A closed set, hard-coded as `JobName` in `src/jobs/jobMetrics.ts`. |
| `network` | `testnet`, `mainnet` | The network the run worked on. For the retention jobs this is the network of the prune loop, not the process-wide `STELLAR_NETWORK`. |
| `outcome` | `success`, `failure` | Only on `job_runs_total`. Failure rate = `failure / (success + failure)`. |

All four are also emitted with the registry-wide `app="lens"` default label.

`job_last_success_timestamp` only moves on success, so a job that starts
failing goes stale instead of looking healthy. Duration is observed for
success and failure alike — a run that fails fast and a run that fails after
ten minutes are different problems. `job_rows_deleted_total` is recorded per
batch inside each retention prune loop, so a run that fails part-way still
reports the rows it already deleted. The pre-existing
`price_points_pruned_total` stays as-is for the price-points retention job;
`job_rows_deleted_total` is the uniform counter, so one query covers every
retention job.

## Where a run is recorded

The recording lives in the shared function both paths call, so the queue
worker and the in-process fallback timer report the same run exactly once:

- The retention jobs record one run per network inside `pruneAllNetworks()`,
  `pruneAllRateNetworks()`, `pruneAllNetworksOracleComparisons()` and the
  price-points `pruneAllNetworks()`. A failure on one network does not stop
  the others, and each network gets its own success or failure.
- Partition maintenance records one run inside `runPricePointsMaintenance()`.
  It is a single global run, not one per network — partitions are cut by
  timestamp across all networks — so it is labelled with the active network
  its queue is pinned to.
- The aggregate-refresh and venue-reconciliation workers are per network
  already, so their handlers record the run directly; the in-process
  reconciliation timer (`startInProcessVenueReconciliation`) records its
  runs the same way.

Two deliberate boundaries:

- Venue reconciliation isolates per-pair failures: a bad pair is logged and
  the other pairs are still reconciled, so a run only counts as a failure
  when the cycle itself throws.
- `job` is never a pair or a pool id. The aggregate-refresh worker runs
  once per watched pair, and a pair label would mint a series per pair per
  network for a question ("is the job failing?") that does not need it.

## Retries

Every job queue pins `defaultJobOptions: { attempts: 1 }` when it is
created. BullMQ's default is already one attempt, but the pin makes the
intent explicit: a failed hourly run is stored as failed, not retried
forever, and the next repeat fires on schedule. A failed run is therefore
visible in `job_runs_total{outcome="failure"}` and in BullMQ's failed set,
not hidden behind a retry loop.

## Cardinality

Series count is `jobs x networks`:

- `job_runs_total` — `jobs x networks x outcomes`. Seven jobs, two
  networks, two outcomes: at most 28 series.
- `job_duration_seconds`, `job_last_success_timestamp`,
  `job_rows_deleted_total` — `jobs x networks`: at most 14 series each.

**Do not add `pair` or `pool` to any of these.** Both are unbounded in
principle — pairs come from configuration and pools are discovered from
chain data — and neither answers a job-health question. If a per-pair
failure needs tracking, it is a log line with the pair in it, not a label.

## Queries

```promql
# Failure rate per job over the last hour
sum(rate(job_runs_total{outcome="failure"}[1h])) by (job)
  / sum(rate(job_runs_total[1h])) by (job)

# How stale is each job, per network? (seconds since the last success)
time() - job_last_success_timestamp

# Jobs that have not succeeded in the last 2 hours
time() - job_last_success_timestamp > 7200

# p95 run duration per job
histogram_quantile(0.95, sum(rate(job_duration_seconds_bucket[15m])) by (job, le))

# Rows deleted by the retention jobs, per network
sum(rate(job_rows_deleted_total[1h])) by (job, network)
```

## Suggested alerts

```yaml
groups:
  - name: lens-jobs
    rules:
      - alert: LensJobFailing
        expr: |
          sum(rate(job_runs_total{outcome="failure"}[15m])) by (job, network) > 0
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.job }} on {{ $labels.network }} is failing"

      - alert: LensJobStale
        expr: |
          (time() - job_last_success_timestamp) > 7200
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.job }} on {{ $labels.network }} has not succeeded in 2 hours"
```

The staleness threshold is per job, not one global one: an hourly retention
job legitimately goes an hour between successes, while a per-minute
aggregate refresh should not. Tune each threshold against the schedule in
the job's `schedule*` function before paging on it.
