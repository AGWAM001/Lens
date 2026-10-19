/**
 * Websocket backpressure policy.
 *
 * `WebSocket#send()` neither blocks nor throws when the peer is merely slow —
 * it queues. A client on a bad mobile connection, or one whose process has been
 * suspended, accumulates price updates in its socket's internal buffer, and
 * nothing inspects `bufferedAmount`, so that buffer has no upper bound. With a
 * price feed running continuously, one stuck subscriber is enough to grow the
 * process until it is OOM-killed, taking every other subscriber with it.
 *
 * The policy, in three tiers, is implemented in `FanOutManager.deliver`:
 *
 *  1. **Coalesce** — past {@link BackpressureLimits.slowClientBufferBytes}, or
 *     inside the coalescing window, keep only the newest update and drop the
 *     ones it supersedes. For a price feed an intermediate tick that arrives
 *     late is worthless: the newest tick has already superseded it, so the
 *     backlog is truncated rather than drained. This is the tier that actually
 *     saves a healthy-but-slow client, and the one most clients hit.
 *  2. **Disconnect** — past {@link BackpressureLimits.maxBufferedBytes}, close
 *     the socket with {@link CLOSE_CODE_SLOW_CONSUMER}. No amount of coalescing
 *     fixes a peer that has stopped reading entirely; what bounds it is not
 *     letting its buffer grow.
 *  3. **Evict** — congested for longer than
 *     {@link BackpressureLimits.maxCongestedMs}, close it too. Tier 1 bounds the
 *     memory such a client costs; this bounds the time. Without it a client that
 *     stopped reading holds its slot, its buffered bytes and a
 *     `ws_clients_total` series forever, and nothing would say why.
 *
 * A stalled client can never affect another one: the thresholds are read per
 * client, dropping one only touches that client's own socket, and every send is
 * individually guarded.
 *
 * Resolved once at import (see `FanOutManager`), because this is read on the
 * price-update path.
 */

/**
 * RFC 6455 §7.4.1 code 1013, "Try Again Later". The condition is the client's
 * rather than the server's, but the meaning to a client is the one it already
 * handles for a throttled feed: reconnect, do not treat the close as fatal.
 */
export const CLOSE_CODE_SLOW_CONSUMER = 1013

export interface BackpressureLimits {
  /** Max updates per second per client, independent of backpressure. 0 disables the window. */
  coalesceIntervalMs: number
  /** Queued bytes above which updates are coalesced instead of sent. */
  slowClientBufferBytes: number
  /** Queued bytes above which the client is closed. */
  maxBufferedBytes: number
  /** How long a client may stay congested before it is closed anyway. 0 disables. */
  maxCongestedMs: number
}

/** Defaults, all overridable per deployment. */
export const DEFAULT_BACKPRESSURE_LIMITS: BackpressureLimits = {
  coalesceIntervalMs: 100,
  // 256 KiB of price updates is over a thousand ticks of backlog. A client that
  // far behind wants the newest value, not the thousand before it.
  slowClientBufferBytes: 256 * 1024,
  maxBufferedBytes: 1024 * 1024,
  maxCongestedMs: 30_000,
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, allowZero: boolean): number {
  const raw = Number(env[name])
  if (!Number.isFinite(raw)) return fallback
  if (raw === 0) return allowZero ? 0 : fallback
  if (raw < 0) return fallback
  return Math.floor(raw)
}

/**
 * Resolves the limits from the environment, clamped so they stay a policy
 * rather than two knobs that can cancel each other.
 *
 * `WS_SLOW_CLIENT_BUFFER_BYTES` at or above `WS_MAX_BUFFERED_BYTES` would mean
 * every client past the soft limit is disconnected on its first update over it
 * and the coalescing tier — the one that keeps a merely-slow client connected —
 * never runs. So the soft limit is clamped to half the hard one.
 */
export function resolveBackpressureLimits(env: NodeJS.ProcessEnv = process.env): BackpressureLimits {
  const coalesceIntervalMs = intFromEnv(
    env,
    'WS_COALESCE_INTERVAL_MS',
    DEFAULT_BACKPRESSURE_LIMITS.coalesceIntervalMs,
    true
  )
  const maxCongestedMs = intFromEnv(
    env,
    'WS_MAX_CONGESTED_MS',
    DEFAULT_BACKPRESSURE_LIMITS.maxCongestedMs,
    true
  )
  const maxBufferedBytes = intFromEnv(
    env,
    'WS_MAX_BUFFERED_BYTES',
    DEFAULT_BACKPRESSURE_LIMITS.maxBufferedBytes,
    false
  )
  const slowClientBufferBytes = intFromEnv(
    env,
    'WS_SLOW_CLIENT_BUFFER_BYTES',
    DEFAULT_BACKPRESSURE_LIMITS.slowClientBufferBytes,
    false
  )

  return {
    coalesceIntervalMs,
    maxBufferedBytes,
    maxCongestedMs,
    slowClientBufferBytes: Math.min(slowClientBufferBytes, Math.floor(maxBufferedBytes / 2)),
  }
}
