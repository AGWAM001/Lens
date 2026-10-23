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
  defindex: {
    /** Whether DeFindex has a usable deployment on this network. */
    enabled: boolean
    /**
     * DeFindex factory contract id — the on-chain registry used to enumerate
     * vaults (56-char `C...`). Sourced from the protocol's own
     * `*.contracts.json`; a malformed id disables the venue.
     */
    factoryAddress: string
    /** How often to poll DeFindex vault share prices in ms. */
    pollIntervalMs: number
  }
  phoenix: {
    /** Whether Phoenix has a usable deployment on this network. */
    enabled: boolean
    /**
     * Phoenix factory contract id for this network. Pools are enumerated from
     * it (`query_pools`) rather than from a list kept in this repo.
     */
    factoryAddress: string
    /** How often to poll Phoenix pool reserves in ms. */
    pollIntervalMs: number
    /** How long the discovered pool list is reused before re-enumerating, in ms. */
    poolCacheTtlMs: number
  }
  oracle: {
    /** Whether the Reflector oracle is deployed on this network. */
    enabled: boolean
    /** Reflector oracle contract ID for this network. */
    reflectorContractId: string
  }
  /**
   * The SEP-40 publisher — the one direction that writes. `oracle` above is
   * Lens reading somebody else's feed; this is Lens pushing its own aggregate
   * on chain for contracts to read.
   */
  publisher: {
    /** Whether Lens publishes to a SEP-40 feed on this network. */
    enabled: boolean
    /** Deployed SEP-40 oracle contract the aggregate is pushed into. */
    contractId: string
    /**
     * Secret key of the account authorized on the contract as publisher. Never
     * committed; see docs/sep40-oracle-publisher.md for how it is funded and
     * rotated. Unset means the publisher cannot sign, so publication stays off.
     */
    secretKey?: string
  }
  /** Watched asset pairs for this network. */
  pairs: WatchedPair[]
  routing: {
    /** Maximum hop depth for multi-hop routing (default: 3) */
    maxHops: number
    /** Configured intermediate assets for multi-hop routing */
    intermediates: AssetId[]
  }
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
 * Read a positive numeric env var, falling back when it is unset, blank, not a
 * number, or not positive.
 *
 * The publisher thresholds below are used as divisors, comparison bases and
 * `setInterval` delays. A typo'd `SEP40_MAX_INTERVAL_MS=abc` would otherwise
 * arrive there as `NaN`, and `NaN` comparisons are false — which reads as
 * "never trigger", silently turning the feed off. Refusing the value and using
 * the documented default keeps a bad env var loud instead of inert.
 */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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

/**
 * Parse a positive integer env var, clamped into [min, max]. Unset, unparsable
 * or out-of-range values fall back to `fallback` rather than silently removing
 * a bound: an operator typo should not turn a limit off altogether.
 */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.max(parsed, min), max)
}

const MAINNET_DEFAULT_PAIRS =
  'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM'

const TESTNET_DEFAULT_INTERMEDIATES =
  'XLM:native,USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

const MAINNET_DEFAULT_INTERMEDIATES =
  'XLM:native,USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

