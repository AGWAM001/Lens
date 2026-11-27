import { getNetworkConfig, type NetworkName, type PeggedAssetConfig } from '../config'
import { pgPool } from '../db'
import type { AssetId, WatchedPair } from '../types'

/**
 * A USD price is only meaningful for a pair whose other side is configured as
 * a USD peg. A stored price is assetB per one assetA, so the answer depends on
 * which side of the pair the requested asset is on; this module picks the pair
 * from configuration (issuer included) and orients the SQL aggregate, rather
 * than guessing from whatever row happens to mention the asset code.
 */

export interface AssetRef {
  code: string
  /** `undefined` means "not given"; `null` means the native asset (XLM). */
  issuer?: string | null
}

export type UsdPriceStatus = 'ok' | 'pegged' | 'unknown'

export type UsdPriceReason =
  | 'found'
  | 'asset_is_usd_peg'
  | 'unknown_asset'
  | 'ambiguous_asset'
  | 'no_usd_pair'
  | 'no_recent_samples'

export interface UsdPriceResult {
  /** Canonical asset identifier: `CODE:ISSUER`, or `CODE` for the native asset. */
  asset: string
  network: NetworkName
  status: UsdPriceStatus
  /** Decimal string as returned by Postgres numeric; null when unknown. */
  price: string | null
  reason: UsdPriceReason
  /** The watched pair that produced the price, when one was found. */
  pair: string | null
  venues: string[]
  sampleCount: number
  lastSeen: string | null
}

/**
 * Parse a route parameter such as `XLM`, `XLM:native` or `CODE:ISSUER`.
 * Returns null for malformed input rather than mixing it with a bare code.
 */
export function parseAssetRef(raw: string): AssetRef | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('/')) return null
  const parts = trimmed.split(':')
  if (parts.length > 2 || !parts[0]) return null

  const code = parts[0].toUpperCase()
  if (parts[1]) {
    const issuer = parts[1].trim()
    if (issuer.toLowerCase() === 'native') return { code, issuer: null }
    return { code, issuer: issuer.toUpperCase() }
  }
  return { code, issuer: code === 'XLM' ? null : undefined }
}

function normalizedIssuer(issuer: string | null | undefined): string | null {
  return issuer ? issuer.toUpperCase() : null
}

function sameAsset(a: AssetRef | AssetId, b: AssetRef | AssetId): boolean {
  return (
    a.code.toUpperCase() === b.code.toUpperCase() &&
    normalizedIssuer(a.issuer) === normalizedIssuer(b.issuer)
  )
}

function assetLabel(asset: AssetRef | AssetId): string {
  const code = asset.code.toUpperCase()
  const issuer = normalizedIssuer(asset.issuer)
  return issuer ? `${code}:${issuer}` : code
}

function isUsdPeg(asset: AssetRef | AssetId, pegs: readonly PeggedAssetConfig[]): PeggedAssetConfig | undefined {
  return pegs.find(peg => sameAsset(asset, peg.asset))
}

/**
 * A bare code is safe only when configuration names exactly one asset with
 * that code. With two issuers the request is ambiguous, and picking either
 * would silently quote the other asset's market.
 */
function resolveAsset(
  ref: AssetRef,
  known: readonly AssetId[]
): { ok: true; asset: AssetId } | { ok: false; reason: 'unknown_asset' | 'ambiguous_asset' } {
  if (ref.issuer !== undefined) {
    return {
      ok: true,
      asset: { code: ref.code.toUpperCase(), issuer: normalizedIssuer(ref.issuer) },
    }
  }

  const matches = new Map<string, AssetId>()
  for (const asset of known) {
    if (asset.code.toUpperCase() === ref.code.toUpperCase()) {
      matches.set(assetLabel(asset), {
        code: asset.code.toUpperCase(),
        issuer: normalizedIssuer(asset.issuer),
      })
    }
  }

  if (matches.size === 1) {
    return { ok: true, asset: matches.values().next().value as AssetId }
  }
  return { ok: false, reason: matches.size === 0 ? 'unknown_asset' : 'ambiguous_asset' }
}

function knownAssets(pairs: readonly WatchedPair[], pegs: readonly PeggedAssetConfig[]): AssetId[] {
  const known = new Map<string, AssetId>()
  for (const pair of pairs) {
    known.set(assetLabel(pair.assetA), pair.assetA)
    known.set(assetLabel(pair.assetB), pair.assetB)
  }
  for (const peg of pegs) known.set(assetLabel(peg.asset), peg.asset)
  return Array.from(known.values())
}

