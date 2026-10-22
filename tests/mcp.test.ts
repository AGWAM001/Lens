import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { BazaarMcpServer, SERVER_VERSION, SERVER_NAME } from '../src/mcp/server';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
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

// ── Discovery routing, advertised tools and the payment audit ledger ─────────
// This branch's half of the file, restored after a merge that replaced it
// wholesale. Main's half above covers the SSRF guard (#407), argument validation
// (#411), discovery upstream failures (#349) and paid-call classification; what
// follows covers where discovery routes to, what the server advertises, and what
// the PaymentLedger this branch adds actually records.
import { register } from '../src/metrics';
import { PaymentLedger } from '../src/mcp/ledger';

/**
 * Hosts these cases are allowed to pay. The gate itself — and every way it
 * refuses — is tested in tests/mcp-paid-call-allowlist.test.ts; naming the
 * fixtures here just lets the cases below reach the code they are about.
 */
const HARNESS_PAID_CALL_ALLOWLIST = [
  'bazaar.example',
  'ledger-audit.test',
  'ledger-offer.test',
  'ledger-sum.test',
  'ledger-metrics.test',
  // Payable, but deliberately absent from the ledger's metricHosts below.
  'not-allow-listed.test',
];

function createHarness(
  fetchWithPayment: Mock = vi.fn(),
  budget?: SpendBudget,
  paymentLedger?: PaymentLedger,
  bazaarFetch?: Record<string, unknown>
) {
  const server = new BazaarMcpServer({
    fetchWithPayment: fetchWithPayment as unknown as typeof fetch,
    paidCallAllowlist: HARNESS_PAID_CALL_ALLOWLIST,
    ...(budget ? { budget } : {}),
    ...(paymentLedger ? { paymentLedger } : {}),
    ...(bazaarFetch ? { bazaarFetch: bazaarFetch as any } : {}),
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
    fetchWithPayment,
    ledger: server.paymentLedger,
    listTools: () => listTools({}),
    callTool: (name: string, args?: Record<string, unknown>) =>
      callTool({ params: { name, arguments: args } }),
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** undici's real shape for a connection-level failure. */
function transportFailure() {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 203.0.113.10:443'), {
      code: 'ECONNREFUSED',
    }),
  });
}

function parseFailure(result: { success: boolean; error?: unknown }) {
  return result.success ? '' : String(result.error);
}

