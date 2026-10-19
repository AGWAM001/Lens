import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { DEFAULT_MCP_HTTP_HOST, DEFAULT_MCP_HTTP_PORT, DEFAULT_MCP_HTTP_PATH, normalizeMcpHttpPath } from './config.js';
import { fetchWithTimeout } from '../fetch.js';

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
}

export interface McpHttpServerOptions {
  authToken: string;
  host?: string;
  port?: number;
  path?: string;
}

export interface McpHttpServerHandle {
  readonly server: HttpServer;
  close(): Promise<void>;
}

const MAX_HTTP_BODY_BYTES = 1024 * 1024;

const RPC_ERROR_CODES = {
  UNAUTHORIZED: -32001,
  NOT_FOUND: -32004,
  METHOD_NOT_ALLOWED: -32005,
  PAYLOAD_TOO_LARGE: -32006,
  UNSUPPORTED_MEDIA_TYPE: -32007,
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  INTERNAL_ERROR: -32603,
} as const;

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly rpcCode: number,
    message: string
  ) {
    super(message);
  }
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  rpcCode: number,
  message: string,
  data?: Record<string, unknown>,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: rpcCode, message, ...(data ? { data } : {}) },
      id: null,
    })
  );
}

function hasValidBearerToken(header: string | undefined, expectedToken: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return false;

  const providedToken = match[1].trim();
  if (!providedToken) return false;

  // Hash both sides so the comparison is constant-time and does not leak the
  // expected token's length.
  const providedDigest = createHash('sha256').update(providedToken).digest();
  const expectedDigest = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return Promise.reject(
      new HttpRequestError(415, RPC_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 'Content-Type must be application/json')
    );
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(
          new HttpRequestError(
            413,
            RPC_ERROR_CODES.PAYLOAD_TOO_LARGE,
            `Request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`
          )
        );
        return;
      }
      if (size === 0) {
        reject(new HttpRequestError(400, RPC_ERROR_CODES.INVALID_REQUEST, 'Request body is required'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpRequestError(400, RPC_ERROR_CODES.PARSE_ERROR, 'Request body must be valid JSON'));
      }
    });

    req.on('error', () => {
      reject(new HttpRequestError(400, RPC_ERROR_CODES.INVALID_REQUEST, 'Failed to read request body'));
    });
  });
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;

  constructor(config: McpServerConfig) {
    this.fetchWithPayment = config.fetchWithPayment;
    this.server = this.createProtocolServer();
  }

  /**
   * A protocol server with this instance's tools registered. Streamable HTTP in
   * stateless mode needs one per request — see runHttp().
   */
  private createProtocolServer(): Server {
    const server = new Server(
      {
        name: 'bazaar-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    this.setupHandlers(server);
    return server;
  }

  private setupHandlers(target: Server = this.server) {
    target.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'bazaar_search',
          description: 'Search for resources in a Stellar Bazaar node',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The base URL of the Bazaar API',
              },
              query: {
                type: 'string',
                description: 'Optional search query',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'paid_call',
          description: 'Make a paid API call to a Bazaar resource, handling the 402 loop automatically.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The full URL of the resource to fetch',
              },
              method: {
                type: 'string',
                description: 'HTTP method (default: GET)',
              },
            },
            required: ['url'],
          },
        },
      ],
    }));

    target.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'bazaar_search') {
        const url = String(request.params.arguments?.url);
        const query = request.params.arguments?.query ? String(request.params.arguments?.query) : undefined;
        
        try {
          const endpoint = query 
            ? `${url.replace(/\/$/, '')}/discovery/search?q=${encodeURIComponent(query)}`
            : `${url.replace(/\/$/, '')}/discovery/resources`;
            
          const res = await fetchWithTimeout(endpoint);
          
          if (!res.ok) {
            return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', `Service returned ${res.status}`);
          }
          
          const data = await res.json();
          
          const hasResources = (d: unknown): d is { resources: unknown[] } => 
            typeof d === 'object' && d !== null && 'resources' in d && Array.isArray((d as Record<string, unknown>).resources);

          if ((Array.isArray(data) && data.length === 0) || (hasResources(data) && data.resources.length === 0)) {
            return this.createErrorResponse('ERR_NO_RESULTS', 'No resources found');
          }
          
          return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          };
        } catch (e: any) {
          return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', e.message);
        }
      }

      if (request.params.name === 'paid_call') {
        const url = String(request.params.arguments?.url);
        const method = request.params.arguments?.method ? String(request.params.arguments?.method) : 'GET';
        
        try {
          const res = await this.fetchWithPayment(url, { method });
          
          if (!res.ok) {
            if (res.status === 402) {
              return this.createErrorResponse('ERR_PAYMENT_REJECTED', 'Payment required but was rejected or failed.');
            }
            return this.createErrorResponse('ERR_BAD_REQUEST', `Request failed with status ${res.status}`);
          }
          
          const text = await res.text();
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          
          return {
            content: [{ type: 'text', text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) }],
          };
        } catch (e: any) {
          return this.handlePaidCallError(e);
        }
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private handlePaidCallError(e: any) {
    const msg = String(e.message || e).toLowerCase();
    
    if (msg.includes('signatureexpirationledger') || msg.includes('signature expired')) {
      return this.createErrorResponse('ERR_EXPIRED_AUTHORISATION', 'The transaction signature expired before it could be submitted.');
    }
    
    if (msg.includes('trustline') || msg.includes('op_no_trust')) {
      return this.createErrorResponse('ERR_MISSING_TRUSTLINE', 'Missing trustline for the required asset.');
    }
    
    if (msg.includes('insufficient') || msg.includes('underfunded')) {
      return this.createErrorResponse('ERR_INSUFFICIENT_BALANCE', 'Insufficient balance to complete the payment.');
    }

    if (msg.includes('fetch') || msg.includes('network')) {
      return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', 'Failed to reach the service: ' + e.message);
    }
    
    return this.createErrorResponse('ERR_INTERNAL_FAILURE', e.message || 'An unknown error occurred during the paid call.');
  }

  private createErrorResponse(code: McpErrorCode, reason: string) {
    // For MCP, returning isError: true with a JSON payload is the standard way to return tool errors.
    const payload = {
      isError: true,
      code,
      reason,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Serve the same tools over Streamable HTTP. Bindings default to loopback and
   * a non-empty bearer token is mandatory: this transport exposes paid_call to
   * anywhere on the network, so it must never start unauthenticated.
   */
  async runHttp(options: McpHttpServerOptions): Promise<McpHttpServerHandle> {
    const authToken = options.authToken?.trim();
    if (!authToken) {
      throw new Error('The HTTP transport requires a non-empty auth token; refusing to start an unauthenticated MCP server');
    }

    const host = options.host?.trim() || DEFAULT_MCP_HTTP_HOST;
    const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`MCP HTTP port must be an integer between 0 and 65535 (received "${port}")`);
    }
    const path = normalizeMcpHttpPath(options.path ?? DEFAULT_MCP_HTTP_PATH);

    const httpServer = createServer((req, res) => {
      void this.handleHttpRequest(req, res, { authToken, path }).catch(() => {
        sendJsonRpcError(res, 500, RPC_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });

    return {
      server: httpServer,
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
          httpServer.closeIdleConnections();
        });
      },
    };
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    config: { authToken: string; path: string }
  ): Promise<void> {
    if (!hasValidBearerToken(req.headers.authorization, config.authToken)) {
      sendJsonRpcError(
        res,
        401,
        RPC_ERROR_CODES.UNAUTHORIZED,
        'Missing or invalid bearer token',
        { code: MCP_ERROR_CODES.ERR_UNAUTHORIZED },
        { 'www-authenticate': 'Bearer realm="lens-mcp"' }
      );
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendJsonRpcError(res, 400, RPC_ERROR_CODES.INVALID_REQUEST, 'Malformed request URL');
      return;
    }

    if (pathname !== config.path) {
      sendJsonRpcError(res, 404, RPC_ERROR_CODES.NOT_FOUND, 'Not found');
      return;
    }

    // Stateless transport: POST is the only MCP method it can answer. GET
    // (server-initiated SSE) and DELETE (session termination) are 405 by spec.
    if (req.method !== 'POST') {
      sendJsonRpcError(
        res,
        405,
        RPC_ERROR_CODES.METHOD_NOT_ALLOWED,
        'Method not allowed; send MCP requests as POST',
        undefined,
        { allow: 'POST' }
      );
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req);
    } catch (e) {
      if (e instanceof HttpRequestError) {
        sendJsonRpcError(res, e.status, e.rpcCode, e.message);
        return;
      }
      throw e;
    }

    // A stateless Streamable HTTP transport is single-use: the SDK rejects a
    // second request on the same instance because message ids from different
    // clients would collide. Each request therefore gets its own protocol
    // server, registered from the same tools as stdio, so the two transports
    // expose identical tools.
    const server = this.createProtocolServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      await server.close().catch(() => {});
    }
  }
}
