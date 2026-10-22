import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BazaarMcpServer, type McpHttpServerHandle } from '../src/mcp/server';
import { resolveMcpTransportConfig } from '../src/mcp/config';
import { SpendBudget } from '../src/mcp/budget';
import { MCP_ERROR_CODES } from '../src/mcp/codes';

const { mockFetchWithTimeout } = vi.hoisted(() => ({
  mockFetchWithTimeout: vi.fn(),
}));

// bazaar_search fetches through src/fetch, which also pulls src/config and its
// env-dependent network resolution. Mocking it keeps this file offline and
// independent of the ambient environment.
vi.mock('../src/fetch', () => ({
  fetchWithTimeout: mockFetchWithTimeout,
}));

/**
 * A test-only shared secret. It is an opaque bearer value with no relation to
 * any Stellar key, and it never leaves the process.
 */
const TEST_AUTH_TOKEN = 'lens-mcp-http-test-token-4d1f8b6e2a97';
const PAID_URL = 'https://bazaar.example/api/v1/price';

const openHandles: McpHttpServerHandle[] = [];

afterEach(async () => {
  while (openHandles.length) {
    await openHandles.pop()!.close();
  }
});

function mcpUrl(handle: McpHttpServerHandle, path = '/mcp'): string {
  const address = handle.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${path}`;
}

async function startHttp(
  fetchWithPayment: Mock = vi.fn(),
  budget?: SpendBudget
): Promise<McpHttpServerHandle> {
  const server = new BazaarMcpServer({
    fetchWithPayment: fetchWithPayment as unknown as typeof fetch,
    ...(budget ? { budget } : {}),
  });
  const handle = await server.runHttp({
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    authToken: TEST_AUTH_TOKEN,
  });
  openHandles.push(handle);
  return handle;
}

function postJsonRpc(
  handle: McpHttpServerHandle,
  message: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(mcpUrl(handle), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(message),
  });
}

function initializeMessage(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'lens-test', version: '1.0.0' },
    },
  };
}

async function connectClient(handle: McpHttpServerHandle, token = TEST_AUTH_TOKEN): Promise<Client> {
  const client = new Client({ name: 'lens-http-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl(handle)), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

function paidCallResponse() {
  return new Response(JSON.stringify({ asset: 'XLM', price: '0.15' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const budgetTempDirs: string[] = [];

/**
 * A budget writing to its own throwaway state file, so a parity assertion
 * cannot be polluted by spend recorded under another test's file.
 */
function makeBudget(label: string): SpendBudget {
  const dir = mkdtempSync(join(tmpdir(), `lens-mcp-http-${label}-`));
  budgetTempDirs.push(dir);
  return new SpendBudget({
    perCallMax: '$1.00',
    dailyCeiling: '$10.00',
    stateFilePath: join(dir, 'spend-state.json'),
  });
}

afterEach(() => {
  while (budgetTempDirs.length) {
    rmSync(budgetTempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('MCP transport configuration', () => {
  it('keeps stdio the default when nothing is configured', () => {
    expect(resolveMcpTransportConfig({})).toEqual({ transport: 'stdio' });
    expect(resolveMcpTransportConfig({ MCP_TRANSPORT: 'stdio' })).toEqual({ transport: 'stdio' });
  });

  it('selects http with loopback defaults once a key is configured', () => {
    expect(resolveMcpTransportConfig({ MCP_TRANSPORT: 'http', MCP_HTTP_AUTH_TOKEN: TEST_AUTH_TOKEN })).toEqual({
      transport: 'http',
      host: '127.0.0.1',
      port: 3003,
      path: '/mcp',
      authToken: TEST_AUTH_TOKEN,
    });
  });

  it('honours host, port and path overrides', () => {
    expect(
      resolveMcpTransportConfig({
        MCP_TRANSPORT: 'http',
        MCP_HTTP_AUTH_TOKEN: TEST_AUTH_TOKEN,
        MCP_HTTP_HOST: '0.0.0.0',
        MCP_HTTP_PORT: '8123',
        MCP_HTTP_PATH: 'mcp/',
      })
    ).toMatchObject({ host: '0.0.0.0', port: 8123, path: '/mcp' });
  });

  it('refuses to select http without a key', () => {
    expect(() => resolveMcpTransportConfig({ MCP_TRANSPORT: 'http' })).toThrow(/MCP_HTTP_AUTH_TOKEN/);
    expect(() => resolveMcpTransportConfig({ MCP_TRANSPORT: 'http', MCP_HTTP_AUTH_TOKEN: '   ' })).toThrow(
      /MCP_HTTP_AUTH_TOKEN/
    );
  });

  it('rejects an unknown transport instead of silently falling back', () => {
    expect(() => resolveMcpTransportConfig({ MCP_TRANSPORT: 'websockets' })).toThrow(/MCP_TRANSPORT/);
  });

  it('rejects a port outside the TCP range', () => {
    const base = { MCP_TRANSPORT: 'http', MCP_HTTP_AUTH_TOKEN: TEST_AUTH_TOKEN };
    expect(() => resolveMcpTransportConfig({ ...base, MCP_HTTP_PORT: '70000' })).toThrow(/MCP_HTTP_PORT/);
    expect(() => resolveMcpTransportConfig({ ...base, MCP_HTTP_PORT: 'not-a-port' })).toThrow(/MCP_HTTP_PORT/);
  });

  it('never echoes the auth token into a configuration error', () => {
    let message = '';
    try {
      resolveMcpTransportConfig({
        MCP_TRANSPORT: 'http',
        MCP_HTTP_AUTH_TOKEN: TEST_AUTH_TOKEN,
        MCP_HTTP_PORT: '70000',
      });
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toContain('MCP_HTTP_PORT');
    expect(message).not.toContain(TEST_AUTH_TOKEN);
  });
});

describe('MCP HTTP transport authentication', () => {
  it('refuses to start without a key, even when a caller asks for http', async () => {
    const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() as unknown as typeof fetch });

    await expect(server.runHttp({ authToken: '' })).rejects.toThrow(/non-empty auth token/);
    await expect(server.runHttp({ authToken: '   ' })).rejects.toThrow(/non-empty auth token/);
  });

  it('refuses an unauthenticated request before any tool can run', async () => {
    const fetchWithPayment = vi.fn().mockImplementation(paidCallResponse);
    const handle = await startHttp(fetchWithPayment);

    const res = await postJsonRpc(handle, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="lens-mcp"');
    expect(await res.json()).toMatchObject({
      jsonrpc: '2.0',
      error: {
        message: 'Missing or invalid bearer token',
        data: { code: MCP_ERROR_CODES.ERR_UNAUTHORIZED },
      },
    });
    expect(fetchWithPayment).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong token', `Bearer ${TEST_AUTH_TOKEN}-wrong`],
    ['the token without a scheme', TEST_AUTH_TOKEN],
    ['the wrong scheme', `Basic ${Buffer.from(TEST_AUTH_TOKEN).toString('base64')}`],
  ])('refuses %s', async (_label, authorization) => {
    const handle = await startHttp();

    const res = await postJsonRpc(handle, initializeMessage(1), { authorization });

    expect(res.status).toBe(401);
  });

  it('refuses a non-MCP path without revealing whether it exists', async () => {
    const handle = await startHttp();

    const unauthenticated = await fetch(mcpUrl(handle, '/admin'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const authenticated = await fetch(mcpUrl(handle, '/admin'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_AUTH_TOKEN}` },
      body: '{}',
    });

    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(404);
  });

  it('answers GET with 405 because a stateless transport cannot hold an SSE stream', async () => {
    const handle = await startHttp();

    const res = await fetch(mcpUrl(handle), {
      method: 'GET',
      headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}`, accept: 'text/event-stream' },
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('rejects a body that is not JSON with a structured parse error', async () => {
    const handle = await startHttp();

    const res = await fetch(mcpUrl(handle), {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      },
      body: '{ not json',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
  });

  it('rejects a non-JSON content type', async () => {
    const handle = await startHttp();

    const res = await fetch(mcpUrl(handle), {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}`, 'content-type': 'text/plain' },
      body: 'hello',
    });

    expect(res.status).toBe(415);
  });
});

