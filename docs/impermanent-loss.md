# Pool return estimates

`GET /pools` reports fee APR and impermanent loss together for a 24-hour
window. `netReturn24hPct` adds the estimated 24-hour fee return to the
divergence loss for the same window; all values are estimates, not a prediction
of future returns.

The divergence estimate assumes a constant-product 50/50 pool and compares the
first stored spot price in the last 24 hours with the latest stored spot price.
It does not include deposits, withdrawals, rewards, or gas. A two-point example
with a price moving from 1 to 2 has an estimated divergence loss of
`(2 * sqrt(2) / (1 + 2) - 1) * 100`, or about -5.72%.

Fee APR annualizes the last 24 hours of stored AMM counter-asset volume, applies
the pool's fee basis points, and divides by twice the current counter-asset
reserve (the pool's estimated value in that asset). This assumes the two
reserves have equal value at the stored spot price. If the pool has no 24-hour
opening snapshot or no usable reserve value, the corresponding net figure is
`null` rather than a fabricated zero.
