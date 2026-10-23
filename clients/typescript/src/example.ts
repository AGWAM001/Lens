/**
 * Example: typed Lens client usage.
 *
 * Every request and response type below comes from `schema.d.ts`, which is
 * generated from `openapi.yaml` by `npm run client:gen`. Nothing here is
 * hand-maintained, so a spec change shows up as a type error at compile time.
 *
 * Run it against a local server with:
 *
 *   npx tsx clients/typescript/src/example.ts
 */
import { createLensClient, type paths } from "./client.js";

/** A price response, derived from the spec — never written by hand. */
type AggregatedPrice = paths["/price/{assetA}/{assetB}"]["get"]["responses"][200]["content"]["application/json"];

const client = createLensClient({ baseUrl: "http://localhost:3002" });

async function main(): Promise<void> {
  const status = await client.GET("/status");
  if (status.error) {
    throw new Error(`GET /status failed with ${status.response.status}`);
  }
  console.log(`watching ${status.data.watchedPairs?.length ?? 0} pairs`);
  console.log(`last indexed ledger: ${status.data.lastIndexedLedger}`);

  const price = await client.GET("/price/{assetA}/{assetB}", {
    params: { path: { assetA: "XLM", assetB: "USDC" } },
  });
  if (price.error) {
    throw new Error(`GET /price failed with ${price.response.status}`);
  }

  const data: AggregatedPrice | undefined = price.data;
  if (!data) {
    throw new Error("GET /price returned no body");
  }
  console.log(`XLM/USDC best route: ${data.bestRoute}`);
  console.log(`XLM/USDC vwap1h: ${data.vwap1h}`);

  const snapshots = await client.GET("/prices/history", {
    params: { query: { pair: "XLM/USDC", interval: "1h" } },
  });
  if (snapshots.error) {
    throw new Error(`GET /prices/history failed with ${snapshots.response.status}`);
  }
  // This route answers text/csv as well as application/json, so the generated
  // types give a union of `string | { count?: number, ... }` and a field read
  // has to narrow first. That the compiler insists on it is the point of
  // generating the client from the spec rather than hand-writing it.
  const body = snapshots.data;
  const count = typeof body === "object" && body !== null ? (body.count ?? 0) : 0;
  console.log(`${count} snapshots returned`);
}

void main();