describe('MCP HTTP transport parity', () => {
  it('exposes the same tools and the same paid_call result as a directly connected transport', async () => {
    const httpFetch = vi.fn().mockImplementation(paidCallResponse);
    const directFetch = vi.fn().mockImplementation(paidCallResponse);

    const handle = await startHttp(httpFetch);
    const httpClient = await connectClient(handle);
    const httpTools = await httpClient.listTools();
    const httpPaidCall = await httpClient.callTool({ name: 'paid_call', arguments: { url: PAID_URL } });
    await httpClient.close();

    // InMemoryTransport stands in for stdio: the same BazaarMcpServer and the
    // same SDK routing, without spawning a process to pipe stdin/stdout.
    const directServer = new BazaarMcpServer({ fetchWithPayment: directFetch as unknown as typeof fetch });
    const [directClientTransport, directServerTransport] = InMemoryTransport.createLinkedPair();
    await (directServer as any).server.connect(directServerTransport);
    const directClient = new Client({ name: 'lens-direct-test', version: '1.0.0' }, { capabilities: {} });
    await directClient.connect(directClientTransport);
    const directTools = await directClient.listTools();
    const directPaidCall = await directClient.callTool({ name: 'paid_call', arguments: { url: PAID_URL } });
    await directClient.close();
    await (directServer as any).server.close();

    expect(httpTools).toEqual(directTools);
    expect(httpTools.tools.map((tool: any) => tool.name)).toEqual(['bazaar_search', 'paid_call']);
    expect(httpPaidCall).toEqual(directPaidCall);
    expect(JSON.parse((httpPaidCall.content as any)[0].text)).toEqual({ asset: 'XLM', price: '0.15' });
    expect(httpFetch).toHaveBeenCalledWith(PAID_URL, { method: 'GET' });
  });

  it('advertises the budget tool over HTTP exactly as it does in-process', async () => {
    // payment_budget only exists when a budget is configured, which is the
    // shape the real npm run mcp:server takes. A parity check that never sets a
    // budget would pass while HTTP silently dropped the conditional tool.
    const httpBudget = makeBudget('http');
    const directBudget = makeBudget('direct');

    const handle = await startHttp(vi.fn(), httpBudget);
    const httpClient = await connectClient(handle);
    const httpNames = (await httpClient.listTools()).tools.map((tool: any) => tool.name);
    await httpClient.close();

    const directServer = new BazaarMcpServer({
      fetchWithPayment: vi.fn() as unknown as typeof fetch,
      budget: directBudget,
    });
    const [directClientTransport, directServerTransport] = InMemoryTransport.createLinkedPair();
    await (directServer as any).server.connect(directServerTransport);
    const directClient = new Client({ name: 'lens-budget-test', version: '1.0.0' }, { capabilities: {} });
    await directClient.connect(directClientTransport);
    const directNames = (await directClient.listTools()).tools.map((tool: any) => tool.name);
    await directClient.close();
    await (directServer as any).server.close();

    expect(httpNames).toEqual(directNames);
    expect(httpNames).toEqual(['bazaar_search', 'paid_call', 'payment_budget']);
  });

  it('keeps a deterministic tool error deterministic across the wire', async () => {
    const handle = await startHttp(
      vi.fn().mockResolvedValue(new Response('Payment Required', { status: 402 }))
    );
    const client = await connectClient(handle);

    const result = await client.callTool({ name: 'paid_call', arguments: { url: PAID_URL } });
    await client.close();

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as any)[0].text)).toMatchObject({
      isError: true,
      code: MCP_ERROR_CODES.ERR_PAYMENT_REJECTED,
    });
  });

  it('refuses a real SDK client that presents no token', async () => {
    const handle = await startHttp();
    const client = new Client({ name: 'lens-unauthenticated-test', version: '1.0.0' }, { capabilities: {} });

    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(handle))))
    ).rejects.toThrow();
  });

  it('serves a full initialize / tools/list handshake over POST', async () => {
    const handle = await startHttp();

    const initialized = await postJsonRpc(
      handle,
      initializeMessage(1),
      { authorization: `Bearer ${TEST_AUTH_TOKEN}` }
    );
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ jsonrpc: '2.0', id: 1 });

    const listed = await postJsonRpc(handle, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
      authorization: `Bearer ${TEST_AUTH_TOKEN}`,
    });
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.result.tools.map((tool: any) => tool.name)).toEqual(['bazaar_search', 'paid_call']);
  });

  it('answers tools/list without an initialize handshake, as the README curl does', async () => {
    // Stateless mode issues no Mcp-Session-Id, so there is no session to
    // initialize first. The documented one-shot curl relies on this.
    const handle = await startHttp();

    const listed = await postJsonRpc(handle, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.result.tools.map((tool: any) => tool.name)).toEqual(['bazaar_search', 'paid_call']);
  });
});
