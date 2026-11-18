import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockPrisma, mockPgPool, mockUpsertPricePoints, storedGaps, storedPoints } = vi.hoisted(() => {
  interface StoredGap {
    id: string
    network: string
    source: string
    pair: string
    start: Date
    end: Date
    status: string
    detectedAt: Date
    updatedAt: Date
  }

  const storedGaps: StoredGap[] = []
  const storedPoints: any[] = []

  const mockPrisma = {
    ingestionGap: {
      findMany: vi.fn(async (args?: any) => {
        let filtered = [...storedGaps]
        if (args?.where) {
          const { network, pair, source, status, start, end, AND } = args.where
          if (network) filtered = filtered.filter(g => g.network === network)
          if (pair) {
            if (typeof pair === 'string') filtered = filtered.filter(g => g.pair === pair)
            else if (pair.in) filtered = filtered.filter(g => pair.in.includes(g.pair))
          }
          if (source) filtered = filtered.filter(g => g.source === source)
          if (status) {
            if (typeof status === 'string') filtered = filtered.filter(g => g.status === status)
            else if (status.in) filtered = filtered.filter(g => status.in.includes(g.status))
          }
          if (start?.lt) filtered = filtered.filter(g => g.start < start.lt)
          if (end?.gt) filtered = filtered.filter(g => g.end > end.gt)
          if (AND) {
            for (const clause of AND) {
              if (clause.start?.lte) filtered = filtered.filter(g => g.start <= clause.start.lte)
              if (clause.end?.gte) filtered = filtered.filter(g => g.end >= clause.end.gte)
            }
          }
        }
        return filtered
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        const row: StoredGap = {
          id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          network: data.network,
          source: data.source,
          pair: data.pair,
          start: data.start,
          end: data.end,
          status: data.status,
          detectedAt: new Date(),
          updatedAt: new Date(),
        }
        storedGaps.push(row)
        return row
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const idx = storedGaps.findIndex(g => g.id === where.id)
        if (idx === -1) throw new Error('Not found')
        storedGaps[idx] = {
          ...storedGaps[idx],
          ...data,
          updatedAt: data.updatedAt ?? new Date(),
        }
        return storedGaps[idx]
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        let count = 0
        for (let i = storedGaps.length - 1; i >= 0; i--) {
          if (where.id.in.includes(storedGaps[i].id)) {
            storedGaps.splice(i, 1)
            count++
          }
        }
        return { count }
      }),
    },
    pricePoint: {
      createMany: vi.fn(async ({ data, skipDuplicates }: { data: any[]; skipDuplicates?: boolean }) => {
        let inserted = 0
        for (const item of data) {
          const id = item.id ?? item.eventId
          // createMany({ skipDuplicates }) skips a row violating ANY unique
          // constraint, so model both the schema declares: the composite
          // primary key @@id([id, timestamp]) and the identity index
          // @@unique([network, source, eventId]). Checking only the primary key
          // made a re-run look non-idempotent, because a point whose timestamp
          // falls back to `now` lands on a different key each time while the
          // event id — the thing that actually identifies it — stays the same.
          const exists = storedPoints.some(
            p =>
              (p.id === id && p.timestamp.getTime() === item.timestamp.getTime()) ||
              (item.eventId != null &&
                p.network === item.network &&
                p.source === item.source &&
                p.eventId === item.eventId),
          )
          if (skipDuplicates && exists) {
            continue
          }
          storedPoints.push({ ...item, id })
          inserted++
        }
        return { count: inserted }
      }),
    },
  }

  const mockPgPool = {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes('MIN(timestamp)')) {
        const earliest = storedPoints.length > 0 ? storedPoints[0].timestamp : null
        return { rows: [{ earliest }] }
      }
      if (sql.includes('FROM price_snapshots')) {
        return { rows: [] }
      }
      if (sql.includes('FROM price_points')) {
        if (sql.includes('AS open') || sql.includes('AS time') || sql.includes('COUNT(')) {
          return { rows: [] }
        }
        const filtered = storedPoints
          .filter(p => p.timestamp >= params[3] && p.timestamp <= params[4])
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        return { rows: filtered }
      }
      return { rows: [] }
    }),
  }

  const mockUpsertPricePoints = vi.fn(async (points: any[], network: any) => {
    if (points.length === 0) return 0
    const res = await mockPrisma.pricePoint.createMany({
      data: points.map(p => ({
        id: p.id ?? (p.eventId ? `${network}:${p.source}:${p.eventId}` : undefined),
        network,
        assetA: p.assetA,
        assetB: p.assetB,
        pairKey: p.pairKey,
        source: p.source,
        poolId: p.poolId ?? null,
        price: p.price,
        baseVolume: p.baseVolume,
        counterVolume: p.counterVolume,
        ledger: p.ledger,
        timestamp: p.timestamp,
        eventId: p.eventId ?? null,
      })),
      skipDuplicates: true,
    })
    return res.count
  })

  return { mockPrisma, mockPgPool, mockUpsertPricePoints, storedGaps, storedPoints }
})

