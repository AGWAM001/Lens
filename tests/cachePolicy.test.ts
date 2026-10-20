import { describe, it, expect } from 'vitest'
import { cachePolicyFor, varyFor } from '../src/middleware/cachePolicy'
import { INTERVAL_SECONDS } from '../src/candleIntervals'

// Unit tests for the per-route Cache-Control policy (issue #266).
// cachePolicyFor / varyFor are pure functions — no server boot needed.

describe('cachePolicyFor', () => {
  it('gives live prices a short max-age', () => {
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB', 200)).toBe('public, max-age=30')
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB/route', 200)).toBe('public, max-age=30')
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB/depth', 200)).toBe('public, max-age=30')
  })

  it('gives /pairs and /pools a medium max-age (rarely change)', () => {
    expect(cachePolicyFor('GET', '/pairs', 200)).toBe('public, max-age=300')
    expect(cachePolicyFor('GET', '/pools', 200)).toBe('public, max-age=300')
  })

  it('gives aggregates a short-medium max-age', () => {
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB/history', 200)).toBe('public, max-age=60')
    expect(cachePolicyFor('GET', '/price/twap/:assetA/:assetB', 200)).toBe('public, max-age=60')
    expect(cachePolicyFor('GET', '/price/vwap/:assetA/:assetB', 200)).toBe('public, max-age=60')
    expect(cachePolicyFor('GET', '/prices/history', 200)).toBe('public, max-age=60')
  })

  it('marks per-caller responses no-store', () => {
    expect(cachePolicyFor('GET', '/usage/me', 200)).toBe('no-store')
    expect(cachePolicyFor('GET', '/admin/keys', 200)).toBe('no-store')
    expect(cachePolicyFor('GET', '/admin/usage', 200)).toBe('no-store')
  })

  it('marks mutations no-store', () => {
    expect(cachePolicyFor('POST', '/pairs', 201)).toBe('no-store')
    expect(cachePolicyFor('POST', '/webhooks', 201)).toBe('no-store')
    expect(cachePolicyFor('DELETE', '/webhooks/:id', 200)).toBe('no-store')
  })

  it('marks error responses no-store', () => {
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB', 404)).toBe('no-store')
    expect(cachePolicyFor('GET', '/pairs', 500)).toBe('no-store')
    expect(cachePolicyFor('GET', '/pairs', 429)).toBe('no-store')
  })

  it('gives closed candle windows a short max-age with stale-while-revalidate', () => {
    // `to` two days ago with a 1h interval: window is probably closed, but
    // backfill can rewrite history — so short max-age, long SWR.
    const closed = { interval: '1h', to: new Date(Date.now() - 2 * 86400 * 1000).toISOString() }
    expect(cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, closed)).toBe(
      'public, max-age=3600, stale-while-revalidate=86400',
    )
  })

  it('gives the live candle window a short max-age', () => {
    // No `to`: defaults to now, window still forming.
    expect(cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, {})).toBe('public, max-age=60')
    // `to` = now: still the live window.
    const live = { interval: '1h', to: new Date().toISOString() }
    expect(cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, live)).toBe('public, max-age=60')
  })

  it('defaults unknown routes to no-store', () => {
    expect(cachePolicyFor('GET', '/graphql', 200)).toBe('no-store')
    expect(cachePolicyFor('GET', '/some/future/route', 200)).toBe('no-store')
  })

  it('downgrades x402-gated routes public -> private when x402 is active', () => {
    // Without x402: shared caching is fine.
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB', 200)).toBe('public, max-age=30')
    expect(cachePolicyFor('GET', '/pools', 200)).toBe('public, max-age=300')
    // With x402 active: a shared cache would let callers skip payment.
    expect(cachePolicyFor('GET', '/price/:assetA/:assetB', 200, {}, { x402Active: true })).toBe(
      'private, max-age=30',
    )
    expect(cachePolicyFor('GET', '/pools', 200, {}, { x402Active: true })).toBe(
      'private, max-age=300',
    )
    const closed = { interval: '1h', to: new Date(Date.now() - 2 * 86400 * 1000).toISOString() }
    expect(
      cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, closed, { x402Active: true }),
    ).toBe('private, max-age=3600, stale-while-revalidate=86400')
  })

  it('does not downgrade non-gated public routes when x402 is active', () => {
    // /pairs is not in GATED_ROUTES — stays public even with x402 on.
    expect(cachePolicyFor('GET', '/pairs', 200, {}, { x402Active: true })).toBe('public, max-age=300')
    expect(cachePolicyFor('GET', '/status', 200, {}, { x402Active: true })).toBe('public, max-age=15')
  })

  it('uses the route interval list as single source of truth (no drift)', () => {
    // cachePolicy imports INTERVAL_SECONDS from the shared candleIntervals
    // module (same one the candles route uses) — assert the import resolves
    // and covers every supported interval.
    expect(INTERVAL_SECONDS['1m']).toBe(60)
    expect(INTERVAL_SECONDS['5m']).toBe(300)
    expect(INTERVAL_SECONDS['15m']).toBe(900)
    expect(INTERVAL_SECONDS['1h']).toBe(3600)
    expect(INTERVAL_SECONDS['4h']).toBe(14_400)
    expect(INTERVAL_SECONDS['1d']).toBe(86_400)
    // Unknown interval falls back to 1h semantics (3600s) in the policy.
    const closed = { interval: 'bogus', to: new Date(Date.now() - 2 * 86400 * 1000).toISOString() }
    expect(cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, closed)).toBe(
      'public, max-age=3600, stale-while-revalidate=86400',
    )
  })
})

describe('varyFor', () => {
  it('returns x-network for public responses', () => {
    expect(varyFor('public, max-age=30')).toBe('x-network')
    expect(varyFor('public, max-age=3600, stale-while-revalidate=86400')).toBe('x-network')
  })

  it('returns null for private and no-store responses', () => {
    expect(varyFor('private, max-age=30')).toBeNull()
    expect(varyFor('no-store')).toBeNull()
  })

  it('every public policy from cachePolicyFor gets a Vary', () => {
    const publicPolicies = [
      cachePolicyFor('GET', '/pairs', 200),
      cachePolicyFor('GET', '/price/:assetA/:assetB', 200),
      cachePolicyFor('GET', '/candles/:assetA/:assetB', 200, {}),
      cachePolicyFor('GET', '/status', 200),
    ]
    for (const policy of publicPolicies) {
      expect(policy.startsWith('public')).toBe(true)
      expect(varyFor(policy)).toBe('x-network')
    }
  })
})
