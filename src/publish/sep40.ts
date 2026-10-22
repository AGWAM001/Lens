/**
 * SEP-40 wire format (#222).
 *
 * Everything in this file is pure: it turns a Lens asset, price and timestamp
 * into exactly the values the on-chain feed accepts, and nothing it writes here
 * touches the network or the database. That matters because the failure mode of
 * an oracle is not "the call failed" — it is "the call succeeded and the number
 * is wrong by four orders of magnitude". Scale, trimming and asset identity are
 * decided once, here, and tested.
 *
 * SEP-40 § Design Rationale defines the two rules this file implements:
 *   - "Price is encoded as an `i128` number where last N digits designate the
 *     fractional part of the price stored with precision defined by
 *     `decimals()` … the actual price can be calculated as `price/10^decimals`"
 *   - "`timestamp` refers to Unix Timestamp calculated as
 *     `floor(unix_now()/resolution)*resolution`"
 */

import { Asset as StellarAsset, Address, StrKey, xdr } from '@stellar/stellar-sdk'
import { getNetworkConfig, type NetworkName } from '../config'
import type { AssetId } from '../types'

/**
 * Soroban's `ScSymbol` is capped at 32 bytes on the wire, and a symbol over the
 * cap is a decode error at the ledger, not a validation error here. Checked at
 * the boundary so an operator gets "venue name X is too long" instead of an
 * opaque `tx failed`.
 */
export const MAX_SYMBOL_LENGTH = 32

/** Must match `MAX_VENUES` in oracle/contract/src/lib.rs. */
export const MAX_VENUES = 16

/** i128 bounds; a price that does not fit is refused here rather than at the ledger. */
const I128_MAX = (2n ** 127n) - 1n

/** Raised for inputs that cannot be represented on chain at all. */
export class Sep40EncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Sep40EncodingError'
  }
}

/**
 * SEP-40 §Interface `enum Asset { Stellar(Address), Other(Symbol) }`.
 *
 * A Stellar asset is named by the address of its Stellar Asset Contract, which
 * is the only representation that is issuer-qualified: two tokens both called
 * USDC are different assets, and a feed keyed on the code alone would blend
 * them. Native XLM has no asset contract, so it takes the `Other` branch, which
 * the spec leaves to the oracle's own naming.
 */
export type Sep40Asset =
  | { kind: 'stellar'; contractId: string }
  | { kind: 'other'; symbol: string }

/** The `{ tag, values }` shape the SDK's Spec layer uses for a contracttype enum. */
export interface SpecUnion {
  tag: string
  values: unknown[]
}

function assertSymbol(name: string, what: string): string {
  if (name.length === 0) {
    throw new Sep40EncodingError(`${what} is empty; it cannot be a Soroban symbol`)
  }
  if (name.length > MAX_SYMBOL_LENGTH) {
    throw new Sep40EncodingError(
      `${what} "${name}" is ${name.length} characters, over the ${MAX_SYMBOL_LENGTH}-character Soroban symbol limit`
    )
  }
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Sep40EncodingError(
      `${what} "${name}" contains characters a Soroban symbol cannot hold (letters, digits and _ only)`
    )
  }
  return name
}

/**
 * Map one of Lens's watched assets to its SEP-40 identifier on `network`.
 *
 * The asset contract address is DERIVED (`Asset#contractId` hashes the asset's
 * own LedgerKey under the network id) rather than looked up from a list, so
 * there is no hand-copied address here to get wrong — and no issuer to elide:
 * an anchored asset without an issuer is refused, because the derivation is
 * what makes the identifier mean something.
 */
