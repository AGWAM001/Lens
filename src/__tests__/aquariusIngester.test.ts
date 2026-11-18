/**
 * Unit tests for the Aquarius AMM venue adapter.
 */

const mocks = vi.hoisted(() => ({
  config: {
    aquarius: { enabled: true, apiUrl: 'https://amm.aquarius.network/api/v1/pools/' },
    indexer: { pollIntervalMs: 5000 },
  },
  pairsRegistry: {
    getActivePairs: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('../config', () => ({
  config: mocks.config,
  activeNetwork: 'testnet',
  // startAquariusIngester / ingestAquariusPair resolve the per-network Aquarius
  // block via getNetworkConfig(network); the mock returns the same shape for
  // whichever network is asked for.
  getNetworkConfig: () => mocks.config,
}))
vi.mock('../pairsRegistry', () => mocks.pairsRegistry)
vi.mock('../db', () => ({ upsertPricePoints: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined) }))

import { fetchAquariusPools, ingestAquariusPair, startAquariusIngester } from '../ingest/venues/aquarius'
import { getFailedSources, listSourceFailures, resetSourceFailures } from '../ingest/sourceFailures'
import { upsertPricePoints } from '../db'

const mockPair = {
  pairKey: 'USDC/XLM',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
}

describe('fetchAquariusPools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  it('queries the configured Aquarius API URL for the network', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    await fetchAquariusPools(mockPair as any, 'https://testnet.example.com/pools/')

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://testnet.example.com/pools/?'),
      expect.anything()
    )
  })

  it('falls back to config.aquarius.apiUrl when no override is passed', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    await fetchAquariusPools(mockPair as any)

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(mocks.config.aquarius.apiUrl),
      expect.anything()
    )
  })

  // #329: a non-ok response used to come back as `[]`, identical to a venue
  // with no pools. It is now a failure, and only an answer is "empty".
  it('reports a non-ok response as a failure, not an empty array', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 })

    const result = await fetchAquariusPools(mockPair as any)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('503')
  })

  it('reports a thrown fetch as a failure, not an empty array', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await fetchAquariusPools(mockPair as any)
    expect(result.ok).toBe(false)
  })

  it('returns an empty, successful result when Aquarius answers with no pools', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    const result = await fetchAquariusPools(mockPair as any)
    expect(result).toEqual({ ok: true, data: [] })
  })
})

describe('ingestAquariusPair (#329)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSourceFailures()
    global.fetch = vi.fn()
  })

  it('records a failing venue and not an empty one', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 502 })
    await ingestAquariusPair(mockPair as any, 'mainnet')
    expect(getFailedSources('mainnet', mockPair.pairKey)).toEqual(['aquarius_amm'])

    // Recovers: an answer with no pools clears the failure and writes nothing.
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    })
    await ingestAquariusPair(mockPair as any, 'mainnet')
    expect(getFailedSources('mainnet', mockPair.pairKey)).toEqual([])
    expect(listSourceFailures()).toEqual([])
    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('leaves the record alone for a cycle abandoned before the request', async () => {
    const controller = new AbortController()
    controller.abort()

    await ingestAquariusPair(mockPair as any, 'mainnet', controller.signal)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(listSourceFailures()).toEqual([])
  })
})

describe('startAquariusIngester', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not start the polling loop when Aquarius is disabled on the active network', async () => {
    mocks.config.aquarius.enabled = false

    await startAquariusIngester()

    expect(mocks.pairsRegistry.getActivePairs).not.toHaveBeenCalled()

    mocks.config.aquarius.enabled = true
  })
})
