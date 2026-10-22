import { describe, it, expect, vi } from 'vitest';
import { BazaarMcpServer, SERVER_VERSION, SERVER_NAME } from '../src/mcp/server';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
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

describe('BazaarMcpServer', () => {
  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    // The SDK server doesn't expose the router directly without a client, but we can test the handlePaidCallError method directly,
    // or by overriding setRequestHandler to capture our handler.
    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    
    // Re-setup handlers to capture the handler
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
  });

  it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('op_no_trust: The account does not have a trustline for this asset'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
  });

  it('should map 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required'
    });
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });
  
  it('should return successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: "hello" })
    });
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
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
    const server = new BazaarMcpServer({
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
    const server = new BazaarMcpServer({
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
    // #416: the page the server asks the node for is bounded by default, so the
    // first hop carries limit/offset.
    expect(calls).toEqual(['https://ok.example/discovery/resources?limit=50&offset=0']);
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
      expect(content.reason).toContain("'url'");
    });

    it('rejects empty string url', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'bazaar_search', arguments: { url: '' } } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
      expect(content.reason).toContain('empty');
    });

    it('rejects non-string url', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'bazaar_search', arguments: { url: 12345 } } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
    });

    it('rejects non-string query', async () => {
      const server = new BazaarMcpServer({ paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'bazaar_search', arguments: { url: 'https://example.com', query: 999 } },
      });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'query'");
    });
  });

  describe('paid_call', () => {
    it('rejects call when url argument is missing without attempting fetch', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'paid_call', arguments: {} } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects empty string url', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'paid_call', arguments: { url: '' } } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects non-string url', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({ params: { name: 'paid_call', arguments: { url: true } } });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'url'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects out-of-range / invalid http method', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid', method: 'INVALID' } },
      });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'method'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects unrecognized extra properties in strict schema', async () => {
      const mockFetch = vi.fn();
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid', extraField: 123 } },
      });
      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_BAD_REQUEST');
      expect(content.reason).toContain("'extraField'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('accepts valid http method and passes it to fetchWithPayment', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      });
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid', method: 'POST' } },
      });
      expect(response.isError).toBeFalsy();
      // objectContaining, not an exact match: the request also carries an
      // AbortSignal deadline. This asserts the method is passed through, which
      // is what the test is about.
      expect(mockFetch).toHaveBeenCalledWith(
        'http://example.com/paid',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('defaults method to GET when omitted', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      });
      const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });
      const { callHandler } = captureHandlers(server);
      const response = await callHandler({
        params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } },
      });
      expect(response.isError).toBeFalsy();
      // objectContaining, not an exact match: the request also carries an
      // AbortSignal deadline. This asserts the method is passed through, which
      // is what the test is about.
      expect(mockFetch).toHaveBeenCalledWith(
        'http://example.com/paid',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });
});

describe('BazaarMcpServer bazaar_search upstream failures (#349)', () => {
  function run(fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>) {
    const server: any = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], lookup: async () => ['93.184.216.34'], fetchImpl },
    });
    let handler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    server.setupHandlers();
    return handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });
  }

  it('passes a deadline signal to the upstream call', async () => {
    let signal: AbortSignal | null | undefined;
    await run(async (_input, init) => {
      signal = init?.signal;
      return new Response('{"resources":[{"a":1}]}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('returns a structured error naming the upstream when the call times out', async () => {
    const response = await run(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.code).toBe('ERR_SERVICE_UNREACHABLE');
    expect(body.reason).toContain('ok.example');
    expect(body.reason).toContain('did not respond');
  });

  it('rejects a non-2xx response naming the upstream and status', async () => {
    const response = await run(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.code).toBe('ERR_SERVICE_UNREACHABLE');
    expect(body.reason).toContain('ok.example');
    expect(body.reason).toContain('502');
  });

  it('rejects a 200 with a non-JSON content type before parsing', async () => {
    const response = await run(
      async () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.code).toBe('ERR_SERVICE_UNREACHABLE');
    expect(body.reason).toContain('ok.example');
    expect(body.reason).toContain('text/html');
  });

  it('rejects a JSON content type with an unparseable body', async () => {
    const response = await run(
      async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.reason).toContain('not valid JSON');
  });
});

import { classifyPaidCallError } from '../src/mcp/codes';

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


describe('BazaarMcpServer paid_call error classification', () => {
  it('maps a signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    // Stellar SDK throws an Error whose message includes the ledge number.
    const sdkError = new Error(
      'Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'
    );
    const mockFetch = vi.fn().mockRejectedValue(sdkError);
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.org'] });
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
    const mockFetch = vi.fn().mockRejectedValue(horizonError);
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.org'] });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
  });

  it('maps a 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required',
    });
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.org'] });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });

  it('returns successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: 'hello' }),
    });
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.org'] });
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

