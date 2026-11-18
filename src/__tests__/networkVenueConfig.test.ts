/**
 * Unit tests for per-network venue configuration (Soroswap / Aquarius / Phoenix / Reflector).
 *
 * Each test resets modules and re-imports `../config` after mutating
 * `process.env` so the lazy per-network cache in config.ts is rebuilt from
 * the env vars set for that test.
 */

import { StrKey } from '@stellar/stellar-sdk'

// config.ts logs invalid contract ids through the structured logger; capture
// those calls so the tests can assert on the warning without a live sink.
const { configLogger } = vi.hoisted(() => ({
  configLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => configLogger,
  logger: configLogger,
  loggerOptions: () => ({}),
  createDestination: () => ({ write: () => {} }),
}))

const ENV_KEYS = [
  'STELLAR_NETWORK',
  'SOROSWAP_ENABLED_TESTNET',
  'SOROSWAP_ENABLED_MAINNET',
  'SOROSWAP_TOKEN_LIST_URL',
  'SOROSWAP_TOKEN_LIST_URL_TESTNET',
  'AQUARIUS_ENABLED_TESTNET',
  'AQUARIUS_ENABLED_MAINNET',
  'AQUARIUS_API_URL',
  'REFLECTOR_CONTRACT_ID_TESTNET',
  'REFLECTOR_CONTRACT_ID_MAINNET',
  'REFLECTOR_ENABLED_TESTNET',
  'REFLECTOR_CONTRACT_ID',
  'SOROSWAP_FACTORY_ADDRESS',
  'SOROSWAP_FACTORY_ADDRESS_TESTNET',
  'SOROSWAP_FACTORY_ADDRESS_MAINNET',
  'PHOENIX_FACTORY_ADDRESS',
  'PHOENIX_FACTORY_ADDRESS_TESTNET',
  'PHOENIX_FACTORY_ADDRESS_MAINNET',
  'PHOENIX_ENABLED_TESTNET',
  'PHOENIX_ENABLED_MAINNET',
  'PHOENIX_POLL_INTERVAL_MS',
  'PHOENIX_POOL_CACHE_TTL_MS',
  'WATCHED_PAIRS',
  'WATCHED_PAIRS_TESTNET',
  'WATCHED_PAIRS_MAINNET',
]

const VALID_CONTRACT_ID = 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'
// The two 55-character literals config.ts used to ship as defaults.
const OLD_REFLECTOR_LITERAL = 'CCYXZMNHFXHKF3YEX4VJJ5TH3YHCVZIBPNBGM7C4PJIMCIMNNWDOQYA'
const OLD_SOROSWAP_TESTNET_LITERAL = 'CDKP5WSEZMDL53VZFPBGCL47WBPKFCN5OPYQVXB3CJWUXHPZRPHSSZ3'

async function loadConfig() {
  vi.resetModules()
  return await import('../config')
}

