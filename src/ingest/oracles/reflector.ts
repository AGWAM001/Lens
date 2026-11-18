/**
 * Reflector Oracle Adapter
 *
 * Polls Reflector on-chain oracle contract prices via Soroban RPC simulation
 * and provides price data for the /compare/:asset comparison endpoint.
 *
 * Issue: #104, #329
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
import { createLogger } from '../../logger'
import { fetchOk, fetchFailed, type FetchResult } from '../fetchResult'
import { recordSourceFailure, clearSourceFailure } from '../sourceFailures'
import type { OracleAdapter, OracleQuote } from './adapter'

const log = createLogger('oracle:reflector')

/** The oracle's key in the source-failure record. */
export const REFLECTOR_SOURCE = 'reflector'

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
 * the given network (#329).
 *
 * - `{ ok: true, data: price }` — the oracle answered with a price.
 * - `{ ok: true, data: null }` — there is genuinely nothing to read: no
 *   Reflector deployment on this network, or the oracle has no price for the
 *   asset.
 * - `{ ok: false, error }` — the oracle could not be read (RPC unreachable,
 *   simulation failed). Logged here; it used to be swallowed with no record
 *   at all.
 */
export async function fetchReflectorPrice(
  assetCode: string,
  network: NetworkName = activeNetwork
): Promise<FetchResult<ReflectorPrice | null>> {
  const netConfig = getNetworkConfig(network)
  // `oracle.enabled` already implies a non-empty reflectorContractId (config.ts),
  // so this single check subsumes the contract-id guard.
  if (!netConfig.oracle.enabled) return fetchOk(null)

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
    if (!SorobanRpc.Api.isSimulationSuccess(result)) {
      const detail = (result as { error?: unknown }).error
      log.error({ asset: assetCode, network, error: detail }, 'reflector lastprice simulation failed')
      return fetchFailed(new Error('Reflector lastprice simulation failed'))
    }

    const raw = scValToNative((result as any).result?.retval) as {
      price?: bigint
      timestamp?: bigint
    } | null

    if (!raw || raw.price === undefined) return fetchOk(null)

    // Reflector uses 14 decimal places of precision
    const price = Number(raw.price) / 1e14

    return fetchOk({
      asset: assetCode.toUpperCase(),
      price,
      timestamp: Number(raw.timestamp ?? 0),
    })
  } catch (err) {
    log.error({ asset: assetCode, network, err }, 'failed to read reflector price')
    return fetchFailed(err)
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
  const fetched = await fetchReflectorPrice(asset, network)
  if (!fetched.ok) {
    // #329: the OracleAdapter contract still answers null, but the failure is
    // recorded so it is retrievable (and on /status), not just logged.
    recordSourceFailure(REFLECTOR_SOURCE, network, asset.toUpperCase(), fetched.error)
    return null
  }
  clearSourceFailure(REFLECTOR_SOURCE, network, asset.toUpperCase())
  const fresh = fetched.data
  if (fresh) {
    const quote = { price: fresh.price, timestamp: fresh.timestamp }
    _cache.set(key, { quote, fetchedAt: Date.now() })
    return quote
  }
  return null
}
