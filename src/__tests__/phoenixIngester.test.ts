/**
 * Unit tests for the Phoenix AMM venue adapter (#210).
 *
 * Covered:
 * - calcSpotPrice: the reserve→price derivation, including zero reserves
 * - parsePoolInfo: the shapes `query_pool_info` returns, and refusal to guess
 * - sacContractId / poolMatchesPair: watched classic asset → Soroban token
 * - derivePhoenixPricePoints: orientation, source labelling, empty pools
 * - discovery: factory enumeration, TTL cache, stale-on-failure, single-flight
 * - degrade: an unreachable RPC silences Phoenix and throws nothing
 * - the network a price was read from is the network it is written with
 *
 * The contract ids and reserve amounts in the fixtures are the values read live
 * from mainnet (ledger 64,991,171) from the factory
 * CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI, so these tests pin
 * the adapter to Phoenix's real deployment rather than to a plausible shape.
 */

// `vi.hoisted` runs before the module's imports and top-level consts, so every
// fixture lives inside it and is re-bound below for the tests to read.
const fixtures = vi.hoisted(() => {
  const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
  const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'
  const PHOENIX_FACTORY = 'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI'
  // The factory's XLM/USDC pool, read live.
  const XLM_USDC_POOL = 'CBHCRSVX3ZZ7EGTSYMKPEFGZNWRVCSESQR3UABET4MIW52N4EVU6BIZX'
  // Soroban token contracts of the watched mainnet pair, verified against the
  // Stellar Asset Contract derivation and Phoenix's own scripts/deploy_pool.sh.
  const XLM_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
  const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
  const CIRCLE_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  // Another Soroban token from Phoenix's own pools (PHO): same two-slot shape,
  // different market — must never be mistaken for the watched pair.
  const PHO_SAC = 'CBZ7M5B3Y4WWBZ5XK5UZCAFOEZ23KSSZXYECYX3IXM6E2JOLQC52DK32'
  // The factory's XLM/EURC pool and its EURC token, read live.
  const XLM_EURC_POOL = 'CBISULYO5ZGS32WTNCBMEFCNKNSLFXCQ4Z3XHVDP4X4FLPSEALGSY3PS'
  const EURC_SAC = 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV'
  // The factory's XLM/PHO pool, read live.
  const XLM_PHO_POOL = 'CBCZGGNOEUZG4CAAE7TGTQQHETZMKUT4OIPFHHPKEUX46U4KXBBZ3GLH'

  const phoenixBlock = {
    enabled: true,
    factoryAddress: PHOENIX_FACTORY,
    pollIntervalMs: 60_000,
    poolCacheTtlMs: 600_000,
  }
  const networks: Record<string, any> = {
    mainnet: { phoenix: phoenixBlock, network: { passphrase: MAINNET_PASSPHRASE }, rpc: { url: 'https://mainnet.example' } },
    testnet: { phoenix: { ...phoenixBlock, enabled: false, factoryAddress: '' }, network: { passphrase: TESTNET_PASSPHRASE }, rpc: { url: 'https://testnet.example' } },
  }

  return {
    networks,
    phoenixBlock,
    rpc: { simulateTransaction: vi.fn(), _simulateTransaction: vi.fn() },
    MAINNET_PASSPHRASE,
    TESTNET_PASSPHRASE,
    PHOENIX_FACTORY,
    XLM_USDC_POOL,
    XLM_SAC,
    USDC_SAC,
    CIRCLE_USDC_ISSUER,
    PHO_SAC,
    XLM_EURC_POOL,
    EURC_SAC,
    XLM_PHO_POOL,
  }
})

const {
  MAINNET_PASSPHRASE,
  TESTNET_PASSPHRASE,
  PHOENIX_FACTORY,
  XLM_USDC_POOL,
  XLM_SAC,
  USDC_SAC,
  CIRCLE_USDC_ISSUER,
  PHO_SAC,
  XLM_EURC_POOL,
  EURC_SAC,
  XLM_PHO_POOL,
} = fixtures

