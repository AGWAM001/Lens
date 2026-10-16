/**
 * Golden tests for the /prices/history CSV export.
 *
 * Downstream analytics ingest this CSV byte-for-byte, so the *shape* — column
 * order, ISO 8601 timestamps, number formatting, quoting, LF line endings and
 * the trailing newline — is a contract, not an implementation detail. Each
 * tests/fixtures/historical-*.csv file is the committed golden rendering of a
 * fixed dataset; any change to historyToCsv() that shifts a byte fails here
 * instead of silently breaking a consumer.
 *
 * Fixtures are intentionally NOT generated from the implementation in the test
 * run: they are read as plain bytes from disk, so a serializer regression is
 * caught rather than papered over.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../src/db', () => ({
  prisma: {},
  pgPool: { query: mockQuery },
}))

import { registerHistoryRoutes, historyToCsv, HISTORY_CSV_COLUMNS, type HistoryPoint } from '../src/api/history'
import { registerNetworkSelector } from '../src/middleware/network'

const golden = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

/** Fixed datasets — the inputs the golden fixtures were rendered from. */
const points1m: HistoryPoint[] = [
  { ts: '2025-03-01T00:00:00.000Z', price: 0.4123, volume: 1200 },
  { ts: '2025-03-01T00:01:00.000Z', price: 0.4125, volume: 980.5 },
  { ts: '2025-03-01T00:02:00.000Z', price: 0.4119, volume: 1044 },
  { ts: '2025-03-01T00:03:00.000Z', price: 0.413, volume: 0 },
  { ts: '2025-03-01T00:04:00.000Z', price: 0.4127, volume: 765 },
]

const points5m: HistoryPoint[] = [
  { ts: '2025-03-01T00:00:00.000Z', price: 0.4123, volume: 5400 },
  { ts: '2025-03-01T00:05:00.000Z', price: 0.4131, volume: 4980.5 },
  { ts: '2025-03-01T00:10:00.000Z', price: 0.4127, volume: 6120 },
]

const points1h: HistoryPoint[] = [
  { ts: '2025-03-01T00:00:00.000Z', price: 0.4123, volume: 125400 },
  { ts: '2025-03-01T01:00:00.000Z', price: 0.4145, volume: 98750.25 },
  { ts: '2025-03-01T02:00:00.000Z', price: 0.4099, volume: 143210 },
]

const pointsEmpty: HistoryPoint[] = []

const goldenCases: Array<[fixture: string, points: HistoryPoint[]]> = [
  ['historical-1m.csv', points1m],
  ['historical-5m.csv', points5m],
  ['historical-1h.csv', points1h],
  ['historical-empty.csv', pointsEmpty],
]

/** Row shape `pg` returns from queryHistory's aggregate query. */
function rowsFor(points: HistoryPoint[]) {
  return points.map(p => ({ bucket: new Date(p.ts), price: String(p.price), volume: String(p.volume) }))
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(registerNetworkSelector)
  await registerHistoryRoutes(app)
  await app.ready()
  return app
}

describe('historyToCsv golden fixtures', () => {
  it.each(goldenCases)('renders %s byte-for-byte', (fixture, points) => {
    expect(historyToCsv(points)).toBe(golden(fixture))
  })

  it('emits the exact column order the fixtures document', () => {
    expect(HISTORY_CSV_COLUMNS).toEqual(['ts', 'price', 'volume'])
    expect(golden('historical-1m.csv').split('\n')[0]).toBe('ts,price,volume')
  })

  it('is byte-identical across repeated runs', () => {
    const runs = Array.from({ length: 25 }, () => historyToCsv(points5m))
    expect(new Set(runs).size).toBe(1)
    expect(runs[0]).toBe(golden('historical-5m.csv'))
  })

  it('uses LF line endings only, and exactly one trailing newline', () => {
    for (const [fixture, points] of goldenCases) {
      const csv = historyToCsv(points)
      expect(csv, fixture).not.toContain('\r')
      expect(csv, fixture).toMatch(/\n$/)
      expect(csv.slice(0, -1), fixture).not.toContain('\n\n')
      expect(csv, fixture).toBe(golden(fixture))
    }
  })

  it('quotes fields containing commas, quotes or newlines per RFC 4180', () => {
    const csv = historyToCsv([{ ts: '2025-03-01T00:00:00.000Z, "v"', price: 1, volume: 2 }])
    expect(csv).toBe('ts,price,volume\n"2025-03-01T00:00:00.000Z, ""v""",1,2\n')
  })

  it('rejects non-finite numbers instead of emitting NaN/Infinity', () => {
    expect(() => historyToCsv([{ ts: '2025-03-01T00:00:00.000Z', price: NaN, volume: 1 }])).toThrow(/non-finite/)
    expect(() => historyToCsv([{ ts: '2025-03-01T00:00:00.000Z', price: 1, volume: Infinity }])).toThrow(/non-finite/)
  })
})

describe('GET /prices/history?format=csv', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    mockQuery.mockReset()
    app = await buildApp()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('serves the golden CSV body with a text/csv content type', async () => {
    mockQuery.mockResolvedValue({ rows: rowsFor(points5m) })

    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC&interval=5m&format=csv',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body).toBe(golden('historical-5m.csv'))
  })

  it('returns the header-only golden file when there are no rows', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC&format=csv',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(golden('historical-empty.csv'))
  })

  it('answers the same bytes for repeated requests', async () => {
    mockQuery.mockResolvedValue({ rows: rowsFor(points1h) })
    const url = '/prices/history?pair=XLM/USDC&interval=1h&format=csv'

    const first = await app.inject({ method: 'GET', url })
    const second = await app.inject({ method: 'GET', url })

    expect(first.body).toBe(second.body)
    expect(first.body).toBe(golden('historical-1h.csv'))
  })

  it('rejects an unknown format without touching the database', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/prices/history?pair=XLM/USDC&format=xml',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/format must be one of/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('keeps JSON as the default when format is omitted', async () => {
    mockQuery.mockResolvedValue({ rows: rowsFor(points1m) })

    const res = await app.inject({ method: 'GET', url: '/prices/history?pair=XLM/USDC' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json().points).toEqual(points1m)
    expect(res.json().count).toBe(points1m.length)
  })
})
