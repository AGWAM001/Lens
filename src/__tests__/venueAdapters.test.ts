import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  venueAdapters,
  sdexAdapter,
  ammAdapter,
  soroswapAdapter,
  aquariusAdapter,
  defindexAdapter,
  phoenixAdapter,
  startVenueAdapter,
  startAllVenueAdapters,
  writeVenuePricePoints,
  getLastPrice,
  resetLastPrice,
  setLastPrice,
  VENUE_CLASSIFICATIONS,
  getVenueClassification,
  isPrimaryVenue,
  isAggregatorVenue,
  getVenueReasoning,
  type VenueAdapter,
} from '../ingest/venues'

vi.mock('../db', () => ({
  upsertPricePoints: vi.fn().mockResolvedValue(1),
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../events', () => ({
  publishPriceUpdate: vi.fn(),
}))

describe('VenueAdapter Interface and Runner (#218)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLastPrice()
  })

  it('registers all existing venue adapters in venueAdapters registry', () => {
    expect(venueAdapters).toContain(sdexAdapter)
    expect(venueAdapters).toContain(ammAdapter)
    expect(venueAdapters).toContain(soroswapAdapter)
    expect(venueAdapters).toContain(aquariusAdapter)
    expect(venueAdapters).toContain(defindexAdapter)
    // Registration is what makes index.ts start one Phoenix instance per entry
    // in ENABLED_NETWORKS, each writing the network it read from.
    expect(venueAdapters).toContain(phoenixAdapter)
    expect(venueAdapters.length).toBe(6)
  })

  it('ensures each adapter implements the VenueAdapter contract', () => {
    for (const adapter of venueAdapters) {
      expect(typeof adapter.name).toBe('string')
      expect(typeof adapter.source).toBe('string')
      expect(['primary', 'aggregator']).toContain(adapter.classification)
      expect(typeof adapter.isEnabled).toBe('function')
      expect(typeof adapter.getPollIntervalMs).toBe('function')
      expect(typeof adapter.discover).toBe('function')
      expect(typeof adapter.read).toBe('function')
      expect(typeof adapter.derive).toBe('function')
      expect(typeof adapter.write).toBe('function')
      expect(typeof adapter.ingestPair).toBe('function')
      expect(adapter.sourceTimeCapability).toBeDefined()
      expect(['provided', 'unavailable']).toContain(adapter.sourceTimeCapability.status)
    }
  })

  it('classifies SDEX, AMM, and Soroswap as primary markets and Aquarius as an aggregator', () => {
    expect(sdexAdapter.classification).toBe('primary')
    expect(ammAdapter.classification).toBe('primary')
    expect(soroswapAdapter.classification).toBe('primary')
    expect(aquariusAdapter.classification).toBe('aggregator')

    expect(isPrimaryVenue('SDEX')).toBe(true)
    expect(isPrimaryVenue('AMM')).toBe(true)
    expect(isPrimaryVenue('soroswap_amm')).toBe(true)
    expect(isPrimaryVenue('aquarius_amm')).toBe(false)

    expect(isAggregatorVenue('aquarius_amm')).toBe(true)
    expect(isAggregatorVenue('Aquarius')).toBe(true)
    expect(isAggregatorVenue('SDEX')).toBe(false)
    expect(isAggregatorVenue('AMM')).toBe(false)

    // Documented reasoning must be present
    expect(getVenueReasoning('SDEX')).toMatch(/order book|CLOB/i)
    expect(getVenueReasoning('AMM')).toMatch(/liquidity pool|reserves/i)
    expect(getVenueReasoning('soroswap_amm')).toMatch(/Soroban/i)
    expect(getVenueReasoning('aquarius_amm')).toMatch(/aggregator|double-count/i)
  })

  it('preserves exact source strings for backward compatibility', () => {
    expect(sdexAdapter.source).toBe('SDEX')
    expect(ammAdapter.source).toBe('AMM')
    expect(soroswapAdapter.source).toBe('soroswap_amm')
    expect(aquariusAdapter.source).toBe('aquarius_amm')
    expect(defindexAdapter.source).toBe('defindex_vault')
    // Phoenix gets its own source: a price that cannot be attributed to a venue
    // is worse than no price, so it must never share a row label.
    expect(phoenixAdapter.source).toBe('phoenix_amm')
  })

  it('manages last-price tracking with network and pairKey isolation in runner', () => {
    const update1 = setLastPrice('SDEX', 'testnet', 'XLM-USD', 0.12)
    expect(update1.previousPrice).toBe(0.12)
    expect(update1.currentPrice).toBe(0.12)
    expect(getLastPrice('SDEX', 'testnet', 'XLM-USD')).toBe(0.12)
    expect(getLastPrice('SDEX', 'mainnet', 'XLM-USD')).toBeUndefined()

    const update2 = setLastPrice('SDEX', 'testnet', 'XLM-USD', 0.15)
    expect(update2.previousPrice).toBe(0.12)
    expect(update2.currentPrice).toBe(0.15)

    resetLastPrice('SDEX')
    expect(getLastPrice('SDEX', 'testnet', 'XLM-USD')).toBeUndefined()
  })

  it('supports adding a new venue adapter without modifying the runner', async () => {
    let cycleExecuted = false

    const customAdapter: VenueAdapter = {
      name: 'CustomDEX',
      source: 'custom_dex',
      sourceTimeCapability: { status: 'unavailable' },
      classification: 'primary',
      isEnabled: () => false,
      getPollIntervalMs: () => 1000,
      discover: async () => [],
      read: async () => null,
      derive: () => [],
      write: async () => {},
      ingestPair: async () => {
        cycleExecuted = true
      },
    }

    await startVenueAdapter(customAdapter, 'testnet')
    expect(cycleExecuted).toBe(false)
  })
})

