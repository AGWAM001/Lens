import { Asset } from '@stellar/stellar-sdk'
import { pgPool } from '../db'
import { getHorizonServer } from '../network/clients'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { getActivePairs } from '../pairsRegistry'
import { createLogger } from '../logger'
import type { WatchedPair } from '../types'

const log = createLogger('coverage')

// Supported windows → lookback in hours.
export const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

export type CoverageWindow = keyof typeof WINDOW_HOURS
export const COVERAGE_WINDOWS = Object.keys(WINDOW_HOURS) as CoverageWindow[]

export const CANONICAL_USDC: Record<NetworkName, { code: string; issuer: string }> = {
  mainnet: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
  testnet: {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
}

export interface ParsedAsset {
  code: string
  issuer: string | null
  canonical: string
  horizon: Asset
}

export interface CoverageCalculationResult {
  coverageRatio: number | null
  status: 'computed' | 'unanswerable'
  reason?: string
}

export interface IndexedActivityResult {
  totalVolume: number
  tradeCount: number
  byVenue: Record<string, number>
  venues: string[]
  sampleCount: number
  lastIndexedTrade: string | null
  dataAgeSeconds: number | null
  hasGap: boolean
}

export interface HorizonActivityResult {
  ok: boolean
  totalVolume: number
  tradeCount: number
  sampleCount: number
  horizonUrl: string
  error?: string
}

export interface AssetCoverageResponse {
  asset: string
  network: NetworkName
  window: CoverageWindow
  startTime: string
  endTime: string
  coverageRatio: number | null
  status: 'computed' | 'unanswerable'
  reason: string | null
  indexed: {
    totalVolume: number
    tradeCount: number
    byVenue: Record<string, number>
    venues: string[]
  }
  networkActivity: {
    totalVolume: number
    tradeCount: number
    source: 'horizon'
    horizonUrl: string
  } | null
  tradeCoverageRatio: number | null
  provenance: {
    venues: string[]
    indexedSampleCount: number
    networkSampleCount: number
    lastIndexedTrade: string | null
    dataAgeSeconds: number | null
    hasGap: boolean
    asOf: string
    horizonUrl: string
  }
  methodology: string
}

export interface OverallCoverageResponse {
  network: NetworkName
  window: CoverageWindow
  startTime: string
  endTime: string
  overall: {
    tradeCoverageRatio: number | null
    volumeCoverageRatio: number | null
    totalIndexedTrades: number
    totalNetworkTrades: number
    assetsTracked: number
    assetsWithActivity: number
    status: 'computed' | 'unanswerable'
    reason: string | null
    venues: string[]
  }
  assets: Array<{
    asset: string
    coverageRatio: number | null
    indexedVolume: number
    networkVolume: number
    indexedTradeCount: number
    networkTradeCount: number
    status: 'computed' | 'unanswerable'
    reason: string | null
    byVenue: Record<string, number>
    venues: string[]
    lastIndexedTrade: string | null
  }>
  provenance: {
    venues: string[]
    indexedSampleCount: number
    networkSampleCount: number
    asOf: string
    horizonUrl: string
    window: CoverageWindow
    startTime: string
    endTime: string
  }
  methodology: string
}

/**
 * Computes coverage ratio as indexedVolume / networkVolume.
 *
 * Rules:
 * 1. Both inputs must be non-negative finite numbers.
 * 2. If networkVolume <= 0, coverage cannot be answered honestly: division by zero
 *    would yield Infinity, and 0 would lie that Lens missed an active market.
 *    Returns null with status 'unanswerable'.
 * 3. If indexedVolume === 0 and networkVolume > 0, ratio is 0.0 (0% coverage):
 *    an honest, unflattering report that Lens indexed none of the market's activity.
 * 4. If indexedVolume > 0 and networkVolume > 0, ratio is indexedVolume / networkVolume.
 *    May be > 1.0 when Lens indexes venues outside Horizon (e.g. Soroban contracts).
 */
export function computeCoverageRatio(
  indexedVolume: number,
  networkVolume: number
): CoverageCalculationResult {
  if (
    !Number.isFinite(indexedVolume) ||
    !Number.isFinite(networkVolume) ||
    indexedVolume < 0 ||
    networkVolume < 0
  ) {
    return {
      coverageRatio: null,
      status: 'unanswerable',
      reason: 'Volume figures must be non-negative finite numbers',
    }
  }

  if (networkVolume === 0) {
    return {
      coverageRatio: null,
      status: 'unanswerable',
      reason: 'No network activity observed on Horizon in the requested window (zero network volume)',
    }
  }

  const raw = indexedVolume / networkVolume
  const coverageRatio = Math.round(raw * 1e6) / 1e6
  return {
    coverageRatio,
    status: 'computed',
  }
}

/**
 * Computes trade coverage ratio as indexedTrades / networkTrades.
 */
export function computeTradeCoverageRatio(
  indexedTrades: number,
  networkTrades: number
): CoverageCalculationResult {
  if (
    !Number.isFinite(indexedTrades) ||
    !Number.isFinite(networkTrades) ||
    indexedTrades < 0 ||
    networkTrades < 0
  ) {
    return {
      coverageRatio: null,
      status: 'unanswerable',
      reason: 'Trade counts must be non-negative finite numbers',
    }
  }

  if (networkTrades === 0) {
    return {
      coverageRatio: null,
      status: 'unanswerable',
      reason: 'No network trades observed on Horizon in the requested window',
    }
  }

  const raw = indexedTrades / networkTrades
  const coverageRatio = Math.round(raw * 1e6) / 1e6
  return {
    coverageRatio,
    status: 'computed',
  }
}

/**
 * Parses an asset identifier into a validated ParsedAsset structure.
 * Supports:
 * - 'XLM', 'native', 'XLM:native' -> native XLM asset
 * - 'CODE:ISSUER' with full 56-character public key
 * - 'CODE' alone when unambiguous across active pairs or canonical defaults
 */
export function parseAssetString(
  raw: string,
  pairs: readonly WatchedPair[] = getActivePairs()
): ParsedAsset {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('/')) {
    throw new Error(`Invalid asset identifier "${raw}"`)
  }

  const parts = trimmed.split(':')
  if (parts.length > 2 || !parts[0]) {
    throw new Error(`Invalid asset identifier "${raw}"`)
  }

  const code = parts[0].toUpperCase()
  const issuer = parts[1]?.trim() || null

  if (code === 'XLM' && (!issuer || issuer.toLowerCase() === 'native')) {
    return { code: 'XLM', issuer: null, canonical: 'XLM', horizon: Asset.native() }
  }

  if (issuer && issuer.toLowerCase() !== 'native') {
    if (!/^G[A-Z2-7]{55}$/.test(issuer)) {
      throw new Error(`Invalid asset issuer "${issuer}" — expected 56-character Stellar public key`)
    }
    return { code, issuer, canonical: `${code}:${issuer}`, horizon: new Asset(code, issuer) }
  }

  // Code given without issuer: check if it matches a watched pair
  const matches = pairs.filter(
    p => (p.assetA.code === code && p.assetA.issuer) || (p.assetB.code === code && p.assetB.issuer)
  )
  if (matches.length > 0) {
    const matchedAsset = matches[0].assetA.code === code ? matches[0].assetA : matches[0].assetB
    if (matchedAsset.issuer) {
      return {
        code,
        issuer: matchedAsset.issuer,
        canonical: `${code}:${matchedAsset.issuer}`,
        horizon: new Asset(code, matchedAsset.issuer),
      }
    }
  }

  // Fallback to canonical USDC if USDC was requested without issuer
  if (code === 'USDC') {
    const defaultUsdc = CANONICAL_USDC[activeNetwork]
    return {
      code: 'USDC',
      issuer: defaultUsdc.issuer,
      canonical: `USDC:${defaultUsdc.issuer}`,
      horizon: new Asset('USDC', defaultUsdc.issuer),
    }
  }

  throw new Error(`Non-native asset "${code}" must include its issuer (CODE:ISSUER)`)
}

