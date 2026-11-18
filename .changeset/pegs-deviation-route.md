---
'lens': minor
---

Add `GET /pegs` (`/v1/pegs`) endpoint reporting current and rolling-window worst peg deviations (in basis points) and provenance (venues, sample count, and freshness) across all configured pegged assets (`PEGGED_ASSETS_TESTNET`, `PEGGED_ASSETS_MAINNET`, `PEGGED_ASSETS`).
- Defaults to Circle `USDC` pegged to `USD:1.0` per network (`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5=USD:1.0` on testnet and `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN=USD:1.0` on mainnet) when `PEGGED_ASSETS*` is unset so deployed instances report the canonical USD stablecoin peg out of the box rather than returning an empty list.
- Shares `DEFAULT_PEG_TOLERANCE_BPS = 100` (100 bps = 1.0%) with `GET /snapshot` (`PEG_TOLERANCE_BPS = 100`) and the peg-deviation alerting engine (#322, default band = 0.01 = 100 bps).
- `GET /snapshot` consults `NetworkConfig.pegged` first when evaluating watched-pair pegs so configured targets and non-1.0 target prices never disagree between `/pegs` and `/snapshot`, while retaining its built-in 1:1 fiat stablecoin ticker map (`PEGGED_ASSETS`) as a fallback for unconfigured watched pairs and stablecoin-sibling reference quotes (`USDC/USDT`).
