/**
 * #237 — Nothing stops the same trade being written twice.
 *
 * price_points had no uniqueness on (network, source, event_id): an ingester
 * that retried after a partial failure, or two instances overlapping during a
 * deploy, wrote the same trade again, inflating volume and skewing the
 * volume-weighted VWAP.
 *
 * These tests run `upsertPricePoints` against a fake table that enforces the
 * two constraints Postgres enforces after the #237 migration:
 *
 *   1. the composite primary key (id, timestamp), and
 *   2. the unique index price_point_identity on (network, source, event_id),
 *      which — because Postgres treats NULLs as distinct in a unique index —
 *      can only ever catch rows that actually carry an event id.
 *
 * That second point is why a source with no natural event id must NOT be
 * stored with eventId = null: such a row could never collide with its own
 * replay. `upsertPricePoints` therefore synthesizes a deterministic id from
 * the row's content when the venue does not supply one (see synthesizeEventId
 * in db.ts), and the replay tests below pin that behaviour.
 */
import { readFileSync, existsSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fakeTable, mockCreateMany } = vi.hoisted(() => {
  const table: any[] = []
  let seq = 0

  /** Emulates prisma.pricePoint.createMany under Postgres constraints. */
  const createMany = vi.fn(({ data, skipDuplicates }: any) => {
    let count = 0
    for (const row of data) {
      // prisma fills in the uuid default per row, so every insert attempt
      // carries a fresh `id` unless the caller provided one.
      const id = row.id ?? `gen-${++seq}`
      const timestamp = new Date(row.timestamp)

      const pkClash = table.some(
        r => r.id === id && r.timestamp.getTime() === timestamp.getTime(),
      )
      // Unique index on (network, source, event_id): NULLs are distinct, so a
      // row without an event id can never be recognized as a duplicate.
      const uqClash =
        row.eventId != null &&
        table.some(
          r =>
            r.network === row.network &&
            r.source === row.source &&
            r.eventId === row.eventId,
        )

      if (pkClash || uqClash) {
        if (skipDuplicates) continue
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: 'P2002',
        })
      }
      table.push({ ...row, id, timestamp })
      count++
    }
    return Promise.resolve({ count })
  })

  return { fakeTable: table, mockCreateMany: createMany }
})

vi.mock('pg', () => ({
  Pool: class FakePool {
    query() {
      return Promise.resolve({ rows: [] })
    }
  },
}))

vi.mock('@prisma/client', () => ({
  PrismaClient: class FakePrismaClient {
    pricePoint = { createMany: (args: any) => mockCreateMany(args) }
  },
}))

import { upsertPricePoints } from '../db'

/** A full USDC issuer address, kept whole per the repo convention. */
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

function point(overrides: Record<string, any> = {}) {
  return {
    assetA: 'XLM',
    assetB: 'USDC',
    pairKey: `XLM/USDC:${USDC_ISSUER}`,
    source: 'SDEX',
    poolId: undefined as string | undefined,
    price: 0.123456,
    baseVolume: 100,
    counterVolume: 12.3456789,
    ledger: 64659443,
    timestamp: new Date('2026-10-17T08:00:00.000Z'),
    eventId: '277710193062797312-0',
    ...overrides,
  }
}

/** Rebuild a batch as a retry would: fresh objects, identical field values. */
function retransmit(batch: ReturnType<typeof point>[]) {
  return batch.map(p => ({ ...p, timestamp: new Date(p.timestamp.getTime()) }))
}

beforeEach(() => {
  fakeTable.splice(0, fakeTable.length)
  mockCreateMany.mockClear()
})

