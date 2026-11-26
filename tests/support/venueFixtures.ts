/**
 * Recorded venue fixtures, and a helper that runs an adapter against them with
 * no network (#226).
 *
 * A fixture is a real response, captured by `npm run fixtures:capture`
 * (scripts/capture-venue-fixtures.ts) and saved under
 * tests/fixtures/venues/<venue>/<name>.json together with where and when it was
 * captured. Replaying it here serves the exact bytes the venue sent, so a test
 * pins the adapter to the venue's real shape instead of a shape someone typed.
 *
 * Replay happens at the HTTP layer the adapters actually use:
 *   - `globalThis.fetch`  - fetchWithTimeout callers (Aquarius, Gate.io,
 *     KuCoin, Horizon AMM, the Soroswap token list);
 *   - stellar-sdk's axios clients (`rpc.AxiosClient`, `Horizon.AxiosClient`) -
 *     Soroban RPC and Horizon `Server` calls (Soroswap, Phoenix, Blend,
 *     DeFindex, SDEX).
 * Adapters therefore run unmodified, through their real parsing code.
 *
 * A request no fixture answers is not a soft miss: it throws, and it is recorded
 * with the network guard so the test fails even when the adapter swallows the
 * error and degrades (which most do, by design).
 */
import fs from 'node:fs'
import path from 'node:path'
import { Horizon, rpc as SorobanRpc, xdr, StrKey } from '@stellar/stellar-sdk'
import type { NetworkName } from '../../src/config'
import type { WatchedPair } from '../../src/types'
import type { VenueAdapter, VenuePricePoint } from '../../src/ingest/venues/types'
import { NetworkAccessError, recordNetworkViolation } from './networkGuard'

export const VENUE_FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'venues')

// ── Fixture file format ──────────────────────────────────────────────────────

export interface RecordedRequest {
  method: string
  url: string
  /** Request body as sent, for POSTs (JSON-RPC). */
  body?: unknown
}

export interface RecordedResponse {
  status: number
  headers?: Record<string, string>
  /** Parsed JSON body, or a string for a non-JSON body. */
  body: unknown
}

export interface RecordedExchange {
  /** Stable match key - see `requestKey`. Re-derivable from `request`. */
  key: string
  request: RecordedRequest
  response: RecordedResponse
}

export interface VenueFixture {
  /** Directory name under tests/fixtures/venues, e.g. 'aquarius'. */
  venue: string
  /** Network the response was read from. A mainnet capture never answers a testnet test. */
  network: NetworkName
  /** ISO-8601 instant the response was captured. */
  capturedAt: string
  /** The URL the venue answered on (the first request of the capture). */
  sourceUrl: string
  /** What the capture asked for, in a sentence. */
  description: string
  exchanges: RecordedExchange[]
}

export class FixtureFormatError extends Error {
  constructor(file: string, problem: string) {
    super(`Invalid venue fixture ${file}: ${problem}`)
    this.name = 'FixtureFormatError'
  }
}

const NETWORKS = new Set(['mainnet', 'testnet'])

/** Reject a fixture that does not say where and when it came from. */
export function validateVenueFixture(fixture: unknown, file = '<inline>'): VenueFixture {
  const f = fixture as Partial<VenueFixture>
  if (!f || typeof f !== 'object') throw new FixtureFormatError(file, 'not an object')
  if (typeof f.venue !== 'string' || f.venue === '') throw new FixtureFormatError(file, 'missing venue')
  if (typeof f.network !== 'string' || !NETWORKS.has(f.network)) {
    throw new FixtureFormatError(file, `network must be mainnet or testnet, got ${String(f.network)}`)
  }
  if (typeof f.capturedAt !== 'string' || Number.isNaN(Date.parse(f.capturedAt))) {
    throw new FixtureFormatError(file, 'capturedAt must be an ISO-8601 timestamp')
  }
  if (typeof f.sourceUrl !== 'string' || !/^https?:\/\//.test(f.sourceUrl)) {
    throw new FixtureFormatError(file, 'sourceUrl must be the http(s) URL the response came from')
  }
  if (typeof f.description !== 'string' || f.description === '') {
    throw new FixtureFormatError(file, 'missing description')
  }
  if (!Array.isArray(f.exchanges) || f.exchanges.length === 0) {
    throw new FixtureFormatError(file, 'no recorded exchanges')
  }
  for (const [i, ex] of f.exchanges.entries()) {
    if (!ex?.request?.url || !ex.request.method) throw new FixtureFormatError(file, `exchange ${i} has no request`)
    if (typeof ex.response?.status !== 'number') throw new FixtureFormatError(file, `exchange ${i} has no response status`)
    const derived = requestKey(ex.request.method, ex.request.url, ex.request.body)
    if (ex.key !== derived) {
      throw new FixtureFormatError(file, `exchange ${i} key does not match its request (expected ${derived})`)
    }
  }
  return f as VenueFixture
}

