import Redis from 'ioredis'
import { config, activeNetwork, type NetworkName } from './config'
import { createLogger } from './logger'

const log = createLogger('redis')

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  // Fail commands immediately while disconnected instead of queueing them.
  //
  // ioredis defaults this to true, so with an unreachable host every command
  // sits in the offline queue waiting for a connection that never comes. The
  // await simply never resolves — a hang, not an error, so the try/catch in
  // getCachedPrice cannot help and the request dies of timeout instead of
  // falling through to Postgres.
  //
  // It stayed hidden while REQUIRE_API_KEY was on, because the auth hook
  // rejected requests before any handler could reach Redis. Opening the API up
  // turned a 401 into a hang, which looked like the key change had failed.
  //
  // Rejecting fast is what the callers already expect: reads fall back to the
  // database, writes are best-effort, and x402 metering fails closed.
  enableOfflineQueue: false,
  // ioredis retries about once a second forever by default. Against a host
  // that no longer resolves that is a DNS lookup and two log lines every
  // second — roughly 170k lines a day, which buries every real message in the
  // log and is how a dead cache stayed invisible for weeks. Back off to a
  // lookup a minute instead. Still reconnects on its own when the host comes
  // back; just quietly.
  retryStrategy: (times) => Math.min(times * 2_000, 60_000),
})

// Same reasoning for the error events themselves: report the first one, then
// at most one a minute with a count of what was suppressed, so a persistent
// outage stays visible without drowning everything else.
let lastRedisErrorLog = 0
let suppressedRedisErrors = 0

redis.on('error', (err) => {
  const now = Date.now()
  if (now - lastRedisErrorLog < 60_000) {
    suppressedRedisErrors++
    return
  }
  log.error({ err, suppressed: suppressedRedisErrors }, 'redis connection error')
  lastRedisErrorLog = now
  suppressedRedisErrors = 0
})

export async function getCachedPrice(pairKey: string): Promise<string | null> {
  try {
    return await redis.get(`lens:${activeNetwork}:price:${pairKey}`)
  } catch {
    return null
  }
}

export async function setCachedPrice(pairKey: string, data: object, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(`lens:${activeNetwork}:price:${pairKey}`, JSON.stringify(data), 'EX', ttlSeconds)
  } catch {
    // Redis cache miss is non-fatal
  }
}

/**
 * Read a cached `GET /snapshot` response for a network. The network is part of
 * the key so a testnet snapshot is never served to a mainnet caller. The whole
 * response is cached (not the raw rows) so a hit is one Redis GET and no
 * Postgres work at all. Errors are swallowed: a cache outage degrades to a
 * normal recompute, never a failed request.
 */
export async function getCachedSnapshot(network: NetworkName): Promise<string | null> {
  try {
    return await redis.get(`lens:snapshot:${network}`)
  } catch {
    return null
  }
}

export async function setCachedSnapshot(network: NetworkName, data: object, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(`lens:snapshot:${network}`, JSON.stringify(data), 'EX', ttlSeconds)
  } catch {
    // Redis cache miss is non-fatal
  }
}
