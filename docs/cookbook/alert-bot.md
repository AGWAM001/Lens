# Recipe: Price Alert Bot

> Build a bot that notifies you the moment **XLM crosses a price you care
> about** — e.g. *"tell me when XLM goes above $0.15"*.

This recipe wires the Lens real-time WebSocket price stream into a tiny
notifier. When the price crosses your threshold, the bot logs an alert and
(optionally) POSTs a signed payload to any HTTPS endpoint — Slack, Discord,
or your own service.

A complete, runnable version of this recipe lives in
[`examples/alert-bot`](../../examples/alert-bot). Everything below explains
how it works so you can adapt it.

## How it works

```
Lens indexer ──price:update──▶ /ws stream ──▶ alert bot ──crosses?──▶ notify
```

1. Lens ingests SDEX + AMM trades and emits a `price:update` whenever a
   watched pair moves.
2. The `/ws` endpoint fans those updates out to connected clients as
   `price_update` messages, with backpressure-aware coalescing.
3. The bot keeps the last price per pair and checks whether the move
   **crossed** your threshold (not merely that it sits past it). Crossing
   detection is the same `crossesThreshold` helper Lens uses internally, so
   the bot and server agree on what "above" and "below" mean.
4. On a crossing, the bot notifies you and — if `ALERT_BOT_NOTIFY_URL` is
   set — delivers an HMAC-signed JSON payload with retries.

> **Crossing vs. level:** the bot fires on the *transition* (`0.14 → 0.16`
> crosses `0.15`), not on every tick above the line. That avoids alert
> spam while the price hovers past your threshold.

## The `price_update` message

Each frame from `/ws` looks like:

```json
{
  "type": "price_update",
  "assetA": "XLM",
  "assetB": "USDC",
  "previousPrice": 0.1487,
  "currentPrice": 0.1502,
  "timestamp": "2026-06-28T18:46:02.114Z"
}
```

The first frame on connect is a `{ "type": "status" }` message; if the
stream is x402-gated and you didn't pay, you'll get
`{ "type": "error", "status": 402, "requirements": { ... } }` instead (see
[Paying for the stream](#paying-for-the-stream)).

## Worked example

The bot below is the heart of [`examples/alert-bot/alert-bot.ts`](../../examples/alert-bot/alert-bot.ts).

```typescript
import WebSocket from 'ws'
import { crossesThreshold } from '../../src/alerts'

const WS_URL = process.env.ALERT_BOT_WS_URL ?? 'ws://localhost:3002/ws'
const config = {
  assetA: 'XLM',
  assetB: 'USDC',
  threshold: 0.15,
  direction: 'above' as const, // "above" | "below"
}

const pair = [config.assetA, config.assetB].sort().join('/')
const ws = new WebSocket(WS_URL)

ws.on('open', () => {
  console.log(`watching ${config.assetA}/${config.assetB} ${config.direction} ${config.threshold}`)
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.type !== 'price_update') return

  // Match the pair regardless of asset order.
  const got = [msg.assetA, msg.assetB].sort().join('/')
  if (got !== pair) return

  if (crossesThreshold(config, msg.previousPrice, msg.currentPrice)) {
    console.log(`ALERT: ${pair} is ${config.direction} ${config.threshold} — now ${msg.currentPrice}`)
    // → POST to Slack/Discord, send a push, page yourself, etc.
  }
})
```

### Run it

```bash
# 1. Start Lens (API + indexer)
docker compose up -d

# 2. Configure the alert and run the bot
ALERT_BOT_THRESHOLD=0.15 ALERT_BOT_DIRECTION=above npm run alert:bot
```

Use `--once` to exit after the first alert (useful in tests/CI):

```bash
npm run alert:bot -- --once
```

Expected output once XLM ticks past `0.15`:

```
[alert-bot] connected to ws://localhost:3002/ws — watching XLM/USDC above 0.15
[alert-bot] ALERT XLM/USDC is above 0.15 — price 0.1502 at 2026-06-28T18:46:02.114Z
```

## Sending the alert somewhere real

Set `ALERT_BOT_NOTIFY_URL` to any HTTPS endpoint and the bot will POST the
alert payload, signed with `X-Lens-Signature: hmac-sha256(secret, body)`:

```bash
ALERT_BOT_THRESHOLD=0.15 \
ALERT_BOT_NOTIFY_URL=https://hooks.slack.com/services/your/webhook \
ALERT_BOT_NOTIFY_SECRET=my-shared-secret \
npm run alert:bot
```

The body matches the Lens threshold-alert shape:

```json
{
  "assetA": "XLM",
  "assetB": "USDC",
  "price": 0.1502,
  "threshold": 0.15,
  "direction": "above",
  "timestamp": "2026-06-28T18:46:02.114Z"
}
```

Verify the signature on your side before trusting the payload:

```typescript
import { createHmac, timingSafeEqual } from 'crypto'

function verify(rawBody: string, header: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  return timingSafeEqual(Buffer.from(expected), Buffer.from(header))
}
```

## Paying for the stream

If the server sets `ORACLE_PAYMENT_ADDRESS`, the `/ws` stream is x402-gated
and the first frame will be a `402` with `requirements`. Sign a payment
with `@x402/stellar`, base64-encode it, and pass it via `ALERT_BOT_PAYMENT`
(sent as the `X-PAYMENT` header on connect). See the
[README payment walkthrough](../../README.md#4-nodejs--automatic-payment-with-x402fetch--x402stellar)
for how to produce that header. On testnet (the default), gating is off and
no payment is needed.

## Server-side alternative: webhooks

If you'd rather not keep a process connected, Lens can do the watching for
you. Register a webhook and Lens POSTs you (with the same HMAC signature)
when the threshold is crossed:

```bash
curl -X POST http://localhost:3002/webhooks \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://example.com/hooks/xlm",
        "assetA": "XLM",
        "assetB": "USDC",
        "threshold": 0.15,
        "direction": "above"
      }'
# → { "id": "...", "secret": "..." }   (store the secret to verify signatures)
```

Delete it with `DELETE /webhooks/:id`. Use the **bot** when you want local
control/custom logic, and **webhooks** when you want Lens to hold the
subscription.

If delivery permanently fails, Lens stores the endpoint host, alert
payload, attempt count, final HTTP status (when available), failure category,
and first/last attempt times. URL credentials, paths, query parameters,
fragments, and the HMAC secret are excluded from the stored endpoint/record. Recent failures are
available to operators at `GET /admin/webhook-delivery-failures` with an
`X-Admin-Token` header; `limit` defaults to 25 and is capped at 100. Records are
retained for 30 days. They are diagnostic only and are not replayed
automatically, since a delayed threshold alert can be stale.

## Live demo

- **Interactive API explorer (GraphiQL):** run Lens locally and open
  <http://localhost:3002/graphiql> to query live prices that drive the
  stream.
- **Published API reference:** <https://miracle656.github.io/lens/openapi.json>
- **Local stream:** `ws://localhost:3002/ws` once `docker compose up -d` is
  running.

## See also

- [`examples/alert-bot`](../../examples/alert-bot) — the full runnable bot
- [Architecture Overview](../architecture.md)
- [`examples/oracle-relay`](../../examples/oracle-relay) — push Lens prices on-chain