/** Load tests/fixtures/venues/<venue>/<name>.json and check its provenance. */
export function loadVenueFixture(venue: string, name: string): VenueFixture {
  const file = path.join(VENUE_FIXTURE_DIR, venue, `${name}.json`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const fixture = validateVenueFixture(raw, path.relative(process.cwd(), file))
  if (fixture.venue !== venue) {
    throw new FixtureFormatError(file, `venue field '${fixture.venue}' does not match directory '${venue}'`)
  }
  return fixture
}

/** Every fixture file on disk, as [relative path, parsed JSON]. */
export function listVenueFixtureFiles(): Array<{ venue: string; name: string; file: string }> {
  if (!fs.existsSync(VENUE_FIXTURE_DIR)) return []
  return fs
    .readdirSync(VENUE_FIXTURE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      fs
        .readdirSync(path.join(VENUE_FIXTURE_DIR, d.name))
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ venue: d.name, name: f.replace(/\.json$/, ''), file: path.join(VENUE_FIXTURE_DIR, d.name, f) }))
    )
}

// ── Request matching ─────────────────────────────────────────────────────────

/**
 * The key a request is recorded and replayed under.
 *
 * GETs match on method + full URL, origin included: a mainnet capture must not
 * answer a request sent to a testnet host - that is precisely the cross-network
 * blend the `network` column exists to prevent.
 *
 * JSON-RPC POSTs match on URL + method + what was asked, not on the raw body:
 * a `simulateTransaction` envelope carries time bounds derived from the clock
 * (`setTimeout(30)`) and the JSON-RPC id is a counter, so the raw body differs
 * on every run. What the venue answered depends only on the contract call, so
 * that is the key: `contract.fn(args-xdr)`.
 */
export function requestKey(method: string, url: string, body?: unknown): string {
  const m = method.toUpperCase()
  if (m === 'GET' || body === undefined || body === null) return `${m} ${url}`

  const parsed = typeof body === 'string' ? safeJson(body) : body
  const rpc = parsed as { jsonrpc?: string; method?: string; params?: any } | undefined
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return `${m} ${url} ${typeof body === 'string' ? body : JSON.stringify(body)}`
  }
  return `${m} ${url} rpc:${rpc.method} ${rpcParamsKey(rpc.method, rpc.params)}`
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

function rpcParamsKey(method: string, params: any): string {
  if (method === 'simulateTransaction') {
    const envelope: string | undefined = params?.transaction
    if (!envelope) return JSON.stringify(params ?? null)
    return describeInvocation(envelope)
  }
  if (method === 'getLedgerEntries') {
    const keys: string[] = Array.isArray(params?.keys) ? [...params.keys] : []
    return keys.sort().join(',')
  }
  return JSON.stringify(params ?? null)
}

