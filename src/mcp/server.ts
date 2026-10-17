import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_ERROR_CODES, McpErrorCode } from './codes.js';
import { fetchWithTimeout } from '../fetch.js';
import { config } from '../config.js';
import { ssrfSafeFetch, SsrfError, type SsrfFetchOptions } from '../net/ssrf.js';
import { boundSerialized, readBodyCapped, type ResultBudget } from './limits.js';
import { defaultResources, snapshotResource, type LensResourceDescriptor } from './resources.js';

/** Size bounds applied to every tool result, and the pages asked of a node. */
export interface McpLimits {
  maxResultBytes: number;
  maxUpstreamBytes: number;
  defaultPageLimit: number;
  maxPageLimit: number;
}

export interface McpServerConfig {
  fetchWithPayment: typeof fetch;
  /**
   * Outbound fetch policy for `bazaar_search`. Falls back to the operator's
   * shared `OUTBOUND_ALLOWED_HOSTS` allowlist. `lookup`/`fetchImpl` exist so
   * tests can drive DNS resolution and the transport without real sockets.
   */
  bazaarFetch?: Partial<SsrfFetchOptions>;
  /** Overrides the `MCP_*` env bounds — primarily for tests. */
  limits?: Partial<McpLimits>;
  /**
   * The read-only resources this server exposes. Defaults to the stable,
   * cacheable Lens facts derived from config and the on-disk OpenAPI document.
   * Pass a custom set to serve richer runtime state (a hot pair registry, a live
   * health check) without giving the stdio server a database dependency.
   */
  resources?: LensResourceDescriptor[];
}

export class BazaarMcpServer {
  private server: Server;
  private fetchWithPayment: typeof fetch;
  private bazaarFetchOptions: SsrfFetchOptions;
  private limits: McpLimits;
  private resources: LensResourceDescriptor[];

