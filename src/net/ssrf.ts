import net from 'net'
import { promises as dns } from 'dns'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'

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
 * What is and is not guaranteed:
 *   - Guaranteed: Hostnames and IP literals are validated against private,
 *     loopback, link-local, and cloud metadata IP ranges.
 *   - Guaranteed: DNS rebinding defense — connect-time resolution is pinned to
 *     an address that was explicitly validated during the pre-flight check,
 *     preventing short-TTL DNS records from redirecting the socket to a private
 *     address at connect time.
 *   - Guaranteed: TLS certificate and SNI verification are performed against the
 *     original hostname, preserving TLS security and host verification.
 *   - Guaranteed: Redirects are followed manually (`redirect: 'manual'`) and
 *     every redirect hop is re-validated and re-pinned.
 *   - Not guaranteed: Host-level application vulnerabilities or semantic contents
 *     served by a legitimately public host.
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
  /** Transport. Defaults to undiciFetch with pinned connection dispatcher. Redirects are forced to `manual`. */
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>
  /** Redirect hops to follow before giving up. Default 5. */
  maxRedirects?: number
}

export interface SafeUrl extends URL {
  pinnedAddress?: string
  validatedAddresses?: string[]
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
 * Creates an undici Dispatcher (Agent) pinned to the specified IP address.
 * The custom connect lookup hook guarantees that no second DNS lookup occurs,
 * defeating DNS rebinding attacks while preserving TLS SNI / certificate checks
 * against the original hostname.
 */
export function createPinnedDispatcher(pinnedAddress: string): Dispatcher {
  const family = net.isIP(pinnedAddress) || 4
  const connectLookup = (
    _hostname: string,
    _options: any,
    callback: (err: Error | null, addresses: any[]) => void,
  ) => {
    callback(null, [{ address: pinnedAddress, family }])
  }
  const agent = new Agent({
    connect: {
      lookup: connectLookup,
    },
  }) as any
  agent.pinnedAddress = pinnedAddress
  agent.connectLookup = connectLookup
  return agent
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
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true
  }
  const [a, b] = parts

  // 0.0.0.0/8 — current network (often treated as loopback by BSD sockets)
  if (a === 0) return true
  // 10.0.0.0/8 — RFC 1918 private
  if (a === 10) return true
  // 100.64.0.0/10 — RFC 6598 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true
  // 127.0.0.0/8 — RFC 1122 loopback
  if (a === 127) return true
  // 169.254.0.0/16 — RFC 3927 link-local (holds AWS/GCP/Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 — RFC 1918 private
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 0) return true
  // 192.0.2.0/24 — TEST-NET-1 documentation
  if (a === 192 && b === 0 && parts[2] === 2) return true
  // 192.168.0.0/16 — RFC 1918 private
  if (a === 192 && b === 168) return true
  // 198.18.0.0/15 — benchmark tests
  if (a === 198 && (b === 18 || b === 19)) return true
  // 198.51.100.0/24 — TEST-NET-2 documentation
  if (a === 198 && b === 51 && parts[2] === 100) return true
  // 203.0.113.0/24 — TEST-NET-3 documentation
  if (a === 203 && b === 0 && parts[2] === 113) return true
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true
  // 240.0.0.0/4 — reserved for future use (includes 255.255.255.255 broadcast)
  if (a >= 240) return true

  return false
}

