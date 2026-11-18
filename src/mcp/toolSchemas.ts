import { z } from 'zod';
import { config } from '../config.js';

/**
 * Supported HTTP methods for the `paid_call` tool.
 */
export const PAID_CALL_HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
] as const;

export type PaidCallHttpMethod = (typeof PAID_CALL_HTTP_METHODS)[number];

/**
 * Validation schema and source of truth for `bazaar_search` tool arguments.
 */
export const BAZAAR_SEARCH_ARGUMENTS_SCHEMA = z.object({
  url: z
    .string()
    .min(1, 'url cannot be empty')
    .describe('The base URL of the Bazaar API'),
  query: z.string().optional().describe('Optional search query'),
  // #416: results are a bounded page, so paging has to be something the agent
  // can ask for. The ceiling is operator configuration and is enforced again on
  // the server side — an ask over it is clamped, not honoured.
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum number of resources to return (default ${config.mcp.defaultPageLimit}, capped at ${config.mcp.maxPageLimit})`,
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of resources to skip, to page past a truncated result (default 0)'),
});

export type BazaarSearchArguments = z.infer<typeof BAZAAR_SEARCH_ARGUMENTS_SCHEMA>;

/**
 * Validation schema and source of truth for `paid_call` tool arguments.
 */
export const PAID_CALL_ARGUMENTS_SCHEMA = z
  .object({
    url: z
      .string()
      .min(1, 'url cannot be empty')
      .describe('The full URL of the resource to fetch. Must be an allow-listed origin.'),
    method: z
      .enum(PAID_CALL_HTTP_METHODS)
      .optional()
      .describe('HTTP method (default: GET)'),
  })
  .strict();

export type PaidCallArguments = z.infer<typeof PAID_CALL_ARGUMENTS_SCHEMA>;

/**
 * #409 — the paging half of the Lens data tools. `limit` is deliberately not
 * capped here: an over-large ask is clamped to the operator's
 * `MCP_MAX_PAGE_LIMIT` the same way `bazaar_search` clamps it, so the agent gets
 * a smaller page rather than a refusal it has to decode. `cursor` is the opaque
 * `nextCursor` the previous page handed back — REST's screener pages by the same
 * token, which is what keeps a tool page and an HTTP page identical.
 */
const networkArg = z
  .enum(['testnet', 'mainnet'])
  .optional()
  .describe('Stellar network to read. Defaults to the network this server is configured for.');
const limitArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Maximum number of items to return in this page (clamped to the server page ceiling)');
const cursorArg = z
  .string()
  .min(1)
  .optional()
  .describe('Opaque cursor from a previous page. Pass back the "nextCursor" the last result gave you; it is not a number an agent should construct.');

export const LENS_LIST_PAIRS_ARGUMENTS_SCHEMA = z
  .object({ network: networkArg, limit: limitArg, cursor: cursorArg })
  .strict();

export type LensListPairsArguments = z.infer<typeof LENS_LIST_PAIRS_ARGUMENTS_SCHEMA>;

export const LENS_GET_POOLS_ARGUMENTS_SCHEMA = z
  .object({ network: networkArg, limit: limitArg, cursor: cursorArg })
  .strict();

export type LensGetPoolsArguments = z.infer<typeof LENS_GET_POOLS_ARGUMENTS_SCHEMA>;

/**
 * Screener filters, one per REST query parameter. Coerced so an agent that
 * sends `"1000"` instead of `1000` is understood rather than refused, which is
 * also how the REST route reads them.
 */
const screenerNum = (name: string) =>
  z.coerce.number({ error: `${name} must be a valid number` }).optional();

export const LENS_SCREEN_PAIRS_ARGUMENTS_SCHEMA = z
  .object({
    network: networkArg,
    limit: limitArg,
    cursor: cursorArg,
    volume: screenerNum('volume'),
    change_24h_min: screenerNum('change_24h_min'),
    change_24h_max: screenerNum('change_24h_max'),
    price_min: screenerNum('price_min'),
    price_max: screenerNum('price_max'),
    liquidity: screenerNum('liquidity'),
    sortBy: z.enum(['volume', 'change_24h', 'price', 'liquidity']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    market_cap: z.string().optional(),
  })
  .strict();

export type LensScreenPairsArguments = z.infer<typeof LENS_SCREEN_PAIRS_ARGUMENTS_SCHEMA>;

/**
 * Converts a Zod object schema into an MCP-compliant JSON schema dictionary.
 * Strips the top-level `$schema` field so it plugs directly into MCP tool `inputSchema`.
 */
export function zodToToolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema, ...cleanSchema } = jsonSchema;
  return cleanSchema;
}

/**
 * Formats Zod validation issues into a human- and agent-readable string naming
 * each offending argument and why it failed.
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      if (issue.code === 'unrecognized_keys' && Array.isArray((issue as any).keys)) {
        return `Unrecognized argument(s): ${(issue as any).keys.map((k: string) => `'${k}'`).join(', ')}`;
      }
      const field = issue.path.length > 0 ? `'${issue.path.join('.')}'` : 'arguments';
      return `Invalid argument ${field}: ${issue.message}`;
    })
    .join('; ');
}
