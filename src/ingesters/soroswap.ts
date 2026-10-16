/**
 * Soroswap AMM Pool Price Ingester
 *
 * Polls Soroswap Soroban pool reserves via Soroban RPC simulation,
 * calculates constant-product spot prices, and stores them in price_points
 * with source = 'soroswap_amm'. Runs independently of the SDEX and Horizon
 * AMM ingesters — a crash here cannot affect them.
 *
 * Issue: #48
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  scValToNative,
  Account,
} from '@stellar/stellar-sdk'
import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { price_rejected_total } from '../metrics'
import { getRpcServer } from '../network/clients'
import { getActivePairs } from '../pairsRegistry'
import { upsertPricePoints } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'
import { publishPriceUpdate } from '../events'
import type { WatchedPair } from '../types'

// ── Constants ─────────────────────────────────────────────────────────────────

// Ephemeral fee-payer account (no real funds needed for simulation)
const FEE_PAYER_KEYPAIR = Keypair.random()

// In-memory last-price tracker for webhook delta dispatch, keyed by (network, pairKey)
const lastPrice = new Map<string, number>()

export function _resetLastPrice(): void {
  lastPrice.clear()
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return lastPrice.get(`${network}:${pairKey}`)
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoroswapToken {
  address: string
  symbol: string
  name: string
  decimals: number
}

export interface SoroswapTokenList {
  tokens: SoroswapToken[]
}

export interface PoolEntry {
  poolAddress: string
  tokenA: SoroswapToken
  tokenB: SoroswapToken
}

// ── Token-list helpers ────────────────────────────────────────────────────────

/**
 * Fetch Soroswap token list. Returns an empty array on failure so the ingester
 * degrades gracefully without affecting other ingesters.
 */
export async function fetchSoroswapTokenList(
  tokenListUrl: string = getNetworkConfig(activeNetwork).soroswap.tokenListUrl
): Promise<SoroswapToken[]> {
  try {
    const res = await fetch(tokenListUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as SoroswapTokenList
    return Array.isArray(data.tokens) ? data.tokens : []
  } catch (err) {
    console.error('[soroswap] Failed to fetch token list:', (err as Error).message)
    return []
  }
}

// ── Pool discovery ────────────────────────────────────────────────────────────

/**
 * Query the Soroswap factory contract's get_pools() to enumerate pool addresses
 * for a specific token pair. Returns an empty array on RPC failure.
 */
export async function fetchPoolsFromFactory(
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  network: NetworkName = activeNetwork
): Promise<string[]> {
  try {
    const rpc = getRpcServer(network)
    const factory = new Contract(factoryAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        factory.call(
          'get_pools',
          new Contract(tokenA).address().toScVal(),
          new Contract(tokenB).address().toScVal()
        )
      )
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      console.debug(
        `[soroswap] get_pools simulation error for ${tokenA}/${tokenB}:`,
        sim.error
      )
      return []
    }

    if (!sim.result?.retval) return []

    const pools = scValToNative(sim.result.retval) as string[]
    return Array.isArray(pools) ? pools : []
  } catch (err) {
    console.debug(
      '[soroswap] fetchPoolsFromFactory error:',
      (err as Error).message
    )
    return []
  }
}

// ── Reserve reading ───────────────────────────────────────────────────────────

/**
 * Read a Soroswap pool's reserves via Soroban RPC simulation.
 * Returns [reserveA, reserveB] where A is `tokenAAddress`.
 * Returns null on any RPC error.
 */
export async function fetchPoolReserves(
  poolAddress: string,
  network: NetworkName = activeNetwork
): Promise<[bigint, bigint] | null> {
  try {
    const rpc = getRpcServer(network)
    const pool = new Contract(poolAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(pool.call('get_reserves'))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      console.debug(
        `[soroswap] get_reserves simulation error for pool ${poolAddress}:`,
        sim.error
      )
      return null
    }

    if (!sim.result?.retval) return null

    const reserves = scValToNative(sim.result.retval) as [bigint | number, bigint | number]
    if (!Array.isArray(reserves) || reserves.length < 2) return null

    return [BigInt(reserves[0]), BigInt(reserves[1])]
  } catch (err) {
    console.debug(
      `[soroswap] fetchPoolReserves error for ${poolAddress}:`,
      (err as Error).message
    )
    return null
  }
}

// ── Token decimals reading & caching ──────────────────────────────────────────

