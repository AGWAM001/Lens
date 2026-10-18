import { describe, it, expect } from 'vitest'
import {
  isBlockedIpAddress,
  assertUrlSafe,
  ssrfSafeFetch,
  SsrfError,
} from '../net/ssrf'

/** A fake DNS that always answers with the given addresses, recording names. */
function stubLookup(addresses: string[]) {
  const seen: string[] = []
  return {
    seen,
    lookup: async (_hostname: string) => {
      seen.push(_hostname)
      return addresses
    },
  }
}

async function expectBlocked(
  promise: Promise<unknown>,
  reason: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SsrfError)
  await expect(promise).rejects.toMatchObject({ reason })
}

describe('isBlockedIpAddress', () => {
  it('flags loopback, private, link-local and metadata v4', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.4.5', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255']) {
      expect(isBlockedIpAddress(ip), ip).toBe(true)
    }
  })

  it('allows public v4', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1']) {
      expect(isBlockedIpAddress(ip), ip).toBe(false)
    }
  })

  it('flags v6 loopback, link-local, unique-local, multicast and mapped-private', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '2002:7f00:0001::', '2001:0000:0:0:0:0:0:1']) {
      expect(isBlockedIpAddress(ip), ip).toBe(true)
    }
  })

  it('allows public v6', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isBlockedIpAddress(ip), ip).toBe(false)
    }
  })
})

describe('assertUrlSafe — scheme parsing', () => {
  it('rejects non-http(s) schemes', async () => {
    await expectBlocked(assertUrlSafe('file:///etc/passwd'), 'unsupported_scheme')
    await expectBlocked(assertUrlSafe('ftp://example.com/x'), 'unsupported_scheme')
    await expectBlocked(assertUrlSafe('gopher://127.0.0.1:1'), 'unsupported_scheme')
  })

  it('rejects strings that are not absolute URLs', async () => {
    await expectBlocked(assertUrlSafe('not a url'), 'invalid_url')
    // "localhost:3000" parses as scheme "localhost:" — a non-http scheme, refused.
    await expectBlocked(assertUrlSafe('localhost:3000'), 'unsupported_scheme')
  })

  it('rejects embedded credentials', async () => {
    await expectBlocked(assertUrlSafe('https://user:pass@8.8.8.8/'), 'embedded_credentials')
  })
})

describe('assertUrlSafe — private address refusal', () => {
  it('refuses a private literal without DNS', async () => {
    const { lookup, seen } = stubLookup(['203.0.113.10'])
    await expectBlocked(assertUrlSafe('http://10.0.0.5/', { lookup }), 'blocked_address')
    // IP literals are classified directly; lookup must never be consulted.
    expect(seen).toEqual([])
  })

  it('refuses the cloud metadata endpoint', async () => {
    await expectBlocked(assertUrlSafe('http://169.254.169.254/latest/meta-data/'), 'blocked_address')
  })

  it('refuses a public hostname that resolves to a private address', async () => {
    const { lookup } = stubLookup(['127.0.0.1'])
    await expectBlocked(assertUrlSafe('http://innocent.example/', { lookup }), 'blocked_address')
  })

  it('refuses when ANY resolved address is private', async () => {
    const { lookup } = stubLookup(['93.184.216.34', '192.168.0.1'])
    await expectBlocked(assertUrlSafe('https://mixed.example/', { lookup }), 'blocked_address')
  })

  it('refuses a hostname that resolves to nothing', async () => {
    const { lookup } = stubLookup([])
    await expectBlocked(assertUrlSafe('https://empty.example/', { lookup }), 'unresolvable_host')
  })
})

describe('assertUrlSafe — operator allowlist', () => {
  const pub = { lookup: async () => ['93.184.216.34'] }

  it('permits a listed public host', async () => {
    const url = await assertUrlSafe('https://ok.example/x', { allowedHosts: ['OK.Example'], ...pub })
    expect(url.hostname).toBe('ok.example')
  })

  it('refuses an unlisted host even when public', async () => {
    await expectBlocked(assertUrlSafe('https://other.example/x', { allowedHosts: ['ok.example'], ...pub }), 'host_not_allowed')
  })

  it('an allowlist entry does not unlock a private address', async () => {
    const priv = { lookup: async () => ['127.0.0.1'] }
    await expectBlocked(assertUrlSafe('https://evil.example/x', { allowedHosts: ['evil.example'], ...priv }), 'blocked_address')
  })
})

describe('ssrfSafeFetch — transport and redirects', () => {
  const publicLookup = { lookup: async () => ['93.184.216.34'] }

  it('returns a plain 200 from a public host', async () => {
    const fetchImpl = async () => new Response('{"resources":[]}', { status: 200 })
    const res = await ssrfSafeFetch('https://ok.example/discovery/resources', {}, { ...publicLookup, fetchImpl })
    expect(res.status).toBe(200)
  })

  it('does not follow a redirect to a host that would itself be refused', async () => {
    const calls: string[] = []
    const fetchImpl = async (input: string | URL) => {
      calls.push(String(input))
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    }
    await expectBlocked(
      ssrfSafeFetch('https://ok.example/discovery/resources', {}, { ...publicLookup, fetchImpl }),
      'blocked_address',
    )
    // The metadata endpoint must never actually be fetched.
    expect(calls).toEqual(['https://ok.example/discovery/resources'])
  })

  it('follows a redirect between public hosts', async () => {
    const hops = ['https://a.example/x', 'https://b.example/y']
    let n = 0
    const fetchImpl = async () => {
      n++
      if (n === 1) return new Response(null, { status: 301, headers: { location: hops[1] } })
      return new Response('done', { status: 200 })
    }
    const res = await ssrfSafeFetch(hops[0], {}, { ...publicLookup, fetchImpl })
    expect(res.status).toBe(200)
    expect(n).toBe(2)
  })

  it('gives up after too many redirects', async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://loop.example/next' } })
    await expectBlocked(
      ssrfSafeFetch('https://loop.example/start', {}, { ...publicLookup, fetchImpl, maxRedirects: 2 }),
      'too_many_redirects',
    )
  })

  it('forces redirect: manual so the transport never follows on its own', async () => {
    let capturedInit: RequestInit | undefined
    const fetchImpl = async (_input: string | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response('ok', { status: 200 })
    }
    await ssrfSafeFetch('https://ok.example/x', {}, { ...publicLookup, fetchImpl })
    expect(capturedInit?.redirect).toBe('manual')
  })
})