vi.mock('../db', () => ({
  prisma: mockPrisma,
  pgPool: mockPgPool,
  upsertPricePoints: mockUpsertPricePoints,
}))

// Attach mocks to globalThis so gaps.ts and db.ts share them cleanly
;(globalThis as any).__lens_prisma = mockPrisma
;(globalThis as any).__lens_pgPool = mockPgPool

const mockHorizonTrades = vi.fn()
vi.mock('../network/clients', () => ({
  getHorizonServer: () => ({
    trades: () => ({
      forAssetPair: () => ({
        cursor: () => ({
          limit: () => ({
            order: () => ({
              call: mockHorizonTrades,
            }),
          }),
        }),
      }),
    }),
  }),
  getRpcServer: () => ({}),
}))

import { detectGaps, recordGaps, findOverlappingGaps, supportsHistory } from '../backfill/gaps'
import { backfill } from '../backfill/backfillService'
import { registerPriceRoutes } from '../routes/price'
import { registerHistoryRoutes } from '../api/history'
import { registerCandleRoutes } from '../routes/candles'
import { registerRESTRoutes } from '../api/rest'
import { registerNetworkSelector } from '../middleware/network'

describe('Gap Detection & Idempotent Recording', () => {
  beforeEach(() => {
    storedGaps.length = 0
    storedPoints.length = 0
    vi.clearAllMocks()
    ;(globalThis as any).__lens_prisma = mockPrisma
    ;(globalThis as any).__lens_pgPool = mockPgPool
  })

  it('determines source history support correctly', () => {
    expect(supportsHistory('SDEX')).toBe(true)
    expect(supportsHistory('sdex')).toBe(true)
    expect(supportsHistory('AMM')).toBe(true)
    expect(supportsHistory('soroswap_amm')).toBe(false)
    expect(supportsHistory('aquarius_amm')).toBe(false)
    expect(supportsHistory('unknown')).toBe(false)
  })

  it('detects a missing window when no points exist and records gap with required fields', async () => {
    const start = new Date('2026-10-15T00:00:00Z')
    const end = new Date('2026-10-15T06:00:00Z')

    const detected = await detectGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      start,
      end,
      cadenceMs: 300_000,
    })

    expect(detected).toHaveLength(1)
    const gap = detected[0]
    expect(gap.source).toBe('SDEX')
    expect(gap.pair).toBe('XLM/USDC')
    expect(gap.start.toISOString()).toBe(start.toISOString())
    expect(gap.end.toISOString()).toBe(end.toISOString())
    expect(gap.status).toBe('open')
    expect(gap.detectedAt).toBeInstanceOf(Date)
    expect(gap.updatedAt).toBeInstanceOf(Date)

    // Verify stored in persistent storage
    expect(storedGaps).toHaveLength(1)
  })

  it('detects internal holes between sparse price points', async () => {
    const t0 = new Date('2026-10-15T00:00:00Z')
    const t1 = new Date('2026-10-15T00:02:00Z')
    // Hole between t1 and t2: 4 hours
    const t2 = new Date('2026-10-15T04:02:00Z')
    const t3 = new Date('2026-10-15T04:04:00Z')

    storedPoints.push(
      { timestamp: t0 },
      { timestamp: t1 },
      { timestamp: t2 },
      { timestamp: t3 },
    )

    const detected = await detectGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      start: t0,
      end: t3,
      cadenceMs: 300_000, // 5 min
    })

    expect(detected).toHaveLength(1)
    expect(detected[0].start.toISOString()).toBe(t1.toISOString())
    expect(detected[0].end.toISOString()).toBe(t2.toISOString())
    expect(detected[0].status).toBe('open')
  })

  it('is idempotent: re-running gap detection produces no duplicates', async () => {
    const start = new Date('2026-10-15T00:00:00Z')
    const end = new Date('2026-10-15T06:00:00Z')

    // First run
    await detectGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      start,
      end,
      cadenceMs: 300_000,
    })
    expect(storedGaps).toHaveLength(1)
    const initialId = storedGaps[0].id

    // Second run with same parameters
    const secondRun = await detectGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      start,
      end,
      cadenceMs: 300_000,
    })

    expect(storedGaps).toHaveLength(1)
    expect(secondRun).toHaveLength(1)
    expect(secondRun[0].id).toBe(initialId)
    expect(secondRun[0].start.toISOString()).toBe(start.toISOString())
    expect(secondRun[0].end.toISOString()).toBe(end.toISOString())
  })

  it('merges overlapping and adjacent gaps into a single continuous row', async () => {
    // Gap 1: 00:00 → 02:00
    await recordGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      gaps: [{
        start: new Date('2026-10-15T00:00:00Z'),
        end: new Date('2026-10-15T02:00:00Z'),
      }],
    })
    expect(storedGaps).toHaveLength(1)

    // Gap 2 overlapping & extending: 01:30 → 04:00
    await recordGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      gaps: [{
        start: new Date('2026-10-15T01:30:00Z'),
        end: new Date('2026-10-15T04:00:00Z'),
      }],
    })

    // Should be merged into one gap: 00:00 → 04:00
    expect(storedGaps).toHaveLength(1)
    expect(storedGaps[0].start.toISOString()).toBe('2026-10-15T00:00:00.000Z')
    expect(storedGaps[0].end.toISOString()).toBe('2026-10-15T04:00:00.000Z')
  })
})