/** `CONTRACT.fn(arg-xdr,...)` for the single invokeContract op in an envelope. */
function describeInvocation(envelopeXdr: string): string {
  try {
    const env = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64')
    const tx = env.switch() === xdr.EnvelopeType.envelopeTypeTx() ? env.v1().tx() : null
    const op = tx?.operations()[0]
    const hostFn = op?.body().invokeHostFunctionOp().hostFunction()
    const invoke = hostFn?.invokeContract()
    if (!invoke) return envelopeXdr
    const contract = StrKey.encodeContract(invoke.contractAddress().contractId() as unknown as Buffer)
    const fn = invoke.functionName().toString()
    const args = invoke.args().map((a) => a.toXDR('base64')).join(',')
    return `${contract}.${fn}(${args})`
  } catch {
    return envelopeXdr
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

export class UnrecordedRequestError extends NetworkAccessError {
  readonly key: string

  constructor(key: string, fixtureNames: string[]) {
    super(
      key,
      `no fixture recorded this request; loaded: ${fixtureNames.join(', ') || 'none'}. ` +
        'Re-capture if the adapter now asks for something new'
    )
    this.name = 'UnrecordedRequestError'
    this.key = key
  }
}

export interface FixtureTransport {
  /** Every request served, in order, by key. */
  readonly served: string[]
  /** Recorded exchanges nothing asked for - a sign the capture is stale. */
  unused(): string[]
  restore(): void
}

type AxiosLike = { defaults: { adapter?: unknown } }

function sdkAxiosClients(): AxiosLike[] {
  return [SorobanRpc.AxiosClient as unknown as AxiosLike, Horizon.AxiosClient as unknown as AxiosLike]
}

/**
 * Serve `fixtures` to every HTTP request the process makes until `restore()`.
 *
 * Exchanges with the same key replay in recorded order and the last one
 * repeats, so a venue polled twice in a test sees the same answer twice rather
 * than a miss.
 */
export function installFixtureTransport(fixtures: VenueFixture | VenueFixture[]): FixtureTransport {
  const list = Array.isArray(fixtures) ? fixtures : [fixtures]
  const byKey = new Map<string, RecordedExchange[]>()
  for (const f of list) {
    for (const ex of f.exchanges) {
      const bucket = byKey.get(ex.key) ?? []
      bucket.push(ex)
      byKey.set(ex.key, bucket)
    }
  }
  const cursor = new Map<string, number>()
  const served: string[] = []
  const names = list.map((f) => `${f.venue}/${f.network}`)

  function answer(method: string, url: string, body: unknown): RecordedResponse {
    const key = requestKey(method, url, body)
    const bucket = byKey.get(key)
    if (!bucket) {
      const err = new UnrecordedRequestError(key, names)
      recordNetworkViolation(err)
      throw err
    }
    const i = cursor.get(key) ?? 0
    cursor.set(key, Math.min(i + 1, bucket.length - 1))
    served.push(key)
    return bucket[i].response
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    init?.signal?.throwIfAborted()
    const body = typeof init?.body === 'string' ? init.body : undefined
    const res = answer(method, url, body)
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
    return new Response(text, {
      status: res.status,
      headers: { 'content-type': 'application/json', ...(res.headers ?? {}) },
    })
  }) as typeof fetch

  const clients = sdkAxiosClients()
  const originalAdapters = clients.map((c) => c.defaults.adapter)
  for (const client of clients) {
    client.defaults.adapter = async (cfg: any) => {
      const url = buildAxiosUrl(cfg)
      const body = cfg.data === undefined ? undefined : typeof cfg.data === 'string' ? safeJson(cfg.data) ?? cfg.data : cfg.data
      const res = answer(cfg.method ?? 'get', url, body)
      const response = {
        data: res.body,
        status: res.status,
        statusText: String(res.status),
        headers: { ...(res.headers ?? {}) },
        config: cfg,
        request: {},
      }
      const ok = typeof cfg.validateStatus === 'function' ? cfg.validateStatus(res.status) : res.status < 300
      if (!ok) {
        const err: any = new Error(`Request failed with status code ${res.status}`)
        err.response = response
        err.config = cfg
        err.isAxiosError = true
        throw err
      }
      return response
    }
  }

  return {
    served,
    unused() {
      return [...byKey.keys()].filter((k) => !served.includes(k))
    },
    restore() {
      globalThis.fetch = originalFetch
      clients.forEach((c, i) => {
        c.defaults.adapter = originalAdapters[i]
      })
    },
  }
}

/** The absolute URL an axios config resolves to, query string included. */
export function buildAxiosUrl(cfg: { url?: string; baseURL?: string; params?: Record<string, unknown> }): string {
  const u = new URL(cfg.url ?? '', cfg.baseURL)
  if (cfg.params) {
    for (const [k, v] of Object.entries(cfg.params)) {
      if (v !== undefined && v !== null) u.searchParams.append(k, String(v))
    }
  }
  return u.toString()
}

/** Run `fn` with `fixtures` installed, restoring the real transport afterwards. */
export async function withVenueFixtures<T>(
  fixtures: VenueFixture | VenueFixture[],
  fn: (transport: FixtureTransport) => Promise<T>
): Promise<T> {
  const transport = installFixtureTransport(fixtures)
  try {
    return await fn(transport)
  } finally {
    transport.restore()
  }
}

// ── Running an adapter ───────────────────────────────────────────────────────

export interface AdapterFixtureRun<TTarget, TRaw> {
  targets: TTarget[]
  /** One entry per target, `null` where the adapter read nothing. */
  raws: Array<TRaw | null>
  points: VenuePricePoint[]
  /** Request keys served, in order. */
  served: string[]
}

export interface RunAdapterOptions {
  pair: WatchedPair
  network: NetworkName
  fixtures: VenueFixture | VenueFixture[]
}

/**
 * Run an adapter's discover -> read -> derive pipeline against fixtures.
 *
 * Nothing is written: `write` is the adapter's DB side and is the caller's to
 * exercise (with `../db` mocked) if the test is about persistence. Fails loudly
 * when:
 *   - a fixture was captured on a different network than the run asks for;
 *   - the adapter makes a request no fixture recorded;
 *   - a derived point carries no `source` (a price that cannot say where it
 *     came from must not reach price_points).
 */
export async function runAdapterAgainstFixtures<TTarget, TRaw>(
  adapter: VenueAdapter<TTarget, TRaw>,
  { pair, network, fixtures }: RunAdapterOptions
): Promise<AdapterFixtureRun<TTarget, TRaw>> {
  const list = Array.isArray(fixtures) ? fixtures : [fixtures]
  for (const f of list) {
    if (f.network !== network) {
      throw new Error(
        `Fixture ${f.venue} was captured on ${f.network}; running ${adapter.name} on ${network} against it ` +
          'would blend networks. Capture a fixture for this network.'
      )
    }
  }

  return withVenueFixtures(list, async (transport) => {
    const targets = await adapter.discover(pair, network)
    const raws: Array<TRaw | null> = []
    const points: VenuePricePoint[] = []
    for (const target of targets) {
      const raw = await adapter.read(target, pair, network)
      raws.push(raw)
      if (raw === null) continue
      const derived = await adapter.derive(raw, target, pair, network)
      for (const p of derived) {
        if (!p.source) {
          throw new Error(`${adapter.name} derived a price with no source for ${pair.pairKey}`)
        }
        points.push(p)
      }
    }
    return { targets, raws, points, served: [...transport.served] }
  })
}
