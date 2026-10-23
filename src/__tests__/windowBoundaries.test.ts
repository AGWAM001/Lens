import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

/**
 * Window boundaries are half-open: [from, to).
 *
 * `from` is inclusive, `to` is exclusive. Two adjacent windows [T0, T1) and
 * [T1, T2) therefore share no boundary, and a sample landing exactly on T1 is
 * counted exactly once across the pair. The old convention was inclusive at
 * both ends — [from, to] — which double-counted every sample that landed on a
 * shared boundary.
 *
 * These tests drive the real route handlers and let the mock apply the range
 * predicate the way Postgres would: the operator is read out of the SQL text
 * the route actually sent, not hard-coded here. A route that regresses to
 * `<=` therefore fails these tests, and a route that never sends a range
 * predicate at all fails them too.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import { registerCandleRoutes } from '../routes/candles'
import { registerHistoryRoutes } from '../api/history'
import { registerNetworkSelector } from '../middleware/network'

// Real Stellar contract addresses, spelled out in full. The range predicates
// are about *when* a sample was taken, but the pair they are taken for has to
// be a real one: a truncated issuer would quietly match nothing.
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

// Three fixed instants: T0, the shared boundary T1, and T2. The sample that
// lands exactly on T1 is the one under test.
const T0 = new Date('2026-01-01T00:00:00.000Z')
const T1 = new Date('2026-01-01T01:00:00.000Z')
const T2 = new Date('2026-01-01T02:00:00.000Z')

type Row = Record<string, unknown>

/**
 * A range-aware stand-in for the price tables.
 *
 * The mock reads the bounds out of the SQL string — `AND <col> <op> $N` — and
 * applies them to the seeded rows, so the behaviour under test is the query
 * the route builds, not a filter this file hard-codes. `network = $N` is
 * honoured too, for the same reason.
 */
function useRangeTable(table: Row[]) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const bounds: Array<{ col: string; op: string; at: number }> = []
    const rangeRe = /AND\s+(\w+)\s*(>=|<=|<|>)\s*\$(\d+)/g
    let match: RegExpExecArray | null
    while ((match = rangeRe.exec(sql)) !== null) {
      bounds.push({ col: match[1], op: match[2], at: Number(match[3]) })
    }

    const networkMatch = /AND\s+network\s*=\s*\$(\d+)/.exec(sql)
    const networkAt = networkMatch ? Number(networkMatch[1]) : null

    const rows = table.filter(row => {
      if (networkAt !== null && row.network !== params[networkAt - 1]) return false
      return bounds.every(b => {
        const value = new Date(row[b.col] as string | Date).getTime()
        const at = new Date(params[b.at - 1] as string | Date).getTime()
        if (b.op === '>=') return value >= at
        if (b.op === '>') return value > at
        if (b.op === '<=') return value <= at
        return value < at
      })
    })

    return { rows }
  })
}

async function buildCandleApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerCandleRoutes(app)
  await app.ready()
  return app
}

async function buildHistoryApp() {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerHistoryRoutes(app)
  await app.ready()
  return app
}

describe('adjacent candle windows share no boundary', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  // price_points rows. `timestamp` is the source column the range predicate
  // filters on; `time` is the bucket the route reports back.
  const table: Row[] = [
    {
      network: 'testnet',
      pair_key: 'XLM/USDC',
      timestamp: new Date(T0.getTime() + 60_000),
      time: new Date(T0.getTime() + 60_000),
      open: '1.0', high: '1.0', low: '1.0', close: '1.0', volume: '10',
    },
    {
      // Lands exactly on the shared boundary T1.
      network: 'testnet',
      pair_key: 'XLM/USDC',
      timestamp: T1,
      time: T1,
      open: '2.0', high: '2.0', low: '2.0', close: '2.0', volume: '20',
    },
    {
      network: 'testnet',
      pair_key: 'XLM/USDC',
      timestamp: new Date(T1.getTime() + 60_000),
      time: new Date(T1.getTime() + 60_000),
      open: '3.0', high: '3.0', low: '3.0', close: '3.0', volume: '30',
    },
  ]

  it('counts a sample landing exactly on the boundary exactly once', async () => {
    useRangeTable(table)
    const app = await buildCandleApp()

    const windowA = await app.inject({
      method: 'GET',
      url: `/candles/XLM/USDC?interval=1h&from=${T0.toISOString()}&to=${T1.toISOString()}`,
    })
    const windowB = await app.inject({
      method: 'GET',
      url: `/candles/XLM/USDC?interval=1h&from=${T1.toISOString()}&to=${T2.toISOString()}`,
    })

    expect(windowA.statusCode).toBe(200)
    expect(windowB.statusCode).toBe(200)

    const a = windowA.json().candles as Array<{ time: string }>
    const b = windowB.json().candles as Array<{ time: string }>

    const boundaryCount =
      a.filter(c => new Date(c.time).getTime() === T1.getTime()).length +
      b.filter(c => new Date(c.time).getTime() === T1.getTime()).length

    expect(boundaryCount).toBe(1)
  })

  it('excludes the boundary sample from the earlier window and includes it in the later one', async () => {
    useRangeTable(table)
    const app = await buildCandleApp()

    const windowA = await app.inject({
      method: 'GET',
      url: `/candles/XLM/USDC?interval=1h&from=${T0.toISOString()}&to=${T1.toISOString()}`,
    })
    const windowB = await app.inject({
      method: 'GET',
      url: `/candles/XLM/USDC?interval=1h&from=${T1.toISOString()}&to=${T2.toISOString()}`,
    })

    const a = windowA.json().candles as Array<{ time: string }>
    const b = windowB.json().candles as Array<{ time: string }>

    // `to` is exclusive: the sample at T1 is not in [T0, T1).
    expect(a.map(c => new Date(c.time).getTime())).not.toContain(T1.getTime())
    // `from` is inclusive: the sample at T1 is in [T1, T2).
    expect(b.map(c => new Date(c.time).getTime())).toContain(T1.getTime())
  })

  it('keeps the network predicate so the pair_key/timestamp index is usable', async () => {
    useRangeTable(table)
    const app = await buildCandleApp()

    await app.inject({
      method: 'GET',
      url: `/candles/XLM/USDC?interval=1h&from=${T0.toISOString()}&to=${T1.toISOString()}`,
    })

    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toMatch(/FROM price_points/)
    expect(sql).toMatch(/AND network = \$5/)
  })
})

