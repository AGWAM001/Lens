# Venue fixtures

Recorded venue responses for adapter tests (#226). Each file is a real response captured from the venue, never typed by hand, and records where and when it was captured.

Tests never reach the network. `vitest.setup.ts` installs `tests/support/networkGuard.ts`, which fails any test that opens a non-loopback socket, even when the adapter catches the error. Run adapters against these files instead.

## File format

`tests/fixtures/venues/<venue>/<name>.json`:

| field | meaning |
|---|---|
| `venue` | directory name, e.g. `soroswap` |
| `network` | network the response was read from; a mainnet recording never answers a testnet run |
| `capturedAt` | ISO time of the capture |
| `sourceUrl` | the venue endpoint the adapter read |
| `description` | what the capture contains |
| `exchanges[]` | every request the adapter made (`key`, `request`) and the response the venue sent (`response.status`, `response.body`) |

Request headers are never written, so no key or token can end up in a fixture.

## Using a fixture in a test

```ts
import { loadVenueFixture, runAdapterAgainstFixtures, withVenueFixtures } from '../support/venueFixtures'

// Whole adapter pipeline: discover -> read -> derive, no writes.
const run = await runAdapterAgainstFixtures(phoenixAdapter, {
  pair,
  network: 'mainnet',
  fixtures: loadVenueFixture('phoenix', 'xlm-usdc-mainnet'),
})

// Or any function that does I/O.
const pools = await withVenueFixtures(loadVenueFixture('amm', 'xlm-usdc-mainnet'), () => fetchPools(pair, 'mainnet'))
```

A request that no fixture recorded throws `UnrecordedRequestError` and fails the test. A derived point with no `source` fails the run.

See `tests/venueAdapterFixtures.test.ts` for every recorded venue.

## Capturing or refreshing

```sh
npm run fixtures:capture                    # every venue
npm run fixtures:capture -- soroswap amm    # just these
```

The script runs each adapter's own read path against the live venue, records what it asked for and what came back, and writes the file. Every contract id, issuer and URL comes from `src/config.ts` or the venue's own published lists. If an adapter changes what it requests, its test fails with an unrecorded-request error; re-capture to fix it.

## Coverage

| venue | fixture | network |
|---|---|---|
| amm (Horizon liquidity pools) | `amm/xlm-usdc-mainnet.json` | mainnet |
| sdex (Horizon trades) | `sdex/xlm-usdc-mainnet.json` | mainnet |
| soroswap | `soroswap/xlm-usdc-mainnet.json` | mainnet |
| phoenix | `phoenix/xlm-usdc-mainnet.json` | mainnet |
| defindex | `defindex/vaults-mainnet.json` | mainnet |
| blend | `blend/pools-mainnet.json` | mainnet |
| gateio | `gateio/xlm-usdt.json` | mainnet |
| aquarius | **not recorded** | the configured API host `amm.aquarius.network` does not resolve (public DNS returns SERVFAIL) |
| kucoin | **not recorded** | `api.kucoin.com` reset the TLS connection from the capture environment |

Neither missing recording was replaced with a made-up response. Run `npm run fixtures:capture -- kucoin` from a network that can reach KuCoin. For Aquarius, first confirm the current API host from Aquarius's own documentation.
