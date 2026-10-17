import { EventEmitter } from 'events'
import { redis } from '../redis'
import { activeNetwork } from '../config'
import { priceEmitter, PRICE_UPDATE, PriceUpdateEvent } from '../events'
import { register, Gauge, Counter } from 'prom-client'

// ─── Metrics ──────────────────────────────────────────────────────────────────
export const ws_clients_total = new Gauge({
  name: 'ws_clients_total',
  help: 'Current number of connected WebSocket clients',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_messages_sent_total = new Counter({
  name: 'ws_messages_sent_total',
  help: 'Total number of price updates sent to WebSocket clients',
  labelNames: ['pair'],
  registers: [register],
})

export const ws_messages_dropped_total = new Counter({
  name: 'ws_messages_dropped_total',
  help: 'Total number of price updates dropped due to client backpressure',
  labelNames: ['pair'],
  registers: [register],
})

// ─── Configuration ─────────────────────────────────────────────────────────────
const REDIS_CHANNEL = `lens:${activeNetwork}:price:updates`
const DEFAULT_COALESCE_INTERVAL_MS = 100 // max 10 updates/sec per client

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
  send: (data: string) => void
  close: () => void
}

interface InternalClient {
  id: string
  socket: FanOutClient
  pairKey: string
  lastSent: number
  pendingUpdate: string | null
  timer: ReturnType<typeof setTimeout> | null
  destroyed: boolean
}

// ─── Fan-Out Manager ──────────────────────────────────────────────────────────
class FanOutManager {
  private clients = new Map<string, InternalClient>() // clientId -> client
  private pairClients = new Map<string, Set<string>>() // pairKey -> Set<clientId>

  // Redis pub/sub for cross-instance broadcasting
  private subscriber: typeof redis | null = null
  private publisher: typeof redis = redis
  private redisConnected = false

  async initialize(): Promise<void> {
    // Subscribe to local price emitter (always works)
    priceEmitter.on(PRICE_UPDATE, (event: PriceUpdateEvent) => {
      this.onPriceUpdate(event)
    })

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
      console.log('[fanout] Redis pub/sub subscriber ready')
    } catch (err) {
      console.warn('[fanout] Redis pub/sub unavailable, running in single-instance mode:', (err as Error).message)
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
    client.destroyed = true

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
   * Publishes to Redis for other instances and broadcasts locally.
   */
  private async onPriceUpdate(event: PriceUpdateEvent): Promise<void> {
    // Publish to Redis for cross-instance fan-out
    if (this.redisConnected) {
      try {
        await this.publisher.publish(REDIS_CHANNEL, JSON.stringify(event))
      } catch {
        // non-fatal
      }
    }

    // Broadcast to local clients
    this.broadcastToLocalClients(event)
  }

  /**
   * Broadcast a price update to local clients subscribed to this pair.
   * Applies per-client coalescing for slow consumers.
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

      const elapsed = now - client.lastSent

      if (elapsed >= DEFAULT_COALESCE_INTERVAL_MS) {
        // Client is ready to receive
        this.sendToClient(client, payload)
        client.lastSent = now
        client.pendingUpdate = null
      } else {
        // Client is too fast — coalesce: buffer the latest update
        client.pendingUpdate = payload
        if (!client.timer) {
          const timeout = DEFAULT_COALESCE_INTERVAL_MS - elapsed
          client.timer = setTimeout(() => {
            client.timer = null
            if (client.destroyed) return
            if (client.pendingUpdate) {
              this.sendToClient(client, client.pendingUpdate)
              client.lastSent = Date.now()
              client.pendingUpdate = null
            }
          }, timeout)
        }
      }
    }
  }

  private sendToClient(client: InternalClient, payload: string): void {
    try {
      client.socket.send(payload)
      const metricPair = pairMetricLabel(client.pairKey)
      if (metricPair) ws_messages_sent_total.labels(metricPair).inc()
      ws_messages_sent_total.labels('*').inc()
    } catch {
      // Client likely disconnected
      this.unregister(client.id)
    }
  }

  /**
   * Dispose all clients and clean up.
   */
  async destroy(): Promise<void> {
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
