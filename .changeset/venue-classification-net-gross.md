---
'lens': minor
---

Classify venues as primary markets or aggregators and report net and gross volume separately (#244). `/volumes/:asset` now returns `totals.net` (summed across primary venues) alongside `totals.gross` (everything observed), so an aggregator re-reporting a trade that already settled on a primary market no longer inflates the headline figure. Aquarius and DeFindex are aggregators; SDEX, the native AMM, Soroswap and Phoenix are primary. The reasoning for each is documented in `docs/venues.md`, and a test fails the build if the adapter and the documented classification ever disagree.
