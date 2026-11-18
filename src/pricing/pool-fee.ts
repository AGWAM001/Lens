export interface PoolFee {
  poolId: string
  feeBp: number
  /** ISO timestamp of when the venue was read. */
  feeReadAt: string
}

export type PoolFeeResult =
  | { ok: true; fee: PoolFee; cached: boolean }
  | { ok: false; poolId: string; reason: string }

export interface PoolFeeOptions {
  /** Horizon base URL for the network being answered, e.g. https://horizon-testnet.stellar.org */
  horizonUrl: string
  /** Cache lifetime in milliseconds. Placeholder default; confirm before merge. */
  ttlMs?: number
  /** Injectable clock for tests. */
  now?: () => number
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TTL_MS = 10 * 60 * 1000

interface CacheEntry {
  fee: PoolFee
  expiresAt: number
}

// Keyed by network and pool, so testnet and mainnet never share a fee.
const cache = new Map<string, CacheEntry>()

export function clearPoolFeeCache(): void {
  cache.clear()
}

/**
 * Reads a pool's fee from the venue (Horizon), with a TTL cache.
 *
 * Failures are never cached, so a transient outage is retried on the next call.
 * A caller that receives { ok: false } must exclude the pool from execution
 * estimates and report the reason. It must not fall back to a default fee.
 */
export async function getPoolFee(
  network: string,
  poolId: string,
  opts: PoolFeeOptions,
): Promise<PoolFeeResult> {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const key = `${network}:${poolId}`

  const hit = cache.get(key)
  if (hit && hit.expiresAt > now()) {
    return { ok: true, fee: hit.fee, cached: true }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  let body: unknown
  try {
    const res = await fetchImpl(
      `${opts.horizonUrl}/liquidity_pools/${encodeURIComponent(poolId)}`,
    )
    if (!res.ok) {
      return { ok: false, poolId, reason: `venue responded ${res.status}` }
    }
    body = await res.json()
  } catch (err) {
    return { ok: false, poolId, reason: `venue unreachable: ${(err as Error).message}` }
  }

  const feeBp = (body as { fee_bp?: unknown } | null)?.fee_bp
  if (typeof feeBp !== 'number' || !Number.isInteger(feeBp) || feeBp < 0 || feeBp >= 10000) {
    return { ok: false, poolId, reason: 'venue did not return a valid fee_bp' }
  }

  const fee: PoolFee = { poolId, feeBp, feeReadAt: new Date(now()).toISOString() }
  cache.set(key, { fee, expiresAt: now() + ttl })
  return { ok: true, fee, cached: false }
}
