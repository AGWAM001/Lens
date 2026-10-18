---
'lens': patch
---

Route all logging through pino (`src/logger.ts`) instead of `console.*`. Every
module now logs through a component-scoped child logger — `ingester:sdex`,
`job:aggregate-refresh`, `ws:fanout`, `redis`, `config`, `webhook`,
`route:price`, … — emitted as a structured `component` field rather than a
message prefix, so operators can filter by component without regexing text.
Fastify's request logger is built from the same options, so `req.log` carries
the same redaction and formatting.

The level is configurable via `LOG_LEVEL` (default `info`, documented in
`.env.example`): logs are newline-delimited JSON when `NODE_ENV=production` and
pretty-printed for humans otherwise. Values of secret-looking environment
variables (`DATABASE_URL`, `DIRECT_DATABASE_URL`, `REDIS_URL`, and any name
containing `KEY`/`SECRET`/`TOKEN`/`PASSWORD`) are scrubbed from every
serialized line, including the password inside a connection string and driver
error messages that echo it, while request auth headers are redacted via
pino's `redact`. A test asserts no `console.*` survives in non-test source and
that a connection string or API key value never reaches the output.