describe('bazaar_search discovery routing', () => {
  /**
   * Drives discovery through an injected lookup and transport, so no case here
   * touches DNS or a socket, and records every URL the server asked the node for.
   */
  function searchHarness(respond: () => Response | Promise<Response>) {
    const calls: string[] = [];
    const harness = createHarness(vi.fn(), undefined, undefined, {
      allowedHosts: [],
      lookup: async () => ['93.184.216.34'],
      fetchImpl: async (input: string | URL) => {
        calls.push(String(input));
        return respond();
      },
    });
    return { ...harness, calls };
  }

  it('lists resources from /discovery/resources when no query is given', async () => {
    const body = {
      resources: [
        {
          name: 'Mock Price Feed',
          description: 'Price data for XLM',
          url: 'https://bazaar.example/api/v1/price',
        },
      ],
    };
    const { callTool, calls, fetchWithPayment } = searchHarness(() => jsonResponse(body));

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example/' });

    // A trailing slash on the base URL must not produce a double slash, and the
    // page is bounded by default (#416).
    expect(calls).toEqual(['https://bazaar.example/discovery/resources?limit=50&offset=0']);
    // Discovery must never spend: only paid_call may reach the payment signer.
    expect(fetchWithPayment).not.toHaveBeenCalled();
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0].text)).toEqual(body);
  });

  it('routes a query to /discovery/search with the query URL-encoded', async () => {
    const body = {
      resources: [{ name: 'Mock Price Feed', url: 'https://bazaar.example/api/v1/price' }],
    };
    const { callTool, calls } = searchHarness(() => jsonResponse(body));

    const response = await callTool('bazaar_search', {
      url: 'https://bazaar.example',
      query: 'XLM/USD spot',
    });

    expect(calls).toEqual(['https://bazaar.example/discovery/search?q=XLM%2FUSD+spot&limit=50&offset=0']);
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0].text)).toEqual(body);
  });

  it('maps an empty resources array to ERR_NO_RESULTS', async () => {
    const { callTool } = searchHarness(() => jsonResponse({ resources: [] }));

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_NO_RESULTS,
      reason: 'No resources found',
    });
  });

  it('maps an empty top-level array to ERR_NO_RESULTS', async () => {
    const { callTool } = searchHarness(() => jsonResponse([]));

    const response = await callTool('bazaar_search', {
      url: 'https://bazaar.example',
      query: 'nothing indexed yet',
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_NO_RESULTS,
      reason: 'No resources found',
    });
  });

  it('maps a non-2xx response to ERR_SERVICE_UNREACHABLE with the status in the reason', async () => {
    const { callTool } = searchHarness(() => new Response('Service Unavailable', { status: 503 }));

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example' });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.code).toBe(MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE);
    expect(payload.reason).toContain('bazaar.example');
    expect(payload.reason).toContain('503');
  });

  it('maps a 200 carrying an unparseable body to ERR_SERVICE_UNREACHABLE', async () => {
    // A gateway can answer 200 with HTML. The content type is checked before the
    // body is parsed, so the reason names the type instead of a parse error.
    const { callTool } = searchHarness(
      () =>
        new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
    );

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example' });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.code).toBe(MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE);
    expect(typeof payload.reason).toBe('string');
    expect(payload.reason.length).toBeGreaterThan(0);
  });

  it('maps a transport failure to ERR_SERVICE_UNREACHABLE', async () => {
    const { callTool } = searchHarness(() => Promise.reject(transportFailure()));

    const response = await callTool('bazaar_search', { url: 'https://bazaar.example' });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.code).toBe(MCP_ERROR_CODES.ERR_SERVICE_UNREACHABLE);
    expect(payload.reason).toContain('bazaar.example');
    expect(payload.reason).toContain('fetch failed');
  });
});

describe('paid_call upstream failures', () => {
  const TARGET_URL = 'https://bazaar.example/api/v1/price';

  it('maps a transport failure to ERR_INTERNAL_FAILURE when nothing structured survives', async () => {
    // undici reports a connection-level failure as TypeError("fetch failed") and
    // puts the real reason on `cause`. classifyPaidCallError reads the message and
    // a Horizon result_codes body, not `cause`, so there is no signal to match and
    // the message is preserved verbatim rather than guessed at.
    const fetchWithPayment = vi.fn().mockRejectedValue(transportFailure());
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: TARGET_URL });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_INTERNAL_FAILURE,
      reason: 'fetch failed',
    });
  });

  it('maps an unmatched non-402 status to ERR_BAD_REQUEST', async () => {
    const fetchWithPayment = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: TARGET_URL });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_BAD_REQUEST,
      reason: 'Request failed with status 500',
    });
  });

  it('falls through to ERR_INTERNAL_FAILURE and keeps the upstream reason verbatim', async () => {
    // @x402/fetch wraps whatever ExactStellarScheme threw while building the
    // payment; this one is its asset-address validation.
    const reason =
      'Failed to create payment payload: Invalid Stellar asset address: not-a-stellar-asset';
    const fetchWithPayment = vi.fn().mockRejectedValue(new Error(reason));
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: TARGET_URL });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_INTERNAL_FAILURE,
      reason,
    });
  });

  it('reports an unregistered scheme client as ERR_INTERNAL_FAILURE instead of blaming the network', async () => {
    // @x402/core throws this when no client matches the payment requirements. It
    // is local misconfiguration, yet the substring "network" in the message used
    // to route it to ERR_SERVICE_UNREACHABLE and point the agent at the remote
    // service instead of its own x402 config. A text match now has to be one of
    // the signals classifyByText lists, so this stays unclassified and keeps its
    // original message.
    const message = 'No client registered for scheme: exact and network: stellar:pubnet';
    const fetchWithPayment = vi.fn().mockRejectedValue(new Error(message));
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: TARGET_URL });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_INTERNAL_FAILURE,
      reason: message,
    });
  });

  it('cannot see a trustline failure that lives in the structured result codes', async () => {
    // Horizon reports why a transaction failed in extras.result_codes, nested
    // under `response.data`, and extractStructuredSignal only reads a top-level
    // `result_codes` — so op_no_trust is lost. Plain-string fixtures hide this;
    // the real error object does not.
    const failure: any = new Error('Transaction submission failed');
    failure.response = {
      status: 400,
      data: {
        title: 'Transaction Failed',
        status: 400,
        detail: 'The transaction failed when submitted to the ledger.',
        extras: {
          result_codes: { transaction: 'tx_failed', operations: ['op_no_trust'] },
        },
      },
    };
    const fetchWithPayment = vi.fn().mockRejectedValue(failure);
    const { callTool } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: TARGET_URL });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.code).not.toBe(MCP_ERROR_CODES.ERR_MISSING_TRUSTLINE);
    expect(payload).toEqual({
      isError: true,
      code: MCP_ERROR_CODES.ERR_INTERNAL_FAILURE,
      reason: 'Transaction submission failed',
    });
  });
});

