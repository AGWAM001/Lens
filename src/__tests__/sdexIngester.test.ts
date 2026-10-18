// ── Mocks ───────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  db: {
    upsertPricePoints: vi.fn(),
    getIndexerState: vi.fn(),
    setIndexerCursor: vi.fn(),
  },
  webhook: {
    dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
  },
  horizon: {
    mockCall: vi.fn(),
  }
}))

vi.mock('../db', () => mocks.db)
vi.mock('../webhookDispatcher', () => mocks.webhook)

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal() as any
  
  class MockServer {
    constructor() {}
    trades() { return this }
    forAssetPair() { return this }
    cursor() { return this }
    limit() { return this }
    order() { return this }
    call() { return mocks.horizon.mockCall() }
  }

  return {
    ...actual,
    Horizon: {
      Server: MockServer,
    },
  }
})

// ── Imports ──────────────────────────────────────────────────────────────────
import { ingestPair } from '../ingesters/sdex'

describe('SDEX Ingester', () => {
  const mockPair = {
    pairKey: 'XLM-USD',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  it('ingests SDEX trades correctly', async () => {
    mocks.db.getIndexerState.mockResolvedValue({ cursor: '0', ledger: null })
    
    // Captured verbatim from GET https://horizon.stellar.org/trades?limit=1&order=desc
    // on 2026-09-30 — Horizon sends no `ledger` on a trade, only `ledger_close_time`.
    // If this fixture ever grows a `ledger` field it stops exercising the TOID path.
    const record = {
      id: '277893235979689985-0',
      paging_token: '277893235979689985-0',
      ledger_close_time: '2026-09-30T19:21:27Z',
      trade_type: 'orderbook',
      base_offer_id: '4889579254407077889',
      base_account: 'GCMTO2QLCBF76V4EUMRKFVHKWLQEE27VRQGKV3X2GKLQD3JYUJRNM4JQ',
      base_amount: '150.0000000',
      base_asset_type: 'native',
      counter_offer_id: '1859615459',
      counter_account: 'GBQURNDHW36S23XPHTWBFLEP5NZ5SKKZETHRGOJXI4WXOMDAQ2YHMWBR',
      counter_amount: '150000.0000000',
      counter_asset_type: 'credit_alphanum4',
      counter_asset_code: 'dXLM',
      counter_asset_issuer: 'GDUD43V3GU5SMMG5BDCIYGJAFYOWPOLDQUBPRTWBVQBKATRS7R52WD3W',
      base_is_seller: false,
      price: { n: '1000', d: '1' },
    }
    expect(record).not.toHaveProperty('ledger')

    mocks.horizon.mockCall.mockResolvedValue({ records: [record] })

    await ingestPair(mockPair as any)

    expect(mocks.db.upsertPricePoints).toHaveBeenCalled()

    // The trade's real ledger must reach both the stored price point and the
    // indexer cursor — otherwise `/status`'s lastIndexedLedger stays null, and
    // a missing ledger would make prisma.pricePoint.createMany reject the batch
    // (the column is a required Int).
    const points = mocks.db.upsertPricePoints.mock.calls[0][0]
    expect(points[0].ledger).toBe(64702061)
    expect(mocks.db.setIndexerCursor).toHaveBeenCalledWith(
      'sdex:testnet:XLM-USD',
      '277893235979689985-0',
      'testnet',
      64702061
    )
  })

  it('handles zero trades safely', async () => {
    mocks.db.getIndexerState.mockResolvedValue({ cursor: '0', ledger: null })
    mocks.horizon.mockCall.mockResolvedValue({
      records: []
    })

    await ingestPair(mockPair as any)

    expect(mocks.db.upsertPricePoints).not.toHaveBeenCalled()
  })

  it('falls back to the stored ledger when a trade id cannot be parsed', async () => {
    mocks.db.getIndexerState.mockResolvedValue({ cursor: '0', ledger: 512345 })
    mocks.horizon.mockCall.mockResolvedValue({
      records: [
        {
          id: 'not-a-toid',
          paging_token: 'not-a-toid',
          base_asset_type: 'native',
          base_amount: '10.0',
          counter_amount: '2.0',
          price: { n: 2, d: 10 },
          ledger_close_time: '2026-09-30T00:00:00Z',
        }
      ]
    })

    await ingestPair(mockPair as any)

    const points = mocks.db.upsertPricePoints.mock.calls[0][0]
    expect(points[0].ledger).toBe(512345)
    expect(mocks.db.setIndexerCursor).toHaveBeenCalledWith(
      'sdex:testnet:XLM-USD',
      'not-a-toid',
      'testnet',
      512345
    )
  })

  it('skips the batch when no ledger can be established', async () => {
    mocks.db.getIndexerState.mockResolvedValue({ cursor: '0', ledger: null })
    mocks.horizon.mockCall.mockResolvedValue({
      records: [
        {
          id: 'not-a-toid',
          paging_token: 'not-a-toid',
          base_asset_type: 'native',
          base_amount: '10.0',
          counter_amount: '2.0',
          price: { n: 2, d: 10 },
          ledger_close_time: '2026-09-30T00:00:00Z',
        }
      ]
    })

    await ingestPair(mockPair as any)

    // A price tagged with a fabricated ledger is worse than none, and the
    // column is required — so nothing is written and the cursor is not moved.
    expect(mocks.db.upsertPricePoints).not.toHaveBeenCalled()
    expect(mocks.db.setIndexerCursor).not.toHaveBeenCalled()
  })
})
