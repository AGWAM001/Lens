import { describe, it, expect, vi } from 'vitest'
import { BazaarMcpServer } from '../src/mcp/server'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/**
 * #404 — `paid_call` pays whatever URL an agent names, up to the x402 ceiling,
 * from a live mainnet key. These tests pin the gate: the hosts it may pay for
 * come from configuration, the default pays nobody, and a refused host is
 * refused before the request is made, with a code the agent can explain.
 */

const ALLOWED = 'api.example.com'

function buildHarness(allowlist?: readonly string[]) {
  const fetchWithPayment = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ price: '0.15' })
  })

  const server = new BazaarMcpServer(
    allowlist === undefined
      ? { fetchWithPayment }
      : { fetchWithPayment, paidCallAllowlist: allowlist }
  )

  const handlers: Record<string, any> = {}
  ;(server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) handlers.call = fn
    if (schema === ListToolsRequestSchema) handlers.list = fn
  }
  ;(server as any).setupHandlers()

  const callPaid = (arguments_: Record<string, unknown>) =>
    handlers.call({ params: { name: 'paid_call', arguments: arguments_ } })

  return { fetchWithPayment, callPaid, listTools: () => handlers.list() }
}

async function paidCall(allowlist: readonly string[] | undefined, url: string) {
  const h = buildHarness(allowlist)
  const response = await h.callPaid({ url })
  return { response, body: JSON.parse(response.content[0].text), fetches: h.fetchWithPayment }
}

describe('paid_call host allow-list', () => {
  it('pays an allow-listed host', async () => {
    const { response, body, fetches } = await paidCall([ALLOWED], `https://${ALLOWED}/price/XLM/USDC`)

    expect(response.isError).toBeFalsy()
    expect(body.price).toBe('0.15')
    expect(fetches).toHaveBeenCalledTimes(1)
  })

  it('refuses a host that is not allow-listed, before any request is made', async () => {
    const { response, body, fetches } = await paidCall([ALLOWED], 'https://evil.test/price')

    expect(response.isError).toBe(true)
    expect(body.code).toBe('ERR_HOST_NOT_ALLOWED')
    expect(body.reason).toContain('evil.test')
    expect(body.reason).toMatch(/no request was sent and no payment was made/i)
    expect(fetches).not.toHaveBeenCalled()
  })

  it('pays nobody when the operator configures nothing', async () => {
    // The default failure mode: an unconfigured server is a server that cannot
    // be talked into spending.
    for (const url of ['https://api.example.com/price', 'http://localhost:3000/price']) {
      const { response, body, fetches } = await paidCall(undefined, url)

      expect(response.isError).toBe(true)
      expect(body.code).toBe('ERR_HOST_NOT_ALLOWED')
      expect(fetches).not.toHaveBeenCalled()
    }
  })

  it('refuses a subdomain look-alike of an allow-listed host', async () => {
    // The host an agent sees is not the host that answers.
    const { body, fetches } = await paidCall([ALLOWED], `https://${ALLOWED}.evil.test/price`)

    expect(body.code).toBe('ERR_HOST_NOT_ALLOWED')
    expect(fetches).not.toHaveBeenCalled()
  })

  it('refuses a path that merely starts with an allow-listed prefix', async () => {
    const prefix = `https://${ALLOWED}/price`

    const allowed = await paidCall([prefix], `${prefix}/XLM/USDC`)
    expect(allowed.response.isError).toBeFalsy()

    const nearMiss = await paidCall([prefix], `https://${ALLOWED}/prices-for-free`)
    expect(nearMiss.body.code).toBe('ERR_HOST_NOT_ALLOWED')
    expect(nearMiss.fetches).not.toHaveBeenCalled()
  })

  it('refuses a host hidden behind url userinfo', async () => {
    const { body, fetches } = await paidCall([ALLOWED], `https://${ALLOWED}@evil.test/price`)

    expect(body.code).toBe('ERR_HOST_NOT_ALLOWED')
    expect(fetches).not.toHaveBeenCalled()
  })

  it('refuses a homograph of an allow-listed host', async () => {
    // "api.exаmplе.com" with a Cyrillic а and е: a different registered name, a
    // different payment, and text an agent cannot tell apart from the list.
    const { body, fetches } = await paidCall([ALLOWED], 'https://api.ex\u0430mpl\u0435.com/price')

    expect(body.code).toBe('ERR_HOST_NOT_ALLOWED')
    expect(fetches).not.toHaveBeenCalled()
  })

  it('pins the port when the entry names one, and only then', async () => {
    const wrongPort = await paidCall([ALLOWED], `https://${ALLOWED}:8443/price`)
    expect(wrongPort.body.code).toBe('ERR_HOST_NOT_ALLOWED')
    expect(wrongPort.fetches).not.toHaveBeenCalled()

    const rightPort = await paidCall([`${ALLOWED}:8443`], `https://${ALLOWED}:8443/price`)
    expect(rightPort.response.isError).toBeFalsy()
  })

  it('refuses protocols this tool does not pay for, and unreadable urls', async () => {
    for (const url of ['file:///etc/passwd', 'not-a-url', 'https://']) {
      const { body, fetches } = await paidCall([ALLOWED], url)

      expect(['ERR_HOST_NOT_ALLOWED', 'ERR_BAD_REQUEST']).toContain(body.code)
      expect(fetches).not.toHaveBeenCalled()
    }
  })

  it('drops an entry it cannot read rather than letting it match everything', async () => {
    for (const entry of ['not a valid entry %%', 'https://api.example.com/price?free=1', 'ftp://api.example.com']) {
      const { body, fetches } = await paidCall([entry], `https://${ALLOWED}/price`)

      expect(body.code).toBe('ERR_HOST_NOT_ALLOWED')
      expect(fetches).not.toHaveBeenCalled()
    }
  })

  it('takes the allow-list from configuration, never from the call', async () => {
    const h = buildHarness([ALLOWED])

    // An argument cannot widen the list — the only inputs the tool accepts are
    // url and method.
    const smuggled = await h.callPaid({
      url: 'https://evil.test/price',
      allowed_hosts: ['evil.test'],
      paidCallAllowlist: ['evil.test']
    })
    // Either guard refusing is correct, and which one fires first is not the
    // property under test: strict argument validation now rejects the
    // unrecognised keys before the host check ever runs. What matters is that
    // the call is refused and no payment leaves the process.
    expect(['ERR_HOST_NOT_ALLOWED', 'ERR_BAD_REQUEST'])
      .toContain(JSON.parse(smuggled.content[0].text).code)
    expect(h.fetchWithPayment).not.toHaveBeenCalled()

    const tools = (await h.listTools()).tools
    const paidCall = tools.find((t: any) => t.name === 'paid_call')
    expect(Object.keys(paidCall.inputSchema.properties).sort()).toEqual(['method', 'url'])
    expect(paidCall.description).toMatch(/allow-list/i)
  })

  it('matches the allow-listed host regardless of case or root dot', async () => {
    const upper = await paidCall([ALLOWED], `https://API.EXAMPLE.COM/price`)
    expect(upper.response.isError).toBeFalsy()

    // A trailing dot is the same name, written absolutely, not a new host.
    const dotted = await paidCall([ALLOWED], `https://${ALLOWED}./price`)
    expect(dotted.response.isError).toBeFalsy()
  })
})
