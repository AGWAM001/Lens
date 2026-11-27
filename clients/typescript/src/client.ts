import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema.js";

export type { paths } from "./schema.js";

export type LensClient = Client<paths>;

export type LensClientOptions = Omit<ClientOptions, "baseUrl" | "fetch"> & {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * API key issued through the admin API, sent as `Authorization: Bearer <key>`
   * (spec: `components.securitySchemes.apiKeyAuth`). Ignored for a request
   * whose headers already set `Authorization` — explicit caller headers win.
   */
  apiKey?: string;
  /**
   * x402 payment proof, sent as the `X-PAYMENT` header (spec:
   * `components.securitySchemes.x402`, base64 encoded JSON). Ignored for a
   * request whose headers already set `X-PAYMENT`.
   */
  payment?: string;
  /**
   * Default `network` query parameter (`testnet` / `mainnet`), added to calls
   * whose URL does not already carry a `network` query parameter. A `network`
   * set per-call in `params.query` wins.
   */
  network?: string;
};

export const DEFAULT_BASE_URL = "http://localhost:3002";

export function createLensClient(
  options: LensClientOptions = {},
): LensClient {
  const authHeaders: Record<string, string> = {};
  if (options.apiKey) authHeaders["Authorization"] = `Bearer ${options.apiKey}`;
  if (options.payment) authHeaders["X-PAYMENT"] = options.payment;
  const defaultNetwork = options.network;

  const innerFetch: typeof globalThis.fetch =
    options.fetch ?? globalThis.fetch.bind(globalThis);

  // openapi-fetch builds the URL (path params, query) and merges headers
  // before calling fetch, so wrapping fetch is the single point where the
  // defaults can be applied per-request without duplicating its logic.
  const fetchWithDefaults: typeof globalThis.fetch = (input, init) => {
    let request = new Request(input, init);
    // Caller-set headers (per-call or constructor `headers`) are already on
    // the Request and take precedence over the defaults.
    for (const [name, value] of Object.entries(authHeaders)) {
      if (!request.headers.has(name)) request.headers.set(name, value);
    }
    if (defaultNetwork && !new URL(request.url).searchParams.has("network")) {
      const url = new URL(request.url);
      url.searchParams.set("network", defaultNetwork);
      request = new Request(url, request);
    }
    return innerFetch(request);
  };

  return createClient<paths>({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    fetch: fetchWithDefaults,
    headers: options.headers,
  });
}
