# Contributing to Lens

Lens is a unified Stellar price oracle aggregating SDEX and AMM prices, gated behind x402 micropayments. Contributions welcome — docs, tests, new endpoints, ingestion improvements.

## Ways to contribute

- **Good first issues** — [`good first issue`](https://github.com/Miracle656/Lens/labels/good%20first%20issue)
- **Bug reports** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Tests** — see [`area:tests`](https://github.com/Miracle656/Lens/labels/area%3Atests)

## Repository layout

```
lens/
├── src/
│   ├── index.ts            # Fastify entry point
│   ├── config.ts           # Per-network config (STELLAR_NETWORK + overrides)
│   ├── db.ts               # Postgres pool / Prisma client
│   ├── api/                # REST + GraphQL route implementations
│   ├── routes/             # Additional REST route modules
│   ├── ingesters/          # SDEX + AMM ingester loops
│   ├── ingest/             # Venue/oracle adapters (Horizon AMM, Aquarius, Reflector)
│   ├── aggregator/         # VWAP + best-route calculation
│   ├── pricing/            # TWAP, depth and aggregate helpers
│   ├── middleware/         # Network selector, x402, auth, metrics
│   └── x402/               # x402 facilitator client + metering
├── prisma/
│   └── schema.prisma       # Network-discriminated data models
├── tests/                  # Integration, load and property suites
└── docs/                   # Architecture, ops and design docs
```

## Development setup

### Prerequisites
- **Node.js 20+**
- **PostgreSQL** (local or Supabase)
- **Redis** (optional — for BullMQ workers)
- A Stellar testnet account for x402 payments (if testing paid endpoints)

### Clone and install

```bash
git clone https://github.com/Miracle656/Lens.git
cd Lens
npm install
cp .env.example .env   # fill in DATABASE_URL, REDIS_URL, WATCHED_PAIRS
npx prisma db push
npm run dev
```

API runs on `http://localhost:3002`.

### Environment variables
- `DATABASE_URL` — Postgres connection string (Supabase or local)
- `REDIS_URL` — optional, enables aggregate refresh worker
- `WATCHED_PAIRS` — comma-separated `CODE:ISSUER/CODE:ISSUER` (e.g. `XLM:native/USDC:GBBD...`)
- `STELLAR_NETWORK` — this instance's default network, `testnet` or `mainnet` (default: `testnet`)
- `ENABLED_NETWORKS` — optional, comma-separated networks to ingest (`testnet,mainnet`); falls back to `STELLAR_NETWORK`

Per-network overrides use a `_TESTNET` / `_MAINNET` suffix (e.g. `HORIZON_URL_MAINNET`, `WATCHED_PAIRS_TESTNET`); see `.env.example` for the full list.

## Commit conventions

- `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
- Keep PRs focused

## Before opening a PR

```bash
npx prisma generate
npx tsc --noEmit
npm run build
npm test --if-present
```

## Testing

Tests run under [Vitest](https://vitest.dev):

```bash
npm test                          # full suite (vitest run)
npx vitest run path/to/file.test.ts   # a single file
```

The suite is ~53 files / ~520 tests covering route handlers, price math
(including property-based tests with [fast-check](https://fast-check.dev)),
the x402 flow, per-network config and ingesters, HTTP metrics, and integration
scenarios under `tests/`. Open test work is tracked under
[`area:tests`](https://github.com/Miracle656/Lens/labels/area%3Atests).

## Releases

Lens uses [changesets](https://github.com/changesets/changesets) for versioning and changelog generation.

### Adding a changeset

When you make a change that should appear in the changelog (a feature, fix, or any user-facing change), add a changeset in the same PR:

```bash
npx changeset
```

Pick the bump type (`patch` / `minor` / `major`) and write a short summary. This creates a markdown file under `.changeset/` — commit it alongside your change.

### How a release happens

1. When PRs with changesets are merged into `main`, the release workflow (`.github/workflows/release.yml`) opens (or updates) a **"Version Packages"** PR.
2. That PR consumes the pending changeset files, bumps the version in `package.json`, and updates `CHANGELOG.md`.
3. Merging the Version Packages PR bumps the version and creates a matching git tag and GitHub release.

Lens is not published to a registry, so there is no publish step — releases are tag-only (`changeset tag`).

## Questions

Open an [issue](https://github.com/Miracle656/Lens/issues) or start a [discussion](https://github.com/Miracle656/Lens/discussions).