// ── Cumulative spend budget (#405) ───────────────────────────────────────────
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SpendBudget, parseUsdToNanodollars } from '../src/mcp/budget';
import { MCP_ERROR_CODES } from '../src/mcp/codes';


const PAID_URL = 'http://example.com/paid';

type CapturedHandler = (request: any) => Promise<any>;

/**
 * The SDK Server only routes once a transport is connected, so the handlers are
 * captured by swapping setRequestHandler for a recorder and re-running
 * setupHandlers(), which is what the tests above already do inline.
 */
function createBudgetHarness(fetchWithPayment: Mock, budget: SpendBudget) {
  const server = new BazaarMcpServer({
    fetchWithPayment: fetchWithPayment as unknown as typeof fetch,
    budget,
    // The paid_call allow-list (#404) landed after this suite was written and
    // is checked before the budget. Without the host named here every case
    // below fails with ERR_HOST_NOT_ALLOWED and never reaches the ceiling.
    paidCallAllowlist: ['example.com'],
  });

  const handlers = new Map<unknown, CapturedHandler>();
  (server as any).server.setRequestHandler = (schema: unknown, fn: CapturedHandler) => {
    handlers.set(schema, fn);
  };
  (server as any).setupHandlers();

  const callTool = handlers.get(CallToolRequestSchema);
  const listTools = handlers.get(ListToolsRequestSchema);
  if (!callTool || !listTools) {
    throw new Error('BazaarMcpServer did not register both a ListTools and a CallTool handler');
  }

  return {
    listTools: () => listTools({}),
    callTool: (name: string, args?: Record<string, unknown>) => callTool({ params: { name, arguments: args } }),
  };
}

/**
 * Each call must hand back a fresh Response: a Response body can only be read
 * once, and reusing one instance would fail the second call for a reason that
 * has nothing to do with the budget.
 */
function cheapPaidCall(): Mock {
  return vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ price: '1.00' }), { status: 200 }))
    );
}