/**
 * Fetches indexed trade activity for an asset from Postgres price_points table.
 */
export async function fetchIndexedAssetActivity(
  asset: ParsedAsset,
  network: NetworkName,
  startTime: Date,
  now: Date = new Date()
): Promise<IndexedActivityResult> {
  const assetIdent = asset.canonical
  const assetCode = asset.code

  const { rows } = await pgPool.query(
    `SELECT source,
            SUM(
              CASE
                WHEN asset_a = $1 OR asset_a = $4 THEN base_volume
                WHEN asset_b = $1 OR asset_b = $4 THEN counter_volume
                ELSE 0
              END
            )::numeric AS volume,
            COUNT(*)::int AS trade_count,
            MAX(timestamp) AS last_seen
       FROM price_points
      WHERE (asset_a = $1 OR asset_a = $4 OR asset_b = $1 OR asset_b = $4)
        AND network = $2
        AND timestamp >= $3
      GROUP BY source`,
    [assetIdent, network, startTime, assetCode],
  )

  const byVenue: Record<string, number> = {}
  let totalVolume = 0
  let tradeCount = 0
  let latestTimestamp: Date | null = null

  for (const row of rows) {
    const volume = parseFloat(row.volume) || 0
    const count = Number(row.trade_count) || 0
    byVenue[row.source] = volume
    totalVolume += volume
    tradeCount += count
    if (row.last_seen) {
      const seen = new Date(row.last_seen)
      if (!latestTimestamp || seen > latestTimestamp) {
        latestTimestamp = seen
      }
    }
  }

  const venues = Object.keys(byVenue).sort()
  const lastIndexedTrade = latestTimestamp ? latestTimestamp.toISOString() : null
  const dataAgeSeconds = latestTimestamp
    ? Math.max(0, Math.floor((now.getTime() - latestTimestamp.getTime()) / 1000))
    : null

  const hasGap = tradeCount === 0 || (dataAgeSeconds !== null && dataAgeSeconds > 6 * 3600)

  return {
    totalVolume,
    tradeCount,
    byVenue,
    venues,
    sampleCount: tradeCount,
    lastIndexedTrade,
    dataAgeSeconds,
    hasGap,
  }
}

