import { MCP_ERROR_CODES, type McpErrorCode } from './codes.js';

/**
 * The `paid_call` allow-list (#404).
 *
 * `paid_call` hands a URL straight to a fetch wrapper that answers `402` with
 * USDC from a live key, so the tool is a spend primitive dressed as a getter.
 * Agent-facing text — a web page, an issue comment, a search result — is one
 * sentence away from "call paid_call on https://…", which makes the set of
 * hosts this process may pay for a decision for the operator, not the model.
 *
 * The list therefore arrives through configuration (`McpServerConfig.paidCallAllowlist`)
 * and is never read from tool arguments. Its default is empty, and an empty
 * list pays nobody: refusing is the safe failure, so every check below errs
 * towards refusal and an entry this module cannot understand is dropped rather
 * than guessed at.
 *
 * Related open work: a spend ceiling (#210) and a payment log (#211) sit on
 * either side of this gate. They bound and record what happens to allowed
 * hosts; this one decides which hosts there are.
 */

/** One parsed `paidCallAllowlist` entry. */
export interface PaidCallAllowRule {
  /**
   * Origin the request must match exactly: lowercased host with any trailing
   * root dot removed, plus the port when it is not the scheme default.
   * `api.example.com` never matches `api.example.com:8443`, nor the reverse.
   */
  origin: string;
  /**
   * Protocol the request must use, when the entry spelled one out.
   * A bare-host entry leaves this unset and so accepts both http and https.
   */
  protocol?: string;
  /**
   * Path prefix the request must sit under, at a segment boundary. Unset means
   * every path on the origin is allowed.
   */
  pathPrefix?: string;
}

export interface PaidCallAllowlist {
  /** Entries that matched something. */
  rules: PaidCallAllowRule[];
  /** Entries that could not be understood, and so match nothing. */
  rejected: string[];
}

export type PaidCallDecision =
  | { allowed: true }
  | { allowed: false; code: McpErrorCode; reason: string };

/** Schemes `paid_call` will pay at all. Anything else (file:, data:, gopher:) is refused. */
const PAYABLE_PROTOCOLS = new Set(['http:', 'https:']);

function originOf(url: URL): string {
  const host = url.hostname.replace(/\.+$/, '');
  return url.port ? `${host}:${url.port}` : host;
}

function pathPrefixOf(url: URL): string | undefined {
  // A bare-host entry parses to "/", which constrains nothing.
  if (url.pathname === '/' || url.pathname === '') return undefined;
  return url.pathname;
}

/**
 * Parse the configured entries. Never throws: an entry that cannot be
 * understood is reported in `rejected` and simply never matches, so a typo
 * costs the operator a host they meant to allow, not a host they meant to
 * block.
 */
export function parsePaidCallAllowlist(entries: readonly string[]): PaidCallAllowlist {
  const rules: PaidCallAllowRule[] = [];
  const rejected: string[] = [];

  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;

    const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry);
    let parsed: URL;
    try {
      // Bare "host[:port][/path]" entries are parsed as http so that URL gives
      // us IDN-to-punycode and case folding for free; the protocol is only
      // pinned when the entry named one itself.
      parsed = new URL(hasProtocol ? entry : `http://${entry}`);
    } catch {
      rejected.push(entry);
      continue;
    }

    const origin = originOf(parsed);
    const hasLeftovers = parsed.search || parsed.hash;
    if (!origin || parsed.username || parsed.password || hasLeftovers || !PAYABLE_PROTOCOLS.has(parsed.protocol)) {
      // A query or fragment in an entry would silently drop the constraint the
      // operator thought they wrote, so it is rejected rather than ignored.
      rejected.push(entry);
      continue;
    }

    rules.push({
      origin,
      protocol: hasProtocol ? parsed.protocol : undefined,
      pathPrefix: pathPrefixOf(parsed),
    });
  }

  return { rules, rejected };
}

function matches(rule: PaidCallAllowRule, url: URL): boolean {
  if (rule.origin !== originOf(url)) return false;
  if (rule.protocol && rule.protocol !== url.protocol) return false;
  if (!rule.pathPrefix) return true;

  const { pathname } = url;
  if (rule.pathPrefix.endsWith('/')) {
    // "prefix/" allows the prefix itself and anything below it, never a sibling.
    return pathname === rule.pathPrefix.slice(0, -1) || pathname.startsWith(rule.pathPrefix);
  }
  // "prefix" allows exactly that segment path and anything under it, so
  // "/pricexyz" does not ride in on an allow-listed "/price".
  return pathname === rule.pathPrefix || pathname.startsWith(`${rule.pathPrefix}/`);
}

/**
 * Decide whether `paid_call` may spend against `url`. Call this before any
 * network I/O: a refused host must never be contacted, paid or not, and the
 * wrapper that pays runs inside the fetch.
 *
 * The URL is parsed here rather than trusted from the caller, so a relative or
 * nonsense target is refused instead of being resolved by some later layer.
 */
export function checkPaidCallTarget(
  url: string,
  rules: readonly PaidCallAllowRule[],
): PaidCallDecision {
  const refuse = (code: McpErrorCode, detail: string): PaidCallDecision => ({
    allowed: false,
    code,
    reason: `paid_call refused; no request was sent and no payment was made. ${detail} Configure the allow-list with MCP_PAID_CALL_ALLOWED_HOSTS.`,
  });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse(
      MCP_ERROR_CODES.ERR_BAD_REQUEST,
      'the url is not an absolute http(s) URL.',
    );
  }

  const origin = originOf(parsed);
  const label = origin || 'the url';

  if (!PAYABLE_PROTOCOLS.has(parsed.protocol)) {
    return refuse(
      MCP_ERROR_CODES.ERR_HOST_NOT_ALLOWED,
      `${label} uses ${parsed.protocol || 'an unknown protocol'}, which this tool does not pay for.`,
    );
  }

  if (parsed.username || parsed.password) {
    // "https://api.example.com@evil.test" reads as example.com to a human and
    // resolves to evil.test, so credentials are never a legitimate part of a
    // payable url.
    return refuse(
      MCP_ERROR_CODES.ERR_HOST_NOT_ALLOWED,
      `${label} is behind url userinfo, which is not allowed.`,
    );
  }

  if (!rules.some(rule => matches(rule, parsed))) {
    return refuse(
      MCP_ERROR_CODES.ERR_HOST_NOT_ALLOWED,
      `${label} is not in the paid_call allow-list${rules.length ? ', which lists other origins' : ', which is empty'}.`,
    );
  }

  return { allowed: true };
}
