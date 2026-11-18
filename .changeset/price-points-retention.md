---
'lens': minor
---

Implement a retention policy and background worker for `price_points`:
- Rolls raw `price_points` older than `PRICE_POINTS_RETENTION_DAYS` (default 30 days) into 1-hour `price_aggregates` prior to pruning, preserving historical OHLCV, VWAP, venue volume breakdowns, and trade counts with full numeric precision.
- Deletes expired raw points in bounded batches (`PRICE_POINTS_PRUNE_BATCH_SIZE`, default 1,000) using `FOR UPDATE SKIP LOCKED` and yields between batches to prevent holding prolonged database locks.
- Scopes every query by `network` to utilize indexes and prevent cross-network data contamination.
- Exports Prometheus metrics `price_points_pruned_total` and `price_points_rolled_up_total` labeled by `network`.
- Includes BullMQ scheduling and in-process hourly fallback for lifecycle resilience.