/**
 * Resolves pairs containing an asset, checking watched pairs, DB price_points,
 * or creating canonical counter-asset pairings.
 */
async function resolvePairsForAsset(
  asset: ParsedAsset,
  pairs: readonly WatchedPair[],
  network: NetworkName
): Promise<Array<{ base: Asset; counter: Asset; isBase: boolean; pairKey: string }>> {
  const matchingPairs: Array<{ base: Asset; counter: Asset; isBase: boolean; pairKey: string }> = []
  const seenKeys = new Set<string>()

  // 1. From active watched pairs
  for (const p of pairs) {
    const aMatch =
      p.assetA.code === asset.code && (p.assetA.issuer === asset.issuer || asset.code === 'XLM')
    const bMatch =
      p.assetB.code === asset.code && (p.assetB.issuer === asset.issuer || asset.code === 'XLM')

    if (aMatch || bMatch) {
      const base = p.assetA.issuer ? new Asset(p.assetA.code, p.assetA.issuer) : Asset.native()
      const counter = p.assetB.issuer ? new Asset(p.assetB.code, p.assetB.issuer) : Asset.native()
      seenKeys.add(p.pairKey)
      matchingPairs.push({ base, counter, isBase: aMatch, pairKey: p.pairKey })
    }
  }

  // 2. From price_points table for this asset and network
  try {
    const { rows } = await pgPool.query(
      `SELECT DISTINCT asset_a, asset_b, pair_key
         FROM price_points
        WHERE (asset_a = $1 OR asset_a = $3 OR asset_b = $1 OR asset_b = $3)
          AND network = $2`,
      [asset.canonical, network, asset.code],
    )

    for (const row of rows) {
      if (seenKeys.has(row.pair_key)) continue
      seenKeys.add(row.pair_key)

      const assetAParts = row.asset_a.split(':')
      const assetBParts = row.asset_b.split(':')

      const base =
        assetAParts[0] === 'XLM' || !assetAParts[1]
          ? Asset.native()
          : new Asset(assetAParts[0], assetAParts[1])
      const counter =
        assetBParts[0] === 'XLM' || !assetBParts[1]
          ? Asset.native()
          : new Asset(assetBParts[0], assetBParts[1])

      const isBase =
        assetAParts[0] === asset.code &&
        (assetAParts[1] === asset.issuer || asset.code === 'XLM')

      matchingPairs.push({ base, counter, isBase, pairKey: row.pair_key })
    }
  } catch {
    // Ignore DB errors during pair discovery; rely on remaining pairs
  }

  // 3. Fallback pairing if no pairs found: pair with canonical counter asset
  if (matchingPairs.length === 0) {
    if (asset.code === 'XLM') {
      const usdcDef = CANONICAL_USDC[network]
      const usdcAsset = new Asset(usdcDef.code, usdcDef.issuer)
      matchingPairs.push({
        base: Asset.native(),
        counter: usdcAsset,
        isBase: true,
        pairKey: `XLM/${usdcDef.code}:${usdcDef.issuer}`,
      })
    } else {
      matchingPairs.push({
        base: asset.horizon,
        counter: Asset.native(),
        isBase: true,
        pairKey: `${asset.canonical}/XLM`,
      })
    }
  }

  return matchingPairs
}

