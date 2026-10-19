# SEP-40 oracle contract

Lens's on-chain price feed. Implements the SEP-40 `PriceFeedTrait` read surface
(`base`, `assets`, `decimals`, `resolution`, `price`, `prices`, `lastprice`) plus
one provider-side write, `report`, which the Lens publisher in `src/publish/` is
the only caller of.

```bash
cargo test --lib                                  # 20 tests, no network needed
cargo build --release --target wasm32v1-none      # target/wasm32v1-none/release/lens_sep40_oracle.wasm
```

Deploying, initializing, the publication policy and the key-handling rules are in
[`../../docs/sep40-oracle-publisher.md`](../../docs/sep40-oracle-publisher.md).

There is no published contract id for this crate: the feed exists once an
operator deploys it, and the id they get is the one that goes in
`SEP40_CONTRACT_ID_TESTNET` / `SEP40_CONTRACT_ID_MAINNET`.