describe('Backfill Command & Idempotent Refetch', () => {
  beforeEach(() => {
    storedGaps.length = 0
    storedPoints.length = 0
    vi.clearAllMocks()
    ;(globalThis as any).__lens_prisma = mockPrisma
    ;(globalThis as any).__lens_pgPool = mockPgPool
  })

  it('validates input ranges (start < end, not in future)', async () => {
    await expect(
      backfill({
        source: 'SDEX',
        pair: 'XLM/USDC',
        start: new Date('2026-10-16T10:00:00Z'),
        end: new Date('2026-10-16T08:00:00Z'),
      })
    ).rejects.toThrow(/start .* must be before end/)

    await expect(
      backfill({
        source: 'SDEX',
        pair: 'XLM/USDC',
        start: new Date('2026-10-16T00:00:00Z'),
        end: new Date(Date.now() + 86400_000 * 365), // 1 year in future
      })
    ).rejects.toThrow(/cannot be in the future/)
  })

  it('performs a successful backfill that fills an open gap', async () => {
    const start = new Date('2026-10-15T00:00:00Z')
    const end = new Date('2026-10-15T02:00:00Z')

    // Seed open gap
    await recordGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      gaps: [{ start, end, status: 'open' }],
    })
    expect(storedGaps[0].status).toBe('open')

    // Mock Horizon returning trades with valid TOID token (e.g. ledger 50000)
    mockHorizonTrades.mockResolvedValueOnce({
      records: [
        {
          id: 'trade-1',
          paging_token: `${(50000n << 32n).toString()}-1`,
          ledger_close_time: '2026-10-15T01:00:00Z',
          base_asset_type: 'native',
          counter_asset_code: 'USDC',
          price: { n: 25, d: 100 },
          base_amount: '100',
          counter_amount: '25',
        },
      ],
    }).mockResolvedValueOnce({ records: [] })

    const result = await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start,
      end,
      network: 'testnet',
    })

    expect(result.success).toBe(true)
    expect(result.pointsIngested).toBe(1)
    expect(result.gapsFilled).toBe(1)

    // Verify stored gap is updated to filled
    expect(storedGaps[0].status).toBe('filled')
  })

  it('proves idempotency on re-run: second run inserts 0 points and changes nothing', async () => {
    const start = new Date('2026-10-15T00:00:00Z')
    const end = new Date('2026-10-15T02:00:00Z')

    await recordGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      gaps: [{ start, end, status: 'open' }],
    })

    const sampleRecords = [
      {
        id: 'trade-repeat',
        paging_token: `${(50000n << 32n).toString()}-1`,
        ledger_close_time: '2026-10-15T01:00:00Z',
        base_asset_type: 'native',
        counter_asset_code: 'USDC',
        price: { n: 25, d: 100 },
        base_amount: '100',
        counter_amount: '25',
      },
    ]

    mockHorizonTrades
      .mockResolvedValueOnce({ records: sampleRecords })
      .mockResolvedValueOnce({ records: [] })

    // Run 1: fills gap
    const run1 = await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start,
      end,
      network: 'testnet',
    })
    expect(run1.pointsIngested).toBe(1)
    expect(storedPoints).toHaveLength(1)
    expect(storedGaps[0].status).toBe('filled')

    // Run 2: exact same range & trades
    mockHorizonTrades
      .mockResolvedValueOnce({ records: sampleRecords })
      .mockResolvedValueOnce({ records: [] })

    const run2 = await backfill({
      source: 'SDEX',
      pair: 'XLM/USDC',
      start,
      end,
      network: 'testnet',
    })

    // Idempotent: 0 new points inserted, no duplicate points in storage
    expect(run2.pointsIngested).toBe(0)
    expect(storedPoints).toHaveLength(1)
    expect(storedGaps).toHaveLength(1)
    expect(storedGaps[0].status).toBe('filled')
  })
})