const tokenDecimalsCache = new Map<string, number>()

export function _resetTokenDecimalsCache(): void {
  tokenDecimalsCache.clear()
}

export function getCachedTokenDecimals(tokenAddress: string): number | undefined {
  return tokenDecimalsCache.get(tokenAddress)
}

export function setCachedTokenDecimals(tokenAddress: string, decimals: number): void {
  tokenDecimalsCache.set(tokenAddress, decimals)
}

/**
 * Read a token's decimals via Soroban RPC simulation, with caching.
 * A token's decimals never change on-chain.
 */
export async function fetchTokenDecimals(
  tokenAddress: string,
  network: NetworkName = activeNetwork
): Promise<number | null> {
  const cached = getCachedTokenDecimals(tokenAddress)
  if (cached !== undefined) return cached

  try {
    if (typeof getRpcServer !== 'function') return null
    const rpc = getRpcServer(network)
    if (!rpc) return null
    const token = new Contract(tokenAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(token.call('decimals'))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      console.debug(
        `[soroswap] decimals simulation error for token ${tokenAddress}:`,
        sim.error
      )
      return null
    }

    if (!sim.result?.retval) return null

    const decimalsVal = scValToNative(sim.result.retval)
    const decimals = typeof decimalsVal === 'number' ? decimalsVal : Number(decimalsVal)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      return null
    }

    setCachedTokenDecimals(tokenAddress, decimals)
    return decimals
  } catch (err) {
    console.debug(
      `[soroswap] fetchTokenDecimals error for ${tokenAddress}:`,
      (err as Error).message
    )
    return null
  }
}

// ── Spot price ────────────────────────────────────────────────────────────────

/**
 * Pure function: calculate spot price from constant-product reserves scaled by token decimals.
 * Returns 0 if either reserve is zero (empty pool guard).
 *
 * price = (reserveA / 10^decimalsA) / (reserveB / 10^decimalsB)
 *       = (reserveA / reserveB) * 10^(decimalsB - decimalsA)
 * (price of assetB denominated in assetA)
 */
export function calcSpotPrice(
  reserveA: bigint,
  reserveB: bigint,
  decimalsA: number = 7,
  decimalsB: number = 7
): number {
  if (reserveA === 0n || reserveB === 0n) return 0
  if (decimalsA === decimalsB) {
    return Number(reserveA) / Number(reserveB)
  }
  const scale = Math.pow(10, decimalsB - decimalsA)
  return (Number(reserveA) / Number(reserveB)) * scale
}

/**
 * Checks whether a derived spot price falls within the configurable sanity range.
 */
export function isPricePlausible(
  price: number,
  min: number = config.plausibility.minPrice,
  max: number = config.plausibility.maxPrice
): boolean {
  return price >= min && price <= max && Number.isFinite(price) && !Number.isNaN(price)
}

// ── Per-pool ingestion ────────────────────────────────────────────────────────

/**
 * Fetch reserves for a single pool, compute spot price, and store a price point.
 * Skips silently on empty pool or RPC failure — does not throw.
 */