describe('adjacent price history windows share no boundary', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  // price_snapshots rows. `ts` is the source column the range predicate
  // filters on; `bucket` is what the route reports back.
  const table: Row[] = [
    {
      network: 'testnet',
      pair: 'XLM/USDC',
      ts: new Date(T0.getTime() + 60_000),
      bucket: new Date(T0.getTime() + 60_000),
      price: '1.0', volume: '10',
    },
    {
      // Lands exactly on the shared boundary T1.
      network: 'testnet',
      pair: 'XLM/USDC',
      ts: T1,
      bucket: T1,
      price: '2.0', volume: '20',
    },
    {
      network: 'testnet',
      pair: 'XLM/USDC',
      ts: new Date(T1.getTime() + 60_000),
      bucket: new Date(T1.getTime() + 60_000),
      price: '3.0', volume: '30',
    },
  ]

  it('counts a sample landing exactly on the boundary exactly once', async () => {
    useRangeTable(table)
    const app = await buildHistoryApp()

    const windowA = await app.inject({
      method: 'GET',
      url: `/prices/history?pair=XLM/USDC&interval=1m&from=${T0.toISOString()}&to=${T1.toISOString()}`,
    })
    const windowB = await app.inject({
      method: 'GET',
      url: `/prices/history?pair=XLM/USDC&interval=1m&from=${T1.toISOString()}&to=${T2.toISOString()}`,
    })

    expect(windowA.statusCode).toBe(200)
    expect(windowB.statusCode).toBe(200)

    const a = windowA.json().points as Array<{ ts: string }>
    const b = windowB.json().points as Array<{ ts: string }>

    const boundaryCount =
      a.filter(p => new Date(p.ts).getTime() === T1.getTime()).length +
      b.filter(p => new Date(p.ts).getTime() === T1.getTime()).length

    expect(boundaryCount).toBe(1)
  })

  it('excludes the boundary sample from the earlier window and includes it in the later one', async () => {
    useRangeTable(table)
    const app = await buildHistoryApp()

    const windowA = await app.inject({
      method: 'GET',
      url: `/prices/history?pair=XLM/USDC&interval=1m&from=${T0.toISOString()}&to=${T1.toISOString()}`,
    })
    const windowB = await app.inject({
      method: 'GET',
      url: `/prices/history?pair=XLM/USDC&interval=1m&from=${T1.toISOString()}&to=${T2.toISOString()}`,
    })

    const a = windowA.json().points as Array<{ ts: string }>
    const b = windowB.json().points as Array<{ ts: string }>

    expect(a.map(p => new Date(p.ts).getTime())).not.toContain(T1.getTime())
    expect(b.map(p => new Date(p.ts).getTime())).toContain(T1.getTime())
  })

  it('keeps the network predicate on the snapshot table', async () => {
    useRangeTable(table)
    const app = await buildHistoryApp()

    await app.inject({
      method: 'GET',
      url: `/prices/history?pair=XLM/USDC&interval=1m&from=${T0.toISOString()}&to=${T1.toISOString()}`,
    })

    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toMatch(/FROM price_snapshots/)
    expect(sql).toMatch(/AND network = \$5/)
  })
})

describe('issuers and contract addresses are never truncated', () => {
  it('uses the full mainnet USDC issuer', () => {
    expect(MAINNET_USDC).toHaveLength(56)
    expect(MAINNET_USDC).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
  })

  it('uses the full testnet USDC issuer', () => {
    expect(TESTNET_USDC).toHaveLength(56)
    expect(TESTNET_USDC).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
  })
})
