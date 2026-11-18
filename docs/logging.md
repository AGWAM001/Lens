# Logging

Every module logs through the shared pino logger in `src/logger.ts`. Use a
component-scoped child, created once at import time:

```ts
const log = createLogger('ingester:amm')
log.error({ venue: 'AMM', pair: pair.pairKey, err }, 'failed to fetch pools')
```

Do not call `console.*` or write hand-rolled JSON. Level is set by `LOG_LEVEL`
(default `info`), and records are NDJSON in production.

## Venue ingestion failures

When a venue cycle fails, the runner logs at `error` on the
`ingester:<venue>` component with these fields:

| Field        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `venue`      | Adapter name, for example `SDEX` or `AMM`            |
| `network`    | `testnet` or `mainnet`                               |
| `pair`       | Pair key being ingested when the cycle failed        |
| `attempt`    | Consecutive failures for this venue, starting at 1   |
| `retryMs`    | Backoff before the next attempt                      |
| `durationMs` | Time spent in the failed cycle                       |
| `err`        | The error, serialized by pino with its stack         |

With Loki, count failures for one pair over the last hour with:

```logql
sum(count_over_time({app="lens"} | json | level="error" | pair="XLM/USDC" [1h]))
```

Background ingestion cycles have no request ID, so the `requestId` field is
omitted rather than invented.
