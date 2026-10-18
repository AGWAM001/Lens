# Dual-Network (mainnet + testnet) — Foundation

Goal: run Lens on **mainnet and testnet at the same time**, keeping testnet as
the safe demo/QA surface while mainnet serves real price data.

## Architecture options

1. **Two deployments (recommended, no refactor).** Same image, one env set +
   one database/Redis per network.
2. **In-process dual-network.** One process ingests both networks — requires the
   issues below (per-network config, network-aware storage, per-network clients
   and ingesters, a network selector on the API).

Storage is network-segregated: every model carries a `network` discriminator and
every write is tagged with the network it came from (#114), so the same
`pairKey` (e.g. `XLM/USDC`) on two networks is stored as distinct rows instead
of colliding. Redis cache keys carry a per-network prefix too.

> Resolved: each network now has its own fully-resolved config block
> (`config.networks.testnet` / `.mainnet`, #113) with matching defaults, so
> Horizon/RPC, the Soroswap factory, the Reflector oracle and Aquarius no longer
> disagree about which network they point at.

## Env matrix

| Var | testnet | mainnet |
|-----|---------|---------|
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` |
| `RPC_URL` | `https://soroban-testnet.stellar.org` | external provider (**secret — host env only**) |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| `SOROSWAP_FACTORY_ADDRESS` | `CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY` | `CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2` |
| `REFLECTOR_CONTRACT_ID` | — (disabled) | — (disabled) — paste an id from [reflector.network](https://reflector.network) to enable |
| `WATCHED_PAIRS` | testnet USDC issuer | mainnet USDC issuer |
| `DATABASE_URL` / `REDIS_URL` | testnet | **separate** mainnet instances |

## Ordered work

Every item below is implemented and merged. The issues for #114–#120 are
closed; #113 is still open as a tracking item only — its code shipped
(`config.networks.testnet` / `.mainnet`, `src/config.ts`). The table is kept as
a reference for the dependency order.

Dependencies: **#113 → #115 → #116 → #117**; #114 before the network selector.

| # | Issue | Dep | Status |
|---|-------|-----|--------|
| [#113](../../issues/113) | `config.ts` → per-network config map | — | ✅ Code merged (issue still open) |
| [#114](../../issues/114) | `network` discriminator on all models + Redis prefix | — | ✅ Done |
| [#115](../../issues/115) | Per-network Horizon/RPC clients across ingesters | #113 | ✅ Done |
| [#116](../../issues/116) | Per-network Soroswap/Reflector/Aquarius/token-list | #113 | ✅ Done |
| [#117](../../issues/117) | Launch ingesters per network | #113–#116 | ✅ Done |
| [#118](../../issues/118) | Network selector on routes + per-request x402 | #114 | ✅ Done |
| [#119](../../issues/119) | Nightly `pg_dump` backup + [restore runbook](backup-restore.md) | — | ✅ Done |
| [#120](../../issues/120) | Mainnet deploy guide | the rest | ✅ Done |

## Ops (Render + UptimeRobot + external Postgres)

- **Compute:** Render free web service kept awake by UptimeRobot pinging
  `/status` every 5 min. Note the **750 instance-hours/month** free cap — run
  mainnet always-on, testnet on-demand / a second account / a paid instance.
- **Database:** use Neon or another managed Postgres. **Do not** use Render's
  free Postgres — it is **deleted after 90 days**. One DB per network.
- **Durability fallback:** nightly `pg_dump` (#119) for fast restore; see
  [backup-restore.md](backup-restore.md). Lens is an aggregator, so the DB is
  also re-derivable by re-ingesting from chain.
