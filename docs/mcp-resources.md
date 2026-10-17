# MCP resources

The Lens MCP server (`src/mcp/server.ts`) exposes two kinds of things to an
agent:

- **Tools** — functions the agent calls to *do* something (`bazaar_search`,
  `paid_call`).
- **Resources** — read-only content the agent can attach to its context once,
  instead of re-fetching by calling a tool every turn.

Resources are for the stable, cacheable facts *about the service itself*. Each
has a fixed URI, an accurate MIME type, and honest freshness so a client can
tell whether what it cached is still current.

## Resource URIs

| URI | MIME type | Contents | Freshness |
| --- | --------- | -------- | --------- |
| `lens://pairs` | `application/json` | The asset pairs Lens quotes on the configured network: `{ network, pairs: [{ pairKey, assetA, assetB }] }`. | `lastModified` is when this process resolved its config; the pairs come from `WATCHED_PAIRS`/`WATCHED_PAIRS_<NETWORK>` and do not change while the process runs. |
| `lens://venues` | `application/json` | The liquidity venues Lens reads from, with each venue's `source` and whether it is `enabled` on this network. | Same boot-time semantics as `lens://pairs`. |
| `lens://openapi.json` | `application/json` | The service OpenAPI 3 document, served verbatim from `openapi.json`. | `lastModified` is the file's on-disk modification time. |
| `lens://status` | `application/json` | Current network, Horizon/RPC URLs, venue enablement, and watched-pair count. | `lastModified` is the read instant — every read is a new version, so it is deliberately **not** cacheable. |

A URI never changes shape. Adding a field to a payload is allowed; renaming a
URI or reusing it for different content is not.

## Freshness

Every resource reports:

- `version` — `sha256:<hex>` of the exact bytes returned. A client that cached a
  previous body compares this to decide whether its copy is still current,
  without diffing the text. It is returned in `_meta.version` on both
  `resources/list` and `resources/read`.
- `lastModified` — an ISO-8601 timestamp for the instant the underlying source
  last changed, in `annotations.lastModified` (list) and `_meta.lastModified`
  (list and read). It is omitted only when a source has no notion of change.

`resources/list` resolves each resource to compute this metadata, so listing is
as current as reading.

## Overriding the sources

The defaults derive only from `config` and the on-disk OpenAPI document — no
database — so the stdio server stays as light as the payment client hosting it.
A process that holds richer runtime state (a registry with hot-added pairs, a
live health check) can pass its own descriptors:

```ts
new BazaarMcpServer({
  fetchWithPayment,
  resources: [
    {
      uri: 'lens://pairs',
      name: 'pairs',
      title: 'Watched pairs',
      description: 'Pairs Lens quotes, including those added at runtime.',
      mimeType: 'application/json',
      read: () => ({ data: { network, pairs: getActivePairs() } }),
    },
  ],
});
```

Reading an unknown URI fails with a JSON-RPC `InvalidParams` error; a resource
source that throws surfaces as `InternalError`.
