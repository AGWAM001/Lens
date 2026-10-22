---
'lens': minor
---

Multi-hop routing through configurable intermediate assets bounded in depth.

- Evaluates multi-hop routes (up to `ROUTING_MAX_HOPS`, defaulting to 3) across configurable intermediate assets (`ROUTING_INTERMEDIATES`, defaulting to XLM and Circle USDC).
- Names each hop with its input/output assets, execution venue (`SDEX` | `AMM`), pool ID if applicable, price, spot price, and slippage percentage.
- Shows side-by-side comparison between direct routes and multi-hop paths, ensuring direct routes win when they produce higher output.
- Returns comprehensive execution provenance including sample timestamps, target network, queried venues, total sample count, and data freshness age in seconds.
- Adds test coverage verifying thin pairs where two hops beat a direct trade.
