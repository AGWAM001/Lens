import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkAndIncrementDailyUsage, resetDailyUsage } from '../api/auth'

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

  it('allows requests within daily quota', () => {
    const res1 = checkAndIncrementDailyUsage('key-1', 5)
    expect(res1.allowed).toBe(true)
    expect(res1.remaining).toBe(4)

    const res2 = checkAndIncrementDailyUsage('key-1', 5)
    expect(res2.allowed).toBe(true)
    expect(res2.remaining).toBe(3)
  })

  it('rejects requests once daily quota is exhausted', () => {
    for (let i = 0; i < 3; i++) {
      const res = checkAndIncrementDailyUsage('key-limit', 3)
      expect(res.allowed).toBe(true)
    }

    const fourth = checkAndIncrementDailyUsage('key-limit', 3)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
  })

  it('maintains independent quotas per API key', () => {
    checkAndIncrementDailyUsage('key-a', 2)
    checkAndIncrementDailyUsage('key-a', 2)
    expect(checkAndIncrementDailyUsage('key-a', 2).allowed).toBe(false)

    // key-b has separate quota
    expect(checkAndIncrementDailyUsage('key-b', 5).allowed).toBe(true)
  })
})