export function toSep40Asset(asset: AssetId, network: NetworkName): Sep40Asset {
  if (asset.issuer === null) {
    return { kind: 'other', symbol: assertSymbol(asset.code, `native asset ${asset.code}`) }
  }
  if (!StrKey.isValidEd25519PublicKey(asset.issuer)) {
    throw new Sep40EncodingError(
      `${asset.code}: issuer "${asset.issuer}" is not a valid G... account id, so its asset contract cannot be derived`
    )
  }
  const passphrase = getNetworkConfig(network).network.passphrase
  let contractId: string
  try {
    contractId = new StellarAsset(asset.code, asset.issuer).contractId(passphrase)
  } catch (err) {
    throw new Sep40EncodingError(
      `${asset.code}:${asset.issuer} has no Stellar Asset Contract id on ${network}: ${(err as Error).message}`
    )
  }
  return { kind: 'stellar', contractId }
}

/** Canonical string identity of a `Sep40Asset`, used as a map key and for equality. */
export function assetKey(asset: Sep40Asset): string {
  return asset.kind === 'stellar' ? `stellar:${asset.contractId}` : `other:${asset.symbol}`
}

export function assetToSpecArg(asset: Sep40Asset): SpecUnion {
  return asset.kind === 'stellar'
    ? { tag: 'Stellar', values: [asset.contractId] }
    : { tag: 'Other', values: [asset.symbol] }
}

/** Inverse of {@link assetToSpecArg}, for values read back from the feed. */
export function assetFromSpecArg(value: SpecUnion | unknown): Sep40Asset {
  if (!value || typeof value !== 'object' || !('tag' in value) || !('values' in value)) {
    throw new Sep40EncodingError(`expected a SEP-40 Asset, got ${JSON.stringify(value)}`)
  }
  const { tag, values } = value as SpecUnion
  const first = values?.[0]
  if (tag === 'Stellar') {
    if (typeof first !== 'string' || !StrKey.isValidContract(first)) {
      throw new Sep40EncodingError(`Asset::Stellar carried "${String(first)}", which is not a C... contract id`)
    }
    return { kind: 'stellar', contractId: first }
  }
  if (tag === 'Other') {
    if (typeof first !== 'string') {
      throw new Sep40EncodingError(`Asset::Other carried ${String(first)}, which is not a symbol`)
    }
    return { kind: 'other', symbol: assertSymbol(first, 'Asset::Other') }
  }
  throw new Sep40EncodingError(`unknown SEP-40 Asset variant "${String(tag)}"`)
}

/**
 * Build the `Asset` SCVal by hand: a Soroban `contracttype` enum's tuple
 * variant is `Vec [ Symbol(variant), ...fields ]` (see `unionToNative` in the
 * SDK's Spec layer, which decodes exactly this shape).
 *
 * Exported so the encoding is asserted in tests rather than only observed when
 * a write fails on chain.
 */
export function assetToScVal(asset: Sep40Asset): xdr.ScVal {
  if (asset.kind === 'stellar') {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('Stellar'),
      new Address(asset.contractId).toScVal(),
    ])
  }
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Other'),
    xdr.ScVal.scvSymbol(assertSymbol(asset.symbol, 'Asset::Other')),
  ])
}

/** Read an `Asset` SCVal back (used by tests and by any raw-footprint decode). */
export function assetFromScVal(value: xdr.ScVal): Sep40Asset {
  const vec = value.vec()
  if (!vec || vec.length !== 2) {
    throw new Sep40EncodingError('expected a SEP-40 Asset encoded as Vec[Symbol, value]')
  }
  const tag = vec[0].sym().toString()
  if (tag === 'Stellar') {
    const contractId = Address.fromScVal(vec[1]).toString()
    if (!StrKey.isValidContract(contractId)) {
      throw new Sep40EncodingError(`Asset::Stellar decoded to "${contractId}", not a contract address`)
    }
    return { kind: 'stellar', contractId }
  }
  if (tag === 'Other') {
    return { kind: 'other', symbol: assertSymbol(vec[1].sym().toString(), 'Asset::Other') }
  }
  throw new Sep40EncodingError(`unknown SEP-40 Asset variant "${tag}"`)
}

