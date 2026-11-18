import { describe, it, expect, vi, beforeEach } from 'vitest'

// Full address for testing without elision
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

interface MockPricePointRow {
  id?: string
  network: string
  assetA: string
  assetB: string
  pairKey: string
  source: string
  poolId?: string | null
  price: any
  baseVolume: any
  counterVolume: any
  ledger: number
  timestamp: Date
  eventId?: string | null
}

interface MockQuarantinedRow extends MockPricePointRow {
  referenceMedian: any
  rejectionReason: string
  rejectionBound?: any
  quarantinedAt: Date
}

let storedPricePoints: MockPricePointRow[] = []
let storedQuarantinedPoints: MockQuarantinedRow[] = []

// Set global prisma before db.ts is loaded to avoid real PrismaClient connecting
const mockPrisma = {
  pricePoint: {
    createMany: vi.fn(async ({ data }: { data: MockPricePointRow[] }) => {
      storedPricePoints.push(...data)
      return { count: data.length }
    }),
    findMany: vi.fn(async ({ where }: { where: { network?: string; pairKey?: string; timestamp?: any } }) => {
      return storedPricePoints.filter(
        (p) => (!where.network || p.network === where.network) && (!where.pairKey || p.pairKey === where.pairKey)
      )
    }),
  },
  quarantinedPricePoint: {
    createMany: vi.fn(async ({ data }: { data: MockQuarantinedRow[] }) => {
      storedQuarantinedPoints.push(...data)
      return { count: data.length }
    }),
    findMany: vi.fn(async ({ where }: { where: { network?: string; pairKey?: string } }) => {
      return storedQuarantinedPoints.filter(
        (p) => (!where.network || p.network === where.network) && (!where.pairKey || p.pairKey === where.pairKey)
      )
    }),
  },
}
;(globalThis as any).prisma = mockPrisma

