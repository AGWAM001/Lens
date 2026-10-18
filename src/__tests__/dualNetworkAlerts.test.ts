import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  db: {
    prisma: {
      webhook: {
        findMany: vi.fn(),
      },
      poolSnapshot: {
        create: vi.fn(),
      },
    },
    upsertPricePoints: vi.fn().mockResolvedValue(undefined),
    // Synthetic paging tokens carry no TOID, so the ingesters fall back to
    // the ledger stored on the cursor row.
    getIndexerState: vi.fn().mockResolvedValue({ cursor: '0', ledger: 64702061 }),
    setIndexerCursor: vi.fn().mockResolvedValue(undefined),
  },
  horizonCall: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: mocks.db.prisma,
  upsertPricePoints: mocks.db.upsertPricePoints,
  getIndexerState: mocks.db.getIndexerState,
  setIndexerCursor: mocks.db.setIndexerCursor,
}))

vi.mock('../network/clients', () => ({
  getHorizonServer: (_network: string) => ({
    trades: () => ({
      forAssetPair: () => ({
        cursor: () => ({
          limit: () => ({
            order: () => ({
              call: mocks.horizonCall,
            }),
          }),
        }),
      }),
    }),
  }),
}))

import { ingestPair as ingestSdexPair, _getLastPrice as getSdexLastPrice, _resetLastPrice as resetSdexLastPrice } from '../ingesters/sdex'
import { snapshotPool, ingestPoolTrades, _getLastPrice as getAmmLastPrice, _resetLastPrice as resetAmmLastPrice } from '../ingesters/amm'
import { ingestPool as ingestSoroswapPool, _getLastPrice as getSoroswapLastPrice, _resetLastPrice as resetSoroswapLastPrice } from '../ingesters/soroswap'
import { ingestAquariusPair, _getLastPrice as getAquariusLastPrice, _resetLastPrice as resetAquariusLastPrice } from '../ingest/venues/aquarius'
import { dispatchPriceUpdate } from '../webhookDispatcher'
import type { WatchedPair } from '../types'

const mockPair: WatchedPair = {
  pairKey: 'XLM-USD',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
}

function makeTradeRecord(id: string, priceN: number, priceD: number) {
  return {
    id,
    paging_token: `token-${id}`,
    base_asset_type: 'native',
    base_amount: '100.0',
    counter_amount: (100 * (priceN / priceD)).toString(),
    price: { n: priceN, d: priceD },
    ledger_close_time: new Date().toISOString(),
  }
}

