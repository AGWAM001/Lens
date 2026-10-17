import { describe, it, expect, vi } from 'vitest';
import { BazaarMcpServer } from '../src/mcp/server';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('BazaarMcpServer', () => {
  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

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
    new Response(JSON.stringify({ resources: [{ name: 'x' }] }), { status: 200 });

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

describe('BazaarMcpServer bounded tool results (#416)', () => {
  function captureHandler(server: any) {
    let handler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    server.setupHandlers();
    return handler;
  }

  const publicLookup = { lookup: async () => ['93.184.216.34'] };

  function searchServer(fetchImpl: any, limits?: any) {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl },
      ...(limits ? { limits } : {}),
    });
    return { server, handler: captureHandler(server) };
  }

  const jsonFetch = (payload: unknown) => async () =>
    new Response(JSON.stringify(payload), { status: 200 });

  it('pages a collection that exceeds the item limit and says so', async () => {
    const resources = Array.from({ length: 500 }, (_, i) => ({ resource: { url: `https://r${i}.example` } }));
    const { handler } = searchServer(jsonFetch({ resources, total: resources.length }));

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });

    expect(response.isError).toBeFalsy();
    const text = response.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.resources.length).toBeLessThanOrEqual(50);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(500);
    expect(parsed.offset).toBe(0);
    expect(parsed.notice).toMatch(/limit and offset/);
    // Indentation is for humans; it costs the agent context for no benefit.
    expect(text).not.toContain('\n  ');
  });

  it('honours limit and offset arguments and asks the node for the same page', async () => {
    const requested: string[] = [];
    const resources = Array.from({ length: 30 }, (_, i) => ({ resource: { url: `https://r${i}.example` } }));
    const { handler } = searchServer(async (input: string | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ resources }), { status: 200 });
    });

    const response = await handler({
      params: { name: 'bazaar_search', arguments: { url: 'https://ok.example', query: 'xlm', limit: 7, offset: 14 } },
    });

    expect(requested[0]).toContain('/discovery/search?');
    expect(requested[0]).toContain('q=xlm');
    expect(requested[0]).toContain('limit=7');
    expect(requested[0]).toContain('offset=14');

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.resources.length).toBe(7);
    expect(parsed.total).toBe(30);
    expect(parsed.offset).toBe(14);
    expect(parsed.truncated).toBe(true);
  });

  it('keeps a response within the configured byte limit', async () => {
    const resources = Array.from({ length: 1000 }, (_, i) => ({
      resource: { url: `https://example.com/${'y'.repeat(200)}${i}` },
    }));
    const { handler } = searchServer(jsonFetch({ resources }), { maxResultBytes: 4096, maxUpstreamBytes: 1_048_576 });

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });

    const text = response.content[0].text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(1000);
    expect(parsed.resources.length).toBeLessThan(1000);
    expect(parsed.resources.length).toBeGreaterThan(0);
  });

  it('truncates a payload with no pageable collection', async () => {
    const { handler } = searchServer(jsonFetch({ blob: 'z'.repeat(10_000) }), { maxResultBytes: 2048 });

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });

    const text = response.content[0].text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.notice).toMatch(/limit and offset/);
    expect(typeof parsed.partial).toBe('string');
    expect(parsed.partial.length).toBeGreaterThan(0);
  });

  it('does not buffer an oversized upstream body in full', async () => {
    const totalChunks = 64;
    const chunk = new TextEncoder().encode('x'.repeat(4096));
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (produced >= totalChunks) {
          controller.close();
          return;
        }
        produced++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const { handler } = searchServer(async () => new Response(stream, { status: 200 }), {
      maxUpstreamBytes: 8192,
      maxResultBytes: 65_536,
    });

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.code).toBe('ERR_RESPONSE_TOO_LARGE');
    expect(payload.reason).toMatch(/limit/);
    expect(produced).toBeLessThan(totalChunks);
    expect(cancelled).toBe(true);
  });

  it('bounds a paid_call result and reports the truncation', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => i) }), { status: 200 })
    );
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, limits: { maxResultBytes: 1024 } });
    const handler = captureHandler(server);

    const response = await handler({ params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } } });

    expect(response.isError).toBeFalsy();
    const text = response.content[0].text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1024);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.rows.length).toBeLessThan(500);
    expect(parsed.total).toBe(500);
    expect(parsed.notice).toMatch(/paginated endpoint/);
  });

  it('flags a paid_call body that exceeds the read cap', async () => {
    const big = 'a'.repeat(5000);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }), { status: 200 })
    );
    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      limits: { maxUpstreamBytes: 4096, maxResultBytes: 2048 },
    });
    const handler = captureHandler(server);

    const response = await handler({ params: { name: 'paid_call', arguments: { url: 'http://example.com/paid' } } });

    const text = response.content[0].text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.notice).toMatch(/incomplete/);
  });

  it('leaves a small response untouched', async () => {
    const { handler } = searchServer(jsonFetch({ resources: [{ resource: { url: 'https://a.example' } }] }));

    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });

    expect(response.isError).toBeFalsy();
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.resources[0].resource.url).toBe('https://a.example');
  });
});
