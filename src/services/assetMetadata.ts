import toml from 'toml'
import { StrKey } from '@stellar/stellar-sdk'
import { config, getNetworkConfig, activeNetwork, type NetworkName } from '../config'
import { createLogger } from '../logger'
import { getHorizonServer } from '../network/clients'
import { getCachedAsset, setCachedAsset } from '../redis'
import { assertUrlSafe, ssrfSafeFetch } from '../net/ssrf'
import { prisma } from '../db'
import { getActivePairs } from '../pairsRegistry'
import type { AssetId } from '../types'

const log = createLogger('asset-metadata')

export const STELLAR_TOML_MAX_SIZE = 100 * 1024

export interface AssetVerificationDetails {
  status: 'verified' | 'unverified'
  verified: boolean
  checkedAt: string
  tomlUrl: string | null
}

export interface AssetProvenance {
  source: string
  checkedAt: string
  tomlUrl: string | null
  verified: boolean
}

export interface AssetMetadata {
  code: string
  issuer: string | null
  name: string | null
  homeDomain: string | null
  domain: string | null
  decimals: number
  displayDecimals: number | null
  status: 'verified' | 'unverified'
  verified: boolean
  checkedAt: string
  dateChecked: string
  contractId: string | null
  tomlUrl: string | null
  verification: AssetVerificationDetails
  provenance: AssetProvenance
}

// In-memory fallback cache to guarantee caching with TTL even when Redis is offline or in tests.
interface CacheEntry {
  data: AssetMetadata
  expiresAt: number
}

const inMemoryCache = new Map<string, CacheEntry>()

export function clearAssetCache(): void {
  inMemoryCache.clear()
}

function getMemoryCached(key: string): AssetMetadata | null {
  const entry = inMemoryCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    inMemoryCache.delete(key)
    return null
  }
  return entry.data
}

function setMemoryCached(key: string, data: AssetMetadata, ttlSeconds: number): void {
  inMemoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttlSeconds * 1000,
  })
}

/**
 * Normalizes an asset identifier into canonical uppercase code and issuer.
 */
export function normalizeAsset(code: string, issuer?: string | null): AssetId {
  const normCode = code.trim().toUpperCase()
  const normIssuer =
    !issuer || issuer.toLowerCase() === 'native' ? null : issuer.trim()
  return { code: normCode, issuer: normIssuer }
}

/**
 * Builds the cache key for an asset on a given network.
 */
export function makeAssetCacheKey(network: NetworkName, code: string, issuer: string | null): string {
  return `${network}:${code.toUpperCase()}:${issuer ?? 'native'}`
}

/**
 * Resolves metadata for native XLM without requiring remote network requests.
 */
function resolveNativeXlm(): AssetMetadata {
  const now = new Date().toISOString()
  return {
    code: 'XLM',
    issuer: null,
    name: 'Stellar Lumens',
    homeDomain: 'stellar.org',
    domain: 'stellar.org',
    decimals: 7,
    displayDecimals: 7,
    status: 'verified',
    verified: true,
    checkedAt: now,
    dateChecked: now,
    contractId: null,
    tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
    verification: {
      status: 'verified',
      verified: true,
      checkedAt: now,
      tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
    },
    provenance: {
      source: 'stellar-protocol',
      checkedAt: now,
      tomlUrl: 'https://stellar.org/.well-known/stellar.toml',
      verified: true,
    },
  }
}

/**
 * Safely fetches and parses the stellar.toml file for a given home domain.
 * Guards against SSRF and respects the maximum TOML size limit.
 */
async function fetchAndParseToml(
  homeDomain: string,
): Promise<{ ok: boolean; toml?: Record<string, unknown>; error?: string }> {
  try {
    const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`

    // Pre-check URL safety against SSRF
    await assertUrlSafe(tomlUrl, { allowedHosts: config.outbound.allowedHosts })

    const signal = AbortSignal.timeout(config.http.timeoutMs)
    const res = await ssrfSafeFetch(
      tomlUrl,
      {
        signal,
        headers: {
          Accept: 'text/plain, application/toml, text/toml, */*',
          'User-Agent': 'Lens/0.2.0 (Stellar Asset Metadata Resolver)',
        },
      },
      {
        allowedHosts: config.outbound.allowedHosts,
      },
    )

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` }
    }

    const text = await res.text()
    if (text.length > STELLAR_TOML_MAX_SIZE) {
      return { ok: false, error: `File exceeds maximum size of ${STELLAR_TOML_MAX_SIZE} bytes` }
    }

    const parsed = toml.parse(text)
    return { ok: true, toml: parsed }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Resolves asset metadata and verification status for an asset on a given network.
 *
 * Verification rules:
 * - XLM is native and verified by definition.
 * - An issued asset is verified if and only if the issuer's stellar.toml lists the asset in [[CURRENCIES]].
 * - An absent or failing stellar.toml yields 'unverified' rather than an error.
 * - Responses are cached in Redis and local memory for the configured TTL (default 1h).
 */
