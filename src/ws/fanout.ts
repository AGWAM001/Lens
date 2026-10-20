import { redis } from '../redis'
import { activeNetwork } from '../config'
import { priceEmitter, PRICE_UPDATE, PriceUpdateEvent } from '../events'
import { Gauge, Counter } from 'prom-client'
import { register } from '../metrics'
import { createLogger } from '../logger'
import { resolveBackpressureLimits, CLOSE_CODE_SLOW_CONSUMER } from './backpressure'

const log = createLogger('ws:fanout')

// ─── Metrics ──────────────────────────────────────────────────────────────────
// Registered on the app's own registry (src/metrics.ts), not prom-client's global
// default. `/metrics` renders that registry, so a slow client counted on the
// default one would be counted somewhere Prometheus never looks — visible in the
// source, invisible in the dashboard.
export const ws_clients_total = new Gauge({
  name: 'ws_clients_total',
  help: 'Current number of connected WebSocket clients',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_messages_sent_total = new Counter({
  name: 'ws_messages_sent_total',
  help: 'Total number of price updates written to WebSocket clients',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_messages_dropped_total = new Counter({
  name: 'ws_messages_dropped_total',
  help: 'Total number of price updates dropped due to client backpressure',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_clients_dropped_total = new Counter({
  name: 'ws_clients_dropped_total',
  help: 'Total number of WebSocket clients disconnected for failing to keep up with the price feed',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_buffered_bytes = new Gauge({
  name: 'ws_buffered_bytes',
  help: 'Bytes handed to client sockets and not yet written out (all clients, aggregate)',
  labelNames: ['pair'],
  registers: [register],
})

// ─── Configuration ─────────────────────────────────────────────────────────────
const REDIS_CHANNEL = `lens:${activeNetwork}:price:updates`

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/** How often the aggregate buffered-bytes gauge is refreshed. */
const BUFFER_SWEEP_INTERVAL_MS = envInt('WS_BUFFER_SWEEP_INTERVAL_MS', 5000)

/**
 * Backpressure limits, resolved once at import — this is read on the
 * price-update path. The policy, the tiers and the reasoning behind each
 * default live in src/ws/backpressure.ts.
 */
const LIMITS = resolveBackpressureLimits()

/**
 * Pair names can contain arbitrary asset codes and issuer identifiers supplied
 * by websocket clients. Keep them out of Prometheus labels: `other` is the
 * bounded bucket for pair-specific subscriptions and `*` remains the aggregate.
 */
function pairMetricLabel(pairKey: string): 'other' | null {
  return pairKey === '*' ? null : 'other'
}

// ─── Client wrapper with backpressure & coalescing ────────────────────────────
export interface FanOutClient {
  id: string
  /**
   * Queues `data` on the socket.
   *
   * `cb` is invoked once the data has actually been written out, or with an
   * error. The fan-out counts a message as *sent* only from that callback:
   * `send()` returns as soon as the payload is queued, so counting at call time
   * reported messages as delivered when they were only in a buffer — including
   * for a client that had stopped reading entirely and would never see them.
   */
  send: (data: string, cb?: (err?: Error | null) => void) => void
  /** Closes the underlying socket, ideally with a status code and reason. */
  close: (code?: number, reason?: string) => void
  /**
   * Bytes queued on this socket and not yet written to the peer.
   *
   * This is the only backpressure signal the WebSocket API offers, and it is
   * what every threshold below is compared against. Omit it only for a client
   * that cannot report a buffer (in-process fakes); a wrapper backed by a real
   * socket must expose it, or nothing bounds that client.
   */
  bufferedAmount?: () => number
}

interface InternalClient {
  id: string
  socket: FanOutClient
  pairKey: string
  lastSent: number
  pendingUpdate: string | null
  timer: ReturnType<typeof setTimeout> | null
  destroyed: boolean
  /** When this client first crossed the soft buffer limit, if it is congested. */
  congestedSince: number | null
}

// ─── Fan-Out Manager ──────────────────────────────────────────────────────────
class FanOutManager {
  private clients = new Map<string, InternalClient>() // clientId -> client
  private pairClients = new Map<string, Set<string>>() // pairKey -> Set<clientId>

  // Redis pub/sub for cross-instance broadcasting
  private subscriber: typeof redis | null = null
  private publisher: typeof redis = redis
  private redisConnected = false

  private bufferSweep: ReturnType<typeof setInterval> | null = null

  async initialize(): Promise<void> {
    // Subscribe to local price emitter (always works)
    priceEmitter.on(PRICE_UPDATE, (event: PriceUpdateEvent) => {
      this.onPriceUpdate(event)
    })

    // Aggregate queued-bytes gauge. Sampled on a timer rather than per broadcast
    // because the number of clients is unbounded and a per-send set() would
    // turn every tick into a metric write per subscriber.
    this.bufferSweep = setInterval(() => this.reportBufferedBytes(), BUFFER_SWEEP_INTERVAL_MS)
    this.bufferSweep.unref?.()

    // Subscribe to Redis channel for cross-instance updates (best-effort)
    try {
      this.subscriber = new (await import('ioredis')).default(
        (await import('../config')).config.redis.url,
        { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false }
      )
      await this.subscriber.connect()
      await this.subscriber.subscribe(REDIS_CHANNEL)
      this.redisConnected = true

      this.subscriber.on('message', (_channel: string, message: string) => {
        try {
          const event: PriceUpdateEvent = JSON.parse(message)
          this.broadcastToLocalClients(event)
        } catch {
          // ignore malformed messages
        }
      })
      log.info('redis pub/sub subscriber ready')
    } catch (err) {
      log.warn({ err }, 'redis pub/sub unavailable, running in single-instance mode')
      this.redisConnected = false
    }
  }

  /**
   * Register a new client for a given pair.
   */
  register(pairKey: string, socket: FanOutClient): () => void {
    const id = socket.id
    const client: InternalClient = {
      id,
      socket,
      pairKey,
      lastSent: 0,
      pendingUpdate: null,
      timer: null,
      destroyed: false,
      congestedSince: null,
    }

    this.clients.set(id, client)
    let clients = this.pairClients.get(pairKey)
    if (!clients) {
      clients = new Set()
      this.pairClients.set(pairKey, clients)
    }
    clients.add(id)

    const metricPair = pairMetricLabel(pairKey)
    if (metricPair) ws_clients_total.labels(metricPair).inc()
    ws_clients_total.labels('*').inc()

    // Return unsubscribe function
    return () => this.unregister(id)
  }

  private unregister(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    if (client.timer) clearTimeout(client.timer)
    client.timer = null
    client.destroyed = true
    // Drop the retained payload. An unregistered client must hold no memory:
    // the whole point of bounding the buffer is that the bytes go away with it.
    client.pendingUpdate = null

    this.clients.delete(id)
    const clients = this.pairClients.get(client.pairKey)
    if (clients) {
      clients.delete(id)
      if (clients.size === 0) {
        this.pairClients.delete(client.pairKey)
      }
    }

    const metricPair = pairMetricLabel(client.pairKey)
    if (metricPair) ws_clients_total.labels(metricPair).dec()
    ws_clients_total.labels('*').dec()
  }

  /**
   * Called when a price update is received from the local emitter.
   * Publishes to Redis for cross-instance broadcasting.
   */
  private async onPriceUpdate(event: PriceUpdateEvent): Promise<void> {
    // Local clients first. Publishing to Redis is a network round trip, and
    // waiting on it before delivering locally meant a slow (or stalled) Redis
    // delayed every subscriber on this instance — the one dependency that can
    // be added to the critical path without improving the result.
    this.broadcastToLocalClients(event)

    // Publish to Redis for cross-instance fan-out
    if (this.redisConnected) {
      try {
        await this.publisher.publish(REDIS_CHANNEL, JSON.stringify(event))
      } catch {
        // non-fatal
      }
    }
  }

  /**
   * Broadcast a price update to local clients subscribed to this pair.
   * Applies per-client backpressure and coalescing for slow consumers.
   * Also sends to wildcard ('*') subscribers that receive all pairs.
   */
  private broadcastToLocalClients(event: PriceUpdateEvent): void {
    // Derive pairKey from event
    const assets = [event.assetA, event.assetB].sort()
    const pairKey = assets.join('/')

    // Collect client IDs from both the specific pair and wildcard subscriptions
    const matchedIds = new Set<string>()
    const pairClients = this.pairClients.get(pairKey)
    if (pairClients) {
      for (const id of pairClients) matchedIds.add(id)
    }
    const wildcardClients = this.pairClients.get('*')
    if (wildcardClients) {
      for (const id of wildcardClients) matchedIds.add(id)
    }

    if (matchedIds.size === 0) return

    const now = Date.now()
    const payload = JSON.stringify({ type: 'price_update', ...event })

    for (const clientId of matchedIds) {
      const client = this.clients.get(clientId)
      if (!client || client.destroyed) continue

      // Each client is handled independently: a dropped, congested or throwing
      // client must never stop the next one on this list from being served.
      this.deliver(client, payload, now)
    }
  }

  /**
   * Hand one payload to one client, respecting what its socket can absorb.
   *
   * The policy, in order:
   *
   *  1. **Over the hard limit** (`WS_MAX_BUFFERED_BYTES`) — the peer is not
   *     draining at all. Close it with 1013 and forget it. There is no amount
   *     of coalescing that fixes a peer which has stopped reading, and an
   *     unbounded socket buffer is how one subscriber OOM-kills the process
   *     for everyone else.
   *  2. **Over the soft limit** (`WS_SLOW_CLIENT_BUFFER_BYTES`) — congested but
   *     alive: keep only the newest update. For a price feed an intermediate
   *     tick that arrives late is worthless, because the newest tick has
   *     already superseded it, so the backlog is truncated rather than drained.
   *  3. **Congested for `WS_MAX_CONGESTED_MS`** — close with 1013. Tier 2
   *     bounds the memory a stuck client costs; this bounds the time. Without
   *     it a client that stopped reading holds its slot, its buffered bytes and
   *     a `ws_clients_total` series forever, and no metric would ever say why.
   *  4. **Otherwise** — send, and count it as sent only once the socket reports
   *     the write completed.
   *
   * Tier 2 also subsumes the fixed coalescing window: a client inside that
   * window gets the same newest-only treatment, for the same reason.
   */
  private deliver(client: InternalClient, payload: string, now: number): void {
    const buffered = this.bufferedBytesOf(client)

    if (buffered >= LIMITS.maxBufferedBytes) {
      this.dropSlowClient(client, 'buffer limit exceeded', buffered)
      return
    }

    const congested = buffered >= LIMITS.slowClientBufferBytes
    if (congested) {
      if (client.congestedSince === null) client.congestedSince = now
      if (LIMITS.maxCongestedMs > 0 && now - client.congestedSince >= LIMITS.maxCongestedMs) {
        this.dropSlowClient(client, 'congested too long', buffered)
        return
      }
    } else {
      client.congestedSince = null
    }

    const elapsed = now - client.lastSent
    if (!congested && elapsed >= LIMITS.coalesceIntervalMs) {
      client.pendingUpdate = null
      client.lastSent = now
      this.sendToClient(client, payload)
      return
    }

    // Only the newest update is worth keeping. Anything already buffered for
    // this client is superseded by `payload`, so it is counted as dropped —
    // silently, and without a metric, a truncated feed is indistinguishable
    // from a healthy one.
    if (client.pendingUpdate !== null) this.countDroppedUpdate(client)
    client.pendingUpdate = payload

    // A congested client is re-checked on the fixed interval rather than
    // immediately: its buffer can only shrink on its own, and a zero-delay
    // reschedule would spin the event loop for as long as the peer stays stuck.
    this.scheduleFlush(client, congested ? LIMITS.coalesceIntervalMs : LIMITS.coalesceIntervalMs - elapsed)
  }

  /**
   * Re-attempt a coalesced update once the client's window has elapsed.
   *
   * Goes back through {@link deliver}, so the buffer is re-inspected before
   * anything is written: by the time this fires the client may have recovered,
   * or crossed the hard limit, or been unregistered.
   */
  private scheduleFlush(client: InternalClient, delayMs: number): void {
    if (client.timer || client.destroyed) return

    client.timer = setTimeout(() => {
      client.timer = null
      if (client.destroyed) return
      const pending = client.pendingUpdate
      client.pendingUpdate = null
      if (pending === null) return
      this.deliver(client, pending, Date.now())
    }, Math.max(delayMs, 1))
    // A pending flush must not be a reason to keep the process alive.
    client.timer.unref?.()
  }

  /** Bytes queued on a client's socket, 0 when it cannot report any. */
  private bufferedBytesOf(client: InternalClient): number {
    try {
      const buffered = client.socket.bufferedAmount?.()
      if (typeof buffered !== 'number' || !Number.isFinite(buffered) || buffered <= 0) return 0
      return buffered
    } catch {
      // A wrapper that throws while reporting its buffer gets the benefit of
      // the doubt: worse to drop a healthy client than to serve a wedged one.
      return 0
    }
  }

  /** Aggregate queued bytes across every connected client, for `ws_buffered_bytes`. */
  private reportBufferedBytes(): void {
    let total = 0
    for (const client of this.clients.values()) total += this.bufferedBytesOf(client)
    // Aggregate only. One series per client pair would be unbounded cardinality
    // driven by caller-supplied subscription strings.
    ws_buffered_bytes.labels('*').set(total)
  }

  /**
   * Disconnect a client that cannot keep up, and say so out loud.
   *
   * The close reason is kept short on purpose: RFC 6455 caps a close reason at
   * 123 bytes and `ws` throws past that, which would turn a backpressure
   * eviction into an unhandled exception on the broadcast path.
   */
  private dropSlowClient(client: InternalClient, reason: string, bufferedBytes: number): void {
    if (client.pendingUpdate !== null) this.countDroppedUpdate(client)

    const metricPair = pairMetricLabel(client.pairKey)
    if (metricPair) ws_clients_dropped_total.labels(metricPair).inc()
    ws_clients_dropped_total.labels('*').inc()

    log.warn(
      {
        clientId: client.id,
        pair: client.pairKey,
        reason,
        bufferedBytes,
        congestedMs: client.congestedSince === null ? 0 : Date.now() - client.congestedSince,
      },
      'dropping websocket client that cannot keep up with the price feed'
    )

    try {
      client.socket.close(CLOSE_CODE_SLOW_CONSUMER, reason)
    } catch {
      // The socket may already be gone; unregistering below is what matters.
    }
    this.unregister(client.id)
  }

  private countDroppedUpdate(client: InternalClient): void {
    const metricPair = pairMetricLabel(client.pairKey)
    if (metricPair) ws_messages_dropped_total.labels(metricPair).inc()
    ws_messages_dropped_total.labels('*').inc()
  }

  private sendToClient(client: InternalClient, payload: string): void {
    let settled = false
    const onWritten = (err?: Error | null): void => {
      if (settled) return
      settled = true
      if (err) {
        // Client likely disconnected, or the write failed underneath us.
        this.unregister(client.id)
        return
      }
      const metricPair = pairMetricLabel(client.pairKey)
      if (metricPair) ws_messages_sent_total.labels(metricPair).inc()
      ws_messages_sent_total.labels('*').inc()
    }

    try {
      client.socket.send(payload, onWritten)
    } catch {
      this.unregister(client.id)
    }
  }

  /**
   * Dispose all clients and clean up.
   */
  async destroy(): Promise<void> {
    if (this.bufferSweep) {
      clearInterval(this.bufferSweep)
      this.bufferSweep = null
    }
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(REDIS_CHANNEL)
      } catch {
        // subscriber may not have connected — ignore
      }
      this.subscriber.disconnect()
    }
    for (const [id] of this.clients) {
      this.unregister(id)
    }
  }
}

export const fanOutManager = new FanOutManager()
export default FanOutManager