describe('ListTools', () => {
  it('advertises exactly bazaar_search and paid_call', async () => {
    const { listTools } = createHarness();

    const result = await listTools();

    expect(result.tools.map((tool: any) => tool.name)).toEqual(['bazaar_search', 'paid_call']);
  });

  it('returns a result a client can parse with the SDK ListTools schema', async () => {
    const { listTools } = createHarness();

    const result = await listTools();
    const parsed = ListToolsResultSchema.safeParse(result);

    expect(parsed.success, parseFailure(parsed)).toBe(true);
  });

  it('declares a valid inputSchema for every advertised tool', async () => {
    const { listTools } = createHarness();

    const { tools } = await listTools();
    expect(tools).toHaveLength(2);

    for (const tool of tools) {
      const parsed = ToolSchema.safeParse(tool);
      expect(parsed.success, `${tool.name}: ${parseFailure(parsed)}`).toBe(true);
      expect(tool.inputSchema.type, `${tool.name}: MCP requires an object inputSchema`).toBe(
        'object'
      );

      const declared = Object.keys(tool.inputSchema.properties ?? {});
      // Both tools read arguments.url unconditionally; an agent that omits it
      // would otherwise get a request to the literal string "undefined".
      expect(tool.inputSchema.required, `${tool.name}: url must be required`).toContain('url');
      for (const required of tool.inputSchema.required ?? []) {
        expect(declared, `${tool.name}: "${required}" is required but undeclared`).toContain(
          required
        );
      }
    }
  });
});

describe('unknown tool', () => {
  it('rejects instead of returning a best-effort result', async () => {
    const { callTool } = createHarness();

    // The handler throws, so the SDK surfaces this as a JSON-RPC error rather
    // than a structured McpErrorResponse — the agent gets no error code.
    await expect(callTool('bazaar_refund')).rejects.toThrow('Unknown tool: bazaar_refund');
  });
});

/**
 * x402 v2 payment header as the client's transport sends it: the seller's own
 * requirements echoed under `accepted`, plus `payload`, the signed envelope.
 * `payload` is the only thing here the ledger must never read, so it carries a
 * marker no record may contain.
 */
const PAYMENT_OFFER = {
  x402Version: 2,
  resource: 'https://ledger-offer.test/api/v1/price',
  accepted: {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: 'native',
    amount: '$0.10',
  },
  payload: { txEnvelopeXdr: 'DECOY-SIGNED-ENVELOPE-MUST-NOT-BE-RECORDED' },
};

/** Settlement header a resource server returns for a payment it accepted. */
const SETTLEMENT = {
  success: true,
  network: 'stellar:testnet',
  // A fixture, not a ledger entry: 64 hex characters written in full, never shortened.
  transaction: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
};

