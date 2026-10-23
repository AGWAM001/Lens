/**
 * Phoenix AMM Venue Adapter (Stellar Soroban)
 *
 * Phoenix is a constant-product AMM on Soroban with live mainnet volume. This
 * adapter enumerates its pools from the protocol's own factory contract, reads
 * reserves over Soroban RPC, derives a spot price from the x*y=k invariant, and
 * stores the result in price_points with `source = 'phoenix_amm'`.
 *
 * Discovery is a factory read, never a list kept in this repo: Phoenix opens and
 * rebalances pools on its own schedule, so a hard-coded array quietly stops
 * quoting the pools that matter. The enumerated list is cached per network for
 * `PHOENIX_POOL_CACHE_TTL_MS` and shared by every watched pair, so a cycle costs
 * one reserves read per matching pool instead of a re-enumeration per pair.
 *
 * Failure mode is "no Phoenix price", never "no Lens": an unreachable RPC yields
 * an empty pool list or a null reserve read rather than throwing, and a failed
 * refresh leaves the previous cache entry in place (stale, then retried next
 * cycle) rather than poisoning it. SDEX, Horizon AMM, Soroswap and Aquarius keep
 * ingesting regardless.
 *
 * Every row carries `source = 'phoenix_amm'` and the pool's contract id in
 * `poolId`, and the network it was read from — Phoenix prices are never blended
 * into another venue's series.
 *
 * Issue: #210
 */

