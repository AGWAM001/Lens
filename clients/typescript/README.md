# `@divinity-labs/lens-client`

Typed TypeScript client for the [Lens](https://github.com/Divinity-Labs/Lens) Stellar price API, generated from `openapi.yaml` using `openapi-typescript` and `openapi-fetch`.

## Install

Build and pack the tarball from the Lens repository:

```bash
npm --prefix clients/typescript run build
npm --prefix clients/typescript pack
```

Then install the generated tarball into your project:

```bash
npm install /path/to/divinity-labs-lens-client-0.2.0.tgz
```

## Usage

Create a client and make a typed request:

```typescript
import { createLensClient } from "@divinity-labs/lens-client";

const client = createLensClient({ baseUrl: "http://localhost:3002" });

const { data, error } = await client.GET("/v1/price/{assetA}/{assetB}", {
  params: { path: { assetA: "XLM", assetB: "USDC" } },
});

if (error) {
  throw new Error(`Request failed: ${JSON.stringify(error)}`);
}

console.log(`XLM/USDC vwap1h: ${data.vwap1h}`);
```
