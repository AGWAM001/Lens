import { describe, it, expect, beforeEach } from 'vitest'
import { getPoolFee, clearPoolFeeCache } from '../src/pricing/pool-fee'

const HORIZON = 'https://horizon.example.test'

function fakeFetch(body: unknown, status = 200) {
  const calls: string[] = []
  const fn = (async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('getPoolFee', () => {
  beforeEach(() => clearPoolFeeCache())

  it('reads fee_bp from the venue and caches it', async () => {
    let t = 0
    const { fn, calls } = fakeFetch({ id: 'p1', fee_bp: 50 })
    const opts = { horizonUrl: HORIZON, now: () => t, fetchImpl: fn }

    const first = await getPoolFee('testnet', 'p1', opts)
    const second = await getPoolFee('testnet', 'p1', opts)

    expect(first.ok && first.fee.feeBp).toBe(50)
    expect(first.ok && first.cached).toBe(false)
    expect(second.ok && second.cached).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('refetches after the TTL expires', async () => {
    let t = 0
    const { fn, calls } = fakeFetch({ id: 'p1', fee_bp: 30 })
    const opts = { horizonUrl: HORIZON, ttlMs: 1000, now: () => t, fetchImpl: fn }

    await getPoolFee('testnet', 'p1', opts)
    t = 1001
    await getPoolFee('testnet', 'p1', opts)

    expect(calls).toHaveLength(2)
  })

  it('does not cache a failed read, so the next call retries', async () => {
    const bad = fakeFetch({ id: 'p1' }) // no fee_bp
    const good = fakeFetch({ id: 'p1', fee_bp: 30 })
    const base = { horizonUrl: HORIZON, now: () => 0 }

    const first = await getPoolFee('testnet', 'p1', { ...base, fetchImpl: bad.fn })
    expect(first.ok).toBe(false)

    const second = await getPoolFee('testnet', 'p1', { ...base, fetchImpl: good.fn })
    expect(second.ok && second.fee.feeBp).toBe(30)
  })

  it('rejects a missing, non-integer or out-of-range fee', async () => {
    const base = { horizonUrl: HORIZON, now: () => 0 }
    for (const body of [{}, { fee_bp: 30.5 }, { fee_bp: -1 }, { fee_bp: 10000 }, { fee_bp: '30' }]) {
      clearPoolFeeCache()
      const r = await getPoolFee('testnet', 'p1', { ...base, fetchImpl: fakeFetch(body).fn })
      expect(r.ok, JSON.stringify(body)).toBe(false)
    }
  })

  it('reports venue HTTP errors as a reason, not a throw', async () => {
    const r = await getPoolFee('testnet', 'p1', {
      horizonUrl: HORIZON,
      now: () => 0,
      fetchImpl: fakeFetch({}, 404).fn,
    })
    expect(r).toEqual({ ok: false, poolId: 'p1', reason: 'venue responded 404' })
  })

  it('keeps networks apart in the cache', async () => {
    const testnet = fakeFetch({ fee_bp: 30 })
    const mainnet = fakeFetch({ fee_bp: 50 })
    const base = { horizonUrl: HORIZON, now: () => 0 }

    await getPoolFee('testnet', 'p1', { ...base, fetchImpl: testnet.fn })
    const m = await getPoolFee('mainnet', 'p1', { ...base, fetchImpl: mainnet.fn })

    expect(m.ok && m.fee.feeBp).toBe(50)
    expect(mainnet.calls).toHaveLength(1)
  })
})
