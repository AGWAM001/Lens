---
'lens': patch
---

Fix numeric price and volume precision across aggregations (#230).

- Remove `::float` casts inside intermediate aggregate expressions in `/candles`, `/prices/history`, and GraphQL `getPriceHistory`.
- Remove `::float` casts from `/price/:assetA/:assetB/history` and query raw numerics directly from `price_aggregates`.
- Add explicit, documented edge serialization formatters in `src/pricing/precision.ts`: prices up to 18 decimal places matching `Decimal(36, 18)`, and volumes up to 7 decimal places matching Stellar stroops (`Decimal(36, 7)`).
- Prevent multi-venue floating-point accumulation drift in `/volumes/:asset`.
