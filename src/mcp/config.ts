export const DEFAULT_MCP_HTTP_HOST = '127.0.0.1';
export const DEFAULT_MCP_HTTP_PORT = 3003;
export const DEFAULT_MCP_HTTP_PATH = '/mcp';
/** Where the MCP HTTP transport exposes its Prometheus registry. */
export const DEFAULT_MCP_METRICS_PATH = '/metrics';

/**
 * The only network ids a payment made by this server can carry, so they are the
 * whole `network` label domain. Bazaar resources are paid on Stellar, and
 * examples/mcp-server/run.ts builds a signer per entry in that list; a label
 * taken from whatever a seller echoes in a header would mint a permanent time
 * series per distinct string.
 */
export const DEFAULT_MCP_METRIC_NETWORKS: readonly string[] = ['stellar:testnet', 'stellar:pubnet'];

export interface McpStdioTransportConfig {
  transport: 'stdio';
}

export interface McpHttpTransportConfig {
  transport: 'http';
  host: string;
  port: number;
  path: string;
  authToken: string;
}

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`MCP_HTTP_PORT must be an integer between 0 and 65535 (received "${raw}")`);
  }
  const port = Number(raw);
  if (port > 65535) {
    throw new Error(`MCP_HTTP_PORT must be an integer between 0 and 65535 (received "${raw}")`);
  }
  return port;
}

export function normalizeMcpHttpPath(raw: string): string {
  const value = raw.trim();
  if (!value) return DEFAULT_MCP_HTTP_PATH;
  if (/[?#\s]/.test(value)) {
    throw new Error('MCP_HTTP_PATH must be a URL path without a query string or fragment');
  }
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

/**
 * Comma-separated allow-list of the values that may carry a Prometheus label,
 * such as the hosts a `host` label may name. Series are permanent, so a label
 * domain must come from configuration, never from a caller's input.
 *
 * An unset variable takes `fallback`; setting one to empty means "allow-list
 * nothing", so every series is labelled `unknown`.
 */
export function parseMetricLabelAllowList(raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw === undefined) {
    return [...fallback];
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function resolveMcpTransportConfig(env: NodeJS.ProcessEnv = process.env): McpTransportConfig {
  const transport = (env.MCP_TRANSPORT ?? 'stdio').trim().toLowerCase();

  if (!transport || transport === 'stdio') {
    return { transport: 'stdio' };
  }

  if (transport !== 'http') {
    throw new Error(`MCP_TRANSPORT must be "stdio" or "http" (received "${transport}")`);
  }

  const authToken = env.MCP_HTTP_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error(
      'MCP_HTTP_AUTH_TOKEN is required when MCP_TRANSPORT=http; refusing to start an unauthenticated remote MCP server'
    );
  }

  const rawPort = env.MCP_HTTP_PORT?.trim();

  return {
    transport: 'http',
    host: env.MCP_HTTP_HOST?.trim() || DEFAULT_MCP_HTTP_HOST,
    port: rawPort ? parsePort(rawPort) : DEFAULT_MCP_HTTP_PORT,
    path: normalizeMcpHttpPath(env.MCP_HTTP_PATH ?? DEFAULT_MCP_HTTP_PATH),
    authToken,
  };
}
