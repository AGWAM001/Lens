import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BazaarMcpServer, classifyPaidCallError, SERVER_VERSION, SERVER_NAME } from '../src/mcp/server.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PAID_CALL_HTTP_METHODS } from '../src/mcp/toolSchemas';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };

describe('BazaarMcpServer — server identity', () => {
  it('advertises the version from package.json (never a hard-coded string)', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('uses the canonical server name lens-mcp-server (client-affecting rename from bazaar-mcp-server)', () => {
    expect(SERVER_NAME).toBe('lens-mcp-server');
  });
});

/**
 * Realistic error shapes from the Stellar SDK / x402 libraries / fetch layer.
 * These are constructed to mirror the structured properties those libraries
 * actually attach to thrown errors, rather than hand-written strings.
 */

function captureHandler(server: BazaarMcpServer): any {
  let handler: any = null;
  // Capture the handler through the server's own router.
  (server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) {
      handler = fn;
    }
  };
  (server as any).setupHandlers();
  return handler;
}

describe('BazaarMcpServer', () => {
  it('maps a signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    // Stellar SDK throws an Error whose message includes the ledge number.
    const sdkError = new Error(
      'Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'
    );
    const mockFetch = vi.fn().mockRejected(sdkError);
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
  });

  it('maps a Horizon transaction_failed result_codes body to ERR_MISSING_TRUSTLINE', async () => {
    // Horizon returns this shape on a transaction_failed response.
    const horizonError: any = new Error('Transaction failed');
    horizonError.result_codes = {
      transaction: 'tx_failed',
      operations: ['op_no_trust'],
    };
    const mockFetch = vi.fn().mockRejected(horizonError);
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
  });

  it('maps a 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
    const mockFetch = vi.fn().mockResolved({
      ok: false,
      status: 402,
      text: async () => 'Payment Required',
    });
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });

  it('returns successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolved({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: 'hello' }),
    });
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
  });
});

describe('classifyPaidCallError', () => {
  it('prefers a structured Horizon result_codes body over text', () => {
    // Message wording is deliberately misleading: the structured code must win.
    const err: any = new Error('network error while fetching');
    err.result_codes = { transaction: 'tx_failed', operations: ['op_underfunded'] };
    const result = classifyPaidCallError(err);
    expect(result.code).toBe('ERR_INSUFFICIENT_BALANCE');
    expect(result.isFallback).toBe(false);
  });

  it('does not report a payment failure mentioning "fetch" as unreachable', () => {
    // This is the regression the issue calls out: the word "fetch" in a
    // payment failure must not be treated as a network error.
    const err = new Error('Payment failed: fetch of the signed transaction was rejected');
    const result = classifyPaidCallError(err);
    expect(result.code).not.toBe('ERR_SERVICE_UNREACHABLE');
  });

  it('marks the text path as a fallback', () => {
    const err = new Error('op_underfunded');
    const result = classifyPaidCallError(err);
    expect(result.code).toBe('ERR_INSUFFICIENT_BALANCE');
    expect(result.isFallback).toBe(true);
  });

  it('preserves the original message for the unclassified case', () => {
    const original = 'Something unexpected happened in the payment flow';
    const result = classifyPaidCallError(new Error(original));
    expect(result.code).toBe('ERR_INTERNAL_FAILURE');
    expect(result.reason).toContain(original);
  });
});

describe('BazaarMcpServer bazaar_search SSRF guard (#407)', () => {
  function captureHandler(server: any) {
    let handler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    server.setupHandlers();
    return handler;
  }

  const publicLookup = { lookup: async () => ['93.184.216.34'] };
  const okFetchImpl = async () =>
    new Response(JSON.stringify({ resources: [{ name: 'x' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('rejects a non-http(s) scheme', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'file:///etc' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a private / metadata literal', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'http://169.254.169.254' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const server = new BazaarMcpServer( {
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], lookup: async () => ['127.0.0.1'], fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://innocent.example' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a redirect to a forbidden host', async () => {
    const calls: string[] = [];
    const server = new BazaarMcpServer( {
      fetchWithPayment: vi.fn(),
      bazaarFetch: {
        allowedHosts: [],
        ...publicLookup,
        fetchImpl: async (input: string | URL) => {
          calls.push(String(input));
          return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
        },
      },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
    expect(calls).toEqual(['https://ok.example/discovery/resources']);
  });

  it('returns results from a permitted public host', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example', query: 'xlm' } } });
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0].text).resources[0].name).toBe('x');
  });
});

describe('BazaarMcpServer argument validation (#411)', () => {
  function captureHandlers(server: any) {
    let callHandler: any = null;
    let listHandler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) callHandler = fn;
      if (schema === ListToolsRequestSchema) listHandler = fn;
    };
    server.setupHandlers();
    return { callHandler, listHandler };
  }

  describe('advertised schema', () => {
    it('advertises schemas derived from Zod definitions', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { listHandler } = captureHandlers(server);
      const res = await listHandler({});
      const tools = res.tools as Array<{ name: string; inputSchema: any }>;

      const searchTool = tools.find((t) => t.name === 'bazaar_search');
      expect(searchTool).toBeDefined();
      expect(searchTool?.inputSchema.type).toBe('object');
      expect(searchTool?.inputSchema.required).toEqual(['url']);
      expect(searchTool?.inputSchema.properties.url.type).toBe('string');
      expect(searchTool?.inputSchema.properties.query.type).toBe('string');

      const paidTool = tools.find((t) => t.name === 'paid_call');
      expect(paidTool).toBeDefined();
      expect(paidTool?.inputSchema.type).toBe('object');
      expect(paidTool?.inputSchema.required).toEqual(['url']);
      expect(paidTool?.inputSchema.properties.url.type).toBe('string');
      expect(paidTool?.inputSchema.properties.method.type).toBe('string');
      expect(paidTool?.inputSchema.properties.method.enum).toEqual(PAID_CALL_HTTP_METHODS);
      expect(paidTool?.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('bazaar_search', () => {
    it('rejects call when url argument is missing', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'bazaar_search', arguments: {} } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
    });

    it('rejects call when arguments object is omitted', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'bazaar_search' } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
    });
  });
});
