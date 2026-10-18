// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../db', () => ({
  prisma: {
    poolSnapshot: {
      create: vi.fn(),
    },
  },
  upsertPricePoints: vi.fn(),
  getIndexerState: vi.fn(),
  setIndexerCursor: vi.fn(),
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

// ── Imports ──────────────────────────────────────────────────────────────────
import { snapshotPool, ingestPoolTrades } from '../ingesters/amm'
import { prisma, upsertPricePoints, getIndexerState, setIndexerCursor } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'

describe('AMM Ingester', () => {
  const mockPair = {
    pairKey: 'XLM-USD',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  it('calculates snapshot price correctly', async () => {
    const mockPool = {
      id: 'pool-1',
      reserves: [
        { asset: 'native', amount: '100.0' },
        { asset: 'USD:GABC...', amount: '20.0' },
      ],
      total_shares: '50',
      last_modified_ledger: 12345,
    }

    await snapshotPool(mockPool, mockPair as any)

    expect(prisma.poolSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spotPrice: 0.2,
        }),
      })
    )
  })

  it('tags snapshots with the requested network when STELLAR_NETWORK is unset', async () => {
    const previousNetwork = process.env.STELLAR_NETWORK
    delete process.env.STELLAR_NETWORK

    try {
      vi.resetModules()
      const createSnapshot = vi.fn()
      vi.doMock('../db', () => ({
        prisma: { poolSnapshot: { create: createSnapshot } },
        upsertPricePoints: vi.fn(),
        getIndexerCursor: vi.fn(),
        setIndexerCursor: vi.fn(),
      }))
      const { snapshotPool: snapshotOnMainnet } = await import('../ingesters/amm')

      await snapshotOnMainnet({
        id: 'pool-mainnet',
        reserves: [
          { asset: 'native', amount: '100.0' },
          { asset: 'USD:GABC...', amount: '20.0' },
        ],
        total_shares: '50',
        last_modified_ledger: 12345,
      }, mockPair as any, 'mainnet')

      expect(createSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ network: 'mainnet' }),
        })
      )
    } finally {
      if (previousNetwork === undefined) delete process.env.STELLAR_NETWORK
      else process.env.STELLAR_NETWORK = previousNetwork
    }
  })

  it('ingests trades correctly', async () => {
    (getIndexerState as any).mockResolvedValue({ cursor: '0', ledger: null })
    
    // Captured verbatim from GET
    // https://horizon.stellar.org/liquidity_pools/{id}/trades?limit=1&order=desc
    // on 2026-09-30 — Horizon sends no `ledger` on a trade, only `ledger_close_time`.
    // If this fixture ever grows a `ledger` field it stops exercising the TOID path.
    const record = {
      id: '277710193062797313-0',
      paging_token: '277710193062797313-0',
      ledger_close_time: '2026-09-28T08:09:56Z',
      trade_type: 'liquidity_pool',
      liquidity_pool_fee_bp: 30,
      base_offer_id: '4889396211490185217',
      base_account: 'GAKR45J2KB5K7UNGOUNQDVOZWWZXKFD3NYWVIHUQQLH3QHU55D2PQGVJ',
      base_amount: '0.0017477',
      base_asset_type: 'native',
      counter_liquidity_pool_id: '0000a8198b5e25994c1ca5b0556faeb27325ac746296944144e0a7406d501e8a',
      counter_amount: '2116529.3181152',
      counter_asset_type: 'credit_alphanum12',
      counter_asset_code: 'GOLDBANK001',
      counter_asset_issuer: 'GDEUQ2MX3YXMITFOTC3CO3GW5V3XE3IVG7JKLZZAOZ7WFYIN256INDUS',
      base_is_seller: false,
      price: { n: '21165293181152', d: '17477' },
    }
    expect(record).not.toHaveProperty('ledger')

    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ _embedded: { records: [record] } })
    })

    // Deliberately a network other than the active one: the point of passing
    // it explicitly is that rows are tagged by the loop that produced them, not
    // by the process-wide STELLAR_NETWORK. Asserting 'testnet' here would pass
    // just as well against the bug this replaced.
    await ingestPoolTrades({ id: 'pool-1' }, mockPair as any, 'mainnet')

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          price: expect.closeTo(1211036973.230646, 0),
          ledger: 64659443,
        })
      ]),
      'mainnet'
    )

    // The cursor row carries the ledger too, so `/status` can report it.
    expect(setIndexerCursor).toHaveBeenCalledWith(
      'amm:mainnet:pool-1',
      '277710193062797313-0',
      'mainnet',
      64659443
    )
  })
})