import {
  Asset,
  Contract,
  Keypair,
  Networks,
  Account,
  StrKey,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
  xdr,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'
import { getNetworkConfig, activeNetwork, type NetworkName } from '../../config'
import { getRpcServer } from '../../network/clients'
import type { AssetId, WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'
import { createLogger } from '../../logger'

const log = createLogger('ingester:phoenix')

// Ephemeral fee-payer account: simulation never charges it.
const FEE_PAYER_KEYPAIR = Keypair.random()

// How many pool detail reads to keep in flight while refreshing the cache. The
// factory can list dozens of pools, and an unbounded fan-out of simulations is
// how one refresh turns into a rate-limited RPC for the rest of the cycle.
const DISCOVERY_CONCURRENCY = 4

export function _resetLastPrice(): void {
  resetLastPrice('Phoenix')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('Phoenix', network, pairKey)
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A discovered Phoenix pool and the two Soroban token contracts it holds. */
export interface PhoenixPool {
  poolAddress: string
  tokenAAddress: string
  tokenBAddress: string
}

/**
 * A pool read: the pool's tokens plus the raw i128 reserve amounts.
 */
export interface PhoenixReserves {
  poolAddress: string
  tokenAAddress: string
  tokenBAddress: string
  reserveA: bigint
  reserveB: bigint
}

// ── Low-level Soroban RPC ─────────────────────────────────────────────────────

function passphraseFor(network: NetworkName): string {
  return getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC
}

/**
 * Networks whose reads go straight to the raw JSON-RPC response.
 *
 * Measured on mainnet (ledger 64,991,171): 9 of the 13 pools the Phoenix
 * factory enumerates simulate a state change, and stellar-sdk 13.3's parsed
 * `simulateTransaction` throws `TypeError: Bad union switch: 1` while decoding
 * their `SorobanTransactionData` — its XDR tables are older than the network's.
 * Going through the parsed response alone would leave the venue quoting 4 pools
 * and silently treating the other 9 (XLM/EURC, USDC/VEUR, USDC/VCHF, …) as if
 * they did not exist. `_simulateTransaction` returns the identical response
 * unparsed, so decoding the returned ScVal here reads all 13.
 *
 * The parsed call is still attempted first — it is the idiom the rest of the
 * repo uses, and the only path needed once the SDK dependency catches up. The
 * fallback is remembered per network so a doomed attempt costs one call, not one
 * per pool per cycle.
 */
const rawRpcNetworks = new Map<NetworkName, boolean>()

/** Test hook: forget which networks needed the raw RPC path. */
export function _resetRawRpcState(): void {
  rawRpcNetworks.clear()
}

/**
 * Simulate a read-only contract call and return its ScVal result, or null when
 * the RPC is unreachable, the simulation fails, or the contract returns nothing.
 * Never throws: an unreachable RPC must degrade this venue, not the process.
 */
export async function simulateRead(
  contractId: string,
  fnName: string,
  network: NetworkName = activeNetwork,
  args: xdr.ScVal[] = []
): Promise<xdr.ScVal | null> {
  try {
    if (!StrKey.isValidContract(contractId)) {
      log.debug(`refusing to call non-contract id ${contractId}`)
      return null
    }

    const rpc = getRpcServer(network)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: passphraseFor(network),
    })
      .addOperation(new Contract(contractId).call(fnName, ...args))
      .setTimeout(30)
      .build()

    if (!rawRpcNetworks.get(network)) {
      try {
        const sim = await rpc.simulateTransaction(tx)
        if (SorobanRpc.Api.isSimulationError(sim)) {
          log.debug({ err: sim.error }, `${fnName} simulation error on ${contractId}`)
          return null
        }
        // `result` is absent when nothing was invoked; `retval` is the single
        // ScVal the contract returned.
        return sim.result?.retval ?? null
      } catch (err) {
        log.debug(
          { err },
          `parsed simulation failed (${fnName} on ${network}), switching to the raw RPC response`
        )
        rawRpcNetworks.set(network, true)
      }
    }

    const raw = await rpc._simulateTransaction(tx)
    if (raw.error) {
      log.debug({ err: raw.error }, `${fnName} simulation error on ${contractId}`)
      return null
    }
    const returned = raw.results?.[0]?.xdr
    if (!returned) return null
    return xdr.ScVal.fromXDR(returned, 'base64')
  } catch (err) {
    log.debug({ err }, `${fnName} failed on ${contractId}`)
    return null
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Pure: turn a decoded `query_pool_info` value into reserves. Phoenix's pool
 * struct is `{ asset_a: { address, amount }, asset_b: { address, amount }, ... }`
 * — a ScValObject map, which `scValToNative` gives back as a keyed object. The
 * positional/tuple form is also read, because a struct exported without field
 * symbols decodes to an array and the two are indistinguishable from here.
 * Anything else returns null: an unreadable pool is skipped, never guessed for.
 */
export function parsePoolInfo(decoded: unknown, poolAddress: string): PhoenixReserves | null {
  const assetA = readAsset(fieldOf(decoded, 'asset_a', 0))
  const assetB = readAsset(fieldOf(decoded, 'asset_b', 1))

  if (!assetA || !assetB) return null
  if (!StrKey.isValidContract(assetA.address) || !StrKey.isValidContract(assetB.address)) return null

  return {
    poolAddress,
    tokenAAddress: assetA.address,
    tokenBAddress: assetB.address,
    reserveA: assetA.amount,
    reserveB: assetB.amount,
  }
}

function fieldOf(decoded: unknown, key: string, index: number): unknown {
  if (Array.isArray(decoded)) return decoded[index]
  if (decoded && typeof decoded === 'object') return (decoded as Record<string, unknown>)[key]
  return undefined
}

function readAsset(candidate: unknown): { address: string; amount: bigint } | null {
  if (!candidate || typeof candidate !== 'object') return null
  const { address, amount } = candidate as Record<string, unknown>
  if (typeof address !== 'string') return null
  const scaled = toBigInt(amount)
  if (scaled === null) return null
  return { address, amount: scaled }
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return null
}

/**
 * Pure: constant-product spot price from raw reserves, expressed as units of the
 * pool's B token per one A token. i128 reserves never fit in Number exactly, but
 * a ratio only needs relative precision, so both sides are scaled identically
 * before dividing. Zero (or negative) on either side means an unquotable pool and
 * yields 0, which callers treat as "no price" rather than a free/infinitely
 * expensive asset.
 */
export function calcSpotPrice(reserveA: bigint, reserveB: bigint): number {
  if (reserveA <= 0n || reserveB <= 0n) return 0
  const price = Number(reserveB) / Number(reserveA)
  return Number.isFinite(price) && price > 0 ? price : 0
}

// ── Pair ↔ token-contract resolution ──────────────────────────────────────────

/**
 * The Soroban token contract a watched classic asset is wrapped into (the
 * Stellar Asset Contract for that code+issuer). Native XLM maps to its own SAC.
 *
 * This is what lets Phoenix pools be matched without any hard-coded per-pair
 * contract list: a pool that holds `XLM` and Circle `USDC` is recognised by the
 * addresses of those two assets' contracts, which are a function of the asset
 * identity and the network passphrase. Both sides of any pool matched here are
 * SAC-wrapped classic assets, so both reserves are 7-decimal — the ratio needs
 * no per-token scale correction.
 */
export function sacContractId(asset: AssetId, network: NetworkName): string {
  const a = asset.issuer ? new Asset(asset.code, asset.issuer) : Asset.native()
  return a.contractId(passphraseFor(network))
}

/** Pure: does this pool hold exactly the two tokens of `pair` (in either order)? */
export function poolMatchesPair(pool: PhoenixPool, pair: WatchedPair, network: NetworkName): boolean {
  try {
    const a = sacContractId(pair.assetA, network)
    const b = sacContractId(pair.assetB, network)
    const forward = pool.tokenAAddress === a && pool.tokenBAddress === b
    const backward = pool.tokenAAddress === b && pool.tokenBAddress === a
    return forward || backward
  } catch (err) {
    log.debug({ err }, `cannot resolve watched assets for ${pair.pairKey}`)
    return false
  }
}

// ── Discovery: factory pool enumeration, cached ───────────────────────────────

/**
 * `query_pools` on the Phoenix factory returns the addresses of every pool it
 * created. This is the protocol's own registry — new pools appear here the
 * moment they are created.
 */
export async function fetchPoolAddresses(
  factoryAddress: string,
  network: NetworkName = activeNetwork
): Promise<string[]> {
  const retval = await simulateRead(factoryAddress, 'query_pools', network)
  if (!retval) return []
  try {
    const pools = scValToNative(retval) as unknown
    if (!Array.isArray(pools)) return []
    return pools.filter((p): p is string => typeof p === 'string' && StrKey.isValidContract(p))
  } catch (err) {
    log.debug({ err }, 'failed to decode query_pools')
    return []
  }
}

/**
 * Read one pool's tokens and reserves via `query_pool_info`. Returns null if the
 * pool is unreadable — it is skipped, never guessed for.
 */
export async function fetchPoolReserves(
  poolAddress: string,
  network: NetworkName = activeNetwork
): Promise<PhoenixReserves | null> {
  const retval = await simulateRead(poolAddress, 'query_pool_info', network)
  if (!retval) return null
  try {
    return parsePoolInfo(scValToNative(retval), poolAddress)
  } catch (err) {
    log.debug({ err }, `failed to decode query_pool_info for ${poolAddress}`)
    return null
  }
}

interface PoolCacheEntry {
  /** Pools with a known token pair; only these are ever matchable. */
  pools: PhoenixPool[]
  /** When the list was successfully refreshed, in epoch ms. */
  fetchedAt: number
  /** True while a refresh is in flight, so concurrent cycles share one read. */
  refreshing?: Promise<PhoenixPool[]>
}

const poolCache = new Map<NetworkName, PoolCacheEntry>()

/**
 * Refresh a cache entry's pool list: enumerate from the factory, then describe
 * each pool concurrently. On any failure the previous list is kept — stale, but
 * real and sourced — and retried on the next cycle.
 */
async function refresh(network: NetworkName, previous: PhoenixPool[]): Promise<PhoenixPool[]> {
  const factory = getNetworkConfig(network).phoenix.factoryAddress
  const addresses = await fetchPoolAddresses(factory, network)

  if (addresses.length === 0) {
    // An empty factory read is indistinguishable from "RPC down", so it is not
    // allowed to erase a list we previously read.
    log.debug(`no pools enumerated on ${network}, keeping ${previous.length} cached`)
    return previous
  }

  const described: PhoenixPool[] = []
  for (let i = 0; i < addresses.length; i += DISCOVERY_CONCURRENCY) {
    const batch = addresses.slice(i, i + DISCOVERY_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (addr) => {
        const info = await fetchPoolReserves(addr, network)
        return info ? { poolAddress: addr, tokenAAddress: info.tokenAAddress, tokenBAddress: info.tokenBAddress } : null
      })
    )
    for (const r of results) if (r) described.push(r)
  }

  if (described.length === 0) {
    log.debug(`enumerated ${addresses.length} pool(s) on ${network} but read none, keeping ${previous.length} cached`)
    return previous
  }

  log.info(`discovered ${described.length}/${addresses.length} pool(s) on ${network}`)
  return described
}

/**
 * Cached pool list for a network. Fresh entries are returned without touching
 * the RPC; expired ones are refreshed once, and concurrent callers await the
 * same in-flight refresh instead of stampeding the node.
 */
export async function discoverPools(
  network: NetworkName = activeNetwork,
  ttlMs: number = getNetworkConfig(network).phoenix.poolCacheTtlMs,
  refreshFn: (network: NetworkName, previous: PhoenixPool[]) => Promise<PhoenixPool[]> = refresh
): Promise<PhoenixPool[]> {
  const now = Date.now()
  let entry = poolCache.get(network)

  if (!entry) {
    entry = { pools: [], fetchedAt: 0 }
    poolCache.set(network, entry)
  }

  if (entry.refreshing) return entry.refreshing
  if (entry.pools.length > 0 && now - entry.fetchedAt < ttlMs) return entry.pools

  const run = refreshFn(network, entry.pools)
    .then((pools) => {
      entry!.pools = pools
      // The timestamp only advances on a successful refresh, so a failed one is
      // retried next cycle rather than cached as "empty for the TTL".
      if (pools.length > 0) entry!.fetchedAt = Date.now()
      return pools
    })
    .catch((err) => {
      log.error({ err }, `pool discovery failed on ${network}`)
      return entry!.pools
    })
    .finally(() => {
      if (entry) entry.refreshing = undefined
    })

  entry.refreshing = run
  return run
}

/** Test/administration hook: drops cached pool lists. */
export function _resetPoolCache(network?: NetworkName): void {
  if (network) poolCache.delete(network)
  else poolCache.clear()
}

/** How many pools are currently cached for a network (0 = never discovered). */
export function _poolCacheSize(network: NetworkName): number {
  return poolCache.get(network)?.pools.length ?? 0
}

// ── Derivation ────────────────────────────────────────────────────────────────

/**
 * Pure: derive price points from a pool read. Returns [] when the pool does not
 * hold the watched pair (a different pool), when the reserves are zero, or when
 * the pool is quoted in the opposite direction to the pair — the ratio is
 * inverted so that `price` always means "units of assetB per unit of assetA",
 * matching the SDEX/AMM convention used everywhere else in Lens.
 */
export function derivePhoenixPricePoints(
  raw: PhoenixReserves,
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): VenuePricePoint[] {
  const forward = poolMatchesPair(
    { poolAddress: raw.poolAddress, tokenAAddress: raw.tokenAAddress, tokenBAddress: raw.tokenBAddress },
    pair,
    network
  )
  if (!forward) return []

  let a = raw.reserveA
  let b = raw.reserveB
  try {
    if (sacContractId(pair.assetA, network) === raw.tokenBAddress) {
      // The pool's A token is the pair's B asset: flip the ratio.
      ;[a, b] = [b, a]
    }
  } catch {
    return []
  }

  const price = calcSpotPrice(a, b)
  if (price === 0) return []

  return [
    {
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      pairKey: pair.pairKey,
      source: 'phoenix_amm',
      poolId: raw.poolAddress,
      price,
      baseVolume: 0,
      counterVolume: 0,
      ledger: 0,
      timestamp: new Date(),
      eventId: `phoenix-${raw.poolAddress}-${Date.now()}`,
    },
  ]
}

// ── Per-pair ingestion ────────────────────────────────────────────────────────

export interface PhoenixIngestDeps {
  discoverPools: (network: NetworkName) => Promise<PhoenixPool[]>
  fetchPoolReserves: (poolAddress: string, network: NetworkName) => Promise<PhoenixReserves | null>
}

const defaultDeps: PhoenixIngestDeps = { discoverPools, fetchPoolReserves }

/**
 * Discover, read, derive and write every Phoenix pool that quotes `pair`. A pool
 * whose reserves cannot be read is logged and skipped; the cycle continues with
 * the remaining pools and returns normally, so this venue's RPC being down looks
 * exactly like "no Phoenix price today" and nothing else.
 */
export async function ingestPhoenixPair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  deps: PhoenixIngestDeps = defaultDeps,
  writePoints: (points: VenuePricePoint[], pair: WatchedPair, network: NetworkName) => Promise<void> = async (
    points,
    p,
    n
  ) => {
    await writeVenuePricePoints('Phoenix', points, p, n)
  }
): Promise<void> {
  try {
    const pools = await deps.discoverPools(network)
    const matching = pools.filter((pool) => poolMatchesPair(pool, pair, network))

    if (matching.length === 0) {
      log.debug(`no pool quotes ${pair.pairKey} on ${network} — skipping`)
      return
    }

    const points: VenuePricePoint[] = []

    for (const pool of matching) {
      const reserves = await deps.fetchPoolReserves(pool.poolAddress, network)
      if (!reserves) {
        log.debug(`pool ${pool.poolAddress} unreadable — skipping`)
        continue
      }
      const derived = derivePhoenixPricePoints(reserves, pair, network)
      if (derived.length === 0) {
        log.debug(`pool ${pool.poolAddress} has no quotable price — skipping`)
        continue
      }
      points.push(...derived)
    }

    if (points.length === 0) return
    await writePoints(points, pair, network)
  } catch (err) {
    // Belt-and-braces: nothing in this venue may reject into the runner.
    log.error({ err }, `ingest cycle for ${pair.pairKey} on ${network} failed`)
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const phoenixAdapter: VenueAdapter<PhoenixPool, PhoenixReserves> = {
  name: 'Phoenix',
  source: 'phoenix_amm',

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).phoenix.enabled
  },

  getPollIntervalMs(network: NetworkName): number {
    return getNetworkConfig(network).phoenix.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<PhoenixPool[]> {
    const pools = await discoverPools(network)
    return pools.filter((pool) => poolMatchesPair(pool, pair, network))
  },

  async read(target: PhoenixPool, _pair: WatchedPair, network: NetworkName): Promise<PhoenixReserves | null> {
    const reserves = await fetchPoolReserves(target.poolAddress, network)
    // Defensive: a pool that turned out to hold different tokens is not ours.
    if (!reserves) return null
    return poolMatchesPair(reserves, _pair, network) ? reserves : null
  },

  derive(raw: PhoenixReserves | null, _target: PhoenixPool, pair: WatchedPair, network: NetworkName): VenuePricePoint[] {
    if (!raw) return []
    return derivePhoenixPricePoints(raw, pair, network)
  },

  async write(points: VenuePricePoint[], _target: PhoenixPool, pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints('Phoenix', points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestPhoenixPair(pair, network)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startPhoenixIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(phoenixAdapter, network)
}