interface PairCandidate {
  pair: WatchedPair
  assetIsA: boolean
}

function unknownResult(
  asset: string,
  network: NetworkName,
  reason: UsdPriceReason,
  pair: string | null = null
): UsdPriceResult {
  return {
    asset,
    network,
    status: 'unknown',
    price: null,
    reason,
    pair,
    venues: [],
    sampleCount: 0,
    lastSeen: null,
  }
}

/**
 * Price one unit of `asset` in USD, using a watched pair whose other side is a
 * configured USD peg.
 *
 * The inverse orientation is computed in SQL numeric (never JavaScript float),
 * and the chosen pair is the lexicographically smallest `pair_key` so that a
 * second qualifying pair can never change the answer without a config change.
 */
export async function usdPriceOf(
  asset: AssetRef,
  network: NetworkName,
  windowMinutes = 5
): Promise<UsdPriceResult> {
  const networkConfig = getNetworkConfig(network)
  const pairs = networkConfig.pairs ?? []
  const pegs = networkConfig.pegged ?? []
  const usdPegs = pegs.filter(peg => peg.target.toUpperCase() === 'USD')

  const resolved = resolveAsset(asset, knownAssets(pairs, pegs))
  if (!resolved.ok) {
    return unknownResult(assetLabel(asset), network, resolved.reason)
  }

  const label = assetLabel(resolved.asset)

  // The asset is itself a dollar peg: its USD price is the configured target,
  // not a market price from whichever pair happens to mention it.
  const selfPeg = isUsdPeg(resolved.asset, usdPegs)
  if (selfPeg) {
    return {
      asset: label,
      network,
      status: 'pegged',
      price: String(selfPeg.targetPrice),
      reason: 'asset_is_usd_peg',
      pair: null,
      venues: [],
      sampleCount: 0,
      lastSeen: null,
    }
  }

  const candidates: PairCandidate[] = []
  for (const pair of pairs) {
    let assetIsA: boolean
    if (sameAsset(resolved.asset, pair.assetA)) assetIsA = true
    else if (sameAsset(resolved.asset, pair.assetB)) assetIsA = false
    else continue

    const other = assetIsA ? pair.assetB : pair.assetA
    if (isUsdPeg(other, usdPegs)) candidates.push({ pair, assetIsA })
  }

  if (candidates.length === 0) {
    return unknownResult(label, network, 'no_usd_pair')
  }

  candidates.sort((a, b) => {
    if (a.pair.pairKey < b.pair.pairKey) return -1
    if (a.pair.pairKey > b.pair.pairKey) return 1
    return 0
  })
  const chosen = candidates[0]

  // Forward: the stored price already is USD per asset, so weight by the
  // asset's own volume. Inverse: asset is the quote side, and each sample is
  // converted with numeric division before the volume-weighted average.
  const priceExpr = chosen.assetIsA
    ? `SUM(price::numeric * base_volume::numeric) / NULLIF(SUM(base_volume::numeric), 0)`
    : `SUM((1::numeric / NULLIF(price::numeric, 0)) * counter_volume::numeric)
         / NULLIF(SUM(counter_volume::numeric), 0)`

  const result = await pgPool.query(
    `SELECT
       ${priceExpr} AS vwap,
       array_remove(array_agg(DISTINCT source), NULL) AS venues,
       COUNT(*)::int AS sample_count,
       MAX(COALESCE(observed_at, timestamp)) AS last_seen
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND COALESCE(observed_at, timestamp) > NOW() - ($3::int * INTERVAL '1 minute')`,
    [chosen.pair.pairKey, network, windowMinutes]
  )

  const row = result.rows[0]
  const price = row?.vwap === null || row?.vwap === undefined ? null : String(row.vwap)
  if (price === null) {
    return {
      ...unknownResult(label, network, 'no_recent_samples', chosen.pair.pairKey),
      venues: Array.isArray(row?.venues) ? row.venues : [],
    }
  }

  return {
    asset: label,
    network,
    status: 'ok',
    price,
    reason: 'found',
    pair: chosen.pair.pairKey,
    venues: Array.isArray(row?.venues) ? row.venues : [],
    sampleCount: Number(row?.sample_count) || 0,
    lastSeen: row?.last_seen ? new Date(row.last_seen).toISOString() : null,
  }
}
