---
'lens': minor
---

Lens publishes prices. A SEP-40 (`oracle/contract/`) oracle contract plus a
rate-limited, deviation-triggered publisher (`src/publish/`) put Lens's own
aggregate on chain so Soroban contracts can read a Lens price, with the same
staleness and venue-provenance guarantees the HTTP API makes.

The contract implements the spec's `PriceFeedTrait` verbatim — `base`, `assets`,
`decimals`, `resolution`, `price`, `prices`, `lastprice` — returning `None`
rather than reverting on input it cannot answer, and adds one provider-side
write: `report(asset, price, timestamp, venues)`, authorized solely by the
publisher address the admin sets. It re-checks every rule a consumer is told to
rely on: the price is positive, the timestamp is trimmed to `resolution()`, is
not ahead of ledger time, and is strictly newer than the last record, and the
venue list is non-empty — `source_count` is derived from that list, never passed
in. `last_report` exposes the venues, the ledger and the close time behind the
current price. `initialize` is one-shot and `upgrade` swaps the WASM without
changing the contract address, as SEP-40 requires.

The publisher is a loop like the venue ingesters: one per entry in
`ENABLED_NETWORKS`, each fault-isolated by `restartIngester`, each reading only
its own network's pairs and rows. Which leg of a pair it quotes and whether the
stored `price = assetB per assetA` has to be inverted are derived from the
`base()` the *deployed contract* reports — the scale and tick come from the
chain too, and the cycle aborts if they cannot be read, because there is no safe
default for a number a contract settles against. Publication then runs as
guards → triggers → write vetoes: staleness and provenance are checked before
the feed is read at all, so a stale aggregate provably never reaches RPC or
spends a fee; a write needs either a `SEP40_DEVIATION_PCT` move measured against
the price already on chain or a `SEP40_MAX_INTERVAL_MS` timer, and even then
`SEP40_MIN_WRITE_INTERVAL_MS` caps it at one transaction per asset per interval.
`SEP40_MAX_AGE_SECONDS` defaults to 120, stricter than the API's 300 s stale
flag on purpose.

Every write — and every failed write — lands in a new `oracle_publications`
table with the venues behind it, the scaled value, the trigger, the deviation and
the tx hash. Blocked decisions are logged, not stored: a 30-second poll across
two networks would otherwise be a table of "nothing happened".

Off by default on every network (`SEP40_ENABLED_*=false`), needs a deployed
contract id and a funded publisher key, and refuses to start half-configured. No
secret key is committed anywhere, and the docs deliberately contain no feed
contract id. No REST or GraphQL route is added.
