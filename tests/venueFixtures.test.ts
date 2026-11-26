/**
 * The fixture layer itself (#226): the network guard, the fixture format, and
 * replay through both transports the adapters use.
 *
 * The inline fixtures in this file exercise the *helper* and are labelled as
 * synthetic; they are never used to assert anything about a venue. Venue
 * behaviour is pinned by the captured files under tests/fixtures/venues.
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { Account, Contract, Networks, TransactionBuilder, BASE_FEE, Keypair, rpc as SorobanRpc, Horizon } from '@stellar/stellar-sdk'
import {
  installNetworkGuard,
  isNetworkGuardInstalled,
  takeNetworkViolations,
  isLoopbackHost,
  NetworkAccessError,
} from './support/networkGuard'
import {
  installFixtureTransport,
  listVenueFixtureFiles,
  loadVenueFixture,
  requestKey,
  runAdapterAgainstFixtures,
  validateVenueFixture,
  withVenueFixtures,
  FixtureFormatError,
  UnrecordedRequestError,
  VENUE_FIXTURE_DIR,
  type VenueFixture,
} from './support/venueFixtures'
import type { VenueAdapter } from '../src/ingest/venues/types'

function synthetic(exchanges: VenueFixture['exchanges'], network: 'mainnet' | 'testnet' = 'mainnet'): VenueFixture {
  return {
    venue: 'synthetic',
    network,
    capturedAt: '2026-01-01T00:00:00.000Z',
    sourceUrl: 'https://venue.invalid/api',
    description: 'SYNTHETIC - exercises the fixture helper only',
    exchanges,
  }
}

function getExchange(url: string, body: unknown, status = 200) {
  return { key: requestKey('GET', url), request: { method: 'GET', url }, response: { status, body } }
}

describe('network guard', () => {
  it('is installed for every test file by vitest.setup.ts', () => {
    expect(isNetworkGuardInstalled()).toBe(true)
  })

  it('fails a non-loopback connection immediately and records it', async () => {
    const started = Date.now()
    const err = await new Promise<Error>((resolve) => {
      const req = https.get('https://example.com/', () => resolve(new Error('connected')))
      req.on('error', resolve)
    })
    expect(err).toBeInstanceOf(NetworkAccessError)
    expect(err.message).toContain('example.com')
    // Fails, not slow: no DNS lookup, no timeout.
    expect(Date.now() - started).toBeLessThan(1_000)

    const attempts = takeNetworkViolations()
    expect(attempts.map((a) => a.target)).toEqual(['example.com:443'])
  })

  it('blocks the global fetch the adapters use', async () => {
    await expect(fetch('https://horizon.stellar.org/')).rejects.toThrow()
    expect(takeNetworkViolations().map((a) => a.target)).toEqual(['horizon.stellar.org:443'])
  })

  it('leaves loopback alone (local Postgres, Redis, test servers)', async () => {
    const server = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as { port: number }
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(await res.text()).toBe('ok')
    await new Promise((r) => server.close(r))
    expect(takeNetworkViolations()).toEqual([])
  })

  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('mainnet.sorobanrpc.com')).toBe(false)
    expect(isLoopbackHost('10.0.0.1')).toBe(false)
  })

  it('re-installing is a no-op', () => {
    installNetworkGuard()
    expect(isNetworkGuardInstalled()).toBe(true)
  })
})

describe('fixture format', () => {
  const good = synthetic([getExchange('https://venue.invalid/api?x=1', { ok: true })])

  it('accepts a fixture that records where and when it was captured', () => {
    expect(validateVenueFixture(good)).toBe(good)
  })

  it.each([
    ['capturedAt', { capturedAt: 'yesterday' }],
    ['sourceUrl', { sourceUrl: '' }],
    ['network', { network: 'futurenet' }],
    ['description', { description: '' }],
    ['exchanges', { exchanges: [] }],
  ])('rejects a fixture with a bad %s', (_field, patch) => {
    expect(() => validateVenueFixture({ ...good, ...patch })).toThrow(FixtureFormatError)
  })

  it('rejects an exchange whose key does not match its request', () => {
    const tampered = synthetic([{ ...getExchange('https://venue.invalid/a', {}), key: 'GET https://venue.invalid/b' }])
    expect(() => validateVenueFixture(tampered)).toThrow(/key does not match/)
  })
})

describe('captured venue fixtures', () => {
  const files = listVenueFixtureFiles()

  // Venues whose capture could not be made, each with the reason. Not a skip
  // list: the test below fails if one of these gains a fixture without being
  // removed from here, and tests/fixtures/venues/README.md must explain each.
  const NOT_YET_RECORDED: Record<string, string> = {
    aquarius: 'configured API host amm.aquarius.network does not resolve (public DNS SERVFAIL)',
    kucoin: 'api.kucoin.com reset the TLS connection from the capture environment',
  }

  it('exist for every venue adapter except the documented unrecorded ones', () => {
    const venues = new Set(files.map((f) => f.venue))
    for (const v of ['aquarius', 'amm', 'sdex', 'soroswap', 'phoenix', 'defindex', 'blend', 'kucoin', 'gateio']) {
      if (v in NOT_YET_RECORDED) {
        expect(venues, `${v} now has a fixture: remove it from NOT_YET_RECORDED`).not.toContain(v)
      } else {
        expect(venues, `no fixture captured for ${v}`).toContain(v)
      }
    }
  })

  it('documents why each unrecorded venue has no fixture', () => {
    const readme = fs.readFileSync(path.join(VENUE_FIXTURE_DIR, 'README.md'), 'utf8')
    for (const v of Object.keys(NOT_YET_RECORDED)) {
      expect(readme).toMatch(new RegExp(`\\| ${v} \\| \\*\\*not recorded\\*\\*`))
    }
  })

  it.each(files.map((f) => [`${f.venue}/${f.name}`, f] as const))('%s records its source and capture time', (_label, f) => {
    const fixture = loadVenueFixture(f.venue, f.name)
    expect(Date.parse(fixture.capturedAt)).toBeLessThanOrEqual(Date.now())
    expect(fixture.sourceUrl).toBe(fixture.exchanges[0].request.url)
  })
})

describe('request keys', () => {
  const contract = 'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI'

  function envelope() {
    return new TransactionBuilder(new Account(Keypair.random().publicKey(), '0'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(new Contract(contract).call('query_pools'))
      .setTimeout(30)
      .build()
      .toXDR()
  }

  it('keys a simulateTransaction by the contract call, not the clock-dependent envelope', () => {
    const a = { jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: { transaction: envelope() } }
    const b = { jsonrpc: '2.0', id: 7, method: 'simulateTransaction', params: { transaction: envelope() } }
    expect(a.params.transaction).not.toBe(b.params.transaction)
    expect(requestKey('POST', 'https://rpc.invalid', a)).toBe(requestKey('POST', 'https://rpc.invalid', b))
    expect(requestKey('POST', 'https://rpc.invalid', a)).toContain(`${contract}.query_pools()`)
  })

  it('keeps the origin, so a mainnet capture cannot answer a testnet request', () => {
    expect(requestKey('GET', 'https://horizon.stellar.org/x')).not.toBe(
      requestKey('GET', 'https://horizon-testnet.stellar.org/x')
    )
  })
})

describe('fixture transport', () => {
  it('replays recorded responses through global fetch', async () => {
    const url = 'https://venue.invalid/api?pair=XLM'
    await withVenueFixtures(synthetic([getExchange(url, { price: '1.5' })]), async (t) => {
      const res = await fetch(url)
      expect(await res.json()).toEqual({ price: '1.5' })
      expect(t.served).toEqual([`GET ${url}`])
    })
  })

  it('replays non-2xx responses as recorded', async () => {
    const url = 'https://venue.invalid/down'
    await withVenueFixtures(synthetic([getExchange(url, 'bad gateway', 502)]), async () => {
      const res = await fetch(url)
      expect(res.status).toBe(502)
    })
  })

  it('replays through stellar-sdk Horizon and RPC clients', async () => {
    const horizonUrl = 'https://horizon.invalid/fee_stats'
    const rpcUrl = 'https://rpc.invalid/'
    const rpcBody = { jsonrpc: '2.0', id: 1, method: 'getHealth', params: null }
    const fixture = synthetic([
      getExchange(horizonUrl, { last_ledger: '1' }),
      {
        key: requestKey('POST', rpcUrl, rpcBody),
        request: { method: 'POST', url: rpcUrl, body: rpcBody },
        response: { status: 200, body: { jsonrpc: '2.0', id: 1, result: { status: 'healthy' } } },
      },
    ])
    await withVenueFixtures(fixture, async () => {
      const h = await Horizon.AxiosClient.get(horizonUrl)
      expect(h.data).toEqual({ last_ledger: '1' })
      const health = await new SorobanRpc.Server(rpcUrl).getHealth()
      expect(health.status).toBe('healthy')
    })
  })

  it('fails loudly on a request no fixture recorded, even if the caller swallows it', async () => {
    const t = installFixtureTransport(synthetic([getExchange('https://venue.invalid/a', {})]))
    try {
      await expect(fetch('https://venue.invalid/b')).rejects.toBeInstanceOf(UnrecordedRequestError)
    } finally {
      t.restore()
    }
    // The violation is recorded for vitest.setup's afterEach; take it here so
    // this deliberate miss does not fail the test that demonstrates it.
    expect(takeNetworkViolations().map((v) => v.target)).toEqual(['GET https://venue.invalid/b'])
  })

  it('restores the real transport afterwards', async () => {
    const before = globalThis.fetch
    await withVenueFixtures(synthetic([getExchange('https://venue.invalid/a', {})]), async () => {
      expect(globalThis.fetch).not.toBe(before)
    })
    expect(globalThis.fetch).toBe(before)
  })
})

describe('runAdapterAgainstFixtures', () => {
  const url = 'https://venue.invalid/ticker'
  const pair = { pairKey: 'XLM/USDC', assetA: { code: 'XLM', issuer: null }, assetB: { code: 'USDC', issuer: null } } as any

  function stubAdapter(source: string): VenueAdapter<string, { price: string }> {
    return {
      name: 'Synthetic',
      source,
      sourceTimeCapability: { status: 'unavailable' },
      classification: 'primary',
      type: 'Test',
      description: 'synthetic adapter for the helper test',
      isEnabled: () => true,
      getPollIntervalMs: () => 1_000,
      discover: async () => [url],
      read: async (target) => (await fetch(target)).json() as Promise<{ price: string }>,
      derive: (raw) => [
        {
          assetA: 'XLM',
          assetB: 'USDC',
          pairKey: 'XLM/USDC',
          source,
          price: Number(raw.price),
          baseVolume: 0,
          counterVolume: 0,
          ledger: 0,
          observedAt: new Date(),
          sourceTime: null,
        },
      ],
      write: async () => {},
      ingestPair: async () => {},
    }
  }

  it('runs discover -> read -> derive with no network', async () => {
    const run = await runAdapterAgainstFixtures(stubAdapter('synthetic'), {
      pair,
      network: 'mainnet',
      fixtures: synthetic([getExchange(url, { price: '0.25' })]),
    })
    expect(run.points.map((p) => p.price)).toEqual([0.25])
    expect(run.served).toEqual([`GET ${url}`])
  })

  it('refuses to run a mainnet capture as testnet', async () => {
    await expect(
      runAdapterAgainstFixtures(stubAdapter('synthetic'), {
        pair,
        network: 'testnet',
        fixtures: synthetic([getExchange(url, { price: '0.25' })], 'mainnet'),
      })
    ).rejects.toThrow(/blend networks/)
  })

  it('refuses a derived price with no source', async () => {
    await expect(
      runAdapterAgainstFixtures(stubAdapter(''), {
        pair,
        network: 'mainnet',
        fixtures: synthetic([getExchange(url, { price: '0.25' })]),
      })
    ).rejects.toThrow(/no source/)
  })
})