describe('Issue #238: Ingest-Time Price Tick Plausibility & Quarantine', () => {
  beforeEach(() => {
    storedPricePoints = []
    storedQuarantinedPoints = []
    vi.clearAllMocks()
  })

  it('quarantines an anomalous upward price tick (40% move) and prevents pollution of price_points', async () => {
    const { upsertPricePoints } = await import('../db')
    const { price_points_accepted_total, price_points_quarantined_total } = await import('../metrics')

    const network = 'testnet'
    const pairKey = `USDC:${USDC_ISSUER}/XLM`
    const now = Date.now()

    // 1. Seed recent baseline price points around 100.0 (median = 100.0)
    const baseline = [
      {
        assetA: 'XLM',
        assetB: `USDC:${USDC_ISSUER}`,
        pairKey,
        source: 'SDEX',
        price: 100.0,
        baseVolume: 1000,
        counterVolume: 100000,
        ledger: 1001,
        timestamp: new Date(now - 30_000),
      },
      {
        assetA: 'XLM',
        assetB: `USDC:${USDC_ISSUER}`,
        pairKey,
        source: 'SDEX',
        price: 101.0,
        baseVolume: 1200,
        counterVolume: 121200,
        ledger: 1002,
        timestamp: new Date(now - 20_000),
      },
      {
        assetA: 'XLM',
        assetB: `USDC:${USDC_ISSUER}`,
        pairKey,
        source: 'SDEX',
        price: 99.0,
        baseVolume: 900,
        counterVolume: 89100,
        ledger: 1003,
        timestamp: new Date(now - 10_000),
      },
    ]

    await upsertPricePoints(baseline, network)
    expect(storedPricePoints).toHaveLength(3)

    // 2. Incoming anomalous tick with a 40% rapid upward swing (price 140.0 vs recent median 100.0)
    const anomalousTick = {
      assetA: 'XLM',
      assetB: `USDC:${USDC_ISSUER}`,
      pairKey,
      source: 'SDEX',
      price: 140.0,
      baseVolume: 50,
      counterVolume: 7000,
      ledger: 1004,
      timestamp: new Date(now),
      eventId: 'evt-outlier-140',
    }

    const res = await upsertPricePoints([anomalousTick], network)
    expect(res.count).toBe(0)

    // Defect check: anomalous tick must NOT be in price_points table
    const storedAnomalousInPricePoints = storedPricePoints.find((p) => p.price === 140.0)
    expect(storedAnomalousInPricePoints).toBeUndefined()
    expect(storedPricePoints).toHaveLength(3)

    // Defect check: anomalous tick must be preserved with full details in quarantine table
    expect(storedQuarantinedPoints).toHaveLength(1)
    const quarantined = storedQuarantinedPoints[0]
    expect(quarantined.network).toBe(network)
    expect(quarantined.assetA).toBe('XLM')
    expect(quarantined.assetB).toBe(`USDC:${USDC_ISSUER}`)
    expect(quarantined.pairKey).toBe(pairKey)
    expect(quarantined.price).toBe(140.0)
    expect(quarantined.baseVolume).toBe(50)
    expect(quarantined.counterVolume).toBe(7000)
    expect(quarantined.source).toBe('SDEX')
    expect(quarantined.ledger).toBe(1004)
    expect(quarantined.eventId).toBe('evt-outlier-140')
    expect(quarantined.referenceMedian).toBeCloseTo(100.0, 1)
    expect(quarantined.rejectionBound).toBeCloseTo(0.20, 2)
    expect(quarantined.rejectionReason).toContain('PRICE_DEVIATION_EXCEEDS_BOUND')
    expect(quarantined.quarantinedAt).toBeInstanceOf(Date)

    // 3. Normal plausible tick within bound (e.g. 2% move, price 102.0)
    const plausibleTick = {
      assetA: 'XLM',
      assetB: `USDC:${USDC_ISSUER}`,
      pairKey,
      source: 'SDEX',
      price: 102.0,
      baseVolume: 800,
      counterVolume: 81600,
      ledger: 1005,
      timestamp: new Date(now + 1000),
      eventId: 'evt-plausible-102',
    }

    const resPlausible = await upsertPricePoints([plausibleTick], network)
    expect(resPlausible.count).toBe(1)
    expect(storedPricePoints).toHaveLength(4)
    expect(storedPricePoints.find((p) => p.price === 102.0)).toBeDefined()

    // 4. Ingest metric counters increment appropriately per source and network
    const acceptedVal = (await price_points_accepted_total.get()).values.find(
      (v) => v.labels.network === network && v.labels.source === 'SDEX'
    )?.value
    const quarantinedVal = (await price_points_quarantined_total.get()).values.find(
      (v) => v.labels.network === network && v.labels.source === 'SDEX'
    )?.value

    expect(acceptedVal).toBeGreaterThanOrEqual(4) // 3 baseline + 1 plausible
    expect(quarantinedVal).toBeGreaterThanOrEqual(1) // 1 anomalous
  })

  it('quarantines an anomalous downward price crash (40% move) from thin pools', async () => {
    const { upsertPricePoints } = await import('../db')
    const network = 'mainnet'
    const pairKey = `USDC:${USDC_ISSUER}/XLM`
    const now = Date.now()

    // Baseline at 100.0
    await upsertPricePoints(
      [
        {
          assetA: 'XLM',
          assetB: `USDC:${USDC_ISSUER}`,
          pairKey,
          source: 'AMM',
          price: 100.0,
          baseVolume: 500,
          counterVolume: 50000,
          ledger: 2001,
          timestamp: new Date(now - 15_000),
        },
      ],
      network
    )

    // Sudden 40% crash down to 60.0
    const crashTick = {
      assetA: 'XLM',
      assetB: `USDC:${USDC_ISSUER}`,
      pairKey,
      source: 'AMM',
      price: 60.0,
      baseVolume: 10,
      counterVolume: 600,
      ledger: 2002,
      timestamp: new Date(now),
      eventId: 'evt-crash-60',
    }

    const res = await upsertPricePoints([crashTick], network)
    expect(res.count).toBe(0)
    expect(storedPricePoints.find((p) => p.price === 60.0)).toBeUndefined()

    const q = storedQuarantinedPoints.find((p) => p.price === 60.0)
    expect(q).toBeDefined()
    expect(q?.referenceMedian).toBe(100.0)
    expect(q?.network).toBe('mainnet')
    expect(q?.source).toBe('AMM')
  })

  it('does not leak quarantined ticks to venue runner dispatchers or last-price cache', async () => {
    const { writeVenuePricePoints, getLastPrice, resetLastPrice } = await import('../ingest/venues/runner')
    const { upsertPricePoints } = await import('../db')

    resetLastPrice()
    const network = 'testnet'
    const pairKey = `USDC:${USDC_ISSUER}/XLM`
    const watchedPair = {
      pairKey,
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: USDC_ISSUER },
    }

    // Seed baseline price 50.0
    await upsertPricePoints(
      [
        {
          assetA: 'XLM',
          assetB: `USDC:${USDC_ISSUER}`,
          pairKey,
          source: 'SDEX',
          price: 50.0,
          baseVolume: 100,
          counterVolume: 5000,
          ledger: 3001,
          timestamp: new Date(Date.now() - 10_000),
        },
      ],
      network
    )

    // Normal trade through writeVenuePricePoints
    await writeVenuePricePoints(
      'SDEX',
      [
        {
          assetA: 'XLM',
          assetB: `USDC:${USDC_ISSUER}`,
          pairKey,
          source: 'SDEX',
          price: 51.0,
          baseVolume: 100,
          counterVolume: 5100,
          ledger: 3002,
          timestamp: new Date(),
        },
      ],
      watchedPair,
      network
    )

    expect(getLastPrice('SDEX', network, pairKey)).toBe(51.0)

    // Now an anomalous tick at 80.0 (+56% swing against ~50-51)
    await writeVenuePricePoints(
      'SDEX',
      [
        {
          assetA: 'XLM',
          assetB: `USDC:${USDC_ISSUER}`,
          pairKey,
          source: 'SDEX',
          price: 80.0,
          baseVolume: 10,
          counterVolume: 800,
          ledger: 3003,
          timestamp: new Date(),
        },
      ],
      watchedPair,
      network
    )

    // Last price should NOT have been updated to the quarantined 80.0 price
    expect(getLastPrice('SDEX', network, pairKey)).toBe(51.0)
    // 80.0 must NOT be in price_points
    expect(storedPricePoints.find((p) => p.price === 80.0)).toBeUndefined()
    // 80.0 must be in quarantine
    expect(storedQuarantinedPoints.find((p) => p.price === 80.0)).toBeDefined()
  })
})

