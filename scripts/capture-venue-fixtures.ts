/**
 * Capture real venue responses as test fixtures (#226).
 *
 *   npm run fixtures:capture                 # every venue
 *   npm run fixtures:capture -- aquarius sdex  # just these
 *
 * Each capture runs the adapter's own read path against the live venue, with a
 * recording transport in front of `fetch` and stellar-sdk's axios clients, and
 * writes tests/fixtures/venues/<venue>/<name>.json containing every request the
 * adapter made, the response the venue sent, the network, the capture time and
 * the source URL. Tests replay those files through tests/support/venueFixtures.ts.
 *
 * Because capture and replay derive the match key with the same `requestKey`,
 * a fixture recorded here is guaranteed to answer the same adapter code in a
 * test. If an adapter changes what it asks for, its test fails with an
 * "unrecorded request" error and the remedy is to re-run this script.
 *
 * Nothing here invents a value: every contract id, issuer and URL comes from
 * src/config.ts defaults (themselves taken from each protocol's published
 * deployments). A capture that the venue refuses is written as the refusal it
 * got, and reported, rather than replaced with something plausible.
 *
 * Credentials: Gate.io and KuCoin adapters only run when a key is configured,
 * but the endpoints they call are public market data. When no key is set the
 * script supplies a placeholder so the adapter runs; request headers are never
 * written to a fixture.
 */
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import { Horizon, rpc as SorobanRpc, Asset, Networks } from '@stellar/stellar-sdk'
import { requestKey, buildAxiosUrl, VENUE_FIXTURE_DIR, type RecordedExchange, type VenueFixture } from '../tests/support/venueFixtures'

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'
process.env.KUCOIN_API_KEY = process.env.KUCOIN_API_KEY || 'fixture-capture'
process.env.KUCOIN_API_SECRET = process.env.KUCOIN_API_SECRET || 'fixture-capture'
process.env.GATEIO_API_KEY = process.env.GATEIO_API_KEY || 'fixture-capture'
process.env.GATEIO_API_SECRET = process.env.GATEIO_API_SECRET || 'fixture-capture'

// Capture reads; it never writes. The adapters import src/db for their write
// side, and src/db constructs a PrismaClient at import - which needs a generated
// client and a query engine. Stand a stub in its place so capturing a venue
// response does not depend on Prisma or a database. Any write reaching it is a
// bug in a capture plan, so it throws.
{
  const dbPath = require.resolve('../src/db')
  const refuse = (name: string) => () => {
    throw new Error(`capture-venue-fixtures: ${name} called - captures must not write`)
  }
  const stub: Record<string, unknown> = new Proxy(
    { getIndexerState: async () => ({ cursor: '0', ledger: null }) },
    { get: (target: any, prop: string) => (prop in target ? target[prop] : prop === '__esModule' ? true : refuse(prop)) }
  )
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub } as any
}

// ── Recording transport ──────────────────────────────────────────────────────

let recorded: RecordedExchange[] = []

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function installRecorder(): void {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? parseBody(init.body) : undefined
    const res = await realFetch(input, init)
    const text = await res.clone().text()
    recorded.push({
      key: requestKey(method, url, body),
      request: { method, url, ...(body === undefined ? {} : { body }) },
      response: { status: res.status, body: parseBody(text) },
    })
    return res
  }) as typeof fetch

  for (const client of [SorobanRpc.AxiosClient, Horizon.AxiosClient] as any[]) {
    const real = axios.getAdapter(client.defaults.adapter ?? axios.defaults.adapter)
    client.defaults.adapter = async (cfg: any) => {
      const url = buildAxiosUrl(cfg)
      const method = String(cfg.method ?? 'get').toUpperCase()
      const body = cfg.data === undefined ? undefined : typeof cfg.data === 'string' ? parseBody(cfg.data) : cfg.data
      const record = (status: number, data: unknown) =>
        recorded.push({
          key: requestKey(method, url, body),
          request: { method, url, ...(body === undefined ? {} : { body }) },
          response: { status, body: typeof data === 'string' ? parseBody(data) : data },
        })
      try {
        const res = await real(cfg)
        record(res.status, res.data)
        return res
      } catch (err: any) {
        if (err?.response) record(err.response.status, err.response.data)
        throw err
      }
    }
  }
}

// ── Redaction ────────────────────────────────────────────────────────────────

/** Placeholder written in place of a trader's account. Not a valid strkey, so it can never be mistaken for one. */
const REDACTED_ACCOUNT = 'REDACTED_TRADER_ACCOUNT'

const TRADER_ACCOUNT_FIELDS = new Set(['base_account', 'counter_account'])

