import 'dotenv/config'
import { Networks, StrKey } from '@stellar/stellar-sdk'
import { createLogger } from './logger'
import type { WatchedPair, AssetId } from './types'

const log = createLogger('config')

// ── Types ─────────────────────────────────────────────────────────────────────

export type NetworkName = 'testnet' | 'mainnet'

/** Per-network configuration block. */
export interface NetworkConfig {
  horizon: {
    url: string
  }
  rpc: {
    url: string
  }
  network: {
    passphrase: string
  }
  soroswap: {
    /** Whether Soroswap has a usable deployment on this network. */
    enabled: boolean
    /** Soroswap factory contract address for this network. */
    factoryAddress: string
    /** Soroswap token-list URL for this network. */
    tokenListUrl: string
    /** How often to poll Soroswap pool reserves in ms. */
    pollIntervalMs: number
  }
  aquarius: {
    /** Whether Aquarius has a usable deployment on this network. */
    enabled: boolean
    /** Aquarius AMM pools API base URL for this network. */
    apiUrl: string
  }
  oracle: {
    /** Whether the Reflector oracle is deployed on this network. */
    enabled: boolean
    /** Reflector oracle contract ID for this network. */
    reflectorContractId: string
  }
  /** Watched asset pairs for this network. */
  pairs: WatchedPair[]
  facilitator: {
    /** Secret key for the facilitator's fee-paying account */
    secretKey?: string
    /** Maximum fee in stroops the facilitator will pay */
    feeStroops: number
  }
}

// ── Asset / pair parsing ───────────────────────────────────────────────────────

function parseAsset(str: string): AssetId {
  const [code, issuer] = str.split(':')
  return {
    code: code.toUpperCase(),
    issuer: (!issuer || issuer.toLowerCase() === 'native') ? null : issuer,
  }
}

function makePairKey(a: AssetId, b: AssetId): string {
  const aStr = a.issuer ? `${a.code}:${a.issuer}` : a.code
  const bStr = b.issuer ? `${b.code}:${b.issuer}` : b.code
  // Alphabetical sort so XLM/USDC and USDC/XLM resolve to the same key
  return [aStr, bStr].sort().join('/')
}

/**
 * Parse a comma-separated hostname allowlist into a normalized, de-duplicated
 * list. Empty entries and surrounding whitespace are dropped; hostnames are
 * lowercased and any IPv6 brackets / trailing dot are stripped so the stored
 * form matches what net/ssrf.ts compares against.
 */
function parseAllowedHosts(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const host = part.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
    if (host.length > 0) seen.add(host)
  }
  return Array.from(seen)
}

const MAINNET_DEFAULT_PAIRS =
  'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM'

function parseWatchedPairs(raw: string): WatchedPair[] {
  if (!raw.trim()) return []
  return raw.split(',').map(pair => {
    const [a, b] = pair.trim().split('/')
    if (!a || !b) {
      throw new Error(
        `Invalid pair format: "${pair}". Expected "CODE:ISSUER/CODE:ISSUER"`
      )
    }
    const assetA = parseAsset(a)
    const assetB = parseAsset(b)
    return { assetA, assetB, pairKey: makePairKey(assetA, assetB) }
  })
}

// ── Per-network config builder ────────────────────────────────────────────────

/**
 * Build a NetworkConfig for the given network name.
 *
 * Resolution order for each field (first value that is non-empty wins):
 *   1. Paired env var  — e.g. HORIZON_URL_TESTNET / HORIZON_URL_MAINNET
 *   2. Generic env var — e.g. HORIZON_URL   (back-compat with single-network setups)
 *   3. Sensible default for that network
 */
/**
 * True when `id` is a well-formed Soroban contract id (`C...`, 56 chars,
 * valid checksum). A malformed id otherwise surfaces later as an opaque decode
 * error on every RPC call, so config refuses to hand one out: on failure it
 * warns, naming the env var, and the caller disables the feature that needs it.
 */
function isUsableContractId(id: string, envVar: string): boolean {
  if (id === '') return false
  if (StrKey.isValidContract(id)) return true
  log.warn(
    { envVar, value: id },
    'invalid Soroban contract id; the feature that needs it is disabled'
  )
  return false
}

