# Deterministic pricing fixture

`pricingDataset.ts` is a fixed, hand-sized dataset for regression tests of the
pricing formulas. All timestamps are UTC and independent of test execution
time. Both networks use `XLM/USDC` so a network-blind query would mix unrelated
markets.

| Network | Time (UTC) | Price | Base volume | Source |
| --- | --- | ---: | ---: | --- |
| testnet | 00:00 | 10 | 2 | SDEX |
| testnet | 00:01 | 12 | 3 | SDEX |
| testnet | 00:03 | 8 | 5 | AMM |
| mainnet | 00:00 | 20 | 1 | SDEX |
| mainnet | 00:01 | 22 | 1 | AMM |
| mainnet | 00:03 | 24 | 2 | AMM |

The testnet's missing 00:02 sample is intentional. With one-minute TWAP
sampling, the 00:01 price carries forward over the gap:
`(10 × 1 + 12 × 1 + 12 × 1) / 3 = 34/3`. The 00:03 endpoint has zero
duration weight. A single-sample TWAP is the sample price, 15, and a VWAP with
zero total volume is 0.

Hand-computed aggregate expectations:

- Testnet VWAP: `(10×2 + 12×3 + 8×5) / 10 = 9.6`.
- Mainnet VWAP: `(20×1 + 22×1 + 24×2) / 4 = 22.5`.
- Testnet OHLCV: open 10, high 12, low 8, close 8, volume 10, 3 trades.
- Mainnet OHLCV: open 20, high 24, low 20, close 24, volume 4, 3 trades.

The depth fixture uses reserves A=100 and B=200 with a 30 bp fee. Spot is
`200/100 = 2`. At step size 0.1 the ask sells 10 A; after fees its input is
9.97, so its displayed price is `(200×9.97/(100+9.97))/10`. The bid inputs 20
B (19.94 after fees), receives `100×19.94/(200+19.94)` A, and displays the
price as input B divided by output A. The pricing fixture test asserts these
formula results directly to avoid rounded constants hiding regressions.
