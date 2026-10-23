import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema.js";

export type { paths } from "./schema.js";

export type LensClient = Client<paths>;

export type LensClientOptions = Omit<ClientOptions, "baseUrl" | "fetch"> & {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export const DEFAULT_BASE_URL = "http://localhost:3002";

export function createLensClient(
  options: LensClientOptions = {},
): LensClient {
  return createClient<paths>({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    fetch: options.fetch,
    headers: options.headers,
  });
}