const mocks = fixtures

vi.mock('../config', () => ({
  config: { indexer: { pollIntervalMs: 5_000 } },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => mocks.networks[network],
}))

vi.mock('../network/clients', () => ({
  getRpcServer: () => mocks.rpc,
}))

vi.mock('../pairsRegistry', () => ({
  getActivePairs: vi.fn().mockReturnValue([]),
}))

vi.mock('../db', () => ({
  upsertPricePoints: vi.fn().mockResolvedValue(1),
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../events', () => ({
  publishPriceUpdate: vi.fn(),
}))

import { StrKey, xdr, Address, scValToNative, nativeToScVal } from '@stellar/stellar-sdk'
import { upsertPricePoints } from '../db'
import {
  calcSpotPrice,
  parsePoolInfo,
  sacContractId,
  poolMatchesPair,
  derivePhoenixPricePoints,
  simulateRead,
  fetchPoolAddresses,
  fetchPoolReserves,
  discoverPools,
  ingestPhoenixPair,
  phoenixAdapter,
  _resetPoolCache,
  _resetLastPrice,
  _resetRawRpcState,
  _poolCacheSize,
  type PhoenixPool,
  type PhoenixReserves,
} from '../ingest/venues/phoenix'

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** The watched mainnet pair, in the order config.ts parses it: USDC then XLM. */
const usdcXlmPair = {
  pairKey: `USDC:${CIRCLE_USDC_ISSUER}/XLM`,
  assetA: { code: 'USDC', issuer: CIRCLE_USDC_ISSUER },
  assetB: { code: 'XLM', issuer: null },
}

/** Live reserves of the XLM/USDC pool, raw i128 (7 decimals on both sides). */
const liveXlmReserve = 101_994_201_611n
const liveUsdcReserve = 18_279_155_744n

const xlmUsdcPool: PhoenixReserves = {
  poolAddress: XLM_USDC_POOL,
  tokenAAddress: XLM_SAC,
  tokenBAddress: USDC_SAC,
  reserveA: liveXlmReserve,
  reserveB: liveUsdcReserve,
}

function poolDescriptor(reserves: PhoenixReserves): PhoenixPool {
  return {
    poolAddress: reserves.poolAddress,
    tokenAAddress: reserves.tokenAAddress,
    tokenBAddress: reserves.tokenBAddress,
  }
}

/** Build the ScVal a Phoenix pool returns from `query_pool_info`. */
function poolInfoScVal(tokenA: string, amountA: bigint, tokenB: string, amountB: bigint): xdr.ScVal {
  // i128 reserves go through nativeToScVal: scvI128 expects Int128Parts, and
  // hand-building them yields a value scValToNative cannot read back.
  const asset = (address: string, amount: bigint) =>
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('address'), val: new Address(address).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: nativeToScVal(amount, { type: 'i128' }) }),
    ])

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('asset_a'), val: asset(tokenA, amountA) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('asset_b'), val: asset(tokenB, amountB) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('asset_lp_share'), val: asset(XLM_USDC_POOL, 0n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('stake_address'), val: new Address(XLM_USDC_POOL).toScVal() }),
  ])
}

function poolsScVal(addresses: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(addresses.map((a) => new Address(a).toScVal()))
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetPoolCache()
  _resetLastPrice()
  _resetRawRpcState()
})

// ── calcSpotPrice ─────────────────────────────────────────────────────────────

