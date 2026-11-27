/**
 * Refuse outbound network access during tests (#226).
 *
 * A test that reaches a real venue is slow when the venue is up, flaky when it
 * is not, and silently wrong when the venue has changed: it pins nothing. The
 * fixtures in tests/fixtures/venues are the recorded alternative, and this guard
 * is what makes using them non-optional.
 *
 * It works at the socket, not at `fetch`, because the adapters reach the
 * network two ways: `fetchWithTimeout` (Aquarius, Gate.io, KuCoin, Horizon AMM,
 * the Soroswap token list) and stellar-sdk's axios clients (Horizon trades for
 * SDEX, Soroban RPC for Soroswap, Phoenix, Blend and DeFindex). Both end in
 * `net.Socket.prototype.connect`, so one patch covers every path - including
 * ones a future adapter adds.
 *
 * A blocked connect does two things:
 *   1. fails the socket on the next tick, so the request errors immediately
 *      instead of waiting out a DNS lookup or an HTTP timeout; and
 *   2. records the attempt. Adapters swallow fetch errors by design ("an
 *      unreachable venue degrades, it does not throw"), so an error alone would
 *      let the test pass on the degraded path. vitest.setup.ts drains the record
 *      after every test and fails the test that tried.
 *
 * Loopback and IPC sockets stay allowed: the integration suites talk to a local
 * Postgres and Redis, and some route tests listen on 127.0.0.1.
 *
 * Set LENS_TEST_ALLOW_NETWORK=1 to switch the guard off for a deliberate live
 * run. Nothing in the default suite needs it.
 */
import net from 'node:net'

export class NetworkAccessError extends Error {
  readonly target: string

  constructor(target: string, detail?: string) {
    super(
      `Network access is disabled in tests: attempted to reach ${target}` +
        (detail ? ` (${detail})` : '') +
        '. Record a fixture with `npm run fixtures:capture` and replay it with ' +
        'tests/support/venueFixtures.ts instead.'
    )
    this.name = 'NetworkAccessError'
    this.target = target
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1', '[::1]'])

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null || host === '') return true // Node defaults to localhost
  const h = host.toLowerCase()
  if (LOOPBACK_HOSTS.has(h)) return true
  if (h.endsWith('.localhost')) return true
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true
  if (h.startsWith('::ffff:127.')) return true
  return false
}

const violations: NetworkAccessError[] = []

/** Record a blocked attempt so the test that made it fails even if the error was swallowed. */
export function recordNetworkViolation(err: NetworkAccessError): void {
  violations.push(err)
}

/** Return and clear the attempts recorded since the last call. */
export function takeNetworkViolations(): NetworkAccessError[] {
  return violations.splice(0, violations.length)
}

interface ConnectTarget {
  host?: string
  port?: number | string
  path?: string
}

/** Normalise the overloaded `socket.connect(...)` arguments to a target. */
function connectTarget(args: unknown[]): ConnectTarget {
  let first = args[0]
  // net.connect() passes [options, cb] wrapped in an array under a private
  // symbol on some Node versions; unwrap one level.
  if (Array.isArray(first)) first = first[0]
  if (first && typeof first === 'object') {
    const o = first as ConnectTarget
    return { host: o.host, port: o.port, path: o.path }
  }
  if (typeof first === 'string' && isNaN(Number(first))) return { path: first }
  return { port: first as number, host: typeof args[1] === 'string' ? args[1] : undefined }
}

let installed = false
let originalConnect: typeof net.Socket.prototype.connect | undefined

export function isNetworkGuardInstalled(): boolean {
  return installed
}

export function installNetworkGuard(): void {
  if (installed) return
  if (process.env.LENS_TEST_ALLOW_NETWORK === '1') return
  installed = true

  originalConnect = net.Socket.prototype.connect
  const passthrough = originalConnect

  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const target = connectTarget(args)
    if (target.path || isLoopbackHost(target.host)) {
      return (passthrough as (...a: unknown[]) => net.Socket).apply(this, args)
    }
    const err = new NetworkAccessError(`${target.host}:${target.port ?? '?'}`)
    recordNetworkViolation(err)
    // Fail on the next tick, the way a refused connection does, so callers get
    // an ordinary 'error' event rather than a throw from inside http.request.
    process.nextTick(() => this.destroy(err))
    return this
  } as typeof net.Socket.prototype.connect
}

/** Test-only: restore the real connect. Used by the guard's own tests. */
export function uninstallNetworkGuard(): void {
  if (!installed || !originalConnect) return
  net.Socket.prototype.connect = originalConnect
  installed = false
}