function isBlockedIpv6(ip: string): boolean {
  // Normalize by parsing into 8 16-bit words.
  const words = parseIpv6(ip)
  if (!words) return true

  // ::/128 — unspecified
  if (words.every((w) => w === 0)) return true
  // ::1/128 — loopback
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true

  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const v4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`
    return isBlockedIpv4(v4)
  }

  // 6to4: 2002::/16 embeds IPv4 in words 1 and 2
  if (words[0] === 0x2002) {
    const v4 = `${words[1] >> 8}.${words[1] & 0xff}.${words[2] >> 8}.${words[2] & 0xff}`
    return isBlockedIpv4(v4)
  }

  // fe80::/10 — link-local
  if ((words[0] & 0xffc0) === 0xfe80) return true
  // fc00::/7 — unique-local (fc00::/8 and fd00::/8)
  if ((words[0] & 0xfe00) === 0xfc00) return true
  // ff00::/8 — multicast
  if ((words[0] & 0xff00) === 0xff00) return true
  // 2001:db8::/32 — documentation
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true
  // 2001::/23 — IETF protocol assignments (includes Teredo 2001:0000::/32)
  if (words[0] === 0x2001 && (words[1] & 0xfe00) === 0x0000) return true

  return false
}

function parseIpv6(ip: string): number[] | null {
  // Strip zone index (%eth0) if present
  const clean = ip.replace(/%.*$/, '').toLowerCase()

  // Handle embedded IPv4 at the end (e.g. ::ffff:192.0.2.1)
  const lastColon = clean.lastIndexOf(':')
  if (lastColon === -1) return null
  const tail = clean.slice(lastColon + 1)
  let embeddedV4: number[] | null = null
  let head = clean
  if (tail.includes('.')) {
    const v4Parts = tail.split('.').map(Number)
    if (v4Parts.length !== 4 || v4Parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return null
    }
    embeddedV4 = [(v4Parts[0] << 8) | v4Parts[1], (v4Parts[2] << 8) | v4Parts[3]]
    head = clean.slice(0, lastColon)
  }

  const parts = head.split('::')
  if (parts.length > 2) return null // at most one "::"

  const parseHex = (s: string) => (s ? s.split(':').map((h) => parseInt(h, 16)) : [])
  const left = parseHex(parts[0])
  const right = parts.length === 2 ? parseHex(parts[1]) : []
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null

  const needed = 8 - (embeddedV4 ? 2 : 0)
  if (parts.length === 1) {
    const total = embeddedV4 ? [...left, ...embeddedV4] : left
    return total.length === 8 ? total : null
  }

  const fill = needed - (left.length + right.length)
  if (fill < 0) return null
  const middle = new Array(fill).fill(0)
  const result = [...left, ...middle, ...right]
  return embeddedV4 ? [...result, ...embeddedV4] : result
}

/**
 * Validate a single URL: scheme, credentials, optional host allowlist, then DNS
 * resolution and per-address classification. Throws {@link SsrfError} on the
 * first refusal; returns the parsed URL with pinned validated address when safe.
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
    throw new SsrfError(
      'unsupported_scheme',
      `Scheme "${url.protocol}" is not allowed; only http/https.`,
      url.protocol,
    )
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
    throw new SsrfError(
      'host_not_allowed',
      `Host "${hostname}" is not in the allowed host list.`,
      hostname,
    )
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

  // Pin the validated address to defeat DNS rebinding attacks at connect time
  const safeUrl = url as SafeUrl
  safeUrl.pinnedAddress = addresses[0]
  safeUrl.validatedAddresses = addresses

  return safeUrl
}

/**
 * Fetch `target`, refusing unsafe hosts and pinning connection to the pre-validated
 * address to defeat DNS rebinding. Re-validates and re-pins every redirect hop.
 * Throws {@link SsrfError} when a hop is refused or the chain is too long.
 */
export async function ssrfSafeFetch(
  target: string | URL,
  init: RequestInit = {},
  opts: SsrfFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  let url = (await assertUrlSafe(target, opts)) as SafeUrl

  for (let hop = 0; ; hop++) {
    const pinnedAddress = url.pinnedAddress || url.hostname
    const dispatcher = createPinnedDispatcher(pinnedAddress)

    let response: Response
    if (opts.fetchImpl) {
      response = await opts.fetchImpl(url.toString(), {
        ...init,
        redirect: 'manual',
        dispatcher,
      } as any)
    } else {
      response = (await undiciFetch(url.toString(), {
        ...init,
        dispatcher,
        redirect: 'manual',
      } as any)) as unknown as Response
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }

    const location = response.headers.get('location')
    if (!location) {
      return response // a redirect we cannot follow — surface it to the caller
    }
    if (hop >= maxRedirects) {
      throw new SsrfError(
        'too_many_redirects',
        `Too many redirects (>${maxRedirects}).`,
        url.hostname,
      )
    }

    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new SsrfError(
        'invalid_url',
        `Redirect target is not a valid URL: ${location}`,
        location,
      )
    }
    url = (await assertUrlSafe(next, opts)) as SafeUrl
  }
}