describe('calcSpotPrice', () => {
  it('quotes units of B per one A from constant-product reserves', () => {
    expect(calcSpotPrice(200n, 1000n)).toBeCloseTo(5)
    expect(calcSpotPrice(1000n, 500n)).toBeCloseTo(0.5)
  })

  it('returns 0 when either side is empty (a pool with zero reserves has no price)', () => {
    expect(calcSpotPrice(0n, 1000n)).toBe(0)
    expect(calcSpotPrice(1000n, 0n)).toBe(0)
    expect(calcSpotPrice(0n, 0n)).toBe(0)
  })

  it('returns 0 for a negative reserve rather than a negative price', () => {
    expect(calcSpotPrice(-5n, 1000n)).toBe(0)
  })

  it('handles live-scale i128 reserves', () => {
    expect(calcSpotPrice(liveXlmReserve, liveUsdcReserve)).toBeCloseTo(0.1792)
  })
})

// ── parsePoolInfo ─────────────────────────────────────────────────────────────

describe('parsePoolInfo', () => {
  it('reads the struct a Phoenix pool returns', () => {
    const parsed = parsePoolInfo(
      {
        asset_a: { address: XLM_SAC, amount: liveXlmReserve },
        asset_b: { address: USDC_SAC, amount: liveUsdcReserve },
        asset_lp_share: { address: XLM_USDC_POOL, amount: 1n },
        stake_address: XLM_USDC_POOL,
      },
      XLM_USDC_POOL
    )

    expect(parsed).toEqual({
      poolAddress: XLM_USDC_POOL,
      tokenAAddress: XLM_SAC,
      tokenBAddress: USDC_SAC,
      reserveA: liveXlmReserve,
      reserveB: liveUsdcReserve,
    })
  })

  it('reads a positionally-decoded pool too', () => {
    const parsed = parsePoolInfo(
      [
        { address: XLM_SAC, amount: liveXlmReserve },
        { address: USDC_SAC, amount: liveUsdcReserve },
      ],
      XLM_USDC_POOL
    )
    expect(parsed?.tokenBAddress).toBe(USDC_SAC)
  })

  it('accepts numeric and string amounts', () => {
    expect(parsePoolInfo({ asset_a: { address: XLM_SAC, amount: '10' }, asset_b: { address: USDC_SAC, amount: 5 } }, XLM_USDC_POOL)?.reserveA).toBe(10n)
  })

  it.each([
    ['null', null],
    ['a bare string', 'not a pool'],
    ['a missing asset_b', { asset_a: { address: XLM_SAC, amount: 1n } }],
    ['a non-contract token address', { asset_a: { address: 'GAAZ5QVKFPZPAOMQGQZZPBGV4BQ5G5W6FRRHMYWQDZ3ZK5V7XQYXWZ6D', amount: 1n }, asset_b: { address: USDC_SAC, amount: 1n } }],
    ['a missing amount', { asset_a: { address: XLM_SAC }, asset_b: { address: USDC_SAC, amount: 1n } }],
    ['a non-numeric amount', { asset_a: { address: XLM_SAC, amount: 'abc' }, asset_b: { address: USDC_SAC, amount: 1n } }],
  ])('returns null for %s instead of inventing a price', (_label, input) => {
    expect(parsePoolInfo(input, XLM_USDC_POOL)).toBeNull()
  })
})

// ── watched asset → Soroban token contract ────────────────────────────────────

describe('sacContractId', () => {
  it('derives the contract Phoenix actually holds for native XLM and Circle USDC', () => {
    expect(sacContractId({ code: 'XLM', issuer: null }, 'mainnet')).toBe(XLM_SAC)
    expect(sacContractId({ code: 'USDC', issuer: CIRCLE_USDC_ISSUER }, 'mainnet')).toBe(USDC_SAC)
  })

  it('is network-scoped: the same asset is a different contract on testnet', () => {
    const testnetXlm = sacContractId({ code: 'XLM', issuer: null }, 'testnet')
    expect(testnetXlm).not.toBe(XLM_SAC)
    expect(StrKey.isValidContract(testnetXlm)).toBe(true)
  })

  it('throws for a malformed issuer, which poolMatchesPair turns into no match', () => {
    expect(() => sacContractId({ code: 'USDC', issuer: 'not-an-account' }, 'mainnet')).toThrow()
    expect(
      poolMatchesPair(poolDescriptor(xlmUsdcPool), { ...usdcXlmPair, assetA: { code: 'USDC', issuer: 'not-an-account' } } as any, 'mainnet')
    ).toBe(false)
  })
})

