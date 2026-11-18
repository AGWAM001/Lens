import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery, mockGetActivePairs } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetActivePairs: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

vi.mock('../pairsRegistry', () => ({
  getActivePairs: mockGetActivePairs,
}))

import { appendSnapshots, floorToMinute } from '../ingest/snapshot'

describe('floorToMinute', () => {
  it('zeros seconds and milliseconds', () => {
    expect(floorToMinute(new Date('2025-01-01T12:34:56.789Z')).toISOString()).toBe('2025-01-01T12:34:00.000Z')
  })

  it('is a no-op for an already minute-aligned time', () => {
    expect(floorToMinute(new Date('2025-01-01T12:34:00.000Z')).toISOString()).toBe('2025-01-01T12:34:00.000Z')
  })

  it('does not roll over to the next minute at :59.999', () => {
    expect(floorToMinute(new Date('2025-01-01T12:34:59.999Z')).toISOString()).toBe('2025-01-01T12:34:00.000Z')
  })

  it('does not mutate its input', () => {
    const input = new Date('2025-01-01T12:34:56.789Z')
    floorToMinute(input)
    expect(input.toISOString()).toBe('2025-01-01T12:34:56.789Z')
  })
})

describe('appendSnapshots', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockGetActivePairs.mockReset()
  })

  it('does nothing and returns 0 when there are no active pairs', async () => {
    mockGetActivePairs.mockReturnValue([])

    const inserted = await appendSnapshots(new Date('2025-01-01T00:00:30Z'))

    expect(inserted).toBe(0)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('inserts at the floored minute and reports rows inserted', async () => {
    mockGetActivePairs.mockReturnValue([
      { pairKey: 'XLM/USDC', assetA: {}, assetB: {} },
      { pairKey: 'XLM/yBTC', assetA: {}, assetB: {} },
    ])
    mockQuery.mockResolvedValue({ rowCount: 2 })

    const inserted = await appendSnapshots(new Date('2025-01-01T00:00:42.500Z'))

    expect(inserted).toBe(2)
    const params = mockQuery.mock.calls[0][1]
    expect(params[0]).toEqual(['XLM/USDC', 'XLM/yBTC'])
    // ts param must be floored to the minute boundary.
    expect((params[1] as Date).toISOString()).toBe('2025-01-01T00:00:00.000Z')
  })

  it('returns 0 when the upsert skips all rows (idempotent re-run)', async () => {
    mockGetActivePairs.mockReturnValue([{ pairKey: 'XLM/USDC', assetA: {}, assetB: {} }])
    mockQuery.mockResolvedValue({ rowCount: 0 })

    const inserted = await appendSnapshots(new Date('2025-01-01T00:00:00Z'))

    expect(inserted).toBe(0)
  })

  it('uses ON CONFLICT DO NOTHING so duplicate minutes are skipped', async () => {
    mockGetActivePairs.mockReturnValue([{ pairKey: 'XLM/USDC', assetA: {}, assetB: {} }])
    mockQuery.mockResolvedValue({ rowCount: 1 })

    await appendSnapshots()

    expect(mockQuery.mock.calls[0][0]).toMatch(/ON CONFLICT \(network, pair, ts\) DO NOTHING/)
  })
})
