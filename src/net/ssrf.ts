import net from 'net'
import { promises as dns } from 'dns'

/**
 * Server-Side Request Forgery (SSRF) guard for outbound fetches whose target is
 * supplied by an untrusted caller (e.g. an agent driving the Bazaar MCP server).
 *
 * The threat: the server runs wherever the operator runs it — often a machine
 * with network reach the caller does *not* have — and will happily fetch a cloud
 * instance metadata endpoint (`169.254.169.254`) or a service on a private
 * address, then hand the response body straight back to the caller. The
 * mitigation is to refuse any target that is not a public http/https host, and
 * to decide that *after* resolving the hostname, because a public-looking name
 * can resolve to a private address — the classic way this check is bypassed.
 *
 * Design notes:
 *   - Private/loopback/link-local/metadata addresses are always refused. The
 *     optional `allowedHosts` list only *narrows* what is reachable; it can never
 *     re-open a blocked address. There is no config that turns the block off.
 *   - Redirects are followed manually (`redirect: 'manual'`) and every hop is put
 *     through the same checks. A permitted host that 302s to a metadata endpoint
 *     is refused exactly as if the caller had named it directly.
 *   - `lookup` and `fetchImpl` are injectable so the resolution behaviour can be
 *     tested without real DNS or sockets.
 */

/** Codes callers branch on; the message is human-facing and may change. */
export type SsrfBlockReason =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'embedded_credentials'
  | 'host_not_allowed'
  | 'unresolvable_host'
  | 'blocked_address'
  | 'too_many_redirects'

export class SsrfError extends Error {
  readonly reason: SsrfBlockReason
  /** The offending value, best-effort, for operator logs (never trusted). */
  readonly detail?: string

  constructor(reason: SsrfBlockReason, message: string, detail?: string) {
    super(message)
    this.name = 'SsrfError'
    this.reason = reason
    this.detail = detail
  }
}

export interface SsrfFetchOptions {
  /**
   * Hostnames an operator may reach. Empty/undefined means "any public host";
   * a non-empty list additionally requires the hostname to appear here. Never
   * grants access to a private address — that block is unconditional.
   */
  allowedHosts?: string[]
  /** Resolve a hostname to its addresses. Defaults to real A/AAAA lookups. */
  lookup?: (hostname: string) => Promise<string[]>
  /** Transport. Defaults to global fetch. Redirects are forced to `manual`. */
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>
  /** Redirect hops to follow before giving up. Default 5. */
  maxRedirects?: number
}

const DEFAULT_MAX_REDIRECTS = 5

/** Redirect statuses whose `Location` we re-validate before following. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function normalizeHosts(hosts: string[] | undefined): string[] {
  return (hosts ?? [])
    .map((h) => h.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, ''))
    .filter((h) => h.length > 0)
}

/** Real DNS: merge A and AAAA, treating NXDOMAIN/empty as resolvable-but-empty. */
export async function defaultLookup(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ])
  return [...v4, ...v6]
}

/**
 * True when `ip` is in a range that must never be fetched: loopback, private,
 * link-local (which holds the cloud metadata IP 169.254.169.254), carrier-grade
 * NAT, documentation/benchmark/multicast/reserved blocks, and the IPv6
 * equivalents — including IPv4-mapped (`::ffff:x:x:x:x`) and 6to4 addresses that
 * smuggle a private IPv4 inside a public-looking IPv6.
 */
export function isBlockedIpAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return isBlockedIpv4(ip)
  if (family === 6) return isBlockedIpv6(ip)
  return true // not a well-formed IP — fail closed
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true
  }
  const [a, b] = parts
  switch (true) {
    case a === 0: return true // 0.0.0.0/8 "this network" (incl. 0.0.0.0)
    case a === 10: return true // 10.0.0.0/8
    case a === 127: return true // 127.0.0.0/8 loopback
    case a === 100 && b >= 64 && b <= 127: return true // 100.64.0.0/10 CGNAT
    case a === 169 && b === 254: return true // 169.254.0.0/16 link-local (metadata)
    case a === 172 && b >= 16 && b <= 31: return true // 172.16.0.0/12
    case a === 192 && b === 0 && parts[2] === 0: return true // 192.0.0.0/24 IETF
    case a === 192 && b === 0 && parts[2] === 2: return true // 192.0.2.0/24 TEST-NET-1
    case a === 198 && (b === 18 || b === 19): return true // 198.18.0.0/15 benchmark
    case a === 198 && b === 51 && parts[2] === 100: return true // 198.51.100.0/24 TEST-NET-2
    case a === 203 && b === 0 && parts[2] === 113: return true // 203.0.113.0/24 TEST-NET-3
    case a === 192 && b === 168: return true // 192.168.0.0/16
    case a >= 224 && a <= 239: return true // 224.0.0.0/4 multicast
    case a >= 240: return true // 240.0.0.0/4 reserved + 255.255.255.255
    default: return false
  }
}

