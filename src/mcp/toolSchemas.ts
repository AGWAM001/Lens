import { z } from 'zod';

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
