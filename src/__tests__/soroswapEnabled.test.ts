/**
 * Verifies the Soroswap ingester respects the per-network enable flag,
 * skipping the polling loop entirely when Soroswap has no usable deployment
 * on the active network.
 */

const mocks = vi.hoisted(() => ({
  config: {
    soroswap: {
      enabled: true,
      factoryAddress: 'CFACTORY',
      tokenListUrl: 'https://example.com/tokens.json',
      pollIntervalMs: 60000,
    },
    network: { passphrase: 'Test SDF Network ; September 2015' },
    rpc: { url: 'https://soroban-testnet.stellar.org' },
  },
  pairsRegistry: {
    getActivePairs: vi.fn().mockReturnValue([]),
  },
}))

// The ingester now takes `network` (defaulting to `activeNetwork`) and reads
// via getNetworkConfig, so the mock has to supply both. getNetworkConfig
// returns the same object the test mutates, keeping `enabled` toggleable.
vi.mock('../config', () => ({
  config: mocks.config,
  activeNetwork: 'testnet',
  getNetworkConfig: () => mocks.config,
}))
vi.mock('../pairsRegistry', () => mocks.pairsRegistry)
vi.mock('../db', () => ({ upsertPricePoints: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined) }))

import { startSoroswapIngester } from '../ingest/venues/soroswap'

describe('startSoroswapIngester', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not start the polling loop when Soroswap is disabled on the active network', async () => {
    mocks.config.soroswap.enabled = false

    await startSoroswapIngester()

    expect(mocks.pairsRegistry.getActivePairs).not.toHaveBeenCalled()

    mocks.config.soroswap.enabled = true
  })
})
