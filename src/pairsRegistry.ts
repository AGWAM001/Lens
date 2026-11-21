import { getNetworkConfig, type NetworkName } from './config'
import { prisma } from './db'
import { getEnabledNetworks } from './network/enabledNetworks'
import type { WatchedPair, AssetId } from './types'

// ─── Per-network runtime pairs store ──────────────────────────────────────────
// Seeded independently from each network's declared config so dual-network
// ingesters, persistence, and runtime POST /pairs registrations stay isolated.
const pairsByNetwork: Record<NetworkName, WatchedPair[]> = {
  testnet: [...getNetworkConfig('testnet').pairs],
  mainnet: [...getNetworkConfig('mainnet').pairs],
}

export function getActivePairs(network: NetworkName): readonly WatchedPair[] {
  return pairsByNetwork[network]
}

export function hasPair(pairKey: string, network: NetworkName): boolean {
  return pairsByNetwork[network].some(p => p.pairKey === pairKey)
}

/** Add a new pair to the in-memory registry for `network`. Returns false if already present. */
export function registerPair(pair: WatchedPair, network: NetworkName): boolean {
  if (hasPair(pair.pairKey, network)) return false
  pairsByNetwork[network].push(pair)
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
/** Persist a new pair to DB for `network` so it survives restarts. */
export async function persistPair(pair: WatchedPair, network: NetworkName): Promise<void> {
  await prisma.pairConfig.upsert({
    where: { network_pairKey: { network, pairKey: pair.pairKey } },
    create: {
      network,
      pairKey: pair.pairKey,
      assetACode: pair.assetA.code,
      assetAIssuer: pair.assetA.issuer,
      assetBCode: pair.assetB.code,
      assetBIssuer: pair.assetB.issuer,
    },
    update: {},
  })
}

/** Load persisted pairs from DB for every enabled network and merge into each network's registry. */
export async function loadPersistedPairs(
  networks: readonly NetworkName[] = getEnabledNetworks()
): Promise<void> {
  if (networks.length === 0) return
  const rows = await prisma.pairConfig.findMany({
    where: { network: { in: [...networks] } },
  })
  for (const row of rows) {
    const net = row.network as NetworkName
    if (!pairsByNetwork[net]) continue
    const pair: WatchedPair = {
      assetA: { code: row.assetACode, issuer: row.assetAIssuer },
      assetB: { code: row.assetBCode, issuer: row.assetBIssuer },
      pairKey: row.pairKey,
    }
    registerPair(pair, net)
  }
}
