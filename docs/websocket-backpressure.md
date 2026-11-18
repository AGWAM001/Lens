# WebSocket backpressure

Lens streams live prices over `/ws`. One property of that stream decides how the
server has to behave: **`send()` does not block and does not throw when a peer
is slow.** It queues. A client on a bad mobile connection, or one whose process
has been suspended and whose TCP window has filled, accumulates payloads in its
socket's internal buffer. Nothing inspected `bufferedAmount`, so that buffer had
no upper bound, and the message was counted as sent the moment it was queued.

With a price feed pushing updates continuously, one stuck subscriber was enough
to grow the process until it was OOM-killed — taking every other subscriber, and
every HTTP client, with it.

The fix is a policy over the socket's `bufferedAmount`, applied per client. It
lives in [`src/ws/fanout.ts`](../src/ws/fanout.ts) (`FanOutManager.deliver`);
the limits and their defaults are in
[`src/ws/backpressure.ts`](../src/ws/backpressure.ts).

## The policy

Checked per client, per update, in this order:

| Tier | Condition | Action |
|---|---|---|
| 1. Evict (dead peer) | `bufferedAmount >= WS_MAX_BUFFERED_BYTES` | Close with **1013**, unregister, count `ws_clients_dropped_total`. |
| 2. Evict (stuck peer) | congested continuously for `WS_MAX_CONGESTED_MS` | Close with **1013**, unregister, count `ws_clients_dropped_total`. |
| 3. Coalesce | `bufferedAmount >= WS_SLOW_CLIENT_BUFFER_BYTES`, or inside the coalescing window | Keep only the newest update; count every superseded one in `ws_messages_dropped_total`. |
| 4. Send | otherwise | Send, and count `ws_messages_sent_total` when the socket reports the write completed. |

**Why 1013.** RFC 6455 §7.4.1 reserves 1013 for "Try Again Later": the server is
refusing to keep serving this client right now. The condition here is the
client's rather than the server's, but the meaning to a client is the one it
already handles for a throttled feed — back off and reconnect, do not treat the
close as fatal. The close reason is one of `buffer limit exceeded` or
`congested too long`, kept short because RFC 6455 caps a close reason at 123
bytes.

**Why coalescing is the primary tier.** For a price feed, an intermediate tick
that arrives late is worthless: the newest tick has already superseded it, so
truncating the backlog costs the client nothing it could still use — and costs
the server one payload per client instead of one per tick. Tier 3 also covers
the ordinary coalescing window (`WS_COALESCE_INTERVAL_MS`, 10 updates/sec by
default), which existed before and is the same behaviour for the same reason.

**Why evict at all.** Coalescing bounds the memory a slow client costs. It does
not bound the *time*: a client that has stopped reading entirely would sit
there forever, holding a slot, its buffered bytes and a `ws_clients_total`
series, with no metric saying why. Tier 1 catches a peer wedged past the hard
limit; tier 2 catches one wedged below it.

**Why the soft limit is clamped.** `WS_SLOW_CLIENT_BUFFER_BYTES` is forced below
`WS_MAX_BUFFERED_BYTES` (at half of it). Set at or above, every client past the
soft limit would be disconnected on its first update over it and tier 3 — the
one that keeps a merely-slow client connected — would never run.

## Defaults

| Variable | Default | Meaning |
|---|---|---|
| `WS_COALESCE_INTERVAL_MS` | `100` | Max updates per second per client. `0` disables the window. |
| `WS_SLOW_CLIENT_BUFFER_BYTES` | `262144` (256 KiB) | Queued bytes above which updates are coalesced. Over a thousand ticks of backlog. |
| `WS_MAX_BUFFERED_BYTES` | `1048576` (1 MiB) | Queued bytes above which the client is closed. |
| `WS_MAX_CONGESTED_MS` | `30000` | How long a client may stay congested. `0` keeps them indefinitely. |
| `WS_BUFFER_SWEEP_INTERVAL_MS` | `5000` | How often `ws_buffered_bytes` is refreshed. |

## Counting, honestly

- `ws_messages_sent_total` increments **when the socket reports the write
  completed**, not when `send()` was called. `send()` returns once the payload is
  queued, so counting there reported messages as delivered when they were only in
  a buffer — including for a client that had stopped reading and would never see
  them.
- `ws_messages_dropped_total` counts updates discarded because a newer one
  superseded them, plus the retained update dropped when a client is evicted.
- `ws_clients_dropped_total` counts evicted clients.
- `ws_buffered_bytes` is the aggregate of every client's queued bytes, sampled on
  a timer. Aggregate only: one series per client would be unbounded cardinality
  driven by caller-supplied subscription strings.

All four keep the existing bounded `pair` label: pair-specific subscriptions are
recorded as `other`, `*` is the aggregate. See
[`http-metrics.md`](http-metrics.md).

## Queries

```promql
# Clients evicted for backpressure, per second
sum(rate(ws_clients_dropped_total[5m]))

# Updates coalesced away, as a fraction of everything we tried to send
sum(rate(ws_messages_dropped_total[5m]))
  / sum(rate(ws_messages_sent_total[5m])) + sum(rate(ws_messages_dropped_total[5m]))

# Total queued bytes across every client — the thing that used to grow unbounded
ws_buffered_bytes{pair="*"}

# Connected clients
sum(ws_clients_total{pair="*"})
```

## Suggested alert

```yaml
groups:
  - name: lens-websocket
    rules:
      - alert: LensWebsocketClientsDropped
        expr: sum(rate(ws_clients_dropped_total[10m])) > 0.1
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "Lens is disconnecting websocket clients for falling behind"
          description: >-
            ws_clients_dropped_total is rising: clients are not draining their
            socket buffers fast enough. Check ws_buffered_bytes and the network
            between clients and this instance before raising the thresholds.
```

Tune against observed traffic before paging anyone. A steady trickle of
evictions on a mobile-heavy client base is a capacity signal, not an incident —
which is exactly why these clients are counted and dropped rather than allowed
to accumulate.