/**
 * Remove the accounts of the people behind a trade before it is committed.
 * Horizon /trades names both sides' accounts (and links to them); no adapter
 * reads them, and fixtures must not carry real users' wallet addresses.
 * Asset issuers, contract ids and pool ids are protocol data and are kept.
 */
function redactTraderAccounts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTraderAccounts)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (TRADER_ACCOUNT_FIELDS.has(k) && typeof v === 'string') {
      out[k] = REDACTED_ACCOUNT
    } else if ((k === 'base' || k === 'counter') && v && typeof v === 'object' && typeof (v as any).href === 'string' && (v as any).href.includes('/accounts/')) {
      out[k] = { ...(v as object), href: (v as any).href.replace(/\/accounts\/[^/?#]+/, `/accounts/${REDACTED_ACCOUNT}`) }
    } else {
      out[k] = redactTraderAccounts(v)
    }
  }
  return out
}

// ── Capture plans ────────────────────────────────────────────────────────────

interface Capture {
  venue: string
  name: string
  network: 'mainnet' | 'testnet'
  description: string
  run: () => Promise<unknown>
}

// Circle's USDC issuer on mainnet, as published at
// https://developers.circle.com/stablecoins/usdc-contract-addresses
const CIRCLE_USDC_MAINNET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const xlmUsdcMainnet = {
  pairKey: `XLM/USDC:${CIRCLE_USDC_MAINNET}`,
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: CIRCLE_USDC_MAINNET },
} as any

const xlmUsdt = {
  pairKey: 'XLM/USDT',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDT', issuer: null },
} as any