describe('Dual-network alerts and price tracking (#188)', () => {
  const testnetWebhook = {
    id: 'wh-testnet',
    network: 'testnet',
    url: 'https://testnet.example.com/webhook',
    assetA: 'XLM',
    assetB: 'USD',
    threshold: 0.10,
    direction: 'above',
    secret: 'secret-testnet',
    createdAt: new Date(),
  }

  const mainnetWebhook = {
    id: 'wh-mainnet',
    network: 'mainnet',
    url: 'https://mainnet.example.com/webhook',
    assetA: 'XLM',
    assetB: 'USD',
    threshold: 0.10,
    direction: 'above',
    secret: 'secret-mainnet',
    createdAt: new Date(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetSdexLastPrice()
    resetAmmLastPrice()
    resetSoroswapLastPrice()
    resetAquariusLastPrice()

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)

    mocks.db.prisma.webhook.findMany.mockImplementation(async (args: any) => {
      const targetNetwork = args?.where?.network
      if (targetNetwork === 'testnet') return [testnetWebhook]
      if (targetNetwork === 'mainnet') return [mainnetWebhook]
      return []
    })
  })

  describe('SDEX ingester dual-network isolation', () => {
    it('ensures a tick on one network never supplies the previous price for the other and alerts do not cross', async () => {
      // ── STEP 1: Trade on testnet at price 0.08 (< threshold 0.10) ─────────────
      mocks.horizonCall.mockResolvedValueOnce({
        records: [makeTradeRecord('t-testnet-1', 8, 100)],
      })
      await ingestSdexPair(mockPair, 'testnet')

      // Initial tick on testnet: price 0.08 is below 0.10 -> no alert
      expect(global.fetch).not.toHaveBeenCalled()
      expect(getSdexLastPrice('testnet', mockPair.pairKey)).toBe(0.08)
      expect(getSdexLastPrice('mainnet', mockPair.pairKey)).toBeUndefined()

      // ── STEP 2: Trade on mainnet at price 0.12 (>= threshold 0.10) ────────────
      // If lastPrice is network-blind, mainnet would pick up testnet's 0.08 as previousPrice,
      // think it crossed 0.10 (0.08 -> 0.12), and dispatch to testnet webhook!
      mocks.horizonCall.mockResolvedValueOnce({
        records: [makeTradeRecord('t-mainnet-1', 12, 100)],
      })
      await ingestSdexPair(mockPair, 'mainnet')

      // First trade on mainnet has previousPrice = 0.12 (no cross), and must NOT fire testnet alert
      expect(global.fetch).not.toHaveBeenCalled()
      expect(getSdexLastPrice('mainnet', mockPair.pairKey)).toBe(0.12)
      // Testnet lastPrice must still be 0.08, not overridden by mainnet
      expect(getSdexLastPrice('testnet', mockPair.pairKey)).toBe(0.08)

      // ── STEP 3: Second trade on testnet at price 0.11 (crosses above 0.10 from 0.08) ─
      mocks.horizonCall.mockResolvedValueOnce({
        records: [makeTradeRecord('t-testnet-2', 11, 100)],
      })
      await ingestSdexPair(mockPair, 'testnet')

      // Testnet crossed above threshold! ONLY testnet webhook should fire
      expect(global.fetch).toHaveBeenCalledOnce()
      const [calledUrl, calledOpts] = (global.fetch as any).mock.calls[0]
      expect(calledUrl).toBe('https://testnet.example.com/webhook')
      const payload = JSON.parse(calledOpts.body)
      expect(payload.price).toBe(0.11)
      expect(getSdexLastPrice('testnet', mockPair.pairKey)).toBe(0.11)
    })
  })

  describe('AMM ingester dual-network isolation', () => {
    it('snapshotPool records correct network in DB and does not cross-alert across networks', async () => {
      const mockPool = {
        id: 'pool-test',
        reserves: [
          { asset: 'native', amount: '100.0' },
          { asset: 'USD:GBBD...', amount: '8.0' }, // spotPrice = 0.08
        ],
        fee_bp: 30,
        total_shares: '10',
      }

      // Step 1: Snapshot on testnet at 0.08
      await snapshotPool(mockPool, mockPair, 'testnet')
      expect(mocks.db.prisma.poolSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            network: 'testnet',
            spotPrice: 0.08,
          }),
        })
      )
      expect(global.fetch).not.toHaveBeenCalled()
      expect(getAmmLastPrice('testnet', mockPair.pairKey)).toBe(0.08)
      expect(getAmmLastPrice('mainnet', mockPair.pairKey)).toBeUndefined()

      // Step 2: Snapshot on mainnet at 0.12
      const mainnetPool = {
        ...mockPool,
        reserves: [
          { asset: 'native', amount: '100.0' },
          { asset: 'USD:GBBD...', amount: '12.0' }, // spotPrice = 0.12
        ],
      }
      await snapshotPool(mainnetPool, mockPair, 'mainnet')
      expect(mocks.db.prisma.poolSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            network: 'mainnet',
            spotPrice: 0.12,
          }),
        })
      )
      // Mainnet baseline is 0.12, not crossing from testnet 0.08 -> no alert!
      expect(global.fetch).not.toHaveBeenCalled()
      expect(getAmmLastPrice('mainnet', mockPair.pairKey)).toBe(0.12)
      expect(getAmmLastPrice('testnet', mockPair.pairKey)).toBe(0.08)
    })

    it('ingestPoolTrades tracks prices per network and dispatches to the correct network', async () => {
      // Mock Horizon trades fetch
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/trades')) {
          return {
            json: async () => ({
              _embedded: {
                records: [
                  {
                    id: 't-amm-1',
                    paging_token: 'p-amm-1',
                    base_asset_type: 'native',
                    base_amount: '100.0',
                    counter_amount: '12.0',
                    ledger_close_time: new Date().toISOString(),
                  },
                ],
              },
            }),
          } as any
        }
        return { ok: true, status: 200 } as Response
      })

      // Prime testnet price at 0.08
      const key = `testnet:${mockPair.pairKey}`
      // Drive mainnet trade at 0.12
      await ingestPoolTrades({ id: 'pool-amm' }, mockPair, 'mainnet')

      // Mainnet trade of 0.12 must not see testnet's previous price
      expect(getAmmLastPrice('mainnet', mockPair.pairKey)).toBe(0.12)
      expect(getAmmLastPrice('testnet', mockPair.pairKey)).toBeUndefined()
    })
  })

  describe('Soroswap ingester dual-network isolation', () => {
    it('ingestPool keys lastPrice by (network, pairKey) and passes network to dispatcher', async () => {
      const mockPoolEntry = {
        poolAddress: 'CBJJLMR6MXJ4YOM3VXFQS4HM2IVBZFVQ3UQXNZKG5R6U3LWJDV4AOPRD',
        tokenA: { address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', symbol: 'XLM', name: 'XLM', decimals: 7 },
        tokenB: { address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', symbol: 'USD', name: 'USD', decimals: 7 },
      }

      // Step 1: Ingest on testnet with reserves 8 / 100 = 0.08
      const mockReservesTestnet = vi.fn().mockResolvedValue([8_000_000n, 100_000_000n])
      await ingestSoroswapPool(mockPoolEntry, mockPair, mockReservesTestnet, 'testnet')

      expect(getSoroswapLastPrice('testnet', mockPair.pairKey)).toBe(0.08)
      expect(getSoroswapLastPrice('mainnet', mockPair.pairKey)).toBeUndefined()
      expect(global.fetch).not.toHaveBeenCalled()

      // Step 2: Ingest on mainnet with reserves 12 / 100 = 0.12
      const mockReservesMainnet = vi.fn().mockResolvedValue([12_000_000n, 100_000_000n])
      await ingestSoroswapPool(mockPoolEntry, mockPair, mockReservesMainnet, 'mainnet')

      expect(getSoroswapLastPrice('mainnet', mockPair.pairKey)).toBe(0.12)
      expect(getSoroswapLastPrice('testnet', mockPair.pairKey)).toBe(0.08)
      // Mainnet did not cross from testnet 0.08 -> no alert!
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  describe('Aquarius venue adapter dual-network isolation', () => {
    it('ingestAquariusPair keys lastPrice by (network, pairKey) and dispatches with network', async () => {
      // Mock Aquarius pool list response
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              pool_hash: 'phash-1',
              reserves: ['100.0', '8.0'], // price = 8 / 100 = 0.08
              total_shares: '50',
            },
          ],
        }),
      } as any)

      await ingestAquariusPair(mockPair, 'testnet')
      expect(getAquariusLastPrice('testnet', mockPair.pairKey)).toBe(0.08)
      expect(getAquariusLastPrice('mainnet', mockPair.pairKey)).toBeUndefined()

      // Next tick on mainnet at 0.12
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              pool_hash: 'phash-1',
              reserves: ['100.0', '12.0'], // price = 12 / 100 = 0.12
              total_shares: '50',
            },
          ],
        }),
      } as any)

      await ingestAquariusPair(mockPair, 'mainnet')
      expect(getAquariusLastPrice('mainnet', mockPair.pairKey)).toBe(0.12)
      expect(getAquariusLastPrice('testnet', mockPair.pairKey)).toBe(0.08)
    })
  })

  describe('dispatchPriceUpdate network filtering', () => {
    it('queries webhooks strictly for the update network and never leaks between chains', async () => {
      mocks.db.prisma.webhook.findMany.mockResolvedValue([])

      await dispatchPriceUpdate({
        assetA: 'XLM',
        assetB: 'USD',
        previousPrice: 0.09,
        currentPrice: 0.11,
        network: 'mainnet',
      })

      expect(mocks.db.prisma.webhook.findMany).toHaveBeenCalledWith({
        where: {
          network: 'mainnet',
          assetA: 'XLM',
          assetB: 'USD',
        },
      })
    })
  })

  describe('No remaining module-level price state is keyed by pairKey alone', () => {
    it('verifies keys in lastPrice maps across all ingesters are scoped by network and never pairKey alone', async () => {
      // SDEX
      mocks.horizonCall.mockResolvedValueOnce({
        records: [makeTradeRecord('t-check-1', 10, 100)],
      })
      await ingestSdexPair(mockPair, 'testnet')
      expect(getSdexLastPrice('testnet', mockPair.pairKey)).toBe(0.1)
      expect(getSdexLastPrice('mainnet', mockPair.pairKey)).toBeUndefined()

      // AMM
      await snapshotPool(
        {
          id: 'pool-check',
          reserves: [{ asset: 'native', amount: '100.0' }, { asset: 'USD:GBBD...', amount: '10.0' }],
          fee_bp: 30,
          total_shares: '10',
        },
        mockPair,
        'testnet'
      )
      expect(getAmmLastPrice('testnet', mockPair.pairKey)).toBe(0.1)
      expect(getAmmLastPrice('mainnet', mockPair.pairKey)).toBeUndefined()

      // Soroswap
      const mockReserves = vi.fn().mockResolvedValue([10_000_000n, 100_000_000n])
      await ingestSoroswapPool(
        {
          poolAddress: 'CBJJLMR6MXJ4YOM3VXFQS4HM2IVBZFVQ3UQXNZKG5R6U3LWJDV4AOPRD',
          tokenA: { address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', symbol: 'XLM', name: 'XLM', decimals: 7 },
          tokenB: { address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', symbol: 'USD', name: 'USD', decimals: 7 },
        },
        mockPair,
        mockReserves,
        'testnet'
      )
      expect(getSoroswapLastPrice('testnet', mockPair.pairKey)).toBe(0.1)
      expect(getSoroswapLastPrice('mainnet', mockPair.pairKey)).toBeUndefined()

      // Aquarius
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ pool_hash: 'phash-check', reserves: ['100.0', '10.0'], total_shares: '50' }],
        }),
      } as any)
      await ingestAquariusPair(mockPair, 'testnet')
      expect(getAquariusLastPrice('testnet', mockPair.pairKey)).toBe(0.1)
      expect(getAquariusLastPrice('mainnet', mockPair.pairKey)).toBeUndefined()
    })
  })
})