describe('replaying a batch never stores the same trade twice (#237)', () => {
  it('absorbs a replay of trades that carry a natural event id', async () => {
    const batch = [point(), point({ eventId: '277710193062797313-0' })]

    expect(await upsertPricePoints(batch, 'testnet')).toBe(2)
    const rowsAfterFirstPass = fakeTable.length

    expect(await upsertPricePoints(retransmit(batch), 'testnet')).toBe(0)
    expect(fakeTable.length).toBe(rowsAfterFirstPass)
  })

  it('absorbs a replay of trades from a source with NO natural event id', async () => {
    // Aquarius-style rows: snapshot venues that have nothing Horizon handed
    // them as an id. A null eventId here would make the replay invisible to
    // the unique index (NULLs are distinct), which is exactly the defect.
    const batch = [
      point({ source: 'aquarius_amm', eventId: undefined }),
      point({ source: 'aquarius_amm', eventId: undefined, price: 0.2 }),
    ]

    expect(await upsertPricePoints(batch, 'testnet')).toBe(2)
    const rowsAfterFirstPass = fakeTable.length

    expect(await upsertPricePoints(retransmit(batch), 'testnet')).toBe(0)
    expect(fakeTable.length).toBe(rowsAfterFirstPass)
  })

  it('absorbs the same batch written by two overlapping ingester instances', async () => {
    // A deploy overlap is just two concurrent writers feeding the same rows
    // from separate processes — same source data, same derived ids.
    const instanceA = [point({ eventId: undefined })]
    const instanceB = [point({ eventId: undefined })]

    await upsertPricePoints(instanceA, 'testnet')
    const rowsAfterFirst = fakeTable.length
    expect(await upsertPricePoints(instanceB, 'testnet')).toBe(0)
    expect(fakeTable.length).toBe(rowsAfterFirst)
  })

  it('writes to different networks independently', async () => {
    // The identity is network-scoped; the same event id on two networks is
    // two legitimately distinct rows (per-network ingesters, #237).
    await upsertPricePoints([point()], 'testnet')
    expect(await upsertPricePoints([point()], 'mainnet')).toBe(1)
    expect(fakeTable.length).toBe(2)
  })

  it('passes skipDuplicates so the batch degrades to ON CONFLICT DO NOTHING', async () => {
    await upsertPricePoints([point()], 'testnet')
    expect(mockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
  })
})

describe('synthesized event ids are deterministic from content, never random', () => {
  it('fills in a non-null eventId when the source does not supply one', async () => {
    await upsertPricePoints([point({ eventId: undefined })], 'testnet')
    expect(fakeTable[0].eventId).toEqual(expect.any(String))
    expect(fakeTable[0].eventId).not.toBe('')
  })

  it('derives the same id for identical content built as separate objects', async () => {
    await upsertPricePoints([point({ eventId: undefined })], 'testnet')
    const first = fakeTable[0].eventId

    await upsertPricePoints(
      [point({ eventId: undefined, timestamp: new Date('2026-10-17T08:00:00.000Z') })],
      'testnet',
    )
    // Deduped, so the stored row still shows the first derivation.
    expect(fakeTable.length).toBe(1)
    expect(fakeTable[0].eventId).toBe(first)
  })

  it('derives different ids when the content genuinely differs', async () => {
    // Distinct observations must not be silently collapsed by the fallback.
    await upsertPricePoints(
      [
        point({ eventId: undefined }),
        point({ eventId: undefined, price: 0.654321 }),
        point({ eventId: undefined, timestamp: new Date('2026-10-17T08:05:00.000Z') }),
      ],
      'testnet',
    )
    expect(fakeTable.length).toBe(3)
    expect(new Set(fakeTable.map(r => r.eventId)).size).toBe(3)
  })

  it('keeps a natural event id unchanged', async () => {
    await upsertPricePoints([point({ eventId: '277710193062797312-0' })], 'testnet')
    expect(fakeTable[0].eventId).toBe('277710193062797312-0')
  })
})

describe('schema and migration', () => {
  const schemaPath = new URL('../../prisma/schema.prisma', import.meta.url)
  const migrationPath = new URL('../../scripts/migrations/2026-10-17-price-point-identity.sql', import.meta.url)

  it('PricePoint declares a unique (network, source, eventId) index', () => {
    const schema = readFileSync(schemaPath, 'utf8')
    const pricePoint = /model PricePoint \{[\s\S]*?\n\}/.exec(schema)?.[0]
    expect(pricePoint).toBeDefined()
    expect(pricePoint).toMatch(
      /@@unique\(\[network, source, eventId\].*map:\s*"price_point_identity"/
    )
  })

  it('the migration removes existing duplicates before creating the index', () => {
    expect(existsSync(migrationPath)).toBe(true)
    const sql = readFileSync(migrationPath, 'utf8')

    const deleteAt = sql.search(/DELETE\s+FROM\s+price_points/i)
    const createAt = sql.search(/CREATE\s+UNIQUE\s+INDEX/i)
    expect(deleteAt).toBeGreaterThanOrEqual(0)
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeLessThan(createAt)

    // Partitioned dedupe that keeps one row per identity — not a blanket delete.
    expect(sql).toMatch(/PARTITION\s+BY\s+network,\s*source,\s*event_id/i)
    expect(sql).toMatch(/price_point_identity/)
  })
})
