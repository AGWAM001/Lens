---
'lens': minor
---

Bound what a slow websocket client can cost the process.

`WebSocket#send()` neither blocks nor throws when a peer is slow, it queues.
Nothing inspected `bufferedAmount`, so one subscriber that stopped reading — a
suspended mobile client, a wedged TCP window — accumulated price updates in its
socket buffer without limit, and the message was counted as sent the moment it
was queued. With the feed pushing continuously, one stuck subscriber was enough
to grow the process until it was OOM-killed, taking every other subscriber and
every HTTP client with it.

`FanOutManager` now applies a per-client policy in
[`src/ws/backpressure.ts`](https://github.com/Divinity-Labs/Lens/blob/main/src/ws/backpressure.ts):
past `WS_SLOW_CLIENT_BUFFER_BYTES` (256 KiB) updates are coalesced to the newest
one, past `WS_MAX_BUFFERED_BYTES` (1 MiB) — or congested for longer than
`WS_MAX_CONGESTED_MS` (30s) — the client is closed with `1013` and counted in
`ws_clients_dropped_total`. Superseded updates count in
`ws_messages_dropped_total`, so a truncated feed is visible rather than silent,
and `ws_buffered_bytes` reports total queued bytes. All the limits are
configurable, and none of them can slow down delivery to any other client.

`ws_messages_sent_total` now increments when the socket reports the write
completed rather than when `send()` returned, so it counts what was written
rather than what was queued. The websocket metrics also moved from
prom-client's global default registry onto the one `/metrics` renders, which is
where they were supposed to be visible all along.