export async function resolveAssetMetadata(
  asset: AssetId,
  network: NetworkName = activeNetwork,
): Promise<AssetMetadata> {
  const { code, issuer } = normalizeAsset(asset.code, asset.issuer)
  const isNative = !issuer || code === 'XLM' && (!issuer || issuer.toLowerCase() === 'native')

  if (isNative) {
    return resolveNativeXlm()
  }

  const cacheKey = makeAssetCacheKey(network, code, issuer)
  const ttlSeconds = config.cache.assetTtl ?? 3600

  // 1. Check local in-memory cache
  const memCached = getMemoryCached(cacheKey)
  if (memCached) {
    return memCached
  }

  // 2. Check Redis cache
  const redisCached = await getCachedAsset(network, `${code}:${issuer}`)
  if (redisCached) {
    try {
      const parsed = JSON.parse(redisCached) as AssetMetadata
      setMemoryCached(cacheKey, parsed, ttlSeconds)
      return parsed
    } catch {
      // Ignore cache JSON parse failure and proceed to re-resolve
    }
  }

  const now = new Date().toISOString()
  let homeDomain: string | null = null
  let contractId: string | null = null
  let tomlUrl: string | null = null

  // 3. Query Horizon for issuer home domain and asset info
  try {
    const horizon = getHorizonServer(network)

    // Load account to obtain home_domain
    if (issuer && StrKey.isValidEd25519PublicKey(issuer)) {
      try {
        const account = await horizon.loadAccount(issuer)
        if (account.home_domain) {
          homeDomain = account.home_domain.trim()
        }
      } catch (accErr) {
        log.debug({ issuer, network, err: accErr }, 'could not load issuer account from horizon')
      }

      // Query Horizon assets endpoint to find contract_id and fallback toml link
      try {
        const assetsRes = await horizon.assets().forCode(code).forIssuer(issuer).call()
        const match = assetsRes.records?.[0] as unknown as Record<string, any> | undefined
        if (match) {
          if (typeof match.contract_id === 'string' && match.contract_id.length > 0) {
            contractId = match.contract_id
          }
          if (!homeDomain && match._links?.toml?.href) {
            try {
              const url = new URL(match._links.toml.href)
              homeDomain = url.hostname
            } catch {
              // ignore invalid url
            }
          }
        }
      } catch (assetErr) {
        log.debug({ code, issuer, network, err: assetErr }, 'could not query horizon assets endpoint')
      }
    }
  } catch (err) {
    log.warn({ code, issuer, network, err }, 'horizon lookup failed for asset')
  }

  // 4. Verify against issuer's stellar.toml
  let status: 'verified' | 'unverified' = 'unverified'
  let verified = false
  let name: string | null = null
  let decimals = 7
  let displayDecimals: number | null = null

  if (homeDomain) {
    tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`
    const tomlResult = await fetchAndParseToml(homeDomain)

    if (tomlResult.ok && tomlResult.toml) {
      const currencies = (tomlResult.toml.CURRENCIES ?? tomlResult.toml.currencies) as Array<Record<string, unknown>> | undefined
      if (Array.isArray(currencies)) {
        const matched = currencies.find(c => {
          if (!c || typeof c.code !== 'string') return false
          if (c.code.toUpperCase() !== code.toUpperCase()) return false
          // If issuer is specified in the currency, verify exact match
          if (typeof c.issuer === 'string' && c.issuer !== issuer) return false
          return true
        })

        if (matched) {
          status = 'verified'
          verified = true
          if (typeof matched.name === 'string' && matched.name.trim().length > 0) {
            name = matched.name.trim()
          }
          if (typeof matched.display_decimals === 'number') {
            displayDecimals = matched.display_decimals
            decimals = matched.display_decimals
          }
          if (!contractId) {
            const rawContract = matched.contract_id ?? matched.contract
            if (typeof rawContract === 'string' && StrKey.isValidContract(rawContract)) {
              contractId = rawContract
            }
          }
        }
      }
    }
  }

  const result: AssetMetadata = {
    code,
    issuer,
    name,
    homeDomain,
    domain: homeDomain,
    decimals,
    displayDecimals,
    status,
    verified,
    checkedAt: now,
    dateChecked: now,
    contractId,
    tomlUrl,
    verification: {
      status,
      verified,
      checkedAt: now,
      tomlUrl,
    },
    provenance: {
      source: verified ? 'stellar-toml' : 'horizon',
      checkedAt: now,
      tomlUrl,
      verified,
    },
  }

  // 5. Store in caches
  setMemoryCached(cacheKey, result, ttlSeconds)
  await setCachedAsset(network, `${code}:${issuer}`, result, ttlSeconds)

  return result
}

/**
 * Returns the list of all distinct assets tracked by Lens on the specified network.
 * Gathers from:
 * 1. Network configuration watched pairs
 * 2. Persisted runtime pairs in the database
 * 3. Active in-memory pairs (when matching active network)
 * 4. Always includes native XLM
 */
export async function getTrackedAssets(network: NetworkName = activeNetwork): Promise<AssetId[]> {
  const assetMap = new Map<string, AssetId>()

  // Always include native XLM
  assetMap.set('XLM:native', { code: 'XLM', issuer: null })

  // 1. Configured pairs for this network
  const networkPairs = getNetworkConfig(network).pairs
  for (const pair of networkPairs) {
    const a = normalizeAsset(pair.assetA.code, pair.assetA.issuer)
    const b = normalizeAsset(pair.assetB.code, pair.assetB.issuer)
    assetMap.set(`${a.code}:${a.issuer ?? 'native'}`, a)
    assetMap.set(`${b.code}:${b.issuer ?? 'native'}`, b)
  }

  // 2. Persisted runtime pairs from DB
  try {
    const dbPairs = await prisma.pairConfig.findMany({ where: { network } })
    for (const p of dbPairs) {
      const a = normalizeAsset(p.assetACode, p.assetAIssuer)
      const b = normalizeAsset(p.assetBCode, p.assetBIssuer)
      assetMap.set(`${a.code}:${a.issuer ?? 'native'}`, a)
      assetMap.set(`${b.code}:${b.issuer ?? 'native'}`, b)
    }
  } catch (err) {
    log.debug({ network, err }, 'could not load pairs from DB')
  }

  // 3. Active runtime pairs if matching active network
  if (network === activeNetwork) {
    for (const p of getActivePairs()) {
      const a = normalizeAsset(p.assetA.code, p.assetA.issuer)
      const b = normalizeAsset(p.assetB.code, p.assetB.issuer)
      assetMap.set(`${a.code}:${a.issuer ?? 'native'}`, a)
      assetMap.set(`${b.code}:${b.issuer ?? 'native'}`, b)
    }
  }

  return Array.from(assetMap.values())
}