describe('per-network venue config', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key]
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
  })

  it('ships a mainnet watched pair by default, and it is Circle USDC', async () => {
    // Every other per-network setting has a mainnet default, so turning mainnet
    // on should not also require pasting an issuer address. Pinned because the
    // wallet converts balances to fiat against this pair: quote the wrong USDC
    // — Horizon lists many unrelated assets by that code — and every balance on
    // screen is wrong in a way nothing else would catch.
    delete process.env.WATCHED_PAIRS
    delete process.env.WATCHED_PAIRS_MAINNET

    const { getNetworkConfig } = await loadConfig()
    const pairs = getNetworkConfig('mainnet').pairs

    expect(pairs).toHaveLength(1)
    expect(pairs[0].assetA.code).toBe('USDC')
    expect(pairs[0].assetA.issuer).toBe(
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    )
    expect(pairs[0].assetB.code).toBe('XLM')
  })

  it('lets WATCHED_PAIRS_MAINNET override the default', async () => {
    process.env.WATCHED_PAIRS_MAINNET =
      'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2/XLM'

    const { getNetworkConfig } = await loadConfig()
    const pairs = getNetworkConfig('mainnet').pairs

    expect(pairs).toHaveLength(1)
    expect(pairs[0].assetA.code).toBe('EURC')
  })

  it('defaults Aquarius to disabled on testnet and enabled on mainnet', async () => {
    delete process.env.AQUARIUS_ENABLED_TESTNET
    delete process.env.AQUARIUS_ENABLED_MAINNET

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').aquarius.enabled).toBe(false)
    expect(getNetworkConfig('mainnet').aquarius.enabled).toBe(true)
  })

  it('respects an explicit AQUARIUS_ENABLED_TESTNET=true override', async () => {
    process.env.AQUARIUS_ENABLED_TESTNET = 'true'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').aquarius.enabled).toBe(true)
  })

  it('defaults Soroswap to enabled on both networks', async () => {
    delete process.env.SOROSWAP_ENABLED_TESTNET
    delete process.env.SOROSWAP_ENABLED_MAINNET

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').soroswap.enabled).toBe(true)
    expect(getNetworkConfig('mainnet').soroswap.enabled).toBe(true)
  })

  it('disables Soroswap on a network when explicitly set to false', async () => {
    process.env.SOROSWAP_ENABLED_TESTNET = 'false'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').soroswap.enabled).toBe(false)
  })

  it('resolves a per-network token-list URL override before falling back to the shared default', async () => {
    delete process.env.SOROSWAP_TOKEN_LIST_URL
    process.env.SOROSWAP_TOKEN_LIST_URL_TESTNET = 'https://example.com/testnet-tokens.json'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').soroswap.tokenListUrl).toBe(
      'https://example.com/testnet-tokens.json'
    )
    expect(getNetworkConfig('mainnet').soroswap.tokenListUrl).toBe(
      'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'
    )
  })

  it('disables the Reflector oracle when no contract id is configured for the network', async () => {
    delete process.env.REFLECTOR_CONTRACT_ID_TESTNET

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').oracle.reflectorContractId).toBe('')
    expect(getNetworkConfig('testnet').oracle.enabled).toBe(false)
  })

  it('has no built-in Reflector contract id: the oracle stays disabled until one is configured', async () => {
    delete process.env.REFLECTOR_CONTRACT_ID_MAINNET
    delete process.env.REFLECTOR_CONTRACT_ID

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('mainnet').oracle.reflectorContractId).toBe('')
    expect(getNetworkConfig('mainnet').oracle.enabled).toBe(false)
  })

  it('enables the Reflector oracle when a valid 56-character contract id is configured', async () => {
    process.env.REFLECTOR_CONTRACT_ID_MAINNET = VALID_CONTRACT_ID

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('mainnet').oracle.enabled).toBe(true)
    expect(getNetworkConfig('mainnet').oracle.reflectorContractId).toBe(VALID_CONTRACT_ID)
  })

  it('rejects the former 55-character mainnet Reflector default, disabling the oracle and naming the env var', async () => {
    configLogger.warn.mockClear()
    process.env.REFLECTOR_CONTRACT_ID_MAINNET = OLD_REFLECTOR_LITERAL

    const { getNetworkConfig } = await loadConfig()

    expect(OLD_REFLECTOR_LITERAL).toHaveLength(55)
    expect(getNetworkConfig('mainnet').oracle.enabled).toBe(false)
    expect(configLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ envVar: 'REFLECTOR_CONTRACT_ID_MAINNET', value: OLD_REFLECTOR_LITERAL }),
      expect.stringContaining('invalid Soroban contract id')
    )
  })

  it('rejects the former 55-character testnet Soroswap default, disabling Soroswap and naming the env var', async () => {
    configLogger.warn.mockClear()
    process.env.SOROSWAP_FACTORY_ADDRESS_TESTNET = OLD_SOROSWAP_TESTNET_LITERAL

    const { getNetworkConfig } = await loadConfig()

    expect(OLD_SOROSWAP_TESTNET_LITERAL).toHaveLength(55)
    expect(getNetworkConfig('testnet').soroswap.enabled).toBe(false)
    expect(configLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ envVar: 'SOROSWAP_FACTORY_ADDRESS_TESTNET' }),
      expect.stringContaining('invalid Soroban contract id')
    )
  })

  it('accepts a valid 56-character Soroswap factory id', async () => {
    process.env.SOROSWAP_FACTORY_ADDRESS_TESTNET = VALID_CONTRACT_ID

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').soroswap.enabled).toBe(true)
    expect(getNetworkConfig('testnet').soroswap.factoryAddress).toBe(VALID_CONTRACT_ID)
  })

  it('ships built-in Soroswap factory defaults that are valid contract ids', async () => {
    delete process.env.SOROSWAP_FACTORY_ADDRESS
    delete process.env.SOROSWAP_FACTORY_ADDRESS_TESTNET
    delete process.env.SOROSWAP_FACTORY_ADDRESS_MAINNET

    const { getNetworkConfig } = await loadConfig()

    for (const network of ['testnet', 'mainnet'] as const) {
      const { soroswap } = getNetworkConfig(network)
      expect(StrKey.isValidContract(soroswap.factoryAddress)).toBe(true)
      expect(soroswap.enabled).toBe(true)
    }
  })

  it('resolves a custom Aquarius API URL override', async () => {
    process.env.AQUARIUS_API_URL = 'https://example.com/aquarius/'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').aquarius.apiUrl).toBe('https://example.com/aquarius/')
    expect(getNetworkConfig('mainnet').aquarius.apiUrl).toBe('https://example.com/aquarius/')
  })

  // ── Phoenix ────────────────────────────────────────────────────────────────

  it('ships the Phoenix mainnet factory id published by Phoenix itself', async () => {
    delete process.env.PHOENIX_FACTORY_ADDRESS
    delete process.env.PHOENIX_FACTORY_ADDRESS_TESTNET
    delete process.env.PHOENIX_FACTORY_ADDRESS_MAINNET

    const { getNetworkConfig } = await loadConfig()
    const { phoenix } = getNetworkConfig('mainnet')

    // scripts/extend-queries.sh and scripts/deploy_pool.sh in
    // github.com/Phoenix-Protocol-Group/phoenix-contracts both set FACTORY to
    // exactly this id, next to mainnet.sorobanrpc.com and the public
    // passphrase. Pinned whole: an elided or invented id would decode fine for
    // one network and quote nothing, or worse, someone else's contracts.
    expect(phoenix.factoryAddress).toBe('CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI')
    expect(phoenix.factoryAddress).toHaveLength(56)
    expect(StrKey.isValidContract(phoenix.factoryAddress)).toBe(true)
    expect(phoenix.enabled).toBe(true)
  })

  it('has no built-in Phoenix testnet factory: the venue stays disabled until one is configured', async () => {
    delete process.env.PHOENIX_FACTORY_ADDRESS
    delete process.env.PHOENIX_FACTORY_ADDRESS_TESTNET

    const { getNetworkConfig } = await loadConfig()

    // Phoenix publishes no testnet deployment. Defaulting to something
    // "plausible" here would ingest a contract that does not exist and label the
    // resulting absence of prices as a live market.
    const { phoenix } = getNetworkConfig('testnet')
    expect(phoenix.factoryAddress).toBe('')
    expect(phoenix.enabled).toBe(false)
  })

  it('enables Phoenix on testnet when a valid factory id is configured', async () => {
    process.env.PHOENIX_FACTORY_ADDRESS_TESTNET = VALID_CONTRACT_ID

    const { getNetworkConfig } = await loadConfig()
    const { phoenix } = getNetworkConfig('testnet')

    expect(phoenix.enabled).toBe(true)
    expect(phoenix.factoryAddress).toBe(VALID_CONTRACT_ID)
  })

  it('rejects a malformed Phoenix factory id, disabling the venue and naming the env var', async () => {
    // config.ts warns through the structured logger, not console — same shape
    // the Reflector and Soroswap cases above assert.
    configLogger.warn.mockClear()
    const MALFORMED = 'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKM'
    process.env.PHOENIX_FACTORY_ADDRESS_MAINNET = MALFORMED

    const { getNetworkConfig } = await loadConfig()

    expect(MALFORMED).toHaveLength(55)
    expect(getNetworkConfig('mainnet').phoenix.enabled).toBe(false)
    expect(configLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ envVar: 'PHOENIX_FACTORY_ADDRESS_MAINNET', value: MALFORMED }),
      expect.stringContaining('invalid Soroban contract id')
    )
  })

  it('applies the unsuffixed PHOENIX_FACTORY_ADDRESS to testnet only', async () => {
    // A single-network deployment sets the generic var. Letting it reach mainnet
    // would aim the mainnet ingester at a testnet contract and merge the two
    // markets into one series under a real-looking source label.
    process.env.PHOENIX_FACTORY_ADDRESS = VALID_CONTRACT_ID
    delete process.env.PHOENIX_FACTORY_ADDRESS_TESTNET
    delete process.env.PHOENIX_FACTORY_ADDRESS_MAINNET

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('testnet').phoenix.factoryAddress).toBe(VALID_CONTRACT_ID)
    expect(getNetworkConfig('mainnet').phoenix.factoryAddress).toBe(
      'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI'
    )
  })

  it('disables Phoenix when PHOENIX_ENABLED_MAINNET=false even with a valid factory', async () => {
    process.env.PHOENIX_ENABLED_MAINNET = 'false'

    const { getNetworkConfig } = await loadConfig()

    expect(getNetworkConfig('mainnet').phoenix.enabled).toBe(false)
  })

  it('resolves Phoenix poll and pool-cache intervals', async () => {
    delete process.env.PHOENIX_POLL_INTERVAL_MS
    delete process.env.PHOENIX_POOL_CACHE_TTL_MS

    const { getNetworkConfig } = await loadConfig()
    expect(getNetworkConfig('mainnet').phoenix.pollIntervalMs).toBe(60_000)
    expect(getNetworkConfig('mainnet').phoenix.poolCacheTtlMs).toBe(600_000)

    process.env.PHOENIX_POOL_CACHE_TTL_MS = '90000'
    const reloaded = await loadConfig()
    expect(reloaded.getNetworkConfig('mainnet').phoenix.poolCacheTtlMs).toBe(90_000)
  })
})