/**
 * Fetches total on-chain network trade activity for an asset from Stellar Horizon.
 */
export async function fetchHorizonAssetActivity(
  asset: ParsedAsset,
  pairs: readonly WatchedPair[],
  network: NetworkName,
  startTime: Date,
  endTime: Date,
  resolutionMs: number
): Promise<HorizonActivityResult> {
  const horizonUrl = getNetworkConfig(network).horizon.url
  const server = getHorizonServer(network)

  const matchingPairs = await resolvePairsForAsset(asset, pairs, network)

  let totalVolume = 0
  let tradeCount = 0
  let sampleCount = 0

  for (const pair of matchingPairs) {
    try {
      const call = server.tradeAggregation(
        pair.base,
        pair.counter,
        startTime.getTime(),
        endTime.getTime(),
        resolutionMs,
        0
      )
      const res = await call.limit(200).call()
      const records = (res as any).records ?? []
      sampleCount += records.length

      for (const rec of records) {
        const vol = parseFloat(pair.isBase ? rec.base_volume : rec.counter_volume) || 0
        const trades = parseInt(String(rec.trade_count), 10) || 0
        totalVolume += vol
        tradeCount += trades
      }
    } catch (err) {
      log.warn({ pair: pair.pairKey, network, err }, 'Failed to fetch trade aggregations from Horizon')
      return {
        ok: false,
        totalVolume,
        tradeCount,
        sampleCount,
        horizonUrl,
        error: (err as Error).message,
      }
    }
  }

  return {
    ok: true,
    totalVolume,
    tradeCount,
    sampleCount,
    horizonUrl,
  }
}

/**
 * Computes market coverage for a single asset.
 */