function parseIntermediateAssets(raw: string): AssetId[] {
  if (!raw.trim()) return []
  return raw.split(',').map(a => parseAsset(a.trim()))
}

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

  // ── DeFindex vault factory ────────────────────────────────────────────────
  // DeFindex vaults are enumerable from the factory contract. The factory ids
  // below are copied whole from the protocol's published deployments —
  // https://github.com/defindex-io/stellar-contracts (public/mainnet.contracts.json
  // and public/testnet.contracts.json). Testnet redeploys often, so override
  // with DEFINDEX_FACTORY_ADDRESS_TESTNET when the published id changes.
  const defindexFactory =
    process.env[`DEFINDEX_FACTORY_ADDRESS_${suffix}`] ||
    process.env.DEFINDEX_FACTORY_ADDRESS ||
    (network === 'mainnet'
      ? 'CDKFHFJIET3A73A2YN4KV7NSV32S6YGQMUFH3DNJXLBWL4SKEGVRNFKI'
      : 'CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32')

  const defindexEnabled =
    (process.env[`DEFINDEX_ENABLED_${suffix}`] ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(defindexFactory, `DEFINDEX_FACTORY_ADDRESS_${suffix}`)

  const defindexPollMs = parseInt(
    process.env[`DEFINDEX_POLL_INTERVAL_MS_${suffix}`] ||
    process.env.DEFINDEX_POLL_INTERVAL_MS ||
    '60000',
    10
  )

  // ── Phoenix AMM (Soroban) ─────────────────────────────────────────────────
  // Mainnet factory id taken verbatim from Phoenix's own repository —
  // scripts/extend-queries.sh and scripts/deploy_pool.sh both set
  // FACTORY="CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI"
  // alongside RPC_URL=https://mainnet.sorobanrpc.com and the public-network
  // passphrase (https://github.com/Phoenix-Protocol-Group/phoenix-contracts).
  //
  // There is no built-in testnet id: Phoenix does not publish a testnet
  // deployment, so a testnet factory only exists if an operator deploys one and
  // names it here. An id that is empty or malformed leaves the venue disabled
  // on that network rather than pointing the ingester at something invented.
  const phoenixFactory =
    process.env[`PHOENIX_FACTORY_ADDRESS_${suffix}`] ||
    (network === 'testnet' ? process.env.PHOENIX_FACTORY_ADDRESS : undefined) ||
    (network === 'mainnet'
      ? 'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI'
      : '')

  const phoenixEnabled =
    (process.env[`PHOENIX_ENABLED_${suffix}`] ?? 'true').toLowerCase() !== 'false' &&
    isUsableContractId(phoenixFactory, `PHOENIX_FACTORY_ADDRESS_${suffix}`)

  const phoenixPollMs = parseInt(
    process.env.PHOENIX_POLL_INTERVAL_MS || '60000',
    10
  )

  // Pool enumeration is one RPC read of the whole factory, so it is reused
  // across pairs and cycles instead of being paid for on every price poll.
  const phoenixPoolCacheTtlMs = parseInt(
    process.env.PHOENIX_POOL_CACHE_TTL_MS || '600000',
    10
  )

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

  // ── SEP-40 publisher ──────────────────────────────────────────────────────
  // Off unless a contract is deployed AND a key is provided. There is no
  // default contract id: the feed is deployed by the operator (see
  // oracle/contract/), and a guessed id would push Lens's aggregate into
  // somebody else's contract — or nowhere. `isUsableContractId` rejects a
  // malformed id the same way every other contract address in this file does.
  const sep40ContractId =
    process.env[`SEP40_CONTRACT_ID_${suffix}`] ||
    process.env.SEP40_CONTRACT_ID ||
    ''

  const sep40SecretKey =
    process.env[`SEP40_PUBLISHER_SECRET_KEY_${suffix}`] ||
    (network === 'testnet' ? process.env.SEP40_PUBLISHER_SECRET_KEY : undefined)

  // A key with no contract, or a contract with no key, is an incomplete
  // deployment rather than a mistake worth crashing on — publication stays off
  // and says so.
  const publisherEnabled =
    (process.env[`SEP40_ENABLED_${suffix}`] ?? 'false').toLowerCase() !== 'false' &&
    isUsableContractId(sep40ContractId, `SEP40_CONTRACT_ID_${suffix}`) &&
    Boolean(sep40SecretKey)

  if (
    (process.env[`SEP40_ENABLED_${suffix}`] ?? '').toLowerCase() === 'true' &&
    !publisherEnabled
  ) {
    log.warn(
      { network, envVar: `SEP40_ENABLED_${suffix}`, contractId: sep40ContractId || undefined },
      `SEP40_ENABLED_${suffix}=true but publication is disabled on ${network}: it needs a valid SEP40_CONTRACT_ID_${suffix} and a SEP40_PUBLISHER_SECRET_KEY_${suffix}`
    )
  }

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

  // ── Multi-hop Routing ───────────────────────────────────────────────────
  const maxHopsRaw =
    process.env[`ROUTING_MAX_HOPS_${suffix}`] ||
    (network === 'testnet' ? process.env.ROUTING_MAX_HOPS : undefined) ||
    '3'
  const maxHops = Math.max(1, parseInt(maxHopsRaw, 10) || 3)

  const defaultIntermediates =
    network === 'mainnet' ? MAINNET_DEFAULT_INTERMEDIATES : TESTNET_DEFAULT_INTERMEDIATES
  const rawIntermediates =
    process.env[`ROUTING_INTERMEDIATES_${suffix}`] ||
    (network === 'testnet' ? process.env.ROUTING_INTERMEDIATES : undefined) ||
    defaultIntermediates
  const intermediates = parseIntermediateAssets(rawIntermediates)

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
    defindex: {
      enabled: defindexEnabled,
      factoryAddress: defindexFactory,
      pollIntervalMs: defindexPollMs,
    },
    phoenix: {
      enabled: phoenixEnabled,
      factoryAddress: phoenixFactory,
      pollIntervalMs: phoenixPollMs,
      poolCacheTtlMs: phoenixPoolCacheTtlMs,
    },
    oracle: { enabled: oracleEnabled, reflectorContractId },
    publisher: {
      enabled: publisherEnabled,
      contractId: sep40ContractId,
      secretKey: sep40SecretKey,
    },
    pairs: parseWatchedPairs(rawPairs),
    routing: { maxHops, intermediates },
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
  /**
   * When the publisher writes to the SEP-40 feed.
   *
   * Cost is the reason an oracle batches: a write per tick would put one
   * transaction per pair per poll interval on chain, which is why every feed
   * that charges for gas publishes on CHANGE. These are the three knobs that
   * make that true, and the ceiling that keeps a bad change off chain:
   *
   * - `deviationPct`     — publish when the aggregate has moved at least this
   *                        much from the value already on chain.
   * - `maxIntervalMs`    — and publish even without movement once this long has
   *                        passed, so a quiet market does not leave consumers
   *                        reading a feed with no recent timestamp.
   * - `minWriteIntervalMs` — the floor between two writes for the same asset,
   *                        whatever triggered them. This is the rate limit:
   *                        it bounds the transaction count during a fast market
   *                        to one per floor, not one per sample.
   * - `maxAgeSeconds`    — the aggregate itself must be younger than this.
   *                        Stricter than the API's own stale flag on purpose:
   *                        the HTTP price can afford to be "as good as we have
   *                        it", a price a contract settles against cannot.
   */
  publisher: {
    deviationPct: positiveNumber(process.env.SEP40_DEVIATION_PCT, 0.5),
    maxIntervalMs: positiveNumber(process.env.SEP40_MAX_INTERVAL_MS, 15 * 60 * 1000),
    minWriteIntervalMs: positiveNumber(process.env.SEP40_MIN_WRITE_INTERVAL_MS, 60 * 1000),
    maxAgeSeconds: positiveNumber(process.env.SEP40_MAX_AGE_SECONDS, 120),
    pollIntervalMs: positiveNumber(process.env.SEP40_POLL_INTERVAL_MS, 30 * 1000),
  },
  cache: {
    priceTtl: parseInt(process.env.PRICE_CACHE_TTL ?? '10', 10),
    // How long a network's GET /snapshot response is served from Redis before
    // it is recomputed from Postgres. Deliberately short: the endpoint is a
    // cheap, pollable summary, so a slightly stale copy is preferable to a
    // per-request scan, but callers must never be shown a minutes-old market.
    snapshotTtl: parseInt(process.env.SNAPSHOT_CACHE_TTL ?? '15', 10),
  },
  plausibility: {
    minPrice: parseFloat(process.env.PRICE_MIN_PLAUSIBLE ?? '0.0000000001'),
    maxPrice: parseFloat(process.env.PRICE_MAX_PLAUSIBLE ?? '10000000000'),
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
  mcp: {
    // Tool results land directly in an agent's context window, so both the body
    // read from a node and the text handed back are capped (#416).
    maxResultBytes: clampInt(process.env.MCP_MAX_RESULT_BYTES, 16_384, 1_024, 1_048_576),
    maxUpstreamBytes: clampInt(process.env.MCP_MAX_UPSTREAM_BYTES, 262_144, 4_096, 8_388_608),
    // Page size for collection results, mirroring the /discovery limits: a
    // request without an explicit limit gets this many items, and an over-large
    // ask is clamped rather than honoured.
    defaultPageLimit: clampInt(process.env.MCP_DEFAULT_PAGE_LIMIT, 50, 1, 200),
    maxPageLimit: clampInt(process.env.MCP_MAX_PAGE_LIMIT, 200, 1, 1000),
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
  get defindex() { return resolveNetwork(activeNetwork).defindex },
  get phoenix()  { return resolveNetwork(activeNetwork).phoenix },
  get oracle()   { return resolveNetwork(activeNetwork).oracle },
  get pairs()    { return resolveNetwork(activeNetwork).pairs },
  get routing()  { return resolveNetwork(activeNetwork).routing },
  get facilitator() { return resolveNetwork(activeNetwork).facilitator },

  // ── Global / network-agnostic ──────────────────────────────────────────────
  db:      globalConfig.db,
  redis:   globalConfig.redis,
  api:     globalConfig.api,
  indexer: globalConfig.indexer,
  // WHEN to publish, shared by both networks. WHICH contract to publish to is
  // per-network and lives at `getNetworkConfig(network).publisher` — there is
  // deliberately no active-network `publisher` shortcut, because the two blocks
  // are different things and one name for both would be read wrongly.
  publisher: globalConfig.publisher,
  cache:   globalConfig.cache,
  plausibility: globalConfig.plausibility,
  http:    globalConfig.http,
  outbound: globalConfig.outbound,
  mcp: globalConfig.mcp,
}
