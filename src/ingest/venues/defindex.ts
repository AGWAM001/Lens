/**
 * DeFindex Vault Venue Adapter
 *
 * DeFindex vaults (Stellar Soroban) pool underlying assets across strategies
 * and issue a share token. A vault share is an asset people actually hold, but
 * its value is never quoted on an order book — it is implied by the vault's own
 * on-chain accounting. This adapter reads that accounting and derives the share
 * price, storing it in price_points with source = 'defindex_vault'.
 *
 * The share price is DERIVED, never TRADED, and never taken from a published
 * figure that could be stale. It comes straight from on-chain state on every
 * read, using the same integer ratio the vault itself uses when redeeming
 * shares:
 *
 *   sharePrice = totalManagedAssets / totalShareSupply        (1 share, in underlying units)
 *
 * A vault with zero shares has no meaningful share price, so the derivation
 * returns 0 and the point is skipped rather than dividing by zero.
 *
 * Every DeFindex contract id used here is copied whole from the protocol's own
 * published deployments (https://github.com/defindex-io/stellar-contracts,
 * public/{mainnet,testnet}.contracts.json) and flows in via config; nothing is
 * elided or invented.
 *
 * Issue: #214
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  Account,
  nativeToScVal,
  scValToNative,
  StrKey,
} from '@stellar/stellar-sdk'
import { getNetworkConfig, type NetworkName } from '../../config'
import { getRpcServer } from '../../network/clients'
import { makePairKey } from '../../pairsRegistry'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'
import { createLogger } from '../../logger'

const log = createLogger('ingester:defindex')

export const DEFINDEX_SOURCE = 'defindex_vault'

// Ephemeral fee-payer account (no real funds needed for simulation).
const FEE_PAYER_KEYPAIR = Keypair.random()

// ── Last-price cache hooks (mirrors the other venue adapters) ─────────────────
export function _resetLastPrice(): void {
  resetLastPrice('DeFindex')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('DeFindex', network, pairKey)
}

// ── On-chain shapes ───────────────────────────────────────────────────────────

/**
 * One underlying asset held by a vault, with its total managed amount
 * (idle + invested, net of locked fees) as reported by `fetch_total_managed_funds`.
 * The amount is kept in the asset's raw integer units — the same units the
 * vault uses internally — so the derived ratio matches the vault exactly.
 */
export interface DeFindexUnderlying {
  address: string
  symbol: string
  totalAmount: bigint
}

/**
 * A snapshot of a vault's on-chain share accounting: total share supply and the
 * per-underlying total managed assets.
 */
export interface DeFindexVaultSnapshot {
  vaultAddress: string
  shareSymbol: string
  totalShares: bigint
  underlying: DeFindexUnderlying[]
}

// ── Share-price arithmetic (pure) ─────────────────────────────────────────────

/**
 * Pure share-price derivation: total assets per share.
 *
 *   price = totalAssets / totalShares
 *
 * Returns 0 when the vault has zero shares — the empty-vault case the issue
 * calls out — so callers skip the point instead of dividing by zero. Also
 * returns 0 for a non-positive asset amount.
 *
 * `totalAssets` and `totalShares` are the raw i128 integers read from the
 * contract; both DeFindex shares and the underlying tokens it holds are
 * 7-decimal by convention, so this raw ratio equals the vault's own
 * `total_amount * shares / total_supply` redemption math.
 */
export function calcSharePrice(totalAssets: bigint, totalShares: bigint): number {
  if (totalShares <= 0n) return 0
  if (totalAssets <= 0n) return 0
  return Number(totalAssets) / Number(totalShares)
}

/**
 * Pure derivation of price points from a vault snapshot — one point per
 * underlying asset, pairing the vault's share token against that asset.
 * Vaults whose share price resolves to 0 (zero shares, empty asset) are dropped.
 */
export function deriveDeFindexPricePoints(
  snapshot: DeFindexVaultSnapshot
): { pair: WatchedPair; point: VenuePricePoint }[] {
  const assetA = { code: snapshot.shareSymbol, issuer: snapshot.vaultAddress }
  const timestamp = new Date()

  return snapshot.underlying.flatMap((u) => {
    const price = calcSharePrice(u.totalAmount, snapshot.totalShares)
    if (price <= 0) return []

    const assetB = { code: u.symbol, issuer: u.address }
    const pair: WatchedPair = { assetA, assetB, pairKey: makePairKey(assetA, assetB) }

    return [
      {
        pair,
        point: {
          assetA: assetA.code,
          assetB: assetB.code,
          pairKey: pair.pairKey,
          source: DEFINDEX_SOURCE,
          poolId: snapshot.vaultAddress,
          price,
          baseVolume: 0,
          counterVolume: 0,
          ledger: 0,
          timestamp,
          eventId: `defindex-${snapshot.vaultAddress}-${timestamp.getTime()}`,
        },
      },
    ]
  })
}

