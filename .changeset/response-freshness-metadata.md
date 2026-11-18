---
'lens': minor
---

Every pricing response (`/price/:assetA/:assetB`, `/price/twap/:assetA/:assetB`, and `/price/vwap/:assetA/:assetB`) now carries:
- `newestInputObservedAt`: ISO 8601 timestamp of its newest input data point (`null` if no trades exist)
- `inputCount`: the count of inputs used in the computation
- `stalenessThresholdSeconds`: the staleness bound in seconds
- `stale`: boolean flag indicating whether the newest input is older than the staleness threshold

The staleness bound defaults to 300 seconds (configurable globally via `PRICE_STALE_THRESHOLD_SECONDS` or `STALENESS_BOUND_SECONDS`) and can be customized per request using the `staleThreshold` query parameter. All routes and schemas are declared in `openapi.yaml` and synchronized in `openapi.json`.