describe('Permanent Gaps (Non-history Sources)', () => {
  beforeEach(() => {
    storedGaps.length = 0
    storedPoints.length = 0
    vi.clearAllMocks()
    ;(globalThis as any).__lens_prisma = mockPrisma
    ;(globalThis as any).__lens_pgPool = mockPgPool
  })

  it('marks newly detected gaps for non-history sources as permanent', async () => {
    const start = new Date('2026-10-15T00:00:00Z')
    const end = new Date('2026-10-15T04:00:00Z')

    const detected = await detectGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'soroswap_amm',
      start,
      end,
      cadenceMs: 300_000,
    })

    expect(detected).toHaveLength(1)
    expect(detected[0].source).toBe('soroswap_amm')
    expect(detected[0].status).toBe('permanent')
    expect(storedGaps[0].status).toBe('permanent')
  })

  it('reports clearly that an unfillable gap cannot be backfilled and marks it permanent', async () => {
    const start = new Date('2026-10-15T00:00:00Z')
    const end = new Date('2026-10-15T02:00:00Z')

    const result = await backfill({
      source: 'aquarius_amm',
      pair: 'XLM/USDC',
      start,
      end,
      network: 'testnet',
    })

    expect(result.success).toBe(false)
    expect(result.unfillable).toBe(true)
    expect(result.message).toMatch(/does not support historical data fetch.*marked permanent/)
    expect(storedGaps).toHaveLength(1)
    expect(storedGaps[0].status).toBe('permanent')
  })
})

describe('Incomplete Window Declarations in API Responses', () => {
  beforeEach(() => {
    storedGaps.length = 0
    storedPoints.length = 0
    vi.clearAllMocks()
    ;(globalThis as any).__lens_prisma = mockPrisma
    ;(globalThis as any).__lens_pgPool = mockPgPool
  })

  async function buildTestApp() {
    const app = Fastify({ logger: false })
    await app.register(registerNetworkSelector)
    await registerPriceRoutes(app)
    await registerHistoryRoutes(app)
    await registerCandleRoutes(app)
    await registerRESTRoutes(app)
    await app.ready()
    return app
  }

  it('flags response as incomplete with overlapping gap details when an open gap overlaps the window', async () => {
    const gapStart = new Date('2026-10-15T01:00:00Z')
    const gapEnd = new Date('2026-10-15T03:00:00Z')

    // Record open gap
    await recordGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      gaps: [{ start: gapStart, end: gapEnd, status: 'open' }],
    })

    const app = await buildTestApp()

    // Request window overlapping the gap: 00:00 → 04:00
    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC&from=2026-10-15T00:00:00.000Z&to=2026-10-15T04:00:00.000Z',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.incomplete).toBe(true)
    expect(body.gaps).toBeDefined()
    expect(body.gaps).toHaveLength(1)
    expect(body.gaps[0].source).toBe('SDEX')
    expect(body.gaps[0].status).toBe('open')
    expect(body.gaps[0].start).toBe(gapStart.toISOString())
    expect(body.gaps[0].end).toBe(gapEnd.toISOString())
  })

  it('flags response as incomplete when a permanent gap overlaps the window', async () => {
    const gapStart = new Date('2026-10-15T01:00:00Z')
    const gapEnd = new Date('2026-10-15T02:00:00Z')

    await recordGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'soroswap_amm',
      gaps: [{ start: gapStart, end: gapEnd, status: 'permanent' }],
    })

    const app = await buildTestApp()

    const res = await app.inject({
      method: 'GET',
      url: '/candles/XLM/USDC?from=2026-10-15T00:00:00.000Z&to=2026-10-15T03:00:00.000Z',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.incomplete).toBe(true)
    expect(body.gaps[0].source).toBe('soroswap_amm')
    expect(body.gaps[0].status).toBe('permanent')
  })

  it('does NOT flag response when the window covers only filled gaps or no gaps', async () => {
    // Record a FILLED gap in that window
    await recordGaps({
      network: 'testnet',
      pair: 'XLM/USDC',
      source: 'SDEX',
      gaps: [{
        start: new Date('2026-10-15T01:00:00Z'),
        end: new Date('2026-10-15T02:00:00Z'),
        status: 'filled',
      }],
    })

    const app = await buildTestApp()

    // Request window
    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC&from=2026-10-15T00:00:00.000Z&to=2026-10-15T03:00:00.000Z',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Should NOT be flagged incomplete
    expect(body.incomplete).toBeUndefined()
    expect(body.gaps).toBeUndefined()
  })
})
