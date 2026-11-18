/**
 * The on-chain half of the SEP-40 publisher (#222).
 *
 * `trigger.ts` decides *whether* to write; this module is the only place that
 * actually talks to a contract. It is deliberately narrow:
 *
 *   - three immutable reads (`base`, `decimals`, `resolution`) so Lens never
 *     guesses how a deployed feed is scaled or trimmed;
 *   - one mutable read (`lastprice`) which is the deviation reference;
 *   - one write (`report`).
 *
 * The whole surface sits behind the `Sep40Feed` interface, so the publisher loop
 * is tested against a recording fake. This class itself talks to a deployed
 * contract, so the suite that proves its other half is the Rust one in
 * `oracle/contract` — the wire forms both sides agree on are pinned here by
 * `src/__tests__/sep40Encoding.test.ts`.
 *
 * Reads FAIL CLOSED. If `base()`/`decimals()`/`resolution()` cannot be fetched,
 * we do not fall back to "14 decimals is what Reflector uses" or to a
 * hard-coded resolution: a price published at the wrong scale is not a slightly
 * wrong price, it is a price off by orders of magnitude, and every consumer
 * downstream trusts it because it came from a contract.
 */

import { contract as StellarContract, Keypair, StrKey } from '@stellar/stellar-sdk'
import { getNetworkConfig, type NetworkName } from '../config'
import { createLogger } from '../logger'
import {
  assetFromSpecArg,
  assetToSpecArg,
  type Sep40Asset,
  type SpecUnion,
} from './sep40'

const log = createLogger('sep40-feed')

/** A raw `PriceData` as it comes off the contract. */
export interface RawPriceData {
  price: bigint
  timestamp: number
}

/** The three feed parameters a consumer must agree with before publishing. */
export interface FeedParameters {
  base: Sep40Asset
  decimals: number
  resolution: number
}

/** Everything a report needs, already in the units the contract expects. */
export interface ReportInput {
  asset: Sep40Asset
  /** Scaled by `decimals` — see `scalePrice` in sep40.ts. */
  price: bigint
  /** Trimmed to `resolution` — SEP-40's `floor(unix_now()/resolution)*resolution`. */
  timestamp: number
  /** Venue names behind the number; the contract derives `source_count` from this. */
  venues: string[]
}

/** What the ledger gave back for a successful write. */
export interface ReportReceipt {
  /** Transaction hash, or null if the RPC did not echo one. */
  txHash: string | null
  /** Ledger the report landed in, when known. */
  ledger: number | null
}

/**
 * The feed, as the publisher sees it. Implementations throw rather than return
 * null when a read of the feed's *own parameters* fails; `lastPrice` returns
 * null when the feed simply has nothing for that asset yet, which is what
 * SEP-40 requires for an unquoted asset (`None`, not an error).
 */
export interface Sep40Feed {
  readonly network: NetworkName
  readonly contractId: string
  parameters(): Promise<FeedParameters>
  lastPrice(asset: Sep40Asset): Promise<RawPriceData | null>
  report(input: ReportInput): Promise<ReportReceipt>
}

/** The feed could not be read, so nothing may be published. */
export class FeedUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedUnavailableError'
  }
}

/** The write was submitted and did not succeed. */
export class FeedWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedWriteError'
  }
}

type AssembledTransaction<T> = StellarContract.AssembledTransaction<T>

/** What the spec-generated `Client` exposes for the calls this module makes. */
interface FeedClient {
  base(): Promise<AssembledTransaction<SpecUnion>>
  decimals(): Promise<AssembledTransaction<number>>
  resolution(): Promise<AssembledTransaction<number>>
  lastprice(args: { asset: SpecUnion }): Promise<AssembledTransaction<RawPriceData | null>>
  report(args: {
    asset: SpecUnion
    price: bigint
    timestamp: number
    venues: string[]
  }): Promise<AssembledTransaction<unknown>>
}

function requireContractId(contractId: string, network: NetworkName): string {
  if (!StrKey.isValidContract(contractId)) {
    throw new FeedUnavailableError(
      `the configured SEP-40 contract id for ${network} is "${contractId}", which is not a C... contract address`
    )
  }
  return contractId
}

function requireKeypair(secretKey: string | undefined, network: NetworkName): Keypair {
  if (!secretKey) {
    throw new FeedUnavailableError(
      `no publisher secret key is configured for ${network}; the feed can be read but never written`
    )
  }
  try {
    return Keypair.fromSecret(secretKey.trim())
  } catch {
    throw new FeedUnavailableError(
      `the configured publisher secret key for ${network} is not a valid Stellar secret key`
    )
  }
}

/**
 * u64 decodes to a JS number when it is safe and to a bigint when it is not; a
 * feed timestamp is a unix second, so either way it fits in a number.
 */
function toSeconds(value: bigint | number): number {
  return Number(value)
}

/**
 * A feed backed by a deployed contract on `network`, driven by the SDK's
 * spec-generated `Client`. The client is built lazily and only once: building it
 * downloads the contract's WASM to read its spec, so a feed that is never polled
 * costs no RPC calls.
 */
export class ContractSep40Feed implements Sep40Feed {
  readonly network: NetworkName
  readonly contractId: string

  private clientPromise: Promise<FeedClient> | null = null
  private parametersCache: FeedParameters | null = null

  constructor(network: NetworkName, contractId: string, private readonly secretKey?: string) {
    this.network = network
    this.contractId = requireContractId(contractId, network)
  }

