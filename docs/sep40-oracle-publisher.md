# SEP-40 oracle publisher

Lens has always been an oracle **consumer**: it reads Reflector's prices and
compares them with its own. Issue #222 is the other direction — Lens as an
oracle **publisher**, exposing a [SEP-40](https://github.com/StellarCommunity/seps/blob/main/SEP-0040.md)
compatible price feed that any Soroban contract can read.

Two pieces make up the feature:

| Piece | Where | What it does |
| --- | --- | --- |
| The feed | `oracle/contract/` | A Soroban contract implementing SEP-40's `PriceFeedTrait`, plus one provider-side write (`report`). |
| The publisher | `src/publish/` | The process that decides **when** a Lens aggregate is worth a transaction, and writes it. Runs once per enabled network, next to the ingest loops. |

SEP-40 standardises the *read* side only ("the exact mechanism of data reporting
mechanism utilized by an oracle is out of scope of this SEP"), so `report` is
Lens's own design and every other entry point is exactly the shape the spec
defines.

---

## 1. The contract

`oracle/contract/src/lib.rs` — package `lens_sep40_oracle`.

### 1.1 The SEP-40 read surface

Declared names and signatures are the spec's, not adaptations:

| Entry point | Signature | Lens's behaviour |
| --- | --- | --- |
| `base` | `() -> Asset` | The asset every price in the feed is denominated in. Set once at `initialize`. |
| `assets` | `() -> Vec<Asset>` | Every asset that has ever been reported, in first-seen order. |
| `decimals` | `() -> u32` | Scale of `PriceData.price`. Immutable. |
| `resolution` | `() -> u32` | Tick period in seconds that timestamps are trimmed to. Immutable. |
| `price` | `(Asset, u64) -> Option<PriceData>` | The newest record **at or before** the requested timestamp. |
| `prices` | `(Asset, u32) -> Option<Vec<PriceData>>` | The last *n* records, newest first. |
| `lastprice` | `(Asset) -> Option<PriceData>` | The current feed value. |
| `last_report` | `(Asset) -> Option<Report>` | Lens-specific: provenance of the last write (see 1.4). |

A deviation-triggered feed is deliberately non-uniform — there is no record at
every tick — so `price(asset, timestamp)` answers with the value that was **in
effect** at that time rather than looking for an exact match. That is the
extrapolation SEP-40 asks an oracle to present, and it is why the feed can be
consumed by contracts that assume a tick per resolution.

### 1.2 Price encoding

`PriceData.price` is an `i128` scaled by `decimals()`:

```
real_price = PriceData.price / 10^decimals()
```

`PriceData.timestamp` is unix **seconds**, and the contract enforces SEP-40's
trimming rule on every write:

```
timestamp == floor(unix_now() / resolution()) * resolution()
```

A write whose timestamp is not a whole number of ticks is rejected
(`TimestampNotAligned`), so a consumer can treat trimming as a guarantee instead
of a convention. Lens trims on the way out (`trimTimestamp` in
`src/publish/sep40.ts`) and the contract re-checks.

Scaling is done through a decimal **string**, not a float multiply, because
`0.29 * 1e14` is `28999999999999.996` — `BigInt()` of that throws and
`Math.round()` of that puts `28999999999999` on chain. One decimal digit off is
a price that is wrong by a factor of ten, so `scalePrice` refuses non-integer
results, exponential notation, non-positive prices and values beyond `i128`.

### 1.3 `None`, not an error

SEP-40: "oracles should delegate error handling logic directly to consumer
contracts". So the read side returns `None` — never a revert — for an asset the
feed has never quoted, a timestamp before the first report, a `records` count of
zero, and an empty history. A consumer that wants to distinguish "no data" from
"bad request" has to ask for `last_report` or call `assets()`; a consumer that
just wants to not settle on missing data checks for `None`.

### 1.4 Provenance, beyond SEP-40

SEP-40's `PriceData` has no room for "where did this come from", and Lens
refuses to publish a number it cannot source. Every `report` therefore carries
the venue names behind it:

```rust
pub struct Report {
    pub price: i128,
    pub timestamp: u64,       // SEP-40 feed timestamp
    pub reported_at: u64,     // ledger close time of the write
    pub reported_ledger: u32, // ledger the write landed in
    pub source_count: u32,    // always venues.len()
    pub venues: Vec<Symbol>,  // 'SDEX', 'AMM', 'aquarius_amm', 'soroswap_amm', …
}
```

`source_count` is **derived** from the venue list rather than passed in, so the
contract cannot store a price claiming more sources than it can name. An empty
venue list is rejected (`NoVenues`), as is a list longer than `MAX_VENUES` (16).
Venues are never blended: the aggregate `price` is a route-aware best quote and
the list says which markets produced it, exactly as `/price/:a/:b` reports
`bestRoute` and `sources`.

`reported_at` and `reported_ledger` are what let a consumer apply the same
staleness bar the HTTP API does: `lastprice.timestamp` says when the *market*
tick happened, `last_report.reported_at` says when the feed *learned* it.

### 1.5 Errors

| Code | Name | Raised when |
| --- | --- | --- |
| 1 | `AlreadyInitialized` | `initialize` is called a second time. |
| 2 | `NonPositivePrice` | `price <= 0`. |
| 3 | `TimestampNotAligned` | `timestamp % resolution != 0`. |
| 4 | `NotNewer` | `timestamp` is not strictly newer than the asset's last record. |
| 5 | `TimestampInFuture` | `timestamp > env.ledger().timestamp()`. |
| 6 | `NoVenues` | Empty venue list. |
| 7 | `TooManyVenues` | More than `MAX_VENUES` names. |
| 8 | `InvalidConfig` | `decimals == 0` or `resolution == 0` at `initialize`. |

`NotNewer` and `TimestampInFuture` are what make a retried publish harmless: a
replay of a tick that already landed is refused, and a publisher with a clock
ahead of the ledger cannot hand consumers a price that never ages.

### 1.6 Admin surface

- `initialize(admin, base, decimals, resolution)` — one-shot, admin-authenticated.
- `set_publisher(publisher)` — admin-authenticated; points `report` at the hot key.
- `upgrade(new_wasm_hash)` — admin-authenticated; swaps the WASM **without
  changing the contract address**, which SEP-40 requires ("smart contract
  consumers should only be expected to change their price feed aggregator address
  if they would like to change oracle providers").

`report` authorizes exactly one address: the publisher when one is set, the
admin otherwise. Tests assert both halves of that — that a write carrying no
publisher authorization does not land, and that the address the feed demands is
the publisher and not the transaction's signer.

### 1.7 Storage

Per asset: `Last` (one `PriceData`), `LastReport` (one `Report`) and `History`
(newest-first, trimmed to `MAX_HISTORY = 64` records). The asset registry is one
instance entry. Persistent entries extend their TTL on read and write
(`TTL_THRESHOLD = 5_000`, `TTL_BUMP = 40_000` ledgers), and instance storage is
extended at `initialize`, so an idle feed does not expire out from under its
consumers.

---

## 2. How a Lens pair becomes a feed value

Lens stores a pair as **`price` = units of assetB per assetA**. SEP-40 quotes
every asset against one **base**. `orientAgainstBase` in
`src/publish/publisher.ts` reconciles the two from the base the *deployed
contract* reports — never from an env var, because a mis-declared scale produces
a price that is wrong by orders of magnitude and still reads fine:

| Feed `base` | Quoted asset | Price published |
| --- | --- | --- |
| equals `assetB` | `assetA` | the stored number, as-is |
| equals `assetA` | `assetB` | `1 / stored` (inverted) |
| neither | — | pair skipped, reason recorded |

Worked example, the default pair in `.env.example`: `XLM:native / USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
stores `price = USDC per XLM`. With `base = Other("USDC")`, `decimals = 14`, the
feed quotes `Asset::Other("XLM")` directly — `0.025` becomes `250000000000000`.
The same feed pointed at `base = Other("XLM")` would quote the USDC leg and
publish `1 / 0.025 = 40` as `400000000000000000000`.

A pair whose legs are neither of them is **not** published. Putting a ratio under
the wrong asset label is worse than an empty feed, so the cycle records the
reason (`base_not_in_pair`) and moves on.

Asset identity follows SEP-40: an anchored asset is identified by the address of
its **Stellar Asset Contract**, derived with
`new Asset(code, issuer).contractId(passphrase)` — issuer-qualified by
construction, so two tokens called USDC are two different assets. Native XLM has
no asset contract and uses the spec's `Other(Symbol)` form. Contract addresses
are derived from the issuer in `WATCHED_PAIRS_*`, never typed by hand. As one
reference point, mainnet USDC (`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`)
derives to `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`; the test
suite asserts that derivation so a typo in the issuer cannot pass silently.
**This document deliberately contains no Lens feed contract id** — it is created
when the operator deploys `oracle/contract/` (§4), and a placeholder in the docs
is how five deployments end up pointing at five different guesses.

---

## 3. When Lens writes

The policy is `src/publish/trigger.ts`, a pure function over
(aggregate, what is already on chain, thresholds, clock). It exists because a
tick is not an event: Lens polls every few seconds, and a publisher that wrote
per sample would be a transaction spam bot that also publishes the noise between
trades.

Order matters, and it is what makes the acceptance criteria checkable:

**Guards — evaluated first, before any chain read.**

| Guard | Condition |
| --- | --- |
| `no_venue` | No venue name behind the number. "A price you cannot source is worse than no price." |
| `invalid_price` | Zero, negative or non-finite. |
| `no_observation` | No trade has ever been recorded for this pair **on this network**. |
| `stale_aggregate` | The aggregator's own `stale` flag is set — the same signal `/price` reports, so the feed can never carry a price the API calls stale. |
| `aggregate_too_old` | `lastTradeAgeSeconds > SEP40_MAX_AGE_SECONDS` (default 120). |

`evaluateGuards` runs **before** `lastprice` is read. A stale aggregate needs no
comparison to decide anything — it is simply not publishable — so a blocked tick
provably touches no RPC and spends no fee. That is the "a stale aggregate is
never published" criterion as a code path, not as a promise.

**Triggers — at least one must fire.**

| Trigger | Condition |
| --- | --- |
| `first_report` | The feed holds nothing for this asset. |
| `deviation` | The aggregate is `SEP40_DEVIATION_PCT` (default 0.5%) away from the **on-chain** price. |
| `max_interval` | The on-chain price is older than `SEP40_MAX_INTERVAL_MS` (default 900000 = 15 min), even without moving. |

`deviation` wins when both fire. The reference for deviation is
`lastprice()` from the contract rather than a local variable, so two publisher
instances (a restart racing itself, a canary) agree on what "moved" means.

**Write vetoes — a trigger that fired still may not write.**

| Veto | Condition |
| --- | --- |
| `tick_not_advanced` | The current feed tick is not newer than the last report — the contract would answer `NotNewer`, so Lens does not send a doomed transaction. |
| `min_write_interval` | Fewer than `SEP40_MIN_WRITE_INTERVAL_MS` (default 60000) seconds since the last report. |

Both record `suppressedBy`, so the audit row says which trigger was silenced and
by what — the difference between "the market did not move" and "the market moved
but we are rate-limited".

`max_interval` is what stops a quiet market from leaving consumers reading a
timestamp that only gets older; `min_write_interval` is the actual rate limit —
it caps a fast market at one write per asset per interval, not one per sample.
At the defaults, an hour of 30-second polling moves at least 0.5% every tick:
**60 writes maximum, not 120**. The deviation threshold is measured against the
value already on chain, so a slow drift publishes when it has accumulated, not
on every step.

`SEP40_MAX_AGE_SECONDS` (120) is deliberately stricter than the API's 300-second
stale flag. An HTTP price can be "as good as we have it"; a price a contract
settles against cannot.

---

## 4. Deploying the feed

### 4.1 Build (this part is reproducible here)

```bash
cd oracle/contract
cargo build --release --target wasm32v1-none
cargo test --lib          # 20 tests, no network needed
```

The release profile in `Cargo.toml` is the one Soroban wants: `opt-level = "z"`,
`lto = true`, `panic = "abort"`. Output:
`target/wasm32v1-none/release/lens_sep40_oracle.wasm`.

`Cargo.lock` is committed. It pins `ed25519-dalek` to 2.2.0 on purpose:
`soroban-env-host` 22.1.3 (which `soroban-sdk` 22.0.11 pins exactly) does not
compile against the 3.0.0 release, and the resolution is what makes
`cargo test --lib` work on a fresh clone.

### 4.2 Deploy, initialize, hand over

The `soroban` CLI is not part of this repository's CI, and its flag names and
enum-argument JSON have moved between versions — check `soroban --version` and
`<subcommand> --help` before pasting. The **sequence** is what matters, and each
step is verifiable:

```bash
# 1. Deploy the WASM. The address it prints is your feed's SEP-40 address.
soroban contract deploy --source "$ADMIN_ACCOUNT" --network testnet \
  --wasm target/wasm32v1-none/release/lens_sep40_oracle.wasm

# 2. Configure it once. base/decimals/resolution are immutable afterwards.
soroban contract invoke --id "$FEED" --source "$ADMIN_ACCOUNT" --network testnet -- \
  initialize --admin "$ADMIN_ACCOUNT" --base "<Asset::Other(\"USDC\") in your CLI's enum JSON>" \
  --decimals 14 --resolution 60

# 3. Point report at the hot publisher key (a different account from $ADMIN_ACCOUNT).
soroban contract invoke --id "$FEED" --source "$ADMIN_ACCOUNT" --network testnet -- \
  set_publisher --publisher "$PUBLISHER_ACCOUNT"

# 4. Read the parameters back before letting Lens near it.
soroban contract invoke --id "$FEED" --source "$ADMIN_ACCOUNT" --network testnet -- base
soroban contract invoke --id "$FEED" --network testnet -- decimals
soroban contract invoke --id "$FEED" --network testnet -- resolution
```

Recommended values, matching the contract's test suite and the scaling in
`src/publish/sep40.ts`: `decimals = 14`, `resolution = 60`. Lens reads both from
the contract at runtime and **fails closed** if the reads fail — there is no
fallback scale. `base` should be the asset you want your consumers quoted in,
and it must be one leg of every pair you intend to publish (§2).

Upgrades keep the address:

```bash
soroban contract install --source "$ADMIN_ACCOUNT" --network testnet \
  --wasm target/wasm32v1-none/release/lens_sep40_oracle.wasm      # prints the WASM hash
soroban contract invoke --id "$FEED" --source "$ADMIN_ACCOUNT" --network testnet -- \
  upgrade --new_wasm_hash "$WASM_HASH"
```

### 4.3 Run the publisher

```bash
# .env (never committed)
ENABLED_NETWORKS=testnet
SEP40_ENABLED_TESTNET=true
SEP40_CONTRACT_ID_TESTNET=<the id step 4.2 printed>
SEP40_PUBLISHER_SECRET_KEY_TESTNET=<S... of $PUBLISHER_ACCOUNT>
```

`src/index.ts` starts one publisher per enabled network the same way it starts
venue ingesters — inside `restartIngester`, so a crash restarts that network's
publisher after 10 s and cannot affect the other network or the other adapters.
Startup is quiet and safe by default:

- `SEP40_ENABLED_*=false` (the default) → the loop never starts.
- Enabled but missing the contract id or the key → warning, publication stays off.
- A malformed (`not even a valid C…` id) → `isUsableContractId` warns and
  disables it, as it does for every other contract address in `src/config.ts`.

Pair lists come from `WATCHED_PAIRS_TESTNET` / `WATCHED_PAIRS_MAINNET` for that
network, not from the shared runtime registry, and every aggregate, venue and
`price_points` query in the loop carries `network` in its WHERE clause. A
publisher must not be able to quote testnet trades on a mainnet feed.

No REST or GraphQL route is added: the point of SEP-40 is that a contract reads
the feed on chain, and the existing `/price` already serves the off-chain
consumer.

### 4.4 Audit trail

`oracle_publications` (Prisma model `OraclePublication`) records **writes**, not
every blocked decision — at the default 30-second poll a blocked decision would
be 2 880 rows a day per pair per network (5 760 on both, 17 280 for a three-pair
list) all saying "nothing happened". Columns: `network`, `pairKey`,
`quotedAsset`, `baseAsset`, `state` (`published` | `failed`), `trigger`,
`price`, `scaledPrice` (the `i128` as text), `decimals`, `feedTimestamp`,
`resolution`, `venues` (comma-joined names), `sourceCount`, `deviationPct`,
`reason`, `txHash`, `errorMessage`, `createdAt`.

A failed write is recorded the same way a success is and the loop continues with
the next pair: the number Lens meant to publish, the venues behind it, and why it
did not land is exactly what an operator needs at 3 a.m. A feed Lens cannot
**read** is different — `FeedUnavailableError` aborts the cycle and the loop
backs off (10 s, doubling, capped at 60 s), because "we could not check what is
already on chain" means the deviation and monotonicity promises cannot be kept.

`npm run db:migrate` (`prisma migrate dev`) creates the table; this repo
has no migrations directory.

---

## 5. Key handling

Two accounts, and they are not interchangeable:

| | Admin | Publisher |
| --- | --- | --- |
| Signs | `initialize`, `set_publisher`, `upgrade` | `report` — every publication |
| Lives | Cold: hardware wallet, or an offline signer. Not in any server's env if you can avoid it. | Hot: `SEP40_PUBLISHER_SECRET_KEY_*` on the host running Lens |
| Needs | Enough XLM for the rare admin transaction | XLM for one transaction per publication, per asset |
| Leak damage | Attacker can upgrade the feed — catastrophic | Attacker can publish bad prices until you rotate — bad, recoverable |

- **Funding.** The publisher pays every write's fee, so it needs XLM on the same
  network as the feed. At the defaults the worst case is bounded and
  computable: one write per asset per `SEP40_MIN_WRITE_INTERVAL_MS`, so
  `pairs × (86400 / minWriteIntervalSeconds)` transactions per day — 1 440 per
  asset per day at the 60-second floor, and typically far fewer, because a
  deviation has to occur for a write to be attempted at all.
- **Never committed.** `.env` is gitignored, `.env.example` carries the variable
  names with empty values and comments only, and no secret key appears in source,
  docs, tests, or changesets. The publisher only ever reads the key through
  `Keypair.fromSecret()` inside `src/publish/onchain.ts`; it is not logged, not
  returned, and not written to `oracle_publications`.
- **Rotation.** Fund a new account, `set_publisher` to it (admin signs), update
  `SEP40_PUBLISHER_SECRET_KEY_*`, restart. Until the new key is live the old one
  still authorizes writes; after `set_publisher` the old one does not — the
  contract compares the stored publisher address, it does not trust the
  transaction's signer.
- **Failing closed.** No key → no publication, with a log line saying so. A
  partially configured publisher is worse than an absent one: it either burns
  fees on the wrong feed or silently publishes nothing while looking healthy.
- If you use one Lens process for both networks, use one publisher account per
  network. A leaked testnet key should not be a mainnet problem.

---

## 6. Reading the feed from a contract

A consumer declares the same two types and calls the spec's names — nothing
Lens-specific is required:

```rust
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, IntoVal, Symbol};

#[contracttype]
#[derive(Clone)]
pub enum Asset { Stellar(Address), Other(Symbol) }

#[contracttype]
#[derive(Clone)]
pub struct PriceData { pub price: i128, pub timestamp: u64 }

#[contract]
pub struct Consumer;

#[contractimpl]
impl Consumer {
    /// XLM per USDC, or nothing at all if the feed has no price or the caller's
    /// staleness bar is not met.
    pub fn spot(env: Env, feed: Address, max_age: u64) -> Option<i128> {
        let asset = Asset::Other(symbol_short!("XLM"));
        let data: PriceData = env
            .invoke_contract::<Option<PriceData>>(
                &feed,
                &symbol_short!("lastprice"),
                (asset,).into_val(&env),
            )
            .ok()??;
        if env.ledger().timestamp() - data.timestamp > max_age {
            return None;      // stale: refuse, rather than settle on an old tick
        }
        Some(data.price)      // still scaled by the feed's decimals()
    }
}
```

Check `None`, and check the age, before trusting a number: that is the whole
consumer-side contract, and it is why `decimals`/`resolution` are readable
entry points rather than documentation.

## 7. Reading the feed from JS

```ts
import { contract as StellarContract, Networks, SorobanRpc } from '@stellar/stellar-sdk'

const client = await StellarContract.Client.from({
  contractId: process.env.SEP40_CONTRACT_ID_TESTNET!,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
})

// SEP-40's `Asset` is a `contracttype` enum with tuple variants, which the SDK
// represents natively as { tag, values } — the form `assetToSpecArg` builds.
const tx = await client.lastprice({ asset: { tag: 'Other', values: ['XLM'] } })
if (!tx.result) throw new Error('the feed has no price for XLM yet')       // None
const decimals = Number((await client.decimals()).result)                   // 14
const price = Number(tx.result.price) / 10 ** decimals
const ageSeconds = Math.floor(Date.now() / 1000) - Number(tx.result.timestamp)
```

Awaiting a dynamic `Client` method simulates the call and gives an
`AssembledTransaction`; `.result` is the decoded return value. `None` from the
contract arrives as `null`/`undefined` here, which is the check §6 also demands.

`src/publish/sep40.ts` has the encoders both directions (`assetToScVal`,
`assetFromSpecArg`, `scalePrice`, `unscalePrice`) if you need the XDR form, and
`src/publish/onchain.ts` is the working `Client.from({...})` setup the publisher
itself uses. Note the import path: this repo compiles with `module: commonjs`, so
the `@stellar/stellar-sdk/contract` subpath does not resolve and the `contract`
namespace comes from the package root.

## 8. Tests

```bash
npm test -- src/__tests__/sep40Encoding.test.ts \
            src/__tests__/sep40Trigger.test.ts \
            src/__tests__/sep40Publisher.test.ts
cd oracle/contract && cargo test --lib
```

This repo's tests are **vitest**, not jest. The three suites cover:

- `sep40Encoding` — exact scaling (`0.29` at 14 decimals is the case that float
  maths gets wrong), `i128` bounds, refusals, SAC-address derivation including
  the mainnet USDC assertion and an imposter-issuer check, the `{tag, values}`
  and `Vec[Symbol, value]` wire forms, venue list validation.
- `sep40Trigger` — every guard outranking every trigger (a stale aggregate that
  has also aged out must not publish), both write vetoes with `suppressedBy`,
  and an hour-long simulated poll asserting the write count is rate-limited
  rather than proportional to samples.
- `sep40Publisher` — orientation and inversion, `base_not_in_pair`, provenance
  audit rows, deviation measured against the on-chain value, a stale aggregate
  proving **zero** `lastPrice`/`report` calls, failed writes recorded without
  killing the cycle, and a bad issuer on one pair not silencing another.

## 9. Known limits

- One feed, one base. Pairs that do not contain the base are skipped with a
  reason; quote more bases by deploying another feed.
- Publication is off by default on every network and needs a funded publisher;
  nothing in this feature runs unless an operator opts in.
- `price(asset, timestamp)` answers from the retained 64 records. Older history
  lives in Postgres and behind `/price/:a/:b/history`, not on chain.
- The RPC layer (`ContractSep40Feed`) is not exercised against a deployed feed
  by any test in this PR — there is no Lens feed contract to point at yet. What
  is proven here is the policy around it (`sep40Publisher`), the encoding both
  sides must agree on (`sep40Encoding`, `sep40Trigger`), and the contract itself
  (`cargo test --lib`). Signing up to a real network is the remaining step, and
  it needs a deployment first.