/**
 * Scale a human-readable price into the `i128` the feed stores.
 *
 * Done through a fixed-point string, not `price * 10 ** decimals`: that product
 * is not even an integer for ordinary prices (`0.29 * 1e14` is
 * 28999999999999.996), so `BigInt()` of it throws and `Math.round()` of it
 * publishes a value a fraction of a ULP away from what the aggregate said. The
 * drift is invisible either way, and it lands on chain where every consumer
 * trusts it. `toFixed(decimals)` is exact to the decimal expansion of the value
 * we hold and rounds once, in the same place every other price reader rounds.
 */
export function scalePrice(price: number, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Sep40EncodingError(
      `decimals must be an integer between 0 and 36 (the feed was configured with ${decimals})`
    )
  }
  if (!Number.isFinite(price)) {
    throw new Sep40EncodingError(`price ${price} is not a finite number`)
  }
  if (price <= 0) {
    throw new Sep40EncodingError(
      `price ${price} is not positive; a zero or negative feed price is refused rather than published`
    )
  }
  const text = price.toFixed(decimals)
  if (!/^\d+(\.\d+)?$/.test(text)) {
    // toFixed switches to exponential notation past 1e21, where the digit
    // string below would no longer be a number at all.
    throw new Sep40EncodingError(`price ${price} cannot be written in fixed-point at ${decimals} decimals`)
  }
  const [whole, fraction = ''] = text.split('.')
  const scaled = BigInt(whole + fraction)
  if (scaled > I128_MAX) {
    throw new Sep40EncodingError(
      `price ${price} at ${decimals} decimals overflows i128; lower the feed's decimals`
    )
  }
  return scaled
}

/**
 * Inverse of {@link scalePrice}. Lossy by construction (a JS number holds ~15
 * significant digits), and used only to compare two prices for deviation, never
 * to produce a published value.
 */
export function unscalePrice(scaled: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Sep40EncodingError(`decimals must be a non-negative integer (got ${decimals})`)
  }
  const text = scaled.toString().padStart(decimals + 1, '0')
  const split = text.length - decimals
  return Number(`${text.slice(0, split)}.${text.slice(split) || '0'}`)
}

/**
 * Trim a wall-clock reading to the feed's tick, per SEP-40:
 * `floor(unix_now() / resolution) * resolution`.
 *
 * Trimming is what lets a consumer treat two reports in the same tick as the
 * same point on the timeline, and the contract re-checks it, so a value that
 * skipped this step is rejected rather than silently stored.
 */
export function trimTimestamp(nowMs: number, resolutionSeconds: number): number {
  if (!Number.isInteger(resolutionSeconds) || resolutionSeconds <= 0) {
    throw new Sep40EncodingError(
      `resolution must be a positive whole number of seconds (the feed was configured with ${resolutionSeconds})`
    )
  }
  const unixSeconds = Math.floor(nowMs / 1000)
  return Math.floor(unixSeconds / resolutionSeconds) * resolutionSeconds
}

/** `Vec<Symbol>` of the venues behind an aggregate, as the contract wants it. */
export function venuesToSpecArg(venues: string[]): string[] {
  if (venues.length === 0) {
    throw new Sep40EncodingError(
      'an aggregate with no named venue is not publishable; a price you cannot source is worse than no price'
    )
  }
  if (venues.length > MAX_VENUES) {
    throw new Sep40EncodingError(
      `${venues.length} venues exceed the feed's limit of ${MAX_VENUES}`
    )
  }
  // Sorted and de-duplicated: the venue list is part of the report's identity,
  // and the same set of markets must not produce two different on-chain values
  // because rows came back in a different order. `[...venues]` first, so the
  // caller's array is not sorted in place under them.
  return [...new Set([...venues].sort())].map(venue => assertSymbol(venue, `venue ${venue}`))
}

export function venuesToScVal(venues: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(venuesToSpecArg(venues).map(name => xdr.ScVal.scvSymbol(name)))
}