  constructor(config_: McpServerConfig) {
    this.fetchWithPayment = config_.fetchWithPayment;
    this.bazaarFetchOptions = {
      allowedHosts: config.outbound.allowedHosts,
      fetchImpl: (input, init) => fetchWithTimeout(input, init),
      ...config_.bazaarFetch,
    };
    this.limits = { ...config.mcp, ...config_.limits };
    this.resources = config_.resources ?? defaultResources();
    this.server = new Server(
      {
        name: 'bazaar-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'bazaar_search',
          description:
            'Search for resources in a Stellar Bazaar node. Results are a bounded page: ' +
            'use limit and offset to ask for more, and check "truncated" / "total" in the response.',
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
              limit: {
                type: 'number',
                description: `Maximum number of resources to return (default ${config.mcp.defaultPageLimit}, capped at ${config.mcp.maxPageLimit})`,
              },
              offset: {
                type: 'number',
                description: 'Number of resources to skip, to page past a truncated result (default 0)',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'paid_call',
          description: 'Make a paid API call to a Bazaar resource, handling the 402 loop automatically. Oversized responses are truncated; the result says so.',
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

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: this.resources.map((descriptor) => {
        const snapshot = snapshotResource(descriptor);
        return {
          uri: snapshot.uri,
          name: snapshot.name,
          title: snapshot.title,
          description: snapshot.description,
          mimeType: snapshot.mimeType,
          ...(snapshot.lastModified
            ? { annotations: { lastModified: snapshot.lastModified } }
            : {}),
          _meta: {
            version: snapshot.version,
            ...(snapshot.lastModified ? { lastModified: snapshot.lastModified } : {}),
          },
        };
      }),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const descriptor = this.resources.find((d) => d.uri === uri);
      if (!descriptor) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown resource: ${uri}. Call resources/list for the available URIs.`
        );
      }

      let snapshot;
      try {
        snapshot = snapshotResource(descriptor);
      } catch (e: any) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read resource ${uri}: ${e?.message ?? String(e)}`
        );
      }

      return {
        contents: [
          {
            uri: snapshot.uri,
            mimeType: snapshot.mimeType,
            text: snapshot.text,
            _meta: {
              version: snapshot.version,
              ...(snapshot.lastModified ? { lastModified: snapshot.lastModified } : {}),
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'bazaar_search') {
        const url = String(request.params.arguments?.url);
        const args = request.params.arguments ?? {};
        const query = args.query ? String(args.query) : undefined;
        const { limit, offset } = this.parsePage(args);

        try {
          const search = new URLSearchParams();
          if (query) search.set('q', query);
          search.set('limit', String(limit));
          search.set('offset', String(offset));

          const endpoint = query
            ? `${url.replace(/\/$/, '')}/discovery/search?${search}`
            : `${url.replace(/\/$/, '')}/discovery/resources?${search}`;

          const res = await ssrfSafeFetch(endpoint, {}, this.bazaarFetchOptions);

          if (!res.ok) {
            return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', `Service returned ${res.status}`);
          }

          // Cap the read, not just the reply: a node that streams megabytes is
          // never buffered here in full.
          const body = await readBodyCapped(res, this.limits.maxUpstreamBytes);
          if (body.exceeded) {
            return this.createErrorResponse(
              'ERR_RESPONSE_TOO_LARGE',
              `Node sent more than ${this.limits.maxUpstreamBytes} bytes, which cannot be parsed as one document. ` +
                `Retry with a smaller limit (currently ${limit}) or a larger offset.`
            );
          }

          let data: unknown;
          try {
            data = JSON.parse(body.text);
          } catch {
            return this.createErrorResponse('ERR_SERVICE_UNREACHABLE', 'Service returned a response that is not valid JSON');
          }

          const hasResources = (d: unknown): d is { resources: unknown[] } =>
            typeof d === 'object' && d !== null && 'resources' in d && Array.isArray((d as Record<string, unknown>).resources);

          if ((Array.isArray(data) && data.length === 0) || (hasResources(data) && data.resources.length === 0)) {
            return this.createErrorResponse('ERR_NO_RESULTS', 'No resources found');
          }

          return this.createBoundedResult(data, {
            maxBytes: this.limits.maxResultBytes,
            maxItems: limit,
            offset,
            notice:
              `Result truncated to fit a ${this.limits.maxResultBytes}-byte tool output limit, ` +
              `of which at most ${limit} items fit on one page. ` +
              'Ask for the rest with the limit and offset arguments.',
          });
        } catch (e: any) {
          if (e instanceof SsrfError) {
            return this.createErrorResponse('ERR_URL_BLOCKED', `Blocked request: ${e.message}`);
          }
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

          const body = await readBodyCapped(res, this.limits.maxUpstreamBytes);

          const budget: ResultBudget = {
            maxBytes: this.limits.maxResultBytes,
            // A paid response has no pagination contract, so paging a collection
            // would hide items with no way to ask for the next one; only the
            // byte ceiling applies.
            maxItems: Number.MAX_SAFE_INTEGER,
            offset: 0,
            knownTruncated: body.exceeded,
            notice: body.exceeded
              ? `Only the first ${this.limits.maxUpstreamBytes} bytes this resource sent are shown, so this result is incomplete. ` +
                'Ask the resource for a smaller response or a paginated endpoint.'
              : `Result truncated to fit a ${this.limits.maxResultBytes}-byte tool output limit. ` +
                'Ask the resource for a smaller response or a paginated endpoint.',
          };

          let parsed;
          try {
            parsed = JSON.parse(body.text);
          } catch {
            // Genuinely non-JSON (or a cut-off body, which cannot parse): hand
            // back the raw text, bounded and labelled as partial.
            parsed = body.text;
          }

          return this.createBoundedResult(parsed, budget);
        } catch (e: any) {
          return this.handlePaidCallError(e);
        }
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  /** Clamp a caller-requested page; mirrors the node's own discovery limits. */
  private parsePage(args: Record<string, unknown> | undefined): { limit: number; offset: number } {
    if (!args || typeof args !== 'object') return { limit: this.limits.defaultPageLimit, offset: 0 };

    const rawLimit = Number(args.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), this.limits.maxPageLimit)
        : this.limits.defaultPageLimit;

    const rawOffset = Number(args.offset);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    return { limit, offset };
  }

  /**
   * Serialize a successful result compactly (indentation is for humans and
   * costs the agent context) and within `budget`, so no upstream response —
   * large or hostile — can fill the context window in one call. Truncation is
   * stated in the payload rather than left to be inferred.
   */
  private createBoundedResult(data: unknown, budget: ResultBudget) {
    const { text } = boundSerialized(data, budget);
    return {
      content: [{ type: 'text', text }],
    };
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

  private createErrorResponse(code: McpErrorCode, reason: string) {    // For MCP, returning isError: true with a JSON payload is the standard way to return tool errors.
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
}
