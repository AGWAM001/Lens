/**
 * Unit tests for the DeFindex vault venue adapter (#214).
 *
 * Focus areas required by the issue:
 * - share-price arithmetic pinned against known reserves (calcSharePrice)
 * - a vault with zero shares must not divide by zero
 * - the source distinguishes a DERIVED vault price from a traded one
 * - the ingester writes the network it read from (per ENABLED_NETWORKS entry)
 *
 * vitest globals (describe/it/expect/vi) are enabled via vitest.config.ts.
 */

// ── Mocks (paths relative to this test file) ──────────────────────────────────
vi.mock('../config', () => {
  const block = {
    horizon: { url: 'https://horizon-testnet.stellar.org' },
    rpc: { url: 'https://soroban-testnet.stellar.org' },
    network: { passphrase: 'Test SDF Network ; September 2015' },
    soroswap: { enabled: false, factoryAddress: '', tokenListUrl: '', pollIntervalMs: 60000 },
    aquarius: { enabled: false, apiUrl: '' },
    defindex: {
      enabled: true,
      factoryAddress: 'CFACTORYFACTORYFACTORYFACTORYFACTORYFACTORYFACTORY0',
      pollIntervalMs: 60000,
    },
    oracle: { enabled: false, reflectorContractId: '' },
    pairs: [] as any[],
    facilitator: { feeStroops: 50000 },
  }
  return {
    activeNetwork: 'testnet',
    getNetworkConfig: () => block,
    config: { indexer: { pollIntervalMs: 5000 }, aquarius: { apiUrl: '' } },
  }
})

vi.mock('../pairsRegistry', () => ({
  // Mirrors the real makePairKey: alphabetical, issuer-qualified asset strings.
  makePairKey: (a: any, b: any) =>
    [a.issuer ? `${a.code}:${a.issuer}` : a.code, b.issuer ? `${b.code}:${b.issuer}` : b.code]
      .sort()
      .join('/'),
  getActivePairs: () => [],
}))

vi.mock('../db', () => ({
  upsertPricePoints: vi.fn().mockResolvedValue(undefined),
  getIndexerState: vi.fn(),
  setIndexerCursor: vi.fn(),
}))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../events', () => ({ publishPriceUpdate: vi.fn() }))
vi.mock('../network/clients', () => ({ getRpcServer: vi.fn() }))

// ── Imports ───────────────────────────────────────────────────────────────────
import {
  calcSharePrice,
  deriveDeFindexPricePoints,
  ingestDeFindexVault,
  ingestDeFindexNetwork,
  DEFINDEX_SOURCE,
  _resetLastPrice,
  _getLastPrice,
  _resetScanState,
  type DeFindexVaultSnapshot,
} from '../ingest/venues/defindex'
import { upsertPricePoints } from '../db'

const VAULT = 'CVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA00'
const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

function snapshot(over: Partial<DeFindexVaultSnapshot> = {}): DeFindexVaultSnapshot {
  return {
    vaultAddress: VAULT,
    shareSymbol: 'dfUSDC',
    totalShares: 500_000_000n,
    underlying: [{ address: USDC, symbol: 'USDC', totalAmount: 1_000_000_000n }],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetLastPrice()
  _resetScanState()
})

// ── calcSharePrice: pinned arithmetic + zero-share guard ──────────────────────
describe('calcSharePrice', () => {
  it('derives totalAssets / totalShares against known reserves', () => {
    // 1_000_000_000 / 500_000_000 = 2 underlying units per share
    expect(calcSharePrice(1_000_000_000n, 500_000_000n)).toBeCloseTo(2, 10)
  })

  it('handles a fractional share price', () => {
    // 3 / 4 = 0.75
    expect(calcSharePrice(3n, 4n)).toBeCloseTo(0.75, 10)
  })

  it('handles an at-issuance 1:1 vault', () => {
    expect(calcSharePrice(1_000_000n, 1_000_000n)).toBe(1)
  })

  it('returns 0 for a vault with zero shares instead of dividing by zero', () => {
    // Would be Infinity / NaN if it divided; must be a clean 0.
    expect(calcSharePrice(1_000_000_000n, 0n)).toBe(0)
    expect(Number.isFinite(calcSharePrice(1_000_000_000n, 0n))).toBe(true)
  })

  it('returns 0 when there are no assets', () => {
    expect(calcSharePrice(0n, 500_000_000n)).toBe(0)
  })

  it('handles large i128 reserves', () => {
    expect(calcSharePrice(1_000_000_000_000n, 500_000n)).toBeCloseTo(2_000_000, 5)
  })
})