describe('venue classification has one source of truth (#244)', () => {
  // `classification` is required on VenueAdapter, so the compiler makes every
  // venue state what it is. VENUE_CLASSIFICATIONS is hand-maintained prose
  // beside it. Two records of the same fact drift, and this one decides whether
  // a venue's volume is counted toward the published net total — so the
  // disagreement has to fail the build, not be resolved quietly at runtime.
  it('agrees with every registered adapter', () => {
    const disagreements: string[] = []
    for (const adapter of venueAdapters) {
      const documented =
        VENUE_CLASSIFICATIONS[adapter.source] ?? VENUE_CLASSIFICATIONS[adapter.name]
      if (!documented) {
        disagreements.push(`${adapter.name} (${adapter.source}) has no entry in VENUE_CLASSIFICATIONS`)
        continue
      }
      if (documented.classification !== adapter.classification) {
        disagreements.push(
          `${adapter.name}: adapter says ${adapter.classification}, VENUE_CLASSIFICATIONS says ${documented.classification}`,
        )
      }
    }
    expect(disagreements).toEqual([])
  })

  it('documents reasoning for every registered adapter', () => {
    const missing = venueAdapters
      .filter((adapter) => !getVenueReasoning(adapter.source) && !getVenueReasoning(adapter.name))
      .map((adapter) => `${adapter.name} (${adapter.source})`)
    expect(missing).toEqual([])
  })

  it('resolves a venue by its adapter even when the map disagrees', () => {
    // The adapter wins: it is the declaration a venue cannot be written
    // without, and it is what the ingester actually ran.
    for (const adapter of venueAdapters) {
      expect(getVenueClassification(adapter.source)).toBe(adapter.classification)
      expect(getVenueClassification(adapter.name)).toBe(adapter.classification)
    }
  })

  it('counts an unregistered source as primary, never silently as an aggregator', () => {
    // A CEX feed has no adapter and is a real independent market. The inverse —
    // an unregistered aggregator counted toward net volume — is what the
    // agreement test above prevents, since an aggregator needs an adapter to be
    // ingested at all.
    expect(getVenueClassification('some_cex_feed')).toBe('primary')
    expect(isAggregatorVenue('some_cex_feed')).toBe(false)
  })
})