export async function getAssetCoverage(
  assetRaw: string,
  window: CoverageWindow = '24h',
  network: NetworkName = activeNetwork
): Promise<AssetCoverageResponse> {
  const hours = WINDOW_HOURS[window]
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)
  const resolutionMs = hours <= 24 ? 3600000 : 86400000

  const asset = parseAssetString(assetRaw)
  const pairs = getActivePairs()

  const indexed = await fetchIndexedAssetActivity(asset, network, startTime, endTime)
  const horizon = await fetchHorizonAssetActivity(
    asset,
    pairs,
    network,
    startTime,
    endTime,
    resolutionMs
  )

  let coverageRatio: number | null = null
  let tradeCoverageRatio: number | null = null
  let status: 'computed' | 'unanswerable' = 'computed'
  let reason: string | null = null

  if (!horizon.ok) {
    status = 'unanswerable'
    reason = `Horizon API unreachable: ${horizon.error ?? 'Unknown error'}`
  } else {
    const volResult = computeCoverageRatio(indexed.totalVolume, horizon.totalVolume)
    coverageRatio = volResult.coverageRatio
    if (volResult.status === 'unanswerable') {
      status = 'unanswerable'
      reason = volResult.reason ?? 'No network volume to compute coverage against'
    }

    const tradeResult = computeTradeCoverageRatio(indexed.tradeCount, horizon.tradeCount)
    tradeCoverageRatio = tradeResult.coverageRatio
  }

  return {
    asset: asset.canonical,
    network,
    window,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    coverageRatio,
    status,
    reason,
    indexed: {
      totalVolume: indexed.totalVolume,
      tradeCount: indexed.tradeCount,
      byVenue: indexed.byVenue,
      venues: indexed.venues,
    },
    networkActivity: horizon.ok
      ? {
          totalVolume: horizon.totalVolume,
          tradeCount: horizon.tradeCount,
          source: 'horizon',
          horizonUrl: horizon.horizonUrl,
        }
      : null,
    tradeCoverageRatio,
    provenance: {
      venues: indexed.venues,
      indexedSampleCount: indexed.sampleCount,
      networkSampleCount: horizon.sampleCount,
      lastIndexedTrade: indexed.lastIndexedTrade,
      dataAgeSeconds: indexed.dataAgeSeconds,
      hasGap: indexed.hasGap,
      asOf: endTime.toISOString(),
      horizonUrl: horizon.horizonUrl,
    },
    methodology:
      'Market coverage ratio is computed as indexed.totalVolume / networkActivity.totalVolume over the window [startTime, endTime]. ' +
      'Indexed volume is summed from Lens price_points across indexed venues for the specified asset. ' +
      'Network activity is queried from Stellar Horizon trade aggregations for all watched pairs containing the asset over the same window. ' +
      'When network volume is zero (no on-chain activity), coverageRatio is reported as null with status "unanswerable" to avoid misleading zero reports. ' +
      'When indexed volume is zero and network volume is positive, coverageRatio is 0.0 (0% coverage), published regardless of value.',
  }
}

/**
 * Computes overall market coverage across all tracked assets.
 */