// ── Soroban simulation helper ─────────────────────────────────────────────────

/**
 * ScVal argument type, derived from the SDK's own builder so we depend only on
 * the exported `nativeToScVal` (whose return is the same `xdr.ScVal` that
 * `Contract.call` accepts) rather than on a namespace type import.
 */
type ScValArg = ReturnType<typeof nativeToScVal>

/**
 * Simulate a read-only contract call and return the decoded native value, or
 * `undefined` on any error. Reads go through `simulateTransaction` so nothing
 * is submitted and no fee is paid; the ephemeral fee-payer account needs no
 * funds.
 */
async function readContract(
  contractId: string,
  fnName: string,
  args: ScValArg[],
  network: NetworkName
): Promise<unknown | undefined> {
  try {
    const rpc = getRpcServer(network)
    const contract = new Contract(contractId)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call(fnName, ...args))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) {
      log.debug({ fn: fnName, contract: contractId, err: sim.error }, 'simulation error')
      return undefined
    }
    if (!sim.result?.retval) return undefined
    return scValToNative(sim.result.retval)
  } catch (err) {
    log.debug({ fn: fnName, contract: contractId, err }, 'call failed')
    return undefined
  }
}

/** A well-formed Soroban contract id (`C...`) — vault shares are identified by it. */
function isContractAddress(address: string): boolean {
  try {
    return StrKey.isValidContract(address)
  } catch {
    return false
  }
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

// ── Vault discovery (dynamic, from the factory) ───────────────────────────────

/**
 * Read the factory's `total_vaults()` count. Returns 0 on any failure so the
 * adapter degrades to "no vaults" rather than throwing.
 */
export async function fetchTotalVaults(
  factoryAddress: string,
  network: NetworkName
): Promise<number> {
  const total = await readContract(factoryAddress, 'total_vaults', [], network)
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) return total
  if (typeof total === 'bigint') return Number(total)
  return 0
}

/**
 * Read a single vault address from the factory's indexed registry
 * (`get_vault_by_index(index)`). Returns null if the index is missing/unreadable.
 */
export async function fetchVaultByIndex(
  factoryAddress: string,
  index: number,
  network: NetworkName
): Promise<string | null> {
  const args = [nativeToScVal(index, { type: 'u32' })]
  const addr = await readContract(factoryAddress, 'get_vault_by_index', args, network)
  return typeof addr === 'string' && isContractAddress(addr) ? addr : null
}

// Vault enumeration hits the factory every cycle; a short TTL keeps the RPC load
// bounded without pinning a stale set (new vaults surface within one TTL).
const VAULT_CACHE_TTL_MS = 5 * 60 * 1000
const vaultCache = new Map<NetworkName, { vaults: string[]; fetchedAt: number }>()

/**
 * Enumerate every vault deployed on the network by walking the factory registry.
 * Results are cached per network for {@link VAULT_CACHE_TTL_MS} so a busy cycle
 * does not re-query the factory once per watched pair.
 */
export async function discoverDeFindexVaults(
  network: NetworkName,
  force = false
): Promise<string[]> {
  const cached = vaultCache.get(network)
  if (!force && cached && Date.now() - cached.fetchedAt < VAULT_CACHE_TTL_MS) {
    return cached.vaults
  }

  const factoryAddress = getNetworkConfig(network).defindex.factoryAddress
  const total = await fetchTotalVaults(factoryAddress, network)
  const vaults: string[] = []
  for (let i = 0; i < total; i++) {
    const addr = await fetchVaultByIndex(factoryAddress, i, network)
    if (addr) vaults.push(addr)
  }

  vaultCache.set(network, { vaults, fetchedAt: Date.now() })
  return vaults
}

// ── Vault share accounting reads ──────────────────────────────────────────────

const symbolCache = new Map<string, string>()

/**
 * Read a token contract's `symbol()`, falling back to a shortened address when
 * the symbol is unavailable. Cached per (network, address) so repeated vault
 * reads do not re-query common underlying tokens (USDC, XLM, …).
 */
export async function fetchTokenSymbol(
  contractId: string,
  network: NetworkName
): Promise<string> {
  const key = `${network}:${contractId}`
  const cached = symbolCache.get(key)
  if (cached) return cached

  const sym = await readContract(contractId, 'symbol', [], network)
  const resolved = typeof sym === 'string' && sym.trim() ? sym : shortAddress(contractId)
  symbolCache.set(key, resolved)
  return resolved
}

/**
 * Read a vault's on-chain share accounting: total share supply (`total_supply`)
 * and the per-asset total managed amount (`fetch_total_managed_funds`).
 * Returns null when either read fails, so the caller skips the vault rather than
 * pricing it from partial data.
 */
