---
'lens': minor
---

Ingest Blend lending pool state (#212). A dedicated ingester reads pool reserves over Soroban, derives utilisation and supply/borrow APR, and stores them in `lending_rates` — not `price_points`, because a lending rate is not a spot price. `GET /rates/:asset` serves them, a retention job prunes old rows, and the cycle is bounded by the same per-ingester deadline every other loop uses.