describe('cumulative spend budget', () => {
  let tempDir: string | undefined;

  function spendStateFile(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'lens-mcp-budget-'));
    return join(tempDir, 'spend-state.json');
  }

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses the call that would take the day total past the ceiling, without paying for it', async () => {
    // Three calls at the $1.00 per-call maximum fill the $3.00 ceiling; each one is
    // individually inside the per-call limit, which is the whole point of the issue.
    const fetchWithPayment = cheapPaidCall();
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$3.00' });
    const { callTool } = createBudgetHarness(fetchWithPayment, budget);

    for (let call = 1; call <= 3; call++) {
      const response = await callTool('paid_call', { url: PAID_URL });
      expect(response.isError, `call ${call} should still fit the ceiling`).toBeFalsy();
    }
    expect(budget.snapshot().spentToday).toBe('$3.00');
    expect(budget.snapshot().remainingToday).toBe('$0.00');

    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(refusal.isError).toBe(true);
    const payload = JSON.parse(refusal.content[0].text);
    expect(payload.code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);
    expect(payload.reason).toContain('Daily spend ceiling reached');
    // The agent has to be able to tell "out of budget" from "broken", and to see
    // what is left, from the refusal alone.
    expect(payload.details.budget).toMatchObject({
      currency: 'USD',
      perCallMax: '$1.00',
      dailyCeiling: '$3.00',
      spentToday: '$3.00',
      remainingToday: '$0.00',
      state: 'ok',
    });
    // Refusing must not spend: the ceiling gate runs before the payment fetch.
    expect(fetchWithPayment).toHaveBeenCalledTimes(3);
  });

  it('refuses a call whose worst case no longer fits, instead of overspending the remainder', async () => {
    const fetchWithPayment = cheapPaidCall();
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$2.50' });
    const { callTool } = createBudgetHarness(fetchWithPayment, budget);

    expect((await callTool('paid_call', { url: PAID_URL })).isError).toBeFalsy();
    await callTool('paid_call', { url: PAID_URL });
    expect(budget.snapshot().remainingToday).toBe('$0.50');

    // $0.50 is left, but a call can cost up to $1.00, so the reservation cannot fit.
    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(refusal.isError).toBe(true);
    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);
    expect(fetchWithPayment).toHaveBeenCalledTimes(2);
    expect(budget.snapshot().spentToday).toBe('$2.00');
  });

  it('resumes the day total after a restart, so a restart does not refill the budget', async () => {
    const file = spendStateFile();
    const options = { perCallMax: '$1.00', dailyCeiling: '$2.00', stateFilePath: file };

    const firstProcess = createBudgetHarness(cheapPaidCall(), new SpendBudget(options));
    await firstProcess.callTool('paid_call', { url: PAID_URL });
    await firstProcess.callTool('paid_call', { url: PAID_URL });

    // A fresh SpendBudget is what a server restart builds: same configuration, same file.
    const restarted = new SpendBudget(options);
    expect(restarted.snapshot().spentToday).toBe('$2.00');

    const fetchWithPayment = cheapPaidCall();
    const secondProcess = createBudgetHarness(fetchWithPayment, restarted);
    const refusal = await secondProcess.callTool('paid_call', { url: PAID_URL });

    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);
    expect(fetchWithPayment).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, spentNanodollars: '2000000000' });
  });

  it('starts a fresh window at UTC midnight', async () => {
    let current = new Date('2026-10-17T23:30:00.000Z');
    const file = spendStateFile();
    const budget = new SpendBudget({
      perCallMax: '$1.00',
      dailyCeiling: '$1.00',
      stateFilePath: file,
      now: () => current,
    });
    const { callTool } = createBudgetHarness(cheapPaidCall(), budget);

    expect((await callTool('paid_call', { url: PAID_URL })).isError).toBeFalsy();
    const sameDay = await callTool('paid_call', { url: PAID_URL });
    expect(JSON.parse(sameDay.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);

    current = new Date('2026-10-18T00:00:00.000Z');

    expect((await callTool('paid_call', { url: PAID_URL })).isError).toBeFalsy();
    expect(budget.snapshot()).toMatchObject({
      day: '2026-10-18',
      spentToday: '$1.00',
      resetsAt: '2026-10-19T00:00:00.000Z',
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ day: '2026-10-18' });
  });

  it('does not charge the budget when the seller rejects the payment', async () => {
    const fetchWithPayment = vi.fn().mockResolvedValue(new Response('Payment Required', { status: 402 }));
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$1.00' });
    const { callTool } = createBudgetHarness(fetchWithPayment, budget);

    const rejection = await callTool('paid_call', { url: PAID_URL });

    expect(JSON.parse(rejection.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_PAYMENT_REJECTED);
    expect(budget.snapshot().spentToday).toBe('$0.00');
    // Rejected money never settled, so the call must be repeatable within the ceiling.
    expect(budget.authorize().allowed).toBe(true);
  });

  it('treats an unreadable state file as fully spent rather than as a clean slate', async () => {
    const file = spendStateFile();
    writeFileSync(file, 'not json at all', 'utf8');
    // The budget degrades while loading, so the spy has to be in place first.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchWithPayment = cheapPaidCall();
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$10.00', stateFilePath: file });
    const { callTool } = createBudgetHarness(fetchWithPayment, budget);

    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BUDGET_EXCEEDED);
    expect(JSON.parse(refusal.content[0].text).details.budget.state).toBe('unavailable');
    expect(fetchWithPayment).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('shows both limits in the tool description and the live budget as a tool', async () => {
    const budget = new SpendBudget({ perCallMax: '$1.00', dailyCeiling: '$10.00' });
    const { listTools, callTool } = createBudgetHarness(cheapPaidCall(), budget);

    const { tools } = await listTools();
    const paidCallTool = tools.find((tool: any) => tool.name === 'paid_call');
    expect(paidCallTool.description).toContain('capped per call at $1.00');
    expect(paidCallTool.description).toContain('$10.00 per UTC day');
    expect(paidCallTool.description).toContain('ERR_BUDGET_EXCEEDED');

    const budgetTool = tools.find((tool: any) => tool.name === 'payment_budget');
    expect(budgetTool).toBeDefined();
    expect(ToolSchema.safeParse(budgetTool).success).toBe(true);

    const reported = await callTool('payment_budget');
    expect(reported.isError).toBeFalsy();
    expect(JSON.parse(reported.content[0].text)).toMatchObject({
      currency: 'USD',
      perCallMax: '$1.00',
      dailyCeiling: '$10.00',
      spentToday: '$0.00',
      reservedToday: '$0.00',
      remainingToday: '$10.00',
      state: 'ok',
    });

    await callTool('paid_call', { url: PAID_URL });
    expect(JSON.parse((await callTool('payment_budget')).content[0].text).remainingToday).toBe('$9.00');
  });

  it('refuses to start with limits that could never allow a call', () => {
    expect(() => new SpendBudget({ perCallMax: '$10.00', dailyCeiling: '$1.00' })).toThrow(/exceeds dailyCeiling/);
    expect(() => new SpendBudget({ perCallMax: 'free', dailyCeiling: '$1.00' })).toThrow(/Invalid USD amount/);
    expect(() => new SpendBudget({ perCallMax: '-$1.00', dailyCeiling: '$10.00' })).toThrow(/Invalid USD amount/);
  });

  it('parses money strings into exact integer nanodollars', () => {
    expect(parseUsdToNanodollars('$1.00')).toBe(1_000_000_000n);
    expect(parseUsdToNanodollars('$0.10')).toBe(100_000_000n);
    expect(parseUsdToNanodollars('0')).toBe(0n);
    expect(() => parseUsdToNanodollars('$1.0000000000')).toThrow(/more than 9 decimal places/);
  })
})