export async function readVaultShareData(
  vaultAddress: string,
  network: NetworkName
): Promise<DeFindexVaultSnapshot | null> {
  const totalSharesRaw = await readContract(vaultAddress, 'total_supply', [], network)
  if (totalSharesRaw === undefined) return null

  const fundsRaw = await readContract(vaultAddress, 'fetch_total_managed_funds', [], network)
  if (!Array.isArray(fundsRaw)) return null

  const totalShares = BigInt(totalSharesRaw as bigint | number)
  const shareSymbol = await fetchTokenSymbol(vaultAddress, network)

  const underlying: DeFindexUnderlying[] = []
  for (const fund of fundsRaw as any[]) {
    const address = fund?.asset
    const amount = fund?.total_amount ?? fund?.totalAmount
    if (typeof address !== 'string') continue
    if (typeof amount !== 'bigint' && typeof amount !== 'number') continue
    const symbol = await fetchTokenSymbol(address, network)
    underlying.push({ address, symbol, totalAmount: BigInt(amount) })
  }

  return { vaultAddress, shareSymbol, totalShares, underlying }
}

// ── Ingestion ─────────────────────────────────────────────────────────────────

/**
 * Price a single vault: read its share accounting, derive a share price per
 * underlying asset, and persist each as a `defindex_vault` price point tagged
 * with the network it was read from. Errors are contained — a bad vault never
 * takes down the cycle.
 */
export async function ingestDeFindexVault(
  vaultAddress: string,
  network: NetworkName,
  _read: (vault: string, network: NetworkName) => Promise<DeFindexVaultSnapshot | null> = readVaultShareData
): Promise<void> {
  try {
    const snapshot = await _read(vaultAddress, network)
    if (!snapshot) return

    const derived = deriveDeFindexPricePoints(snapshot)
    if (derived.length === 0) {
      log.debug(
        { vault: vaultAddress, network },
        'no derivable share price (likely zero shares)'
      )
      return
    }

    for (const { pair, point } of derived) {
      await writeVenuePricePoints('DeFindex', [point], pair, network)
    }
    log.info(
      { vault: vaultAddress, network, points: derived.length },
      'derived share prices'
    )
  } catch (err) {
    log.error({ vault: vaultAddress, network, err }, 'vault ingest failed')
  }
}

/**
 * Price every discovered vault on a network. This is the per-network entry
 * point: it runs once per ENABLED_NETWORKS entry and writes each row with the
 * network it read from, so mainnet and testnet series never merge.
 */
export async function ingestDeFindexNetwork(
  network: NetworkName,
  _discover: (network: NetworkName, force?: boolean) => Promise<string[]> = discoverDeFindexVaults,
  _read: (vault: string, network: NetworkName) => Promise<DeFindexVaultSnapshot | null> = readVaultShareData
): Promise<void> {
  const vaults = await _discover(network)
  if (vaults.length === 0) {
    log.debug({ network }, 'no vaults discovered')
    return
  }
  for (const vault of vaults) {
    await ingestDeFindexVault(vault, network, _read)
  }
}

// The generic venue runner drives ingestion once per watched pair. DeFindex's
// universe is the vault factory, not the watched pairs, so a pair trigger runs a
// full-network scan — throttled to at most one scan per poll interval so a cycle
// with many pairs does not re-scan the factory many times.
const lastScanAt = new Map<NetworkName, number>()

/** Test-only: clear discovery/throttle caches so a case starts from a clean slate. */
export function _resetScanState(): void {
  vaultCache.clear()
  symbolCache.clear()
  lastScanAt.clear()
}

async function ingestPairThrottled(
  pair: WatchedPair,
  network: NetworkName
): Promise<void> {
  void pair
  const intervalMs = getNetworkConfig(network).defindex.pollIntervalMs
  const last = lastScanAt.get(network) ?? 0
  if (Date.now() - last < intervalMs) return
  lastScanAt.set(network, Date.now())
  await ingestDeFindexNetwork(network)
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const defindexAdapter: VenueAdapter<string, DeFindexVaultSnapshot> = {
  name: 'DeFindex',
  source: DEFINDEX_SOURCE,

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).defindex.enabled
  },

  getPollIntervalMs(network: NetworkName): number {
    return getNetworkConfig(network).defindex.pollIntervalMs
  },

  async discover(_pair: WatchedPair, network: NetworkName): Promise<string[]> {
    return discoverDeFindexVaults(network)
  },

  async read(target: string, _pair: WatchedPair, network: NetworkName): Promise<DeFindexVaultSnapshot | null> {
    return readVaultShareData(target, network)
  },

  derive(_raw: DeFindexVaultSnapshot, target: string, _pair: WatchedPair, _network: NetworkName) {
    // `readVaultShareData` is async; `derive` is synchronous in the interface,
    // so the concrete pricing path lives in ingestDeFindexVault. The adapter's
    // ingestPair override is what the runner actually drives.
    void target
    return []
  },

  async write(_points: VenuePricePoint[], target: string, _pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestDeFindexVault(target, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestPairThrottled(pair, network)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startDeFindexIngester(network: NetworkName): Promise<void> {
  await startVenueAdapter(defindexAdapter, network)
}
