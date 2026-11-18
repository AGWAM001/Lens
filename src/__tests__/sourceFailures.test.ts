/**
 * #329 — a failed venue fetch must be distinguishable from an empty venue,
 * all the way to the aggregate.
 *
 * Covers each acceptance criterion:
 * - a failing venue and an empty venue produce different results
 * - a failing venue does not reweight the aggregate as though it answered
 * - reflector.ts logs its failures
 * - the set of failed sources for an aggregate is retrievable
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Networks, StrKey } from '@stellar/stellar-sdk'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fetchHorizonJson: vi.fn(),
  simulateTransaction: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  },
  netConfig: {
    horizon: { url: 'https://horizon-testnet.stellar.org' },
    soroswap: { tokenListUrl: 'https://example.test/tokens.json', enabled: true },
    oracle: { enabled: true, reflectorContractId: '' },
    network: { passphrase: '' },
  },
}))

vi.mock('../db', () => ({
  pgPool: { query: mocks.query },
  upsertPricePoints: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../logger', () => ({
  createLogger: () => mocks.logger,
  logger: mocks.logger,
}))
vi.mock('../config', () => ({
  config: { pairs: [], indexer: { pollIntervalMs: 5000 }, plausibility: { minPrice: 0, maxPrice: 1e12 } },
  activeNetwork: 'testnet',
  getNetworkConfig: () => mocks.netConfig,
}))
vi.mock('../ingest/venues/horizon', () => ({
  fetchHorizonJson: mocks.fetchHorizonJson,
  HorizonRateLimitError: class HorizonRateLimitError extends Error {},
}))
vi.mock('../network/clients', () => ({
  getRpcServer: () => ({ simulateTransaction: mocks.simulateTransaction }),
}))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined) }))

import { aggregatePrice } from '../pricing/aggregate'
import {
  recordSourceFailure,
  clearSourceFailure,
  getFailedSources,
  listSourceFailures,
  resetSourceFailures,
} from '../ingest/sourceFailures'
import { fetchPools, ingestPair as ingestAmmPair } from '../ingest/venues/amm'
import { fetchSoroswapTokenList } from '../ingest/venues/soroswap'
import { fetchReflectorPrice, getCachedReflectorPrice } from '../ingest/oracles/reflector'

const PAIR = {
  pairKey: 'XLM:native/USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
}

/** VWAP rows per source, as the aggregate's SELECT returns them. */
function rows(...r: Array<[string, number, number]>) {
  return { rows: r.map(([source, vwap, volume]) => ({ source, vwap: String(vwap), volume: String(volume) })) }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSourceFailures()
  global.fetch = vi.fn()
  // A real, complete contract id — derived, never shortened or invented.
  mocks.netConfig.oracle.reflectorContractId = StrKey.encodeContract(Buffer.alloc(32, 7))
  mocks.netConfig.network.passphrase = Networks.TESTNET
})

describe('fetchers: a failing venue and an empty venue produce different results', () => {
  it('Horizon AMM: an error is a failure, an empty record set is an empty success', async () => {
    mocks.fetchHorizonJson.mockRejectedValueOnce(new Error('ECONNRESET'))
    const failed = await fetchPools(PAIR as any, 'testnet')

    mocks.fetchHorizonJson.mockResolvedValueOnce({ _embedded: { records: [] } })
    const empty = await fetchPools(PAIR as any, 'testnet')

    expect(failed.ok).toBe(false)
    expect(empty).toEqual({ ok: true, data: [] })
    expect(failed).not.toEqual(empty)
  })

  it('Soroswap token list: a non-ok response is a failure, an empty list is an empty success', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 })
    const failed = await fetchSoroswapTokenList('https://example.test/tokens.json')

    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: async () => ({ tokens: [] }) })
    const empty = await fetchSoroswapTokenList('https://example.test/tokens.json')

    expect(failed.ok).toBe(false)
    expect(empty).toEqual({ ok: true, data: [] })
  })

  it('AMM ingestPair records the failure for the pair and clears it once Horizon answers', async () => {
    mocks.fetchHorizonJson.mockRejectedValueOnce(new Error('ECONNRESET'))
    await ingestAmmPair(PAIR as any, 'mainnet')
    expect(getFailedSources('mainnet', PAIR.pairKey)).toEqual(['AMM'])

    mocks.fetchHorizonJson.mockResolvedValueOnce({ _embedded: { records: [] } })
    await ingestAmmPair(PAIR as any, 'mainnet')
    expect(getFailedSources('mainnet', PAIR.pairKey)).toEqual([])
  })
})

describe('reflector.ts logs its failures', () => {
  it('logs and returns a failure when the RPC throws, instead of a silent null', async () => {
    mocks.simulateTransaction.mockRejectedValueOnce(new Error('rpc unreachable'))

    const result = await fetchReflectorPrice('XLM', 'testnet')

    expect(result.ok).toBe(false)
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ asset: 'XLM', network: 'testnet', err: expect.any(Error) }),
      'failed to read reflector price'
    )
  })

  it('treats a disabled oracle as nothing to read, not a failure', async () => {
    mocks.netConfig.oracle.enabled = false
    try {
      const result = await fetchReflectorPrice('XLM', 'testnet')
      expect(result).toEqual({ ok: true, data: null })
      expect(mocks.logger.error).not.toHaveBeenCalled()
    } finally {
      mocks.netConfig.oracle.enabled = true
    }
  })

  it('records a failed read so it is retrievable, not just logged', async () => {
    mocks.simulateTransaction.mockRejectedValueOnce(new Error('rpc unreachable'))

    const quote = await getCachedReflectorPrice('XLM', 'testnet')

    expect(quote).toBeNull()
    expect(getFailedSources('testnet', 'XLM')).toEqual(['reflector'])
  })
})