describe('poolMatchesPair', () => {
  it('matches a pool holding the pair in either token order', () => {
    expect(poolMatchesPair(poolDescriptor(xlmUsdcPool), usdcXlmPair as any, 'mainnet')).toBe(true)
    const flipped: PhoenixReserves = { ...xlmUsdcPool, tokenAAddress: USDC_SAC, tokenBAddress: XLM_SAC }
    expect(poolMatchesPair(poolDescriptor(flipped), usdcXlmPair as any, 'mainnet')).toBe(true)
  })

  it('does not match a pool holding a different token under the same asset code', () => {
    const wrongToken: PhoenixReserves = { ...xlmUsdcPool, tokenBAddress: PHO_SAC }
    expect(poolMatchesPair(poolDescriptor(wrongToken), usdcXlmPair as any, 'mainnet')).toBe(false)
  })

  it('does not match an unrelated pool', () => {
    const eurcPool: PhoenixReserves = { ...xlmUsdcPool, tokenBAddress: EURC_SAC }
    expect(poolMatchesPair(poolDescriptor(eurcPool), usdcXlmPair as any, 'mainnet')).toBe(false)
  })
})

// ── derivePhoenixPricePoints ──────────────────────────────────────────────────

describe('derivePhoenixPricePoints', () => {
  it('labels the row with its own source and pool, on the requested pair', () => {
    const [point] = derivePhoenixPricePoints(xlmUsdcPool, usdcXlmPair as any, 'mainnet')

    expect(point.source).toBe('phoenix_amm')
    expect(point.poolId).toBe(XLM_USDC_POOL)
    expect(point.pairKey).toBe(usdcXlmPair.pairKey)
    expect(point.assetA).toBe('USDC')
    expect(point.assetB).toBe('XLM')
    expect(point.eventId).toMatch(/^phoenix-CBHCRSVX/)
  })

  it('always quotes assetB per unit of assetA, whichever order the pool stores', () => {
    // USDC/XLM: one USDC buys ~5.58 XLM. Inverting the pool's token order (with
    // its reserves) must not invert the answer, or the same pool would produce
    // two contradictory price series under one source.
    const forward = derivePhoenixPricePoints(xlmUsdcPool, usdcXlmPair as any, 'mainnet')[0]
    const flipped: PhoenixReserves = {
      ...xlmUsdcPool,
      tokenAAddress: USDC_SAC,
      tokenBAddress: XLM_SAC,
      reserveA: liveUsdcReserve,
      reserveB: liveXlmReserve,
    }
    const backward = derivePhoenixPricePoints(flipped, usdcXlmPair as any, 'mainnet')[0]

    expect(forward.price).toBeCloseTo(5.5798, 4)
    expect(backward.price).toBeCloseTo(forward.price, 10)
  })

  it('produces nothing for a pool with zero reserves', () => {
    const drained: PhoenixReserves = { ...xlmUsdcPool, reserveA: 0n, reserveB: liveUsdcReserve }
    expect(derivePhoenixPricePoints(drained, usdcXlmPair as any, 'mainnet')).toEqual([])
    expect(derivePhoenixPricePoints({ ...xlmUsdcPool, reserveB: 0n }, usdcXlmPair as any, 'mainnet')).toEqual([])
  })

  it('produces nothing for a pool that does not hold the watched pair', () => {
    const eurcPool: PhoenixReserves = { ...xlmUsdcPool, tokenBAddress: EURC_SAC }
    expect(derivePhoenixPricePoints(eurcPool, usdcXlmPair as any, 'mainnet')).toEqual([])
  })

  it('produces nothing when the pool is read on a different network than the pair', () => {
    // Testnet watched assets resolve to different contracts, so a mainnet pool
    // must not be quoted as a testnet price.
    expect(derivePhoenixPricePoints(xlmUsdcPool, usdcXlmPair as any, 'testnet')).toEqual([])
  })
})

