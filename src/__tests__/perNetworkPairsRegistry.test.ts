import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const RUNTIME_AQUA = 'GBNZILSTVOZ4R7V2T3Q62X6P2K5G7S4V7J5H3H6C6Y5M7R3P2Y3P7K7M'

const { mockUpsert, mockFindMany, mockQuery } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue({}),
  mockFindMany: vi.fn().mockResolvedValue([]),
  mockQuery: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
}))

vi.mock('../db', () => ({
  prisma: {
    pairConfig: {
      upsert: mockUpsert,
      findMany: mockFindMany,
    },
  },
  pgPool: { query: mockQuery },
}))

describe('per-network pairsRegistry (#646)', () => {
  const savedTestnet = process.env.WATCHED_PAIRS_TESTNET
  const savedMainnet = process.env.WATCHED_PAIRS_MAINNET
  const savedEnabled = process.env.ENABLED_NETWORKS

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WATCHED_PAIRS_TESTNET = `USDC:${TESTNET_USDC}/XLM`
    process.env.WATCHED_PAIRS_MAINNET = `USDC:${MAINNET_USDC}/XLM`
    process.env.ENABLED_NETWORKS = 'testnet,mainnet'
  })

  afterEach(() => {
    if (savedTestnet === undefined) delete process.env.WATCHED_PAIRS_TESTNET
    else process.env.WATCHED_PAIRS_TESTNET = savedTestnet
    if (savedMainnet === undefined) delete process.env.WATCHED_PAIRS_MAINNET
    else process.env.WATCHED_PAIRS_MAINNET = savedMainnet
    if (savedEnabled === undefined) delete process.env.ENABLED_NETWORKS
    else process.env.ENABLED_NETWORKS = savedEnabled
  })

  it('seeds testnet and mainnet pairs independently from per-network config', async () => {
    vi.resetModules()
    const { getActivePairs, hasPair } = await import('../pairsRegistry')

    const testnetPairs = getActivePairs('testnet')
    const mainnetPairs = getActivePairs('mainnet')

    expect(testnetPairs.map(p => p.pairKey)).toEqual([`USDC:${TESTNET_USDC}/XLM`])
    expect(mainnetPairs.map(p => p.pairKey)).toEqual([`USDC:${MAINNET_USDC}/XLM`])
    expect(hasPair(`USDC:${TESTNET_USDC}/XLM`, 'testnet')).toBe(true)
    expect(hasPair(`USDC:${TESTNET_USDC}/XLM`, 'mainnet')).toBe(false)
    expect(hasPair(`USDC:${MAINNET_USDC}/XLM`, 'mainnet')).toBe(true)
    expect(hasPair(`USDC:${MAINNET_USDC}/XLM`, 'testnet')).toBe(false)
  })

  it('keeps runtime registerPair isolated to its target network and persists with network', async () => {
    vi.resetModules()
    const { getActivePairs, hasPair, registerPair, persistPair } = await import('../pairsRegistry')

    const customPair = {
      pairKey: `AQUA:${RUNTIME_AQUA}/XLM`,
      assetA: { code: 'AQUA', issuer: RUNTIME_AQUA },
      assetB: { code: 'XLM', issuer: null },
    }

    expect(registerPair(customPair, 'mainnet')).toBe(true)
    expect(registerPair(customPair, 'mainnet')).toBe(false)
    expect(hasPair(customPair.pairKey, 'mainnet')).toBe(true)
    expect(hasPair(customPair.pairKey, 'testnet')).toBe(false)
    expect(getActivePairs('mainnet').some(p => p.pairKey === customPair.pairKey)).toBe(true)
    expect(getActivePairs('testnet').some(p => p.pairKey === customPair.pairKey)).toBe(false)

    await persistPair(customPair, 'mainnet')
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { network_pairKey: { network: 'mainnet', pairKey: customPair.pairKey } },
        create: expect.objectContaining({ network: 'mainnet', pairKey: customPair.pairKey }),
      })
    )
  })

  it('loadPersistedPairs loads rows across all enabled networks and registers each onto its own network', async () => {
    vi.resetModules()
    mockFindMany.mockResolvedValueOnce([
      {
        network: 'testnet',
        pairKey: `AQUA:${RUNTIME_AQUA}/XLM`,
        assetACode: 'AQUA',
        assetAIssuer: RUNTIME_AQUA,
        assetBCode: 'XLM',
        assetBIssuer: null,
      },
      {
        network: 'mainnet',
        pairKey: 'EURC/XLM',
        assetACode: 'EURC',
        assetAIssuer: null,
        assetBCode: 'XLM',
        assetBIssuer: null,
      },
    ])

    const { loadPersistedPairs, hasPair } = await import('../pairsRegistry')
    await loadPersistedPairs()

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { network: { in: ['testnet', 'mainnet'] } },
    })
    expect(hasPair(`AQUA:${RUNTIME_AQUA}/XLM`, 'testnet')).toBe(true)
    expect(hasPair(`AQUA:${RUNTIME_AQUA}/XLM`, 'mainnet')).toBe(false)
    expect(hasPair('EURC/XLM', 'mainnet')).toBe(true)
    expect(hasPair('EURC/XLM', 'testnet')).toBe(false)
  })

  it('runner cycles and snapshot cycles only ingest pairs belonging to that cycle network', async () => {
    vi.resetModules()
    const { startVenueAdapter } = await import('../ingest/venues/runner')
    const { appendSnapshots } = await import('../ingest/snapshot')

    const seenByNetwork: Record<string, string[]> = { testnet: [], mainnet: [] }
    const controller = new AbortController()

    const fakeAdapter = {
      name: 'test-adapter',
      sourceTimeCapability: { status: 'declared' as const },
      isEnabled: () => true,
      getPollIntervalMs: () => 0,
      ingestPair: vi.fn(async (pair: { pairKey: string }, net: 'testnet' | 'mainnet') => {
        seenByNetwork[net].push(pair.pairKey)
        controller.abort()
      }),
    }

    await startVenueAdapter(fakeAdapter as any, 'testnet', { stopSignal: controller.signal })
    const controller2 = new AbortController()
    const fakeAdapter2 = {
      ...fakeAdapter,
      ingestPair: vi.fn(async (pair: { pairKey: string }, net: 'testnet' | 'mainnet') => {
        seenByNetwork[net].push(pair.pairKey)
        controller2.abort()
      }),
    }
    await startVenueAdapter(fakeAdapter2 as any, 'mainnet', { stopSignal: controller2.signal })

    expect(seenByNetwork.testnet).toEqual([`USDC:${TESTNET_USDC}/XLM`])
    expect(seenByNetwork.mainnet).toEqual([`USDC:${MAINNET_USDC}/XLM`])

    await appendSnapshots(new Date('2026-01-01T00:00:00Z'), 'testnet')
    expect(mockQuery).toHaveBeenLastCalledWith(
      expect.any(String),
      [[`USDC:${TESTNET_USDC}/XLM`], expect.any(Date), 'testnet']
    )

    await appendSnapshots(new Date('2026-01-01T00:00:00Z'), 'mainnet')
    expect(mockQuery).toHaveBeenLastCalledWith(
      expect.any(String),
      [[`USDC:${MAINNET_USDC}/XLM`], expect.any(Date), 'mainnet']
    )
  })
})
