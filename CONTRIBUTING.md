# Contributing to Lens

Lens is a unified Stellar price oracle aggregating SDEX and AMM prices, gated behind x402 micropayments. Contributions welcome — docs, tests, new endpoints, ingestion improvements.

## Ways to contribute

- **Good first issues** — [`good first issue`](https://github.com/Divinity-Labs/Lens/labels/good%20first%20issue)
- **Bug reports** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Tests** — see [`area:tests`](https://github.com/Divinity-Labs/Lens/labels/area%3Atests)

## Repository layout

```
lens/
├── src/
│   ├── index.ts            # Fastify entry point
│   ├── config.ts           # Per-network config (STELLAR_NETWORK + overrides)
│   ├── db.ts               # Postgres pool / Prisma client
│   ├── api/                # REST + GraphQL route implementations
│   ├── routes/             # Additional REST route modules
│   ├── ingest/             # Venue/oracle adapters + ingester loops (SDEX, Horizon AMM, Soroswap, Aquarius, Reflector)
│   ├── publish/            # SEP-40 publisher: encoding, publication policy, on-chain feed
│   ├── aggregator/         # VWAP + best-route calculation
│   ├── pricing/            # TWAP, depth and aggregate helpers
│   ├── middleware/         # Network selector, x402, auth, metrics
│   └── x402/               # x402 facilitator client + metering
├── oracle/
│   └── contract/           # Soroban SEP-40 price feed contract (Rust, `cargo test --lib`)
├── prisma/
│   └── schema.prisma       # Network-discriminated data models
├── tests/                  # Integration, load and property suites
└── docs/                   # Architecture, ops and design docs
```

## Development setup

### Prerequisites
- **Node.js 22** (matches the `Dockerfile` and every workflow)
- **PostgreSQL** (local or Supabase — needed to run the server, not to run the tests)
- **Redis** (optional — for BullMQ workers)
- A Stellar testnet account for x402 payments (if testing paid endpoints)

### Clone and install

```bash
git clone https://github.com/Divinity-Labs/Lens.git
cd Lens
npm ci
cp .env.example .env   # fill in DATABASE_URL, REDIS_URL, WATCHED_PAIRS
npm run db:migrate     # apply committed migrations (prisma migrate dev) — do NOT `db push`
npm run dev
```

API runs on `http://localhost:3002`.

### Seed data

A fresh database is empty, so every price endpoint returns zeros and you
cannot tell working code from broken code. Seed it with deterministic
fixture data (requires `DATABASE_URL`):

```bash
npm run seed                       # seed both networks
npm run seed -- --network testnet  # seed testnet only
```

Seeding is idempotent — re-running it converges to the same rows.

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

The suite is ~160 test files / ~1,950 tests covering route handlers, price math
(including property-based tests with [fast-check](https://fast-check.dev)),
the x402 flow, per-network config and ingesters, HTTP metrics, and integration
scenarios under `tests/`. Open test work is tracked under
[`area:tests`](https://github.com/Divinity-Labs/Lens/labels/area%3Atests).

The tests need no database: `npm test` runs in the CI build job with no
Postgres or Redis service. The database-backed drift checks live in the
separate `db-migrations` job (`.github/workflows/ci.yml`).

## Generated files

Five files are generated and compared byte for byte in CI. Never hand-edit
one — change its source and regenerate it, then commit the result.

| File | Regenerate with | Guard |
| --- | --- | --- |
| `openapi.json` | `npm run openapi:gen` | `tests/openapi.test.ts` |
| `README.md` (venue and endpoint tables) | `npm run readme:gen` | `tests/readme.test.ts`, `npm run readme:check` in CI |
| `schema.graphql` | `npm run graphql:schema:gen` | `src/__tests__/graphqlSchemaDrift.test.ts` |
| `clients/typescript/src/schema.d.ts` | `npm run client:gen` | CI build job fails if the client differs after regenerating; `npm run client:typecheck` |
| `prisma/migrations/0_init/migration.sql` | `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql` | `tests/prisma-migrations.test.ts`, CI `db-migrations` job |

Notes:

- `openapi.yaml` is the hand-edited source for `openapi.json`:
  `tests/openapi.test.ts` also checks it against the registered routes.
  `npm run openapi:gen` regenerates `openapi.json` and refreshes the
  README tables as well.
- The README tables live between the `<!-- VENUES:START -->` /
  `<!-- VENUES:END -->` and `<!-- ENDPOINTS:START -->` /
  `<!-- ENDPOINTS:END -->` markers. Edit the registry or `openapi.yaml`,
  not the tables.
- A change to `prisma/schema.prisma` needs a new migration
  (`npm run db:migrate`) and a regenerated baseline — see
  `docs/database-migrations.md`. Never use `prisma db push`.

## If CI fails

- **A guard fails but the diff looks identical: line endings.** The guards
  compare bytes, and the generators always emit LF. If your editor or git
  config wrote CRLF, the file differs on every line while looking unchanged.
  `.gitattributes` pins the generated files to LF — convert the file back to
  LF, regenerate it, and commit the result. Do not hand-edit the generated
  file to match.
- **Dropped tests.** `.github/workflows/dropped-tests.yml` fails a PR that
  deletes test cases present on the base branch. It does not run the tests
  and does not judge whether a removal is correct — removing a test is
  sometimes exactly right. If the removal is intentional, say so in the PR
  and apply the `tests-removed-intentionally` label to pass.
- **Nothing ran after install.** CI installs dependencies first
  (`npm ci`); if that step fails, no later step runs, so a red run with no
  test output means look at the install step first — usually
  `package.json` and `package-lock.json` are out of sync.
- **A generated file is out of date.** Regenerate it with the command in
  the table above and commit the result; do not edit the generated file
  by hand.

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

Open an [issue](https://github.com/Divinity-Labs/Lens/issues) or start a [discussion](https://github.com/Divinity-Labs/Lens/discussions).