// ── deriveDeFindexPricePoints ─────────────────────────────────────────────────
describe('deriveDeFindexPricePoints', () => {
  it('produces a derived price point per underlying asset with the vault source', () => {
    const derived = deriveDeFindexPricePoints(snapshot())
    expect(derived).toHaveLength(1)

    const { pair, point } = derived[0]
    expect(point.source).toBe(DEFINDEX_SOURCE)
    expect(DEFINDEX_SOURCE).toBe('defindex_vault')
    expect(point.price).toBeCloseTo(2, 10)
    expect(point.poolId).toBe(VAULT)
    expect(point.assetA).toBe('dfUSDC')
    expect(point.assetB).toBe('USDC')
    expect(pair.pairKey).toBe(point.pairKey)
    // Share token (C... issuer) sorts after USDC:... alphabetically is not assumed;
    // the key is simply the sorted issuer-qualified pair.
    expect(point.pairKey.split('/').sort()).toEqual(
      [`USDC:${USDC}`, `dfUSDC:${VAULT}`].sort()
    )
    // Derived, not traded: no volume is ever attributed.
    expect(point.baseVolume).toBe(0)
    expect(point.counterVolume).toBe(0)
  })

  it('skips a zero-share vault (no divide-by-zero, no fabricated price)', () => {
    const derived = deriveDeFindexPricePoints(snapshot({ totalShares: 0n }))
    expect(derived).toEqual([])
  })

  it('emits one point per underlying asset in a multi-asset vault', () => {
    const derived = deriveDeFindexPricePoints(
      snapshot({
        totalShares: 1_000_000n,
        underlying: [
          { address: USDC, symbol: 'USDC', totalAmount: 5_000_000n },
          { address: 'CXLMAAAA', symbol: 'XLM', totalAmount: 2_000_000n },
        ],
      })
    )
    expect(derived).toHaveLength(2)
    expect(derived.map((d) => d.point.price).sort()).toEqual([2, 5])
  })
})

// ── ingestDeFindexVault / ingestDeFindexNetwork ───────────────────────────────
describe('ingestDeFindexNetwork', () => {
  it('writes price points tagged with the network it read from', async () => {
    const read = vi.fn().mockResolvedValue(snapshot())
    const discover = vi.fn().mockResolvedValue([VAULT])

    // Read/ingest against mainnet while the process is active as testnet, to
    // prove the network is honored rather than hard-coded.
    await ingestDeFindexNetwork('mainnet', discover, read)

    expect(read).toHaveBeenCalledWith(VAULT, 'mainnet')
    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ source: 'defindex_vault', poolId: VAULT, price: expect.closeTo(2, 5) }),
      ]),
      'mainnet'
    )
    // Last-price cache is keyed by the network that was read.
    expect(_getLastPrice('mainnet', deriveDeFindexPricePoints(snapshot())[0].point.pairKey)).toBeCloseTo(2, 5)
  })

  it('writes nothing when the vault has zero shares', async () => {
    const read = vi.fn().mockResolvedValue(snapshot({ totalShares: 0n }))
    const discover = vi.fn().mockResolvedValue([VAULT])

    await ingestDeFindexNetwork('testnet', discover, read)

    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('skips a vault whose on-chain read fails, without throwing', async () => {
    const read = vi.fn().mockResolvedValue(null)
    const discover = vi.fn().mockResolvedValue([VAULT])

    await expect(ingestDeFindexNetwork('testnet', discover, read)).resolves.toBeUndefined()
    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('is fault-isolated: a throwing read does not crash the cycle', async () => {
    const read = vi.fn().mockRejectedValue(new Error('rpc down'))
    const discover = vi.fn().mockResolvedValue([VAULT])

    await expect(ingestDeFindexVault(VAULT, 'testnet', read)).resolves.toBeUndefined()
    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('prices nothing when the factory discovers no vaults', async () => {
    const read = vi.fn()
    const discover = vi.fn().mockResolvedValue([])

    await ingestDeFindexNetwork('testnet', discover, read)

    expect(read).not.toHaveBeenCalled()
    expect(upsertPricePoints).not.toHaveBeenCalled()
  })
})