// ── simulateRead: parsed SDK path, raw fallback, total failure ────────────────

describe('simulateRead', () => {
  it('returns the ScVal from the parsed simulation response', async () => {
    const retval = poolsScVal([XLM_USDC_POOL])
    mocks.rpc.simulateTransaction.mockResolvedValue({ result: { retval } })

    await expect(simulateRead(PHOENIX_FACTORY, 'query_pools', 'mainnet')).resolves.toBe(retval)
  })

  it('falls back to the raw JSON-RPC response when the SDK cannot parse it', async () => {
    // stellar-sdk 13.3 throws `TypeError: Bad union switch: 1` decoding the
    // SorobanTransactionData of 9 of Phoenix's 13 mainnet pools. Reading through
    // the parsed response alone would leave those pools unquoted forever.
    const retval = poolInfoScVal(XLM_SAC, liveXlmReserve, USDC_SAC, liveUsdcReserve)
    mocks.rpc.simulateTransaction.mockRejectedValue(new TypeError('Bad union switch: 1'))
    mocks.rpc._simulateTransaction.mockResolvedValue({ results: [{ xdr: retval.toXDR('base64') }] })

    const decoded = await simulateRead(XLM_USDC_POOL, 'query_pool_info', 'mainnet')
    expect(decoded).toBeTruthy()
    expect(parsePoolInfo(scValToNative(decoded!), XLM_USDC_POOL)).toEqual(xlmUsdcPool)

    // The need is remembered per network: the doomed parsed call is not retried
    // for every pool in every cycle.
    await simulateRead(XLM_USDC_POOL, 'query_pool_info', 'mainnet')
    expect(mocks.rpc.simulateTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.rpc._simulateTransaction).toHaveBeenCalledTimes(2)
  })

  it('returns null when the simulation reports an error', async () => {
    mocks.rpc.simulateTransaction.mockResolvedValue({ error: 'HostError: NotFound' })
    await expect(simulateRead(XLM_USDC_POOL, 'query_pool_info', 'mainnet')).resolves.toBeNull()
  })

  it('returns null rather than throwing when the RPC is unreachable', async () => {
    mocks.rpc.simulateTransaction.mockRejectedValue(new Error('fetch failed'))
    mocks.rpc._simulateTransaction.mockRejectedValue(new Error('fetch failed'))

    await expect(simulateRead(PHOENIX_FACTORY, 'query_pools', 'mainnet')).resolves.toBeNull()
  })

  it('refuses to call an id that is not a contract', async () => {
    await expect(simulateRead('GAAZ5QVKFPZPAOMQGQZZPBGV4BQ5G5W6FRRHMYWQDZ3ZK5V7XQYXWZ6D', 'query_pools', 'mainnet')).resolves.toBeNull()
    expect(mocks.rpc.simulateTransaction).not.toHaveBeenCalled()
  })
})

describe('fetchPoolAddresses', () => {
  it('enumerates pools from the factory and drops anything that is not a contract id', async () => {
    // CIRCLE_USDC_ISSUER is a real, valid strkey — an account, not a contract —
    // so the filter is exercised against a well-formed non-pool entry.
    mocks.rpc.simulateTransaction.mockResolvedValue({
      result: { retval: poolsScVal([XLM_USDC_POOL, CIRCLE_USDC_ISSUER]) },
    })

    const pools = await fetchPoolAddresses(PHOENIX_FACTORY, 'mainnet')
    expect(pools).toEqual([XLM_USDC_POOL])
  })

  it('returns [] when the factory read fails — Phoenix goes quiet, nothing else', async () => {
    mocks.rpc.simulateTransaction.mockRejectedValue(new Error('connection refused'))
    mocks.rpc._simulateTransaction.mockRejectedValue(new Error('connection refused'))

    await expect(fetchPoolAddresses(PHOENIX_FACTORY, 'mainnet')).resolves.toEqual([])
  })

  it('returns [] when the factory returns nothing', async () => {
    mocks.rpc.simulateTransaction.mockResolvedValue({ result: {} })
    await expect(fetchPoolAddresses(PHOENIX_FACTORY, 'mainnet')).resolves.toEqual([])
  })
})

