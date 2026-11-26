/**
 * Every venue adapter, run against its recorded fixture with no network (#226).
 *
 * Each block replays a real response captured by `npm run fixtures:capture`
 * (tests/fixtures/venues/<venue>/<name>.json, which records where and when it
 * was captured). Expected values are read from the fixture body itself or
 * cross-checked against another venue's capture, never typed in, so a test
 * pins the adapter to what the venue actually sends.
 *
 * The network guard (vitest.setup.ts) fails any test here that tries to reach
 * the network; the fixture transport fails any request no fixture recorded.
 *
 * Aquarius and KuCoin have no recorded fixture yet: see the PR for why (the
 * configured Aquarius API host does not resolve; KuCoin refused the capture
 * connection). Their existing tests replay inline fixtures through the same
 * transport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/db', () => ({
  upsertPricePoints: vi.fn(),
  getIndexerState: vi.fn(async () => ({ cursor: '0', ledger: null })),
}))

import {
  loadVenueFixture,
  requestKey,
  runAdapterAgainstFixtures,
  withVenueFixtures,
  type VenueFixture,
} from './support/venueFixtures'
import { getNetworkConfig } from '../src/config'
import { gateioAdapter } from '../src/ingest/venues/gateio'
import { phoenixAdapter } from '../src/ingest/venues/phoenix'
import { defindexAdapter } from '../src/ingest/venues/defindex'
import { blendAdapter } from '../src/ingest/venues/blend'
import { sdexAdapter } from '../src/ingest/venues/sdex'
import { fetchPools } from '../src/ingest/venues/amm'
import { fetchPoolsFromFactory, fetchPoolReserves, fetchTokenDecimals } from '../src/ingest/venues/soroswap'

// Circle's USDC issuer on mainnet (same constant as scripts/capture-venue-fixtures.ts).
const CIRCLE_USDC_MAINNET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const xlmUsdcMainnet = {
  pairKey: `XLM/USDC:${CIRCLE_USDC_MAINNET}`,
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: CIRCLE_USDC_MAINNET },
} as any
const xlmUsdt = { pairKey: 'XLM/USDT', assetA: { code: 'XLM', issuer: null }, assetB: { code: 'USDT', issuer: null } } as any

/** Gate.io's recorded XLM/USDT last price: an independent market to cross-check XLM/USDC pools against. */
function gateioLast(): number {
  const body = loadVenueFixture('gateio', 'xlm-usdt').exchanges[0].response.body as Array<{ last: string }>
  return Number(body[0].last)
}

function expectNear(actual: number, reference: number, tolerance = 0.05) {
  expect(Math.abs(actual - reference) / reference).toBeLessThan(tolerance)
}