describe('aggregatePrice (#329)', () => {
  it('excludes a failed venue instead of letting it reweight the composite', async () => {
    // SDEX and AMM agree at 0.10; Aquarius's last rows before it went down say 0.12.
    mocks.query.mockResolvedValue(rows(['SDEX', 0.1, 1000], ['AMM', 0.1, 1000], ['aquarius_amm', 0.12, 1000]))
    recordSourceFailure('aquarius_amm', 'testnet', PAIR.pairKey, new Error('aquarius unreachable'))

    const agg = await aggregatePrice(PAIR.pairKey, 0.5, 'testnet')

    expect(agg.composite).toBeCloseTo(0.1, 10)
    const aquarius = agg.breakdown.find(b => b.source === 'aquarius_amm')!
    expect(aquarius.excluded).toBe(true)
    expect(aquarius.reason).toBe('source failed to fetch')
    expect(agg.failedSources).toEqual(['aquarius_amm'])
  })

  it('a failing venue and an empty venue produce different aggregates', async () => {
    // Aquarius has no rows either way. Empty: it answered with no pools.
    mocks.query.mockResolvedValue(rows(['SDEX', 0.1, 1000]))
    const empty = await aggregatePrice(PAIR.pairKey, 0.05, 'testnet')

    // Failing: same rows, but its fetch failed.
    recordSourceFailure('aquarius_amm', 'testnet', PAIR.pairKey, new Error('aquarius unreachable'))
    const failing = await aggregatePrice(PAIR.pairKey, 0.05, 'testnet')

    expect(empty.failedSources).toEqual([])
    expect(failing.failedSources).toEqual(['aquarius_amm'])
    expect(failing).not.toEqual(empty)
  })

  it('keeps the deviation baseline to sources that answered', async () => {
    // Without the failed source in the baseline, SDEX and AMM are both within
    // 5% of each other. Counting the failed source's stale 0.20 would drag the
    // baseline up and wrongly exclude one of the healthy venues.
    mocks.query.mockResolvedValue(rows(['SDEX', 0.1, 1000], ['AMM', 0.102, 1000], ['soroswap_amm', 0.2, 1000]))
    recordSourceFailure('soroswap_amm', 'testnet', PAIR.pairKey, new Error('token list unreachable'))

    const agg = await aggregatePrice(PAIR.pairKey, 0.05, 'testnet')

    expect(agg.breakdown.find(b => b.source === 'SDEX')!.excluded).toBe(false)
    expect(agg.breakdown.find(b => b.source === 'AMM')!.excluded).toBe(false)
    expect(agg.composite).toBeCloseTo(0.101, 10)
  })

  it('scopes failures to the network and pair they happened on', async () => {
    mocks.query.mockResolvedValue(rows(['SDEX', 0.1, 1000]))
    recordSourceFailure('aquarius_amm', 'mainnet', PAIR.pairKey, new Error('down on mainnet'))
    // A different pair on the same network; the issuer is derived, not invented.
    const otherPair = `XLM:native/EURC:${StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9))}`
    recordSourceFailure('AMM', 'testnet', otherPair, new Error('other pair'))

    const agg = await aggregatePrice(PAIR.pairKey, 0.05, 'testnet')

    expect(agg.failedSources).toEqual([])
  })

  it('merges caller-supplied failed sources with the recorded ones', async () => {
    mocks.query.mockResolvedValue(rows(['SDEX', 0.1, 1000], ['AMM', 0.1, 1000]))
    recordSourceFailure('aquarius_amm', 'testnet', PAIR.pairKey, new Error('down'))

    const agg = await aggregatePrice(PAIR.pairKey, 0.05, 'testnet', ['AMM'])

    expect(agg.failedSources).toEqual(['AMM', 'aquarius_amm'])
    expect(agg.breakdown.find(b => b.source === 'AMM')!.excluded).toBe(true)
    expect(agg.composite).toBeCloseTo(0.1, 10)
  })
})

describe('source failure record', () => {
  it('lists failures newest first and clears on success', () => {
    recordSourceFailure('AMM', 'testnet', PAIR.pairKey, new Error('first'))
    recordSourceFailure('aquarius_amm', 'testnet', PAIR.pairKey, 'second')

    expect(listSourceFailures('testnet').map(f => f.message).sort()).toEqual(['first', 'second'])
    expect(getFailedSources('testnet')).toEqual(['AMM', 'aquarius_amm'])

    clearSourceFailure('AMM', 'testnet', PAIR.pairKey)
    expect(getFailedSources('testnet')).toEqual(['aquarius_amm'])
  })
})