describe('fetchPoolReserves', () => {
  it('decodes a pool read into tokens and raw i128 reserves', async () => {
    mocks.rpc.simulateTransaction.mockResolvedValue({
      result: { retval: poolInfoScVal(XLM_SAC, liveXlmReserve, USDC_SAC, liveUsdcReserve) },
    })

    await expect(fetchPoolReserves(XLM_USDC_POOL, 'mainnet')).resolves.toEqual(xlmUsdcPool)
  })

  it('returns null for a pool whose read fails', async () => {
    mocks.rpc.simulateTransaction.mockRejectedValue(new Error('timeout'))
    mocks.rpc._simulateTransaction.mockRejectedValue(new Error('timeout'))
    await expect(fetchPoolReserves(XLM_USDC_POOL, 'mainnet')).resolves.toBeNull()
  })
})

// ── discovery + cache ─────────────────────────────────────────────────────────

describe('discoverPools', () => {
  const described: PhoenixPool[] = [poolDescriptor(xlmUsdcPool)]

  it('asks the factory once and reuses the list within the TTL', async () => {
    const refresh = vi.fn().mockResolvedValue(described)

    const first = await discoverPools('mainnet', 600_000, refresh)
    const second = await discoverPools('mainnet', 600_000, refresh)

    expect(first).toEqual(described)
    expect(second).toEqual(described)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('re-enumerates once the TTL has expired', async () => {
    const refresh = vi.fn().mockResolvedValue(described)

    await discoverPools('mainnet', 600_000, refresh)
    await discoverPools('mainnet', -1, refresh) // TTL already expired

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('runs one refresh for concurrent callers', async () => {
    let release: (pools: PhoenixPool[]) => void = () => {}
    const refresh = vi.fn().mockReturnValue(new Promise<PhoenixPool[]>((resolve) => { release = resolve }))

    // Both calls start before the refresh resolves, so the second must join the
    // in-flight enumeration instead of issuing another one.
    const first = discoverPools('mainnet', 600_000, refresh)
    const second = discoverPools('mainnet', 600_000, refresh)
    release(described)

    const [a, b] = await Promise.all([first, second])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a).toEqual(described)
    expect(b).toBe(a)
  })

  it('keeps the previous list when a refresh throws, and retries next cycle', async () => {
    const refresh = vi.fn().mockResolvedValue(described)
    await discoverPools('mainnet', 600_000, refresh)

    const failing = vi.fn().mockRejectedValue(new Error('RPC down'))
    await expect(discoverPools('mainnet', -1, failing)).resolves.toEqual(described)
    expect(_poolCacheSize('mainnet')).toBe(1)

    // The failed refresh did not advance the TTL, so the next cycle tries again.
    await discoverPools('mainnet', -1, vi.fn().mockResolvedValue(described))
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('does not let a failed enumeration overwrite a cached list with nothing', async () => {
    // Real refresh path, RPC mocked: the factory read fails after a good first
    // enumeration, so the pools already known stay in play.
    mocks.rpc.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: poolsScVal([XLM_USDC_POOL]) } })
      .mockResolvedValueOnce({ result: { retval: poolInfoScVal(XLM_SAC, liveXlmReserve, USDC_SAC, liveUsdcReserve) } })
      .mockRejectedValue(new Error('RPC down'))

    await expect(discoverPools('mainnet')).resolves.toEqual(described)
    await expect(discoverPools('mainnet', -1)).resolves.toEqual(described)
  })

  it('caches per network, so a mainnet list is never served for testnet', async () => {
    const refreshMainnet = vi.fn().mockResolvedValue(described)
    await discoverPools('mainnet', 600_000, refreshMainnet)

    const refreshTestnet = vi.fn().mockResolvedValue([])
    await expect(discoverPools('testnet', 600_000, refreshTestnet)).resolves.toEqual([])

    expect(refreshMainnet).not.toHaveBeenCalledWith('testnet', expect.anything())
    expect(refreshTestnet).toHaveBeenCalledWith('testnet', [])
  })
})

// ── ingestion ─────────────────────────────────────────────────────────────────

describe('ingestPhoenixPair', () => {
  const writePoints = vi.fn().mockResolvedValue(undefined)

  const depsReturning = (pools: PhoenixPool[], reserves: PhoenixReserves | null) => ({
    discoverPools: vi.fn().mockResolvedValue(pools),
    fetchPoolReserves: vi.fn().mockResolvedValue(reserves),
  })

  it('writes the pool price under the network it was read from', async () => {
    const deps = depsReturning([poolDescriptor(xlmUsdcPool)], xlmUsdcPool)

    await ingestPhoenixPair(usdcXlmPair as any, 'mainnet', deps, writePoints)

    expect(writePoints).toHaveBeenCalledTimes(1)
    const [points, , network] = writePoints.mock.calls[0]
    expect(network).toBe('mainnet')
    expect(points[0]).toMatchObject({ source: 'phoenix_amm', poolId: XLM_USDC_POOL, pairKey: usdcXlmPair.pairKey })
    expect(points[0].price).toBeCloseTo(5.5798, 4)
  })

  it('writes nothing when no Phoenix pool quotes the pair', async () => {
    const deps = depsReturning([], null)
    await ingestPhoenixPair(usdcXlmPair as any, 'mainnet', deps, writePoints)
    expect(writePoints).not.toHaveBeenCalled()
    expect(deps.fetchPoolReserves).not.toHaveBeenCalled()
  })

  it('skips a pool it cannot read and still writes the one it can', async () => {
    const other: PhoenixReserves = { ...xlmUsdcPool, poolAddress: 'CBCZGGNOEUZG4CAAE7TGTQQHETZMKUT4OIPFHHPKEUX46U4KXBBZ3GLH' }
    const discoverPoolsMock = vi.fn().mockResolvedValue([poolDescriptor(xlmUsdcPool), poolDescriptor(other)])
    const fetchPoolReserves = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(other)

    await ingestPhoenixPair(usdcXlmPair as any, 'mainnet', { discoverPools: discoverPoolsMock, fetchPoolReserves }, writePoints)

    expect(writePoints).toHaveBeenCalledTimes(1)
    expect(writePoints.mock.calls[0][0]).toHaveLength(1)
  })

  it('never rejects when discovery throws — an unreachable Phoenix RPC degrades the venue only', async () => {
    const deps = {
      discoverPools: vi.fn().mockRejectedValue(new Error('socket hang up')),
      fetchPoolReserves: vi.fn(),
    }
    await expect(ingestPhoenixPair(usdcXlmPair as any, 'mainnet', deps, writePoints)).resolves.toBeUndefined()
    expect(writePoints).not.toHaveBeenCalled()
  })

  it('never rejects when a pool read throws', async () => {
    const deps = {
      discoverPools: vi.fn().mockResolvedValue([poolDescriptor(xlmUsdcPool)]),
      fetchPoolReserves: vi.fn().mockRejectedValue(new Error('socket hang up')),
    }
    await expect(ingestPhoenixPair(usdcXlmPair as any, 'mainnet', deps, writePoints)).resolves.toBeUndefined()
    expect(writePoints).not.toHaveBeenCalled()
  })

  it('writes through the shared writer, tagged with the network it read from', async () => {
    const deps = depsReturning([poolDescriptor(xlmUsdcPool)], xlmUsdcPool)

    await ingestPhoenixPair(usdcXlmPair as any, 'mainnet', deps)

    expect(upsertPricePoints).toHaveBeenCalledTimes(1)
    const [rows, network] = (upsertPricePoints as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(network).toBe('mainnet')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'phoenix_amm', poolId: XLM_USDC_POOL })
  })

  it('writes each instance its own network, never the active one', async () => {
    // Two ingester instances run in one process (see ENABLED_NETWORKS). A row
    // written from a testnet read must not land in the mainnet series — that
    // merge is the bug this repo is fixing on four existing routes.
    const mainnetDeps = depsReturning([poolDescriptor(xlmUsdcPool)], xlmUsdcPool)
    const testnetDeps = depsReturning([], null)

    await ingestPhoenixPair(usdcXlmPair as any, 'mainnet', mainnetDeps)
    await ingestPhoenixPair(usdcXlmPair as any, 'testnet', testnetDeps)

    const writtenNetworks = (upsertPricePoints as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1])
    expect(writtenNetworks).toEqual(['mainnet'])
    expect(testnetDeps.discoverPools).toHaveBeenCalledWith('testnet')
  })
})