export async function ingestPool(
  poolEntry: PoolEntry,
  pair: WatchedPair,
  _fetchReserves: (poolAddress: string, network?: NetworkName) => Promise<[bigint, bigint] | null> = fetchPoolReserves,
  network: NetworkName = activeNetwork,
  _fetchDecimals: (tokenAddress: string, network?: NetworkName) => Promise<number | null> = fetchTokenDecimals
): Promise<void> {
  try {
    const reserves = await _fetchReserves(poolEntry.poolAddress, network)
    if (!reserves) return

    const [reserveA, reserveB] = reserves

    const decimalsA =
      (await _fetchDecimals(poolEntry.tokenA.address, network)) ??
      poolEntry.tokenA.decimals ??
      7
    const decimalsB =
      (await _fetchDecimals(poolEntry.tokenB.address, network)) ??
      poolEntry.tokenB.decimals ??
      7

    const spotPrice = calcSpotPrice(reserveA, reserveB, decimalsA, decimalsB)

    if (spotPrice === 0) {
      console.debug(
        `[soroswap] Skipping empty pool ${poolEntry.poolAddress} for ${pair.pairKey}`
      )
      return
    }

    if (!isPricePlausible(spotPrice)) {
      console.warn(
        `[soroswap] Derived price ${spotPrice} for ${pair.pairKey} (${poolEntry.poolAddress}) outside plausible range [${config.plausibility.minPrice}, ${config.plausibility.maxPrice}] — rejecting`
      )
      price_rejected_total.inc({
        pair: pair.pairKey,
        network,
        venue: 'soroswap',
        reason: 'out_of_bounds',
      })
      return
    }

    await upsertPricePoints([
      {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'soroswap_amm' as const,
        poolId: poolEntry.poolAddress,
        price: spotPrice,
        baseVolume: 0,
        counterVolume: 0,
        ledger: 0,
        timestamp: new Date(),
        eventId: `soroswap-${poolEntry.poolAddress}-${Date.now()}`,
      },
    ], network)

    const trackerKey = `${network}:${pair.pairKey}`
    const previousPrice = lastPrice.get(trackerKey) ?? spotPrice
    lastPrice.set(trackerKey, spotPrice)

    publishPriceUpdate({
      pair: pair.pairKey,
      price: spotPrice,
      ts: new Date().toISOString(),
      network,
    })

    dispatchPriceUpdate({
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      previousPrice,
      currentPrice: spotPrice,
      network,
    }).catch((err) =>
      console.error('[soroswap] webhook dispatch error:', err.message)
    )

    console.log(
      `[soroswap] Pool ${poolEntry.poolAddress.slice(0, 8)}: price=${spotPrice.toFixed(8)} for ${pair.pairKey}`
    )
  } catch (err) {
    console.error(
      `[soroswap] ingestPool error for ${poolEntry.poolAddress}:`,
      (err as Error).message
    )
  }
}

// ── Main per-pair logic ───────────────────────────────────────────────────────

/**
 * Discover Soroswap pools for a watched pair, then snapshot each pool's price.
 * Matches pair assets to token list by symbol; filters to watched pairs only.
 */
export async function ingestPair(
  pair: WatchedPair,
  tokens: SoroswapToken[],
  factoryAddress: string,
  _fetchPools: (
    factoryAddress: string,
    tokenA: string,
    tokenB: string,
    network?: NetworkName
  ) => Promise<string[]> = fetchPoolsFromFactory,
  network: NetworkName = activeNetwork
): Promise<void> {
  const tokenA = tokens.find(
    (t) => t.symbol.toUpperCase() === pair.assetA.code.toUpperCase()
  )
  const tokenB = tokens.find(
    (t) => t.symbol.toUpperCase() === pair.assetB.code.toUpperCase()
  )

  if (!tokenA || !tokenB) {
    console.debug(
      `[soroswap] No Soroswap token found for pair ${pair.pairKey} — skipping`
    )
    return
  }

  const poolAddresses = await _fetchPools(
    factoryAddress,
    tokenA.address,
    tokenB.address,
    network
  )

  if (!poolAddresses.length) {
    console.debug(
      `[soroswap] No pools found for ${pair.pairKey} — skipping`
    )
    return
  }

  await Promise.all(
    poolAddresses.map((addr) =>
      ingestPool(
        { poolAddress: addr, tokenA, tokenB },
        pair,
        fetchPoolReserves,
        network
      )
    )
  )
}

// ── Ingester loop ─────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Start the Soroswap AMM ingester. Runs as an infinite polling loop.
 * Fault-isolated: a crash is caught by the caller (restartIngester in index.ts).
 */
export async function startSoroswapIngester(network: NetworkName = activeNetwork): Promise<void> {
  const netConfig = getNetworkConfig(network)

  if (!netConfig.soroswap.enabled) {
    console.log(`[soroswap] Soroswap is disabled on ${network} — ingester not started`)
    return
  }

  const factoryAddress = netConfig.soroswap.factoryAddress
  const tokenListUrl = netConfig.soroswap.tokenListUrl
  const pollInterval = netConfig.soroswap.pollIntervalMs

  console.log(
    `[soroswap] Starting Soroswap ingester on ${network} | factory=${factoryAddress} | interval=${pollInterval}ms`
  )

  while (true) {
    const pairs = getActivePairs()
    const tokens = await fetchSoroswapTokenList(tokenListUrl)

    if (tokens.length === 0) {
      console.warn('[soroswap] Token list empty — skipping poll cycle')
    } else {
      await Promise.all(
        pairs.map((pair) => ingestPair(pair, tokens, factoryAddress, fetchPoolsFromFactory, network))
      )
    }

    await sleep(pollInterval)
  }
}