export async function getOverallCoverage(
  window: CoverageWindow = '24h',
  network: NetworkName = activeNetwork
): Promise<OverallCoverageResponse> {
  const hours = WINDOW_HOURS[window]
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)
  const resolutionMs = hours <= 24 ? 3600000 : 86400000

  const pairs = getActivePairs()
  const assetMap = new Map<string, ParsedAsset>()

  // Add assets from watched pairs
  for (const pair of pairs) {
    const aIdent = pair.assetA.issuer ? `${pair.assetA.code}:${pair.assetA.issuer}` : pair.assetA.code
    const bIdent = pair.assetB.issuer ? `${pair.assetB.code}:${pair.assetB.issuer}` : pair.assetB.code

    if (!assetMap.has(aIdent)) {
      assetMap.set(aIdent, {
        code: pair.assetA.code,
        issuer: pair.assetA.issuer,
        canonical: aIdent,
        horizon: pair.assetA.issuer
          ? new Asset(pair.assetA.code, pair.assetA.issuer)
          : Asset.native(),
      })
    }
    if (!assetMap.has(bIdent)) {
      assetMap.set(bIdent, {
        code: pair.assetB.code,
        issuer: pair.assetB.issuer,
        canonical: bIdent,
        horizon: pair.assetB.issuer
          ? new Asset(pair.assetB.code, pair.assetB.issuer)
          : Asset.native(),
      })
    }
  }

  // Add distinct assets from price_points table for this network
  try {
    const { rows } = await pgPool.query(
      `SELECT DISTINCT asset_a, asset_b FROM price_points WHERE network = $1`,
      [network],
    )
    for (const row of rows) {
      for (const assetStr of [row.asset_a, row.asset_b]) {
        if (!assetStr || assetMap.has(assetStr)) continue
        try {
          const parsed = parseAssetString(assetStr, pairs)
          assetMap.set(parsed.canonical, parsed)
        } catch {
          // Skip unparseable identifiers
        }
      }
    }
  } catch {
    // Ignore query failure
  }

  // Ensure default assets exist (XLM and canonical USDC)
  if (!assetMap.has('XLM')) {
    assetMap.set('XLM', { code: 'XLM', issuer: null, canonical: 'XLM', horizon: Asset.native() })
  }
  const usdcDef = CANONICAL_USDC[network]
  const usdcKey = `USDC:${usdcDef.issuer}`
  if (!assetMap.has(usdcKey)) {
    assetMap.set(usdcKey, {
      code: 'USDC',
      issuer: usdcDef.issuer,
      canonical: usdcKey,
      horizon: new Asset('USDC', usdcDef.issuer),
    })
  }

  const assetResults: OverallCoverageResponse['assets'] = []
  let totalIndexedTrades = 0
  let totalNetworkTrades = 0
  let totalIndexedVolume = 0
  let totalNetworkVolume = 0
  let totalIndexedSamples = 0
  let totalNetworkSamples = 0
  const allVenues = new Set<string>()
  let assetsWithActivity = 0

  for (const asset of assetMap.values()) {
    const indexed = await fetchIndexedAssetActivity(asset, network, startTime, endTime)
    const horizon = await fetchHorizonAssetActivity(
      asset,
      pairs,
      network,
      startTime,
      endTime,
      resolutionMs
    )

    for (const v of indexed.venues) {
      allVenues.add(v)
    }

    totalIndexedTrades += indexed.tradeCount
    totalIndexedSamples += indexed.sampleCount
    totalNetworkTrades += horizon.tradeCount
    totalNetworkSamples += horizon.sampleCount

    totalIndexedVolume += indexed.totalVolume
    totalNetworkVolume += horizon.totalVolume

    const volResult = horizon.ok
      ? computeCoverageRatio(indexed.totalVolume, horizon.totalVolume)
      : { coverageRatio: null, status: 'unanswerable' as const, reason: horizon.error }

    if (horizon.totalVolume > 0 || indexed.totalVolume > 0) {
      assetsWithActivity++
    }

    assetResults.push({
      asset: asset.canonical,
      coverageRatio: volResult.coverageRatio,
      indexedVolume: indexed.totalVolume,
      networkVolume: horizon.totalVolume,
      indexedTradeCount: indexed.tradeCount,
      networkTradeCount: horizon.tradeCount,
      status: volResult.status,
      reason: volResult.reason ?? null,
      byVenue: indexed.byVenue,
      venues: indexed.venues,
      lastIndexedTrade: indexed.lastIndexedTrade,
    })
  }

  const overallTradeCoverage = computeTradeCoverageRatio(totalIndexedTrades, totalNetworkTrades)
  const overallVolCoverage = computeCoverageRatio(totalIndexedVolume, totalNetworkVolume)

  const horizonUrl = getNetworkConfig(network).horizon.url

  return {
    network,
    window,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    overall: {
      tradeCoverageRatio: overallTradeCoverage.coverageRatio,
      volumeCoverageRatio: overallVolCoverage.coverageRatio,
      totalIndexedTrades,
      totalNetworkTrades,
      assetsTracked: assetMap.size,
      assetsWithActivity,
      status: overallTradeCoverage.status,
      reason: overallTradeCoverage.reason ?? null,
      venues: Array.from(allVenues).sort(),
    },
    assets: assetResults,
    provenance: {
      venues: Array.from(allVenues).sort(),
      indexedSampleCount: totalIndexedSamples,
      networkSampleCount: totalNetworkSamples,
      asOf: endTime.toISOString(),
      horizonUrl,
      window,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    },
    methodology:
      'Overall market coverage compares cumulative trade volume and trade counts indexed by Lens across its configured venues against total network activity from Horizon across all watched assets over the window. ' +
      'Overall tradeCoverageRatio = totalIndexedTrades / totalNetworkTrades. ' +
      'Overall volumeCoverageRatio = totalIndexedVolume / totalNetworkVolume. ' +
      'Per-asset coverageRatio = indexedVolume / networkVolume. ' +
      'When network activity is zero, ratios are reported as null with status "unanswerable". ' +
      'When indexed activity is zero and network activity is positive, ratios are 0.0, published regardless of value.',
  }
}