function buildNetworkConfig(network: NetworkName): NetworkConfig {
  const suffix = network.toUpperCase() as 'TESTNET' | 'MAINNET'

  // ── Horizon ──────────────────────────────────────────────────────────────
  const horizonUrl =
    process.env[`HORIZON_URL_${suffix}`] ||
    (network === 'testnet' ? process.env.HORIZON_URL : undefined) ||
    (network === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org')

  // ── Soroban RPC ───────────────────────────────────────────────────────────
  const rpcUrl =
    process.env[`RPC_URL_${suffix}`] ||
    (network === 'testnet' ? process.env.RPC_URL : undefined) ||
    (network === 'mainnet'
      ? 'https://mainnet.sorobanrpc.com'
      : 'https://soroban-testnet.stellar.org')

  // ── Network passphrase ────────────────────────────────────────────────────
  const passphrase =
    process.env[`NETWORK_PASSPHRASE_${suffix}`] ||
    (network === 'testnet' ? process.env.NETWORK_PASSPHRASE : undefined) ||
    (network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET)

  // ── Soroswap factory ──────────────────────────────────────────────────────
  const soroswapFactory =
    process.env[`SOROSWAP_FACTORY_ADDRESS_${suffix}`] ||
    process.env.SOROSWAP_FACTORY_ADDRESS ||
    (network === 'mainnet'
      ? 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'
      : 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY')

  // Soroswap token-list is a single canonical list covering both networks by
  // default, but can be overridden per network (e.g. a testnet-specific list).
  const soroswapTokenListUrl =
    process.env[`SOROSWAP_TOKEN_LIST_URL_${suffix}`] ||
    process.env.SOROSWAP_TOKEN_LIST_URL ||
    'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'

  const soroswapEnabled =
    (process.env[`SOROSWAP_ENABLED_${suffix}`] ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(soroswapFactory, `SOROSWAP_FACTORY_ADDRESS_${suffix}`)

  const soroswapPollMs = parseInt(
    process.env[`SOROSWAP_POLL_INTERVAL_MS_${suffix}`] ||
    process.env.SOROSWAP_POLL_INTERVAL_MS ||
    '60000',
    10
  )

  // ── Aquarius ──────────────────────────────────────────────────────────────
  // Aquarius only runs on Stellar classic mainnet today — there is no public
  // testnet deployment, so it is disabled there by default.
  const aquariusApiUrl =
    process.env[`AQUARIUS_API_URL_${suffix}`] ||
    process.env.AQUARIUS_API_URL ||
    'https://amm.aquarius.network/api/v1/pools/'

  const aquariusEnabled =
    (process.env[`AQUARIUS_ENABLED_${suffix}`] ?? (network === 'mainnet' ? 'true' : 'false')).toLowerCase() !== 'false'

  // ── Reflector oracle ──────────────────────────────────────────────────────
  // No built-in default: the previous mainnet literal was a malformed
  // (55-character) id and a replacement could not be verified against
  // Reflector's published deployments. Set REFLECTOR_CONTRACT_ID_<NETWORK> to
  // the oracle contract listed at https://reflector.network to enable it.
  const reflectorContractId =
    process.env[`REFLECTOR_CONTRACT_ID_${suffix}`] ||
    process.env.REFLECTOR_CONTRACT_ID ||
    ''

  const oracleEnabled =
    (process.env[`REFLECTOR_ENABLED_${suffix}`] ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(reflectorContractId, `REFLECTOR_CONTRACT_ID_${suffix}`)

  // ── Watched pairs ─────────────────────────────────────────────────────────
  // Mainnet gets a default for the same reason every field above does: turning
  // it on should not require knowing an issuer address by heart. USDC/XLM is
  // the pair the wallet actually converts balances against.
  //
  // The issuer is Circle's, confirmed by its home domain (circle.com) rather
  // than by asset code — Horizon lists many unrelated assets also called USDC,
  // and picking the wrong one would quote a price no one trades at.
  const rawPairs =
    process.env[`WATCHED_PAIRS_${suffix}`] ||
    (network === 'testnet' ? process.env.WATCHED_PAIRS : undefined) ||
    (network === 'mainnet' ? MAINNET_DEFAULT_PAIRS : '')

  // ── Facilitator ───────────────────────────────────────────────────────────
  const facilitatorSecretKey =
    process.env[`FACILITATOR_SECRET_KEY_${suffix}`] ||
    (network === 'testnet' ? process.env.FACILITATOR_SECRET_KEY : undefined)

  const facilitatorFeeStroops = parseInt(
    process.env[`FACILITATOR_FEE_STROOPS_${suffix}`] ||
    process.env.FACILITATOR_FEE_STROOPS ||
    '50000',
    10
  )

  return {
    horizon: { url: horizonUrl },
    rpc: { url: rpcUrl },
    network: { passphrase },
    soroswap: {
      enabled: soroswapEnabled,
      factoryAddress: soroswapFactory,
      tokenListUrl: soroswapTokenListUrl,
      pollIntervalMs: soroswapPollMs,
    },
    aquarius: {
      enabled: aquariusEnabled,
      apiUrl: aquariusApiUrl,
    },
    oracle: { enabled: oracleEnabled, reflectorContractId },
    pairs: parseWatchedPairs(rawPairs),
    facilitator: { secretKey: facilitatorSecretKey, feeStroops: facilitatorFeeStroops },
  }
}

// ── Global (non-network-specific) config ──────────────────────────────────────

const globalConfig = {
  db: {
    url: process.env.DATABASE_URL ?? 'postgresql://lens:lens@localhost:5432/lens',
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  api: {
    port: parseInt(process.env.PORT ?? '3002', 10),
    host: process.env.HOST ?? '0.0.0.0',
  },
  indexer: {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10),
    sdexPageSize: parseInt(process.env.SDEX_PAGE_SIZE ?? '200', 10),
    ammPageSize: parseInt(process.env.AMM_PAGE_SIZE ?? '200', 10),
  },
  cache: {
    priceTtl: parseInt(process.env.PRICE_CACHE_TTL ?? '10', 10),
    // How long a network's GET /snapshot response is served from Redis before
    // it is recomputed from Postgres. Deliberately short: the endpoint is a
    // cheap, pollable summary, so a slightly stale copy is preferable to a
    // per-request scan, but callers must never be shown a minutes-old market.
    snapshotTtl: parseInt(process.env.SNAPSHOT_CACHE_TTL ?? '15', 10),
  },
  http: {
    timeoutMs: parseInt(process.env.HTTP_TIMEOUT_MS ?? '10000', 10),
  },
  outbound: {
    // One operator-maintained list for every outbound fetch the app makes to a
    // caller-supplied target (Bazaar MCP discovery now, payment endpoints later).
    // Empty = "any public host"; a non-empty list narrows reach to these
    // hostnames. It never re-opens a private/link-local/metadata address — that
    // block is unconditional (see net/ssrf.ts).
    allowedHosts: parseAllowedHosts(process.env.OUTBOUND_ALLOWED_HOSTS ?? ''),
  },
} as const

// ── Per-network map ───────────────────────────────────────────────────────────

/**
 * `config.networks` holds a fully-resolved config block for each Stellar
 * network.  Each block is built lazily on first access so startup cost stays
 * minimal when only one network is active.
 */
const _networkCache = new Map<NetworkName, NetworkConfig>()

function resolveNetwork(name: NetworkName): NetworkConfig {
  const cached = _networkCache.get(name)
  if (cached) return cached
  const built = buildNetworkConfig(name)
  _networkCache.set(name, built)
  return built
}

/**
 * Return the fully-resolved config for a given network.
 *
 * @example
 * const { horizon, rpc, soroswap } = getNetworkConfig('mainnet')
 */
export function getNetworkConfig(network: NetworkName): NetworkConfig {
  return resolveNetwork(network)
}

// ── Active network ────────────────────────────────────────────────────────────

/**
 * The active network, driven by the `STELLAR_NETWORK` env var.
 * Falls back to `'testnet'` when unset so local dev always works.
 */
export const activeNetwork: NetworkName =
  (process.env.STELLAR_NETWORK?.toLowerCase() as NetworkName | undefined) === 'mainnet'
    ? 'mainnet'
    : 'testnet'

// ── Unified config export ─────────────────────────────────────────────────────

/**
 * The main config export consumed throughout the app.
 *
 * - `config.networks.testnet` / `config.networks.mainnet` — per-network blocks
 * - `config.network`  — shorthand for the currently-active network block
 *                       (driven by `STELLAR_NETWORK` env var; defaults to testnet)
 * - All other top-level keys (`db`, `redis`, `api`, `indexer`, `cache`) are
 *   network-agnostic and shared across both networks.
 *
 * Back-compat: any existing code that reads `config.horizon.url`,
 * `config.rpc.url`, `config.network.passphrase`, `config.soroswap.*`, or
 * `config.pairs` continues to work — those paths now proxy to the active
 * network's block.
 */
export const config = {
  // ── Network map ────────────────────────────────────────────────────────────
  networks: {
    get testnet(): NetworkConfig { return resolveNetwork('testnet') },
    get mainnet(): NetworkConfig { return resolveNetwork('mainnet') },
  },

  // ── Active-network shortcuts (back-compat) ─────────────────────────────────
  get horizon()  { return resolveNetwork(activeNetwork).horizon },
  get rpc()      { return resolveNetwork(activeNetwork).rpc },
  get network()  { return resolveNetwork(activeNetwork).network },
  get soroswap() { return resolveNetwork(activeNetwork).soroswap },
  get aquarius() { return resolveNetwork(activeNetwork).aquarius },
  get oracle()   { return resolveNetwork(activeNetwork).oracle },
  get pairs()    { return resolveNetwork(activeNetwork).pairs },
  get facilitator() { return resolveNetwork(activeNetwork).facilitator },

  // ── Global / network-agnostic ──────────────────────────────────────────────
  db:      globalConfig.db,
  redis:   globalConfig.redis,
  api:     globalConfig.api,
  indexer: globalConfig.indexer,
  cache:   globalConfig.cache,
  http:    globalConfig.http,
  outbound: globalConfig.outbound,
}