  private async client(): Promise<FeedClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.buildClient()
    }
    try {
      return await this.clientPromise
    } catch (err) {
      // A failed construction must not be cached forever: the next poll should
      // get another chance after an RPC hiccup or a redeploy.
      this.clientPromise = null
      throw err
    }
  }

  private async buildClient(): Promise<FeedClient> {
    const netConfig = getNetworkConfig(this.network)
    const keypair = requireKeypair(this.secretKey, this.network)
    const signer = StellarContract.basicNodeSigner(keypair, netConfig.network.passphrase)
    try {
      const client = await StellarContract.Client.from({
        contractId: this.contractId,
        rpcUrl: netConfig.rpc.url,
        networkPassphrase: netConfig.network.passphrase,
        publicKey: keypair.publicKey(),
        signTransaction: signer.signTransaction,
        signAuthEntry: signer.signAuthEntry,
      })
      return client as unknown as FeedClient
    } catch (err) {
      throw new FeedUnavailableError(
        `could not load the SEP-40 feed at ${this.contractId} on ${this.network} (${netConfig.rpc.url}): ${(err as Error).message}`
      )
    }
  }

  /**
   * `base`, `decimals` and `resolution` are fixed at `initialize` time, and
   * SEP-40 tells consumers they can rely on that, so they are read once and
   * kept for the life of the process.
   */
  async parameters(): Promise<FeedParameters> {
    if (this.parametersCache) return this.parametersCache
    const client = await this.client()
    let baseTx: AssembledTransaction<SpecUnion>
    let decimalsTx: AssembledTransaction<number>
    let resolutionTx: AssembledTransaction<number>
    try {
      ;[baseTx, decimalsTx, resolutionTx] = await Promise.all([
        client.base(),
        client.decimals(),
        client.resolution(),
      ])
    } catch (err) {
      throw new FeedUnavailableError(
        `the feed at ${this.contractId} on ${this.network} did not answer base()/decimals()/resolution(): ${(err as Error).message}`
      )
    }

    const decimals = Number(decimalsTx.result)
    const resolution = Number(resolutionTx.result)
    const base = assetFromSpecArg(baseTx.result)
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new FeedUnavailableError(
        `the feed at ${this.contractId} on ${this.network} reported decimals=${decimals}`
      )
    }
    if (!Number.isInteger(resolution) || resolution <= 0) {
      throw new FeedUnavailableError(
        `the feed at ${this.contractId} on ${this.network} reported resolution=${resolution}`
      )
    }
    this.parametersCache = { base, decimals, resolution }
    return this.parametersCache
  }

  async lastPrice(asset: Sep40Asset): Promise<RawPriceData | null> {
    const client = await this.client()
    try {
      const tx = await client.lastprice({ asset: assetToSpecArg(asset) })
      const raw = tx.result
      if (!raw) return null
      return { price: BigInt(raw.price), timestamp: toSeconds(raw.timestamp) }
    } catch (err) {
      throw new FeedUnavailableError(
        `lastprice failed against ${this.contractId} on ${this.network} for ${asset.kind === 'stellar' ? asset.contractId : asset.symbol}: ${(err as Error).message}`
      )
    }
  }

  async report(input: ReportInput): Promise<ReportReceipt> {
    const client = await this.client()
    const assetId = input.asset.kind === 'stellar' ? input.asset.contractId : input.asset.symbol
    try {
      const tx = await client.report({
        asset: assetToSpecArg(input.asset),
        price: input.price,
        timestamp: input.timestamp,
        venues: input.venues,
      })
      // `signAndSend` waits for the transaction to finalize, so a success here
      // is a claim about the ledger — which is what makes the audit row safe to
      // write as `published` rather than `sent`.
      const sent = await tx.signAndSend()
      const response = sent.getTransactionResponse
      // `ledger` only exists on the responses the RPC actually found; a
      // NOT_FOUND shape has none, and the union has to be narrowed for TS (and
      // for the operator reading the message) to agree on that.
      const ledger = response && 'ledger' in response ? Number(response.ledger) : null
      if (response && String(response.status) !== 'SUCCESS') {
        throw new FeedWriteError(
          `report for ${assetId} at ${input.timestamp} finalized as ${response.status} in ledger ${ledger ?? 'unknown'} (tx ${sent.sendTransactionResponse?.hash ?? 'unknown'}); re-run the diagnostic events against Soroban RPC with that hash to see why`
        )
      }
      const receipt: ReportReceipt = {
        txHash: sent.sendTransactionResponse?.hash ?? null,
        ledger,
      }
      log.info({ contract: this.contractId, network: this.network, ...receipt }, 'SEP-40 report finalized')
      return receipt
    } catch (err) {
      if (err instanceof FeedWriteError) throw err
      throw new FeedWriteError(
        `report to ${this.contractId} on ${this.network} failed for ${assetId} at ${input.timestamp}: ${(err as Error).message}`
      )
    }
  }
}

// ── Feed registry ────────────────────────────────────────────────────────────

const feeds = new Map<NetworkName, ContractSep40Feed>()

/**
 * The feed for `network`, or null when publication is not configured for it.
 * `config` already folds "enabled" together with "has a usable contract id and
 * a key", so null here means the operator has not finished wiring this network
 * up — a supported state, not an error.
 */
export function getSep40Feed(network: NetworkName): Sep40Feed | null {
  const publisher = getNetworkConfig(network).publisher
  if (!publisher.enabled) return null
  const existing = feeds.get(network)
  if (existing && existing.contractId === publisher.contractId) return existing
  const feed = new ContractSep40Feed(network, publisher.contractId, publisher.secretKey)
  feeds.set(network, feed)
  log.info({ network, contract: publisher.contractId }, 'SEP-40 feed ready')
  return feed
}

/** Test hook: forget cached feeds so a suite can point at another contract. */
export function _resetFeeds(): void {
  feeds.clear()
}