describe('recorded venue fixtures', () => {
  beforeEach(() => {
    vi.stubEnv('GATEIO_API_KEY', 'fixture-replay')
    vi.stubEnv('GATEIO_API_SECRET', 'fixture-replay')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('Gate.io: derives the ticker last price as recorded, sourced to Gate.io', async () => {
    const run = await runAdapterAgainstFixtures(gateioAdapter as any, {
      pair: xlmUsdt,
      network: 'mainnet',
      fixtures: loadVenueFixture('gateio', 'xlm-usdt'),
    })
    expect(run.points).toHaveLength(1)
    expect(run.points[0]).toMatchObject({ source: 'Gate.io', pairKey: 'XLM/USDT', price: gateioLast() })
  })

  it('Horizon AMM: returns only the XLM/USDC (Circle) pool, priced in line with the market', async () => {
    const result = await withVenueFixtures(loadVenueFixture('amm', 'xlm-usdc-mainnet'), () =>
      fetchPools(xlmUsdcMainnet, 'mainnet')
    )
    if (!result.ok) throw result.error
    expect(result.data.length).toBeGreaterThan(0)
    for (const pool of result.data) {
      expect(pool.reserves.map((r: any) => r.asset).sort()).toEqual([`USDC:${CIRCLE_USDC_MAINNET}`, 'native'])
    }
    const pool = result.data[0]
    const xlm = Number(pool.reserves.find((r: any) => r.asset === 'native').amount)
    const usdc = Number(pool.reserves.find((r: any) => r.asset !== 'native').amount)
    expectNear(usdc / xlm, gateioLast())
  })

  it('Horizon AMM: drops a pool whose reserves are not the pair, even if Horizon returns it', async () => {
    // SYNTHETIC: the recorded response with one unrelated pool spliced in, to
    // pin the defensive filter. Horizon ignoring the filter is what the first
    // capture of this venue actually showed.
    const real = loadVenueFixture('amm', 'xlm-usdc-mainnet')
    const body = structuredClone(real.exchanges[0].response.body) as any
    body._embedded.records.push({
      id: 'synthetic-unrelated-pool',
      reserves: [
        { asset: 'native', amount: '1.0000000' },
        { asset: 'OTHER:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '1000000.0000000' },
      ],
    })
    const fixture: VenueFixture = {
      ...real,
      description: 'SYNTHETIC - recorded AMM response plus one unrelated pool',
      exchanges: [{ ...real.exchanges[0], response: { ...real.exchanges[0].response, body } }],
    }
    const result = await withVenueFixtures(fixture, () => fetchPools(xlmUsdcMainnet, 'mainnet'))
    if (!result.ok) throw result.error
    expect(result.data.map((p: any) => p.id)).not.toContain('synthetic-unrelated-pool')
  })

  it('SDEX: turns every recorded trade into a price point at the trade price, sourced to SDEX', async () => {
    const fixture = loadVenueFixture('sdex', 'xlm-usdc-mainnet')
    const records = (fixture.exchanges[0].response.body as any)._embedded.records as Array<{
      price: { n: string; d: string }
    }>
    const run = await runAdapterAgainstFixtures(sdexAdapter as any, {
      pair: xlmUsdcMainnet,
      network: 'mainnet',
      fixtures: fixture,
    })
    expect(run.points.length).toBe(records.length)
    run.points.forEach((p, i) => {
      expect(p.source).toBe('SDEX')
      expect(p.pairKey).toBe(xlmUsdcMainnet.pairKey)
      expect(p.price).toBeCloseTo(Number(records[i].price.n) / Number(records[i].price.d), 9)
    })
  })

  it('Soroswap: finds the XLM/USDC pair via get_pair and reads reserves in line with the market', async () => {
    const net = getNetworkConfig('mainnet')
    const fixture = loadVenueFixture('soroswap', 'xlm-usdc-mainnet')
    // Token contracts as the capture resolved them: Circle USDC from Soroswap's
    // published token list, native XLM derived by the SDK (the list has no XLM entry).
    const { Asset, Networks } = await import('@stellar/stellar-sdk')
    const xlmSac = Asset.native().contractId(Networks.PUBLIC)
    const usdcSac = new Asset('USDC', CIRCLE_USDC_MAINNET).contractId(Networks.PUBLIC)

    const out = await withVenueFixtures(fixture, async () => {
      const pools = await fetchPoolsFromFactory(net.soroswap.factoryAddress, xlmSac, usdcSac, 'mainnet')
      const reserves = await fetchPoolReserves(pools[0], 'mainnet')
      const decimals = [await fetchTokenDecimals(xlmSac, 'mainnet'), await fetchTokenDecimals(usdcSac, 'mainnet')]
      return { pools, reserves, decimals }
    })

    expect(out.pools).toHaveLength(1)
    expect(out.decimals).toEqual([7, 7])
    expect(out.reserves).not.toBeNull()
    // A Soroswap pair orders tokens by address: XLM's SAC sorts before USDC's.
    expect(xlmSac < usdcSac).toBe(true)
    const [xlm, usdc] = out.reserves!
    expectNear(Number(usdc) / Number(xlm), gateioLast())
  })

  it('Phoenix: derives one price per discovered pool, sourced to phoenix_amm', async () => {
    const run = await runAdapterAgainstFixtures(phoenixAdapter as any, {
      pair: xlmUsdcMainnet,
      network: 'mainnet',
      fixtures: loadVenueFixture('phoenix', 'xlm-usdc-mainnet'),
    })
    expect(run.targets.length).toBeGreaterThan(0)
    expect(run.points).toHaveLength(run.targets.length)
    for (const p of run.points) {
      expect(p).toMatchObject({ source: 'phoenix_amm', pairKey: xlmUsdcMainnet.pairKey })
      expect(Number.isFinite(p.price) && p.price > 0).toBe(true)
    }
    // At least one Phoenix pool trades with the market. (Others may not: the
    // recorded mainnet response includes a pool far off it, which is exactly
    // why every point carries its poolId.)
    expect(run.points.some((p) => Math.abs(p.price - gateioLast()) / gateioLast() < 0.05)).toBe(true)
    expect(new Set(run.points.map((p) => p.poolId)).size).toBe(run.points.length)
  })

  it('DeFindex: enumerates the factory vaults and reads each one from the recording', async () => {
    const run = await runAdapterAgainstFixtures(defindexAdapter as any, {
      pair: xlmUsdcMainnet,
      network: 'mainnet',
      fixtures: loadVenueFixture('defindex', 'vaults-mainnet'),
    })
    expect(run.targets.length).toBeGreaterThan(0)
    expect(run.raws.filter((r) => r !== null).length).toBeGreaterThan(0)
    for (const p of run.points) expect(p.source).toBe(defindexAdapter.source)
  })

  it('Blend: reads the configured pools from the recording', async () => {
    const run = await runAdapterAgainstFixtures(blendAdapter as any, {
      pair: xlmUsdcMainnet,
      network: 'mainnet',
      fixtures: loadVenueFixture('blend', 'pools-mainnet'),
    })
    expect(run.targets.length).toBeGreaterThan(0)
    expect(run.raws.every((r) => r !== null)).toBe(true)
  })

  it('refuses to replay a mainnet recording for a testnet run', async () => {
    await expect(
      runAdapterAgainstFixtures(gateioAdapter as any, {
        pair: xlmUsdt,
        network: 'testnet',
        fixtures: loadVenueFixture('gateio', 'xlm-usdt'),
      })
    ).rejects.toThrow(/captured on mainnet/)
  })

  it('keys every recorded exchange by the request it answers', () => {
    for (const [venue, name] of [
      ['amm', 'xlm-usdc-mainnet'],
      ['sdex', 'xlm-usdc-mainnet'],
      ['soroswap', 'xlm-usdc-mainnet'],
      ['phoenix', 'xlm-usdc-mainnet'],
      ['defindex', 'vaults-mainnet'],
      ['blend', 'pools-mainnet'],
      ['gateio', 'xlm-usdt'],
    ]) {
      const f = loadVenueFixture(venue, name)
      expect(f.network).toBe('mainnet')
      expect(Number.isNaN(Date.parse(f.capturedAt))).toBe(false)
      expect(f.sourceUrl).toMatch(/^https:\/\//)
      for (const ex of f.exchanges) {
        expect(ex.key).toBe(requestKey(ex.request.method, ex.request.url, ex.request.body))
      }
    }
  })
})
