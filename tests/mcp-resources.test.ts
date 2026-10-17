import { describe, it, expect } from 'vitest';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { BazaarMcpServer } from '../src/mcp/server';
import { defaultResources, snapshotResource } from '../src/mcp/resources';

/** Capture the resource handlers the way tests/mcp.test.ts captures tool handlers. */
function captureHandlers(server: BazaarMcpServer) {
  const handlers: Record<string, any> = {};
  (server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === ListResourcesRequestSchema) handlers.list = fn;
    if (schema === ReadResourceRequestSchema) handlers.read = fn;
  };
  (server as any).setupHandlers();
  return handlers;
}

function serverWith(resources: any) {
  return new BazaarMcpServer({
    fetchWithPayment: async () => new Response(),
    resources,
  });
}

describe('BazaarMcpServer MCP resources (#418)', () => {
  const fixed = new Date('2026-01-01T00:00:00.000Z');

  it('declares the resources capability', () => {
    const server = serverWith(defaultResources());
    const caps = (server as any).server._capabilities ?? (server as any).server.serverCapabilities;
    expect(caps).toHaveProperty('resources');
    expect(caps).toHaveProperty('tools');
  });

  it('lists stable URIs, MIME types and freshness for every resource', async () => {
    const { list } = captureHandlers(
      serverWith([
        {
          uri: 'lens://pairs',
          name: 'pairs',
          title: 'Watched pairs',
          description: 'd',
          mimeType: 'application/json',
          read: () => ({ data: { pairs: ['XLM/USDC'] }, lastModified: fixed.toISOString() }),
        },
      ])
    );

    const { resources } = await list();
    expect(resources).toHaveLength(1);
    const r = resources[0];
    expect(r.uri).toBe('lens://pairs');
    expect(r.mimeType).toBe('application/json');
    expect(r.annotations.lastModified).toBe(fixed.toISOString());
    expect(r._meta.version).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reads a resource, returning its JSON body and version', async () => {
    const { read } = captureHandlers(
      serverWith([
        {
          uri: 'lens://pairs',
          name: 'pairs',
          title: 'Watched pairs',
          description: 'd',
          mimeType: 'application/json',
          read: () => ({ data: { network: 'testnet', pairs: [] }, lastModified: fixed.toISOString() }),
        },
      ])
    );

    const result = await read({ params: { uri: 'lens://pairs' } });
    expect(result.contents).toHaveLength(1);
    const c = result.contents[0];
    expect(c.uri).toBe('lens://pairs');
    expect(c.mimeType).toBe('application/json');
    expect(JSON.parse(c.text)).toEqual({ network: 'testnet', pairs: [] });
    expect(c._meta.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(c._meta.lastModified).toBe(fixed.toISOString());
  });

  it('serves a text body verbatim (OpenAPI document)', async () => {
    const doc = '{"openapi":"3.0.0","info":{"title":"Lens"}}';
    const { read } = captureHandlers(
      serverWith([
        {
          uri: 'lens://openapi.json',
          name: 'openapi',
          title: 'OpenAPI document',
          description: 'd',
          mimeType: 'application/json',
          read: () => ({ text: doc, lastModified: fixed.toISOString() }),
        },
      ])
    );

    const result = await read({ params: { uri: 'lens://openapi.json' } });
    expect(result.contents[0].text).toBe(doc);
  });

  it('rejects an unknown URI with an InvalidParams JSON-RPC error', async () => {
    const { read } = captureHandlers(serverWith(defaultResources()));
    await expect(read({ params: { uri: 'lens://nope' } })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    await expect(read({ params: { uri: 'lens://nope' } })).rejects.toBeInstanceOf(McpError);
  });

  it('reports an internal error when a resource source fails', async () => {
    const { read } = captureHandlers(
      serverWith([
        {
          uri: 'lens://status',
          name: 'status',
          title: 'Service status',
          description: 'd',
          mimeType: 'application/json',
          read: () => {
            throw new Error('health check timed out');
          },
        },
      ])
    );

    await expect(read({ params: { uri: 'lens://status' } })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('health check timed out'),
    });
  });

  it('exposes at least the pair list and the OpenAPI document by default', () => {
    const uris = defaultResources().map((r) => r.uri);
    expect(uris).toContain('lens://pairs');
    expect(uris).toContain('lens://openapi.json');
    expect(uris).toContain('lens://venues');
    expect(uris).toContain('lens://status');
  });

  it('produces a stable version for identical content and a new one when it changes', () => {
    const mk = (pairs: string[]) => ({
      uri: 'lens://x',
      name: 'x',
      title: 'x',
      description: 'x',
      mimeType: 'application/json',
      read: () => ({ data: { pairs } }),
    });
    const a = snapshotResource(mk(['XLM/USDC'])).version;
    const b = snapshotResource(mk(['XLM/USDC'])).version;
    const c = snapshotResource(mk(['BTC/USDC'])).version;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('reads the real OpenAPI document from disk with an mtime-based version', async () => {
    const { read } = captureHandlers(serverWith(defaultResources()));
    const result = await read({ params: { uri: 'lens://openapi.json' } });
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toHaveProperty('openapi');
    expect(parsed).toHaveProperty('paths');
    expect(new Date(result.contents[0]._meta.lastModified).toString()).not.toBe('Invalid Date');
  });

  it('treats status as never-cacheable: each read is a new version', async () => {
    const { read } = captureHandlers(serverWith(defaultResources()));
    const v1 = (await read({ params: { uri: 'lens://status' } })).contents[0]._meta.version;
    await new Promise((r) => setTimeout(r, 5));
    const v2 = (await read({ params: { uri: 'lens://status' } })).contents[0]._meta.version;
    expect(v1).not.toBe(v2);
  });
});