function ipv6ToGroups(addr: string): number[] | null {
  const lower = addr.toLowerCase()
  let a = lower
  let tail: number[] = []

  // An embedded IPv4 (RFC 4291 §2.2 / 6to4 / mapped) occupies the last 32 bits.
  if (a.includes('.')) {
    const lastColon = a.lastIndexOf(':')
    const nums = a.slice(lastColon + 1).split('.').map(Number)
    if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    tail = [(nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]]
    a = a.slice(0, lastColon)
  }

  const doubleIdx = a.indexOf('::')
  let head: string[]
  let rest: string[]
  if (doubleIdx !== -1) {
    const left = a.slice(0, doubleIdx)
    const right = a.slice(doubleIdx + 2)
    head = left ? left.split(':') : []
    rest = right ? right.split(':') : []
  } else {
    head = a.split(':')
    rest = []
  }

  const headNums = head.map((h) => parseInt(h, 16))
  const restNums = rest.map((h) => parseInt(h, 16))
  if ([...headNums, ...restNums].some((n) => Number.isNaN(n))) return null

  if (doubleIdx === -1) {
    if (headNums.length + tail.length !== 8) return null
    return [...headNums, ...tail]
  }
  const fill = 8 - headNums.length - restNums.length - tail.length
  if (fill < 0) return null
  return [...headNums, ...Array(fill).fill(0), ...restNums, ...tail]
}

/** Extract the 4 IPv4 octets encoded in groups[6] and groups[7]. */
function v4FromGroups(g6: number, g7: number): number[] {
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]
}

function isBlockedIpv6(ip: string): boolean {
  const g = ipv6ToGroups(ip)
  if (!g) return true // malformed — fail closed

  const zero = (n: number) => n === 0
  const headIsZero = g.slice(0, 6).every(zero)

  if (g.every(zero)) return true // :: unspecified
  if (headIsZero && g[6] === 0 && g[7] === 1) return true // ::1 loopback

  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast

  // 6to4 (2002::/16) embeds an IPv4 in groups 1-2.
  if (g[0] === 0x2002) {
    return isBlockedIpv4(`${(g[1] >> 8) & 0xff}.${g[1] & 0xff}.${(g[2] >> 8) & 0xff}.${g[2] & 0xff}`)
  }
  // Teredo (2001:0000::/32) obfuscates the peer address — refuse by default.
  if (g[0] === 0x2001 && g[1] === 0x0000) return true

  // IPv4-mapped (::ffff:x.x.x.x) and IPv4-compatible (::x.x.x.x): classify the v4 tail.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    if (g[6] === 0 && g[7] === 0) return false // :: / ::ffff:: handled above
    return isBlockedIpv4(v4FromGroups(g[6], g[7]).join('.'))
  }

  return false
}

/**
 * Validate a single URL: scheme, credentials, optional host allowlist, then DNS
 * resolution and per-address classification. Throws {@link SsrfError} on the
 * first refusal; returns the parsed URL when the target is safe to fetch.
 */
export async function assertUrlSafe(
  raw: string | URL,
  opts: Pick<SsrfFetchOptions, 'allowedHosts' | 'lookup'> = {},
): Promise<URL> {
  let url: URL
  try {
    url = new URL(typeof raw === 'string' ? raw : raw.toString())
  } catch {
    throw new SsrfError('invalid_url', 'Target is not a valid absolute URL.', String(raw))
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('unsupported_scheme', `Scheme "${url.protocol}" is not allowed; only http/https.`, url.protocol)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SsrfError('embedded_credentials', 'URL must not embed credentials.')
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  if (hostname.length === 0) {
    throw new SsrfError('invalid_url', 'URL has no hostname.')
  }

  const allowlist = normalizeHosts(opts.allowedHosts)
  if (allowlist.length > 0 && !allowlist.includes(hostname)) {
    throw new SsrfError('host_not_allowed', `Host "${hostname}" is not in the allowed host list.`, hostname)
  }

  const lookup = opts.lookup ?? defaultLookup
  let addresses: string[]
  if (net.isIP(hostname)) {
    addresses = [hostname]
  } else {
    addresses = await lookup(hostname)
    if (!addresses || addresses.length === 0) {
      throw new SsrfError('unresolvable_host', `Host "${hostname}" did not resolve.`, hostname)
    }
  }

  for (const address of addresses) {
    if (isBlockedIpAddress(address)) {
      throw new SsrfError(
        'blocked_address',
        `Host "${hostname}" resolves to a blocked address (${address}).`,
        address,
      )
    }
  }

  return url
}

/**
 * Fetch `target`, refusing unsafe hosts and re-validating every redirect hop.
 * Throws {@link SsrfError} when a hop is refused or the chain is too long.
 */
export async function ssrfSafeFetch(
  target: string | URL,
  init: RequestInit = {},
  opts: SsrfFetchOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  let url = await assertUrlSafe(target, opts)

  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(url.toString(), { ...init, redirect: 'manual' })

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }

    const location = response.headers.get('location')
    if (!location) {
      return response // a redirect we cannot follow — surface it to the caller
    }
    if (hop >= maxRedirects) {
      throw new SsrfError('too_many_redirects', `Too many redirects (>${maxRedirects}).`, url.hostname)
    }

    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new SsrfError('invalid_url', `Redirect target is not a valid URL: ${location}`, location)
    }
    url = await assertUrlSafe(next, opts)
  }
}
