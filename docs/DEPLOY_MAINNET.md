# Mainnet Deployment Guide (Render + UptimeRobot + Neon + external RPC)

This runbook walks through running a **mainnet** Lens node on Render, kept
awake by UptimeRobot, backed by a managed Postgres (Neon) and an external
Soroban RPC provider.

> **No secrets or keys are committed anywhere in this guide.** Every credential
> below is a placeholder — set the real values in your Render dashboard / host
> environment only.

## Why mainnet is different from testnet

Lens is already closer to mainnet than testnet out of the box: its Soroswap
factory and Aquarius defaults are **mainnet** addresses. The Reflector oracle
has no built-in default — supply `REFLECTOR_CONTRACT_ID_MAINNET` from
[reflector.network](https://reflector.network) to enable it. To point a node at
mainnet you mostly need to flip the network passphrase, Horizon/RPC URLs and
set mainnet `WATCHED_PAIRS`.

Two things have no free mainnet equivalent:

- **Soroban RPC** — there is no free public mainnet Soroban RPC. You must bring
  your own provider (see [RPC provider](#rpc-provider)).
- **Render free Postgres** — it is **deleted after 90 days**. Use Neon or
  another managed Postgres for any durable deployment.

## Architecture

```
UptimeRobot ──GET /status──▶ Render web service (Lens)
                                  │
                                  ├── external Soroban RPC provider (RPC_URL)
                                  ├── Horizon (https://horizon.stellar.org)
                                  └── Neon Postgres (DATABASE_URL)
                                  └── Redis (REDIS_URL)
```

- **Compute:** Render web service (free tier OK for a single node).
- **Keep-alive:** UptimeRobot pings `/status` every 5 minutes so the free web
  service never sleeps.
- **Database:** Neon (or any managed Postgres) — **never** Render free Postgres.
- **Cache/queues:** Redis (managed, e.g. Render Redis or Upstash).

## Env matrix

| Var | testnet | mainnet |
|-----|---------|---------|
| `STELLAR_NETWORK` | `testnet` | `mainnet` |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` |
| `RPC_URL` | `https://soroban-testnet.stellar.org` | external provider — **placeholder only** (see below) |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| `SOROSWAP_FACTORY_ADDRESS` | `CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY` | `CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2` |
| `REFLECTOR_CONTRACT_ID` | *(empty)* | *(required to enable the oracle — copy from reflector.network)* |
| `WATCHED_PAIRS` | testnet USDC issuer | mainnet USDC issuer |
| `DATABASE_URL` | testnet DB | **separate** mainnet DB |
| `REDIS_URL` | testnet Redis | **separate** mainnet Redis |

> Lens resolves each field in this priority order: paired var
> (`HORIZON_URL_MAINNET`) → generic var (`HORIZON_URL`) → built-in default.
> Prefer the paired `_MAINNET` / `_TESTNET` vars so both networks can coexist
> in one env file.

### Mainnet USDC issuer

The mainnet `WATCHED_PAIRS` uses the mainnet USDC issuer:

```
WATCHED_PAIRS_MAINNET=XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
```

## RPC provider

Mainnet has **no free Soroban RPC**. You must provision one from a provider
(e.g. a hosted Soroban RPC service, a self-hosted `soroban-rpc` node, or a
third-party RPC gateway). Set the endpoint in the host environment only:

```
RPC_URL_MAINNET=https://your-provider.example.com/soroban-rpc   # placeholder
```

Never commit a real provider URL or API key to the repo.

## Render keep-alive (UptimeRobot)

Render **free web services sleep** after ~15 minutes of inactivity. Because
Lens is an indexer that must keep ingesting, you need a keep-alive:

1. Deploy the Lens image as a Render **web service**.
2. Create an UptimeRobot monitor that hits `GET /status` every **5 minutes**.
   `/status` is public (no API key required) and returns indexer health.
3. Each ping wakes the service and keeps it running.

> **750 instance-hours/month free cap.** A single always-on free instance uses
> 24 × 31 ≈ 744 hours/month — right at the cap. If you also run a testnet node,
> either run it on-demand, on a second account, or upgrade to a paid instance.
> See [Running testnet + mainnet side-by-side](#running-testnet--mainnet-side-by-side).

## Database durability (Neon / managed Postgres)

**Do not use Render's free Postgres for mainnet** — it is **deleted after
90 days**. Use Neon or another managed Postgres with:

- Automatic backups / point-in-time recovery.
- A dedicated database per network.

Lens is an aggregator, so the DB is also re-derivable by re-ingesting from
chain — but a nightly `pg_dump` makes restores fast. See the
[backup & restore runbook](../../issues/119) (L053) for the nightly `pg_dump`
workflow and restore procedure.

## Running testnet + mainnet side-by-side

Run **two separate deployments** (same image, one env set each). Give each
network its **own** database and Redis: every row now carries a `network`
discriminator (#114), but separate stores keep the two deployments — and any
read path not yet network-scoped — from pooling networks.

| | testnet node | mainnet node |
|---|---|---|
| `STELLAR_NETWORK` | `testnet` | `mainnet` |
| `DATABASE_URL` | `postgresql://…testnet…` | `postgresql://…mainnet…` |
| `REDIS_URL` | `redis://…testnet…` | `redis://…mainnet…` |

See [`docs/DUAL_NETWORK.md`](./DUAL_NETWORK.md) for the full dual-network
architecture.

## Step-by-step

1. **Provision the database.** Create a Neon project (or your managed Postgres)
   and a dedicated database for mainnet. Copy the connection string.
2. **Provision Redis.** Create a managed Redis instance for mainnet.
3. **Provision an RPC provider.** Sign up / self-host a mainnet Soroban RPC
   endpoint.
4. **Deploy on Render.** Create a web service from the Lens repo/image and set
   the mainnet env vars (below) in the Render dashboard — never in a committed
   file.
5. **Set up UptimeRobot.** Add a monitor for `https://<your-app>.onrender.com/status`
   every 5 minutes.
6. **Verify.** `curl https://<your-app>.onrender.com/status` should return
   `"ok": true` with your mainnet watched pairs and a recent `lastIndexedLedger`.

### Mainnet env set (placeholders)

```bash
# --- Active network ---
STELLAR_NETWORK=mainnet

# --- Stellar (mainnet) ---
HORIZON_URL_MAINNET=https://horizon.stellar.org
RPC_URL_MAINNET=https://your-provider.example.com/soroban-rpc   # placeholder
NETWORK_PASSPHRASE_MAINNET=Public Global Stellar Network ; September 2015
SOROSWAP_FACTORY_ADDRESS_MAINNET=CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2
REFLECTOR_CONTRACT_ID_MAINNET=   # copy from https://reflector.network; empty disables the oracle
WATCHED_PAIRS_MAINNET=XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# --- Storage (separate from testnet) ---
DATABASE_URL=postgresql://user:password@your-neon-host/mainnet   # placeholder
REDIS_URL=redis://user:password@your-redis-host:6379             # placeholder

# --- Auth (set real secrets in the host env only) ---
ADMIN_API_KEY=change-me
ADMIN_TOKEN=change-me
```

## Related docs

- [`docs/DUAL_NETWORK.md`](./DUAL_NETWORK.md) — dual-network architecture
- [`docs/architecture.md`](./architecture.md) — system overview
- [Backup & restore runbook](../../issues/119) — nightly `pg_dump` workflow (L053)