async function plans(): Promise<Capture[]> {
  const { config, getNetworkConfig } = await import('../src/config')
  const { getHorizonServer } = await import('../src/network/clients')
  const { aquariusAdapter } = await import('../src/ingest/venues/aquarius')
  const { fetchPools } = await import('../src/ingest/venues/amm')
  const { fetchPoolsFromFactory, fetchPoolReserves, fetchTokenDecimals } = await import('../src/ingest/venues/soroswap')
  const { phoenixAdapter } = await import('../src/ingest/venues/phoenix')
  const { defindexAdapter } = await import('../src/ingest/venues/defindex')
  const { blendAdapter } = await import('../src/ingest/venues/blend')
  const { kucoinAdapter } = await import('../src/ingest/venues/kucoin')
  const { gateioAdapter } = await import('../src/ingest/venues/gateio')

  const pipeline = (adapter: any, pair: any, network: 'mainnet' | 'testnet') => async () => {
    const targets = await adapter.discover(pair, network)
    for (const t of targets) {
      const raw = await adapter.read(t, pair, network)
      if (raw !== null) await adapter.derive(raw, t, pair, network)
    }
    return targets.length
  }

  return [
    {
      venue: 'aquarius',
      name: 'xlm-usdc-mainnet',
      network: 'mainnet',
      description: 'Aquarius pools for XLM / USDC (Circle) on mainnet, via the Aquarius AMM API.',
      run: pipeline(aquariusAdapter, xlmUsdcMainnet, 'mainnet'),
    },
    {
      venue: 'amm',
      name: 'xlm-usdc-mainnet',
      network: 'mainnet',
      description: 'Horizon liquidity_pools for XLM / USDC (Circle) reserves on mainnet.',
      run: async () => {
        const res = await fetchPools(xlmUsdcMainnet, 'mainnet')
        if (!res.ok) throw res.error
        return res.data.length
      },
    },
    {
      venue: 'sdex',
      name: 'xlm-usdc-mainnet',
      network: 'mainnet',
      description:
        'Horizon /trades for XLM / USDC (Circle) on mainnet from cursor 0, the request fetchSdexTrades makes on a fresh indexer state.',
      run: async () => {
        const res = await getHorizonServer('mainnet')
          .trades()
          .forAssetPair(Asset.native(), new Asset('USDC', CIRCLE_USDC_MAINNET))
          .cursor('0')
          .limit(config.indexer.sdexPageSize)
          .order('asc')
          .call()
        return res.records.length
      },
    },
    {
      venue: 'soroswap',
      name: 'xlm-usdc-mainnet',
      network: 'mainnet',
      description:
        'Soroswap token list, factory get_pools, pool get_reserves and token decimals for XLM / USDC on mainnet (Soroban RPC).',
      // Not via soroswapAdapter.discover: the published token list moved from
      // `tokens[].address` to `assets[].contract`, which the adapter does not
      // read yet (tracked separately), so discovery stops before any RPC call.
      // The token contracts are taken from the list itself, matched on the
      // watched asset's code *and* issuer, so the capture stays a faithful
      // record of what Soroswap publishes.
      //
      // The published list (v1.6.3) has no entry for native XLM. Its Stellar
      // Asset Contract id is not looked up or typed in: it is derived from the
      // protocol (Asset.native().contractId(Networks.PUBLIC)), the same
      // derivation that reproduces the list's own Circle USDC contract.
      run: async () => {
        const net = getNetworkConfig('mainnet')
        const res = await fetch(net.soroswap.tokenListUrl)
        const list = (await res.json()) as { assets?: Array<{ code: string; issuer?: string; contract: string }> }
        const find = (code: string, issuer: string | null) =>
          list.assets?.find((a) => a.code === code && (issuer ? a.issuer === issuer : !a.issuer))?.contract
        const xlm = find('XLM', null) ?? Asset.native().contractId(Networks.PUBLIC)
        const usdc = find('USDC', CIRCLE_USDC_MAINNET)
        if (!usdc) throw new Error('Circle USDC not in the published Soroswap token list')
        if (usdc !== new Asset('USDC', CIRCLE_USDC_MAINNET).contractId(Networks.PUBLIC)) {
          throw new Error('Soroswap token list USDC contract does not match the Circle USDC asset contract')
        }
        const pools = await fetchPoolsFromFactory(net.soroswap.factoryAddress, xlm, usdc, 'mainnet')
        if (pools.length === 0) throw new Error('Soroswap factory returned no XLM/USDC pool')
        for (const pool of pools) await fetchPoolReserves(pool, 'mainnet')
        await fetchTokenDecimals(xlm, 'mainnet')
        await fetchTokenDecimals(usdc, 'mainnet')
        return pools.length
      },
    },
    {
      venue: 'phoenix',
      name: 'xlm-usdc-mainnet',
      network: 'mainnet',
      description: 'Phoenix factory query_pools and pool query_pool_info for XLM / USDC (Circle) on mainnet (Soroban RPC).',
      run: pipeline(phoenixAdapter, xlmUsdcMainnet, 'mainnet'),
    },
    {
      venue: 'defindex',
      name: 'vaults-mainnet',
      network: 'mainnet',
      description: 'DeFindex factory vault enumeration and per-vault share data on mainnet (Soroban RPC).',
      run: pipeline(defindexAdapter, xlmUsdcMainnet, 'mainnet'),
    },
    {
      venue: 'blend',
      name: 'pools-mainnet',
      network: 'mainnet',
      description: 'Blend pool ledger entries (instance, ResList, ResConfig, ResData) for the configured mainnet pools (Soroban RPC).',
      run: pipeline(blendAdapter, xlmUsdcMainnet, 'mainnet'),
    },
    {
      venue: 'kucoin',
      name: 'xlm-usdt',
      network: 'mainnet',
      description: 'KuCoin public level-1 order book (ticker) for XLM-USDT.',
      run: pipeline(kucoinAdapter, xlmUsdt, 'mainnet'),
    },
    {
      venue: 'gateio',
      name: 'xlm-usdt',
      network: 'mainnet',
      description: 'Gate.io public spot ticker for XLM_USDT.',
      run: pipeline(gateioAdapter, xlmUsdt, 'mainnet'),
    },
  ]
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  installRecorder()
  const only = new Set(process.argv.slice(2))
  const all = await plans()
  const selected = only.size ? all.filter((p) => only.has(p.venue)) : all
  let failures = 0

  for (const plan of selected) {
    recorded = []
    const capturedAt = new Date().toISOString()
    try {
      await plan.run()
    } catch (err) {
      // A capture that did not complete would leave a file whose description
      // claims requests that were never made. Write nothing; say why.
      console.error(`✗ ${plan.venue}: ${(err as Error).message}; nothing written`)
      failures++
      continue
    }
    // De-duplicate repeated identical requests (a capture may poll twice) but
    // keep their order: replay serves same-key exchanges in sequence.
    if (recorded.length === 0) {
      console.error(`✗ ${plan.venue}: no request reached the venue; nothing written`)
      failures++
      continue
    }
    const bad = recorded.filter((r) => r.response.status >= 400)
    if (bad.length) {
      console.error(`! ${plan.venue}: venue refused ${bad.length} request(s): ${bad.map((b) => `${b.response.status} ${b.request.url}`).join('; ')}`)
    }
    const fixture: VenueFixture = {
      venue: plan.venue,
      network: plan.network,
      capturedAt,
      sourceUrl: recorded[0].request.url,
      description: plan.description,
      exchanges: recorded.map((ex) => ({ ...ex, response: { ...ex.response, body: redactTraderAccounts(ex.response.body) } })),
    }
    const file = path.join(VENUE_FIXTURE_DIR, plan.venue, `${plan.name}.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n')
    console.log(`✓ ${plan.venue}: ${recorded.length} exchange(s) -> ${path.relative(process.cwd(), file)}`)
  }

  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