const ENVELOPE_MARKER = 'DECOY-SIGNED-ENVELOPE-MUST-NOT-BE-RECORDED';

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function settledResponse(body: unknown, settle: unknown = SETTLEMENT) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'payment-response': base64Json(settle),
    },
  });
}

describe('payment audit ledger', () => {
  const PAID_URL = 'https://ledger-audit.test/api/v1/price';

  let ledgerDir: string | undefined;

  beforeEach(() => {
    ledgerDir = undefined;
  });

  afterEach(() => {
    if (ledgerDir) {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  function tempLedgerFile(name: string): string {
    ledgerDir = mkdtempSync(join(tmpdir(), 'lens-mcp-ledger-'));
    return join(ledgerDir, name);
  }

  /**
   * Discovery goes through the SSRF-safe fetch, so it needs a lookup and a
   * transport of its own to stay off DNS and sockets.
   */
  function discoveryStub(body: unknown = { resources: [{ name: 'Mock Price Feed', url: PAID_URL }] }) {
    return {
      allowedHosts: [],
      lookup: async () => ['93.184.216.34'],
      fetchImpl: async () => jsonResponse(body),
    };
  }

  /**
   * Wires the ledger the way run.ts does: the ledger wraps the transport's fetch,
   * and a stand-in for wrapFetchWithPayment adds the payment header that the real
   * scheme builds. The price is only observable there — the wrapped fetch hands
   * back a plain Response with no amount on it.
   */
  function createPaidTransport(ledger: PaymentLedger, respond: () => Response) {
    const instrumented = ledger.instrumentFetch(
      vi.fn().mockImplementation(async () => respond()) as unknown as typeof fetch
    );
    const transport = vi.fn(async (url: string, init?: RequestInit) =>
      instrumented(url, { ...init, headers: { 'payment-signature': base64Json(PAYMENT_OFFER) } })
    );
    return createHarness(transport as unknown as Mock, undefined, ledger);
  }

  it('records a failed payment as an attempt', async () => {
    const fetchWithPayment = vi.fn().mockResolvedValue(new Response('Payment Required', { status: 402 }));
    const { callTool, ledger } = createHarness(fetchWithPayment);

    const response = await callTool('paid_call', { url: PAID_URL });

    expect(response.isError).toBe(true);
    const [record] = ledger.records();
    expect(ledger.records()).toHaveLength(1);
    expect(record).toMatchObject({
      url: PAID_URL,
      host: 'ledger-audit.test',
      method: 'GET',
      outcome: 'failure',
      spend: 'none',
      errorCode: MCP_ERROR_CODES.ERR_PAYMENT_REJECTED,
      transactionHash: null,
    });
    expect(Date.parse(record.timestamp)).not.toBeNaN();
  });

  it('records every paid call, whatever the transport did with it', async () => {
    const ledger = new PaymentLedger();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(settledResponse({ price: '1.00' }))
      .mockResolvedValueOnce(new Response('Payment Required', { status: 402 }))
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
      .mockRejectedValueOnce(transportFailure());
    const { callTool } = createHarness(transport, undefined, ledger);

    await callTool('paid_call', { url: PAID_URL, method: 'POST' });
    await callTool('paid_call', { url: PAID_URL });
    await callTool('paid_call', { url: 'https://ledger-audit.test/api/v1/other' });
    await callTool('paid_call', { url: PAID_URL });

    expect(ledger.records().map((record) => [record.outcome, record.errorCode])).toEqual([
      ['success', null],
      ['failure', MCP_ERROR_CODES.ERR_PAYMENT_REJECTED],
      ['failure', MCP_ERROR_CODES.ERR_BAD_REQUEST],
      ['failure', MCP_ERROR_CODES.ERR_INTERNAL_FAILURE],
    ]);
    // The method the agent asked for, carried through to the record.
    expect(ledger.records()[0].method).toBe('POST');
    // A call that threw before any response existed cannot be proved unspent.
    expect(ledger.records()[3].spend).toBe('possible');

    // A url the argument schema rejects is refused before anything is spent, so
    // there is no attempt for the ledger to record — and none appears.
    const refused = await callTool('paid_call', { url: 'not a url at all' });
    expect(JSON.parse(refused.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_BAD_REQUEST);
    expect(ledger.records()).toHaveLength(4);
  });

  it('records the transaction hash the seller echoes on settlement', async () => {
    const ledger = new PaymentLedger();
    const { callTool } = createHarness(vi.fn().mockResolvedValue(settledResponse({ price: '1.00' })), undefined, ledger);

    await callTool('paid_call', { url: PAID_URL });

    expect(ledger.records()[0]).toMatchObject({
      outcome: 'success',
      spend: 'settled',
      transactionHash: SETTLEMENT.transaction,
      network: 'stellar:testnet',
    });
  });

  it('reads the price off the payment header the transport sends', async () => {
    const ledger = new PaymentLedger();
    const { callTool } = createPaidTransport(ledger, () => settledResponse({ price: '1.00' }));

    const response = await callTool('paid_call', { url: 'https://ledger-offer.test/api/v1/price' });

    expect(response.isError).toBeFalsy();
    expect(ledger.records()[0]).toMatchObject({
      amount: '$0.10',
      asset: 'native',
      network: 'stellar:testnet',
      outcome: 'success',
      // The envelope settled, so the offer price is what was spent.
      spend: 'settled',
    });
  });

  it('records no secret material from the payment header', async () => {
    const ledger = new PaymentLedger({ filePath: tempLedgerFile('payments.jsonl') });
    const { callTool } = createPaidTransport(ledger, () => settledResponse({ price: '1.00' }));

    await callTool('paid_call', { url: 'https://ledger-offer.test/api/v1/price' });

    const record = JSON.stringify(ledger.records()[0]);
    const file = readFileSync(ledgerDir + '/payments.jsonl', 'utf8');
    for (const stored of [record, file]) {
      expect(stored).not.toContain(ENVELOPE_MARKER);
      expect(stored).not.toContain('txEnvelopeXdr');
      expect(stored).not.toContain('payload');
    }
    // The offer is recorded; the signature that carried it is not.
    expect(record).toContain('$0.10');
  });

  it('appends one line per attempt to the audit file, oldest first', async () => {
    const filePath = tempLedgerFile('payments.jsonl');
    const ledger = new PaymentLedger({ filePath });
    const fetchWithPayment = vi
      .fn()
      .mockResolvedValueOnce(settledResponse({ price: '1.00' }))
      .mockResolvedValueOnce(new Response('Payment Required', { status: 402 }));
    const { callTool } = createHarness(fetchWithPayment, undefined, ledger, discoveryStub());

    await callTool('paid_call', { url: PAID_URL });
    await callTool('paid_call', { url: PAID_URL });
    await callTool('bazaar_search', { url: 'https://ledger-audit.test' });

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.outcome)).toEqual(['success', 'failure']);
    expect(lines[0]).toMatchObject({ transactionHash: SETTLEMENT.transaction, spend: 'settled' });
  });

  it('refuses to spend once the audit trail cannot be written', async () => {
    const ledger = new PaymentLedger({ filePath: tempLedgerFile('payments.jsonl') });
    const fetchWithPayment = vi.fn().mockResolvedValue(settledResponse({ price: '1.00' }));
    const { callTool } = createHarness(fetchWithPayment, undefined, ledger);

    // Stand in for a write that failed mid-run; the ledger marks itself not durable.
    ledger.durable = false;

    const refusal = await callTool('paid_call', { url: PAID_URL });

    expect(refusal.isError).toBe(true);
    expect(JSON.parse(refusal.content[0].text).code).toBe(MCP_ERROR_CODES.ERR_INTERNAL_FAILURE);
    expect(fetchWithPayment).not.toHaveBeenCalled();
  });

  it('sums settled spend and flags spend it cannot price', async () => {
    const ledger = new PaymentLedger();
    const instrumented = ledger.instrumentFetch(
      vi
        .fn()
        .mockResolvedValueOnce(settledResponse({ price: '1.00' }))
        .mockResolvedValueOnce(settledResponse({ price: '1.00' })) as unknown as typeof fetch
    );
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      const amount = url.includes('unpriced') ? 'usdc:1000000' : '$0.10';
      const offer = { ...PAYMENT_OFFER, accepted: { ...PAYMENT_OFFER.accepted, amount } };
      return instrumented(url, { ...init, headers: { 'payment-signature': base64Json(offer) } });
    });
    const { callTool } = createHarness(transport as unknown as Mock, undefined, ledger);

    await callTool('paid_call', { url: 'https://ledger-sum.test/api/v1/price' });
    await callTool('paid_call', { url: 'https://ledger-sum.test/api/v1/unpriced' });

    // $0.10 settled as nanodollars; the asset-prefixed offer is recorded verbatim
    // but cannot join a USD total, and the ledger says so instead of quietly
    // undercounting what the agent spent.
    expect(ledger.totalSpend()).toEqual({
      attempts: 2,
      settledNanodollars: '100000000',
      possibleNanodollars: '0',
      unquantifiedPayments: 1,
    });
    expect(ledger.records()[1].amount).toBe('usdc:1000000');
  });

  it('exports spend as metrics with a bounded label set', async () => {
    const ledger = new PaymentLedger({
      metricHosts: ['ledger-metrics.test'],
      metricNetworks: ['stellar:testnet'],
    });
    const { callTool } = createPaidTransport(ledger, () => settledResponse({ price: '1.00' }));

    await callTool('paid_call', { url: 'https://ledger-metrics.test/api/v1/price' });
    await callTool('paid_call', { url: 'https://not-allow-listed.test/api/v1/price' });

    const attempts = await register.getSingleMetricAsString('mcp_payment_attempts_total');
    expect(attempts).toMatch(/mcp_payment_attempts_total\{[^}]*host="ledger-metrics\.test"[^}]*network="stellar:testnet"[^}]*outcome="success"[^}]*\} 1/);
    expect(attempts).toMatch(/host="unknown"/);
    // A host outside the allow-list never becomes a series of its own: an agent
    // that loops over URLs must not be able to mint unbounded time series.
    expect(attempts).not.toContain('not-allow-listed.test');

    const settled = await register.getSingleMetricAsString('mcp_payment_amount_usd_total');
    expect(settled).toMatch(/mcp_payment_amount_usd_total\{[^}]*host="ledger-metrics\.test"[^}]*\} 0\.1/);
    expect(settled).not.toContain('not-allow-listed.test');
  });

  it('surfaces the running total to the budget tool', async () => {
    const ledger = new PaymentLedger();
    const instrumented = ledger.instrumentFetch(
      vi.fn().mockResolvedValue(settledResponse({ price: '1.00' })) as unknown as typeof fetch
    );
    const transport = vi.fn(async (url: string, init?: RequestInit) =>
      instrumented(url, { ...init, headers: { 'payment-signature': base64Json(PAYMENT_OFFER) } })
    );
    const budget = new SpendBudget({
      perCallMax: '$1.00',
      dailyCeiling: '$10.00',
      stateFilePath: tempLedgerFile('spend-state.json'),
    });
    const { callTool } = createHarness(transport as unknown as Mock, budget, ledger);

    await callTool('paid_call', { url: 'https://ledger-offer.test/api/v1/price' });

    const reported = JSON.parse((await callTool('payment_budget')).content[0].text);
    expect(reported.recordedSpend).toEqual({
      attempts: 1,
      settledNanodollars: '100000000',
      possibleNanodollars: '0',
      unquantifiedPayments: 0,
    });
    // The two views disagree on purpose: the budget can only hold the worst case
    // it reserved before paying, while the ledger reports the price it actually saw.
    expect(reported.spentToday).toBe('$1.00');
  });

  it('records nothing for discovery, which never pays', async () => {
    const { callTool, ledger } = createHarness(vi.fn(), undefined, undefined, discoveryStub());

    await callTool('bazaar_search', { url: 'https://ledger-audit.test' });

    expect(ledger.records()).toEqual([]);
    expect(ledger.totalSpend().attempts).toBe(0);
  });
});
