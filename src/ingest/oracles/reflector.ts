/**
 * Reflector Oracle Adapter
 *
 * Polls Reflector on-chain oracle contract prices via Soroban RPC simulation
 * and provides price data for the /compare/:asset comparison endpoint.
 *
 * Issue: #104
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  scValToNative,
  nativeToScVal,
  Account,
} from '@stellar/stellar-sdk'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { getRpcServer } from '../../network/clients'
import type { OracleAdapter, OracleQuote } from './adapter'

// Ephemeral fee payer — simulation only, no real funds needed
const FEE_PAYER = Keypair.random()

export interface ReflectorPrice {
  asset: string
  price: number
  timestamp: number
}

/** Reflector implementation of the shared oracle adapter contract. */
export const reflectorOracleAdapter: OracleAdapter = {
  name: 'reflector',
  isConfigured(network) {
    return getNetworkConfig(network).oracle.enabled
  },
  getPrice(asset, network) {
    return getCachedReflectorPrice(asset, network)
  },
}

/**
 * Fetch the latest price for a given asset code from the Reflector oracle on
 * the given network. Returns null when the contract is unreachable, the
 * network has no Reflector deployment configured, or the asset is unknown.
 */
export async function fetchReflectorPrice(
  assetCode: string,
  network: NetworkName = activeNetwork
): Promise<ReflectorPrice | null> {
  const netConfig = getNetworkConfig(network)
  // `oracle.enabled` already implies a non-empty reflectorContractId (config.ts),
  // so this single check subsumes the contract-id guard.
  if (!netConfig.oracle.enabled) return null

  try {
    const rpc = getRpcServer(network)
    const contract = new Contract(netConfig.oracle.reflectorContractId)
    const account = new Account(FEE_PAYER.publicKey(), '0')

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: netConfig.network.passphrase,
    })
      .addOperation(
        contract.call('lastprice', nativeToScVal(assetCode, { type: 'symbol' }))
      )
      .setTimeout(30)
      .build()

    const result = await rpc.simulateTransaction(tx)
    if (!SorobanRpc.Api.isSimulationSuccess(result)) return null

    const raw = scValToNative((result as any).result?.retval) as {
      price?: bigint
      timestamp?: bigint
    } | null

    if (!raw || raw.price === undefined) return null

    // Reflector uses 14 decimal places of precision
    const price = Number(raw.price) / 1e14

    return {
      asset: assetCode.toUpperCase(),
      price,
      timestamp: Number(raw.timestamp ?? 0),
    }
  } catch {
    return null
  }
}

// In-memory cache (60 s TTL) to avoid hammering RPC on every comparison request
const _cache = new Map<string, { quote: OracleQuote; fetchedAt: number }>()
const CACHE_TTL_MS = 60_000

export async function getCachedReflectorPrice(
  asset: string,
  network: NetworkName = activeNetwork
): Promise<OracleQuote | null> {
  const key = `${network}:${asset.toUpperCase()}`
  const entry = _cache.get(key)
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.quote
  }
  const fresh = await fetchReflectorPrice(asset, network)
  if (fresh) {
    const quote = { price: fresh.price, timestamp: fresh.timestamp }
    _cache.set(key, { quote, fetchedAt: Date.now() })
    return quote
  }
  return null
}