// ── adapter contract ──────────────────────────────────────────────────────────

describe('phoenixAdapter', () => {
  it('identifies itself as Phoenix with its own source', () => {
    expect(phoenixAdapter.name).toBe('Phoenix')
    expect(phoenixAdapter.source).toBe('phoenix_amm')
  })

  it('is enabled only where the network config says so', () => {
    expect(phoenixAdapter.isEnabled('mainnet')).toBe(true)
    expect(phoenixAdapter.isEnabled('testnet')).toBe(false)
  })

  it('polls at the configured Phoenix interval', () => {
    expect(phoenixAdapter.getPollIntervalMs('mainnet')).toBe(60_000)
    mocks.networks.mainnet.phoenix.pollIntervalMs = 30_000
    expect(phoenixAdapter.getPollIntervalMs('mainnet')).toBe(30_000)
    mocks.networks.mainnet.phoenix.pollIntervalMs = 60_000
  })

  it('reads and derives through one target', async () => {
    mocks.rpc.simulateTransaction.mockResolvedValue({
      result: { retval: poolInfoScVal(XLM_SAC, liveXlmReserve, USDC_SAC, liveUsdcReserve) },
    })
    const target = poolDescriptor(xlmUsdcPool)

    const raw = await phoenixAdapter.read(target, usdcXlmPair as any, 'mainnet')
    expect(raw).toEqual(xlmUsdcPool)
    expect(phoenixAdapter.derive(raw as PhoenixReserves, target, usdcXlmPair as any, 'mainnet')).toHaveLength(1)
    expect(phoenixAdapter.derive(null, target, usdcXlmPair as any, 'mainnet')).toEqual([])
  })

  it('drops a pool whose tokens turn out not to be the watched pair', async () => {
    mocks.rpc.simulateTransaction.mockResolvedValue({
      result: { retval: poolInfoScVal(EURC_SAC, 1n, XLM_SAC, 1n) },
    })
    const target = { poolAddress: XLM_USDC_POOL, tokenAAddress: XLM_SAC, tokenBAddress: USDC_SAC }

    await expect(phoenixAdapter.read(target, usdcXlmPair as any, 'mainnet')).resolves.toBeNull()
  })

  it('filters discovery down to the pools that quote the pair', async () => {
    const eurc: PhoenixPool = { poolAddress: XLM_EURC_POOL, tokenAAddress: XLM_SAC, tokenBAddress: EURC_SAC }
    const refresh = vi.fn().mockResolvedValue([poolDescriptor(xlmUsdcPool), eurc])
    await discoverPools('mainnet', 600_000, refresh)

    const found = await phoenixAdapter.discover(usdcXlmPair as any, 'mainnet')
    expect(found).toEqual([poolDescriptor(xlmUsdcPool)])
  })
})
