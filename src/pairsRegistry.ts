import { config, activeNetwork, getNetworkConfig, type NetworkName } from './config'
import { prisma } from './db'
import type { WatchedPair, AssetId } from './types'

// ─── Mutable runtime pairs store ─────────────────────────────────────────────
const activePairs: WatchedPair[] = [...config.pairs]

export function getActivePairs(): readonly WatchedPair[] {
  return activePairs
}

/**
 * Returns the watched pairs for `network`. On this process's own active network,
 * runtime-registered pairs added via POST /pairs are included alongside configured pairs;
 * other networks use their declared static config so a pair watched on one network never leaks to another.
 */
export function getPairsForNetwork(network: NetworkName = activeNetwork): readonly WatchedPair[] {
  const configured = getNetworkConfig(network).pairs
  if (network !== activeNetwork) return configured
  const seen = new Set(configured.map(p => p.pairKey))
  const merged = [...configured]
  for (const pair of activePairs) {
    if (!seen.has(pair.pairKey)) {
      seen.add(pair.pairKey)
      merged.push(pair)
    }
  }
  return merged
}

export function hasPair(pairKey: string): boolean {
  return activePairs.some(p => p.pairKey === pairKey)
}

/** Add a new pair to the in-memory registry. Returns false if already present. */
export function registerPair(pair: WatchedPair): boolean {
  if (hasPair(pair.pairKey)) return false
  activePairs.push(pair)
  return true
}

// ─── Asset format helpers ─────────────────────────────────────────────────────
export function parseAssetStr(str: string): AssetId | null {
  const parts = str.split(':')
  if (parts.length < 1 || parts.length > 2) return null
  const code = parts[0].trim().toUpperCase()
  if (!code || code.length > 12) return null
  const issuer = parts[1] && parts[1].toLowerCase() !== 'native' ? parts[1].trim() : null
  if (issuer && !/^G[A-Z2-7]{55}$/.test(issuer)) return null
  return { code, issuer }
}

export function makePairKey(a: AssetId, b: AssetId): string {
  const aStr = a.issuer ? `${a.code}:${a.issuer}` : a.code
  const bStr = b.issuer ? `${b.code}:${b.issuer}` : b.code
  return [aStr, bStr].sort().join('/')
}

// ─── Persistence ──────────────────────────────────────────────────────────────
/** Persist a new pair to DB so it survives restarts. */
export async function persistPair(pair: WatchedPair): Promise<void> {
  await prisma.pairConfig.upsert({
    where: { network_pairKey: { network: activeNetwork, pairKey: pair.pairKey } },
    create: {
      network: activeNetwork,
      pairKey: pair.pairKey,
      assetACode: pair.assetA.code,
      assetAIssuer: pair.assetA.issuer,
      assetBCode: pair.assetB.code,
      assetBIssuer: pair.assetB.issuer,
    },
    update: {},
  })
}

/** Load persisted pairs from DB and merge into the active registry. */
export async function loadPersistedPairs(): Promise<void> {
  const rows = await prisma.pairConfig.findMany({ where: { network: activeNetwork } })
  for (const row of rows) {
    const pair: WatchedPair = {
      assetA: { code: row.assetACode, issuer: row.assetAIssuer },
      assetB: { code: row.assetBCode, issuer: row.assetBIssuer },
      pairKey: row.pairKey,
    }
    registerPair(pair)
  }
}
