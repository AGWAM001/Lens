import { beforeEach, expect, it, vi } from 'vitest'
import { cache_requests_total, cache_write_errors_total } from '../metrics'
import {
  getCachedAsset, getCachedPrice, getCachedSnapshot,
  setCachedAsset, setCachedPrice, setCachedSnapshot,
} from '../redis'

const mockRedis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), on: vi.fn() }))
vi.mock('ioredis', () => ({ default: function Redis() { return mockRedis } }))

beforeEach(() => {
  vi.resetAllMocks()
  cache_requests_total.reset()
  cache_write_errors_total.reset()
})

const data = { price: '1' }
const caches = [
  { cache: 'price', read: () => getCachedPrice('pair'), write: () => setCachedPrice('pair', data, 60) },
  { cache: 'snapshot', read: () => getCachedSnapshot('testnet'), write: () => setCachedSnapshot('testnet', data, 60) },
  { cache: 'asset', read: () => getCachedAsset('testnet', 'asset'), write: () => setCachedAsset('testnet', 'asset', data, 60) },
]

it.each(caches)('counts cache outcomes for $cache and preserves fallback behavior', async ({ cache, read, write }) => {
  mockRedis.get.mockResolvedValueOnce('').mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'))
  mockRedis.set.mockResolvedValueOnce('OK').mockRejectedValueOnce(new Error('offline'))

  await expect(read()).resolves.toBe('')
  await expect(read()).resolves.toBeNull()
  await expect(read()).resolves.toBeNull()
  await expect(write()).resolves.toBeUndefined()
  expect((await cache_write_errors_total.get()).values).toEqual([])
  await expect(write()).resolves.toBeUndefined()

  const reads = (await cache_requests_total.get()).values
  expect(reads).toHaveLength(3)
  expect(reads).toEqual(expect.arrayContaining(['hit', 'miss', 'error'].map(result =>
    expect.objectContaining({ labels: { cache, result }, value: 1 })
  )))
  expect((await cache_write_errors_total.get()).values).toEqual([
    expect.objectContaining({ labels: { cache }, value: 1 })
  ])
})
