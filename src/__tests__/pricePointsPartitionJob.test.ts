import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockEnsure, mockDrop } = vi.hoisted(() => ({
  mockEnsure: vi.fn(),
  mockDrop: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: {},
}))

vi.mock('../partitioning/pricePoints', () => ({
  ensurePricePointsPartitions: mockEnsure,
  dropExpiredPricePointsPartitions: mockDrop,
  DEFAULT_RETENTION_DAYS: 30,
  DEFAULT_PRECREATE_DAYS: 7,
}))

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn()
  },
  Worker: class {
    on = vi.fn()
  },
}))

import {
  runPricePointsMaintenance,
  PRICE_POINTS_RETENTION_DAYS,
  PRICE_POINTS_PRECREATE_DAYS,
  schedulePricePointsPartitionMaintenance,
} from '../jobs/pricePointsPartitionJob'

describe('pricePointsPartitionJob', () => {
  beforeEach(() => {
    mockEnsure.mockReset()
    mockDrop.mockReset()
  })

  it('runs maintenance with pre-creation only by default (dropExpired = false)', async () => {
    mockEnsure.mockResolvedValueOnce({
      created: ['price_points_y2026m10d24'],
      existing: ['price_points_y2026m10d16'],
    })

    const result = await runPricePointsMaintenance(30, 7, false)

    expect(mockEnsure).toHaveBeenCalledWith(expect.anything(), {
      precreateDays: 7,
      daysBack: 1,
    })
    expect(mockDrop).not.toHaveBeenCalled()

    expect(result.created).toEqual(['price_points_y2026m10d24'])
    expect(result.dropped).toEqual([])
  })

  it('drops expired partitions when dropExpired is explicitly enabled', async () => {
    mockEnsure.mockResolvedValueOnce({
      created: ['price_points_y2026m10d24'],
      existing: ['price_points_y2026m10d16'],
    })
    mockDrop.mockResolvedValueOnce({
      dropped: ['price_points_y2026m09d10'],
      retained: ['price_points_y2026m10d16'],
    })

    const result = await runPricePointsMaintenance(30, 7, true)

    expect(mockEnsure).toHaveBeenCalledWith(expect.anything(), {
      precreateDays: 7,
      daysBack: 1,
    })
    expect(mockDrop).toHaveBeenCalledWith(expect.anything(), 30)

    expect(result.created).toEqual(['price_points_y2026m10d24'])
    expect(result.dropped).toEqual(['price_points_y2026m09d10'])
  })

  it('schedules hourly job and immediate startup run', async () => {
    const queue = { add: vi.fn() } as any
    await schedulePricePointsPartitionMaintenance(queue)

    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'maintain',
      {},
      { repeat: { every: 60 * 60 * 1000 }, jobId: 'price-points-partition:maintain' }
    )
    expect(queue.add).toHaveBeenNthCalledWith(2, 'maintain', {})
  })
})
