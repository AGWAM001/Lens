export const DEFAULT_MCP_HTTP_HOST = '127.0.0.1';
export const DEFAULT_MCP_HTTP_PORT = 3003;
export const DEFAULT_MCP_HTTP_PATH = '/mcp';

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
