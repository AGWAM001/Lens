import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  checkAndIncrementDailyUsage,
  resetDailyUsage,
  getSecondsUntilUtcMidnight,
} from '../api/auth'
import { redis } from '../redis'

vi.mock('../db', () => ({
  prisma: {
    apiKey: { findUnique: vi.fn() },
  },
  pgPool: { query: vi.fn() },
}))

describe('Daily API Key Quota Enforcement (#175)', () => {
  beforeEach(() => {
    resetDailyUsage()
  })

  it('calculates numeric seconds until UTC midnight correctly', () => {
    const seconds = getSecondsUntilUtcMidnight()
    expect(typeof seconds).toBe('number')
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeLessThanOrEqual(86400)
  })

  it('allows requests within daily quota', async () => {
    const res1 = await checkAndIncrementDailyUsage('key-1', 5)
    expect(res1.allowed).toBe(true)
    expect(res1.remaining).toBe(4)

    const res2 = await checkAndIncrementDailyUsage('key-1', 5)
    expect(res2.allowed).toBe(true)
    expect(res2.remaining).toBe(3)
  })

  it('rejects requests once daily quota is exhausted', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await checkAndIncrementDailyUsage('key-limit', 3)
      expect(res.allowed).toBe(true)
    }

    const fourth = await checkAndIncrementDailyUsage('key-limit', 3)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
  })

  it('maintains independent quotas per API key', async () => {
    await checkAndIncrementDailyUsage('key-a', 2)
    await checkAndIncrementDailyUsage('key-a', 2)
    const thirdA = await checkAndIncrementDailyUsage('key-a', 2)
    expect(thirdA.allowed).toBe(false)

    // key-b has separate quota
    const firstB = await checkAndIncrementDailyUsage('key-b', 5)
    expect(firstB.allowed).toBe(true)
  })

  it('fails open when Redis encounters an error rather than failing closed', async () => {
    // If Redis is unreachable or throws, it allows the request
    const originalIncr = redis.incr
    try {
      // Force Redis error
      // @ts-expect-error test mock
      redis.status = 'ready'
      redis.incr = vi.fn().mockRejectedValueOnce(new Error('Connection lost'))

      const res = await checkAndIncrementDailyUsage('key-failopen', 10)
      expect(res.allowed).toBe(true)
    } finally {
      redis.incr = originalIncr
      // @ts-expect-error test restore
      redis.status = 'wait'
    }
  })
})
