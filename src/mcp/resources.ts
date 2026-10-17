import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { config, activeNetwork } from '../config.js';

/**
 * A resource an agent can attach to its context once, rather than re-fetching
 * by calling a tool every turn. These are the stable, cacheable facts about the
 * Lens service itself — the pairs it quotes, the venues it reads, its OpenAPI
 * document, and its current status.
 *
 * `read` may be called on every `resources/list` and `resources/read`, so it
 * must be cheap. Throwing is allowed and surfaces to the caller as a read
 * error.
 */
export interface LensResourceDescriptor {
  /** Stable URI. Clients cache against it, so it must never change shape. */
  uri: string;
  /** Short machine-readable handle, unique within the service. */
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /**
   * Produce the current payload. Supply `text` for a verbatim body (e.g. a
   * file served byte-for-byte) or `data`, which is serialized to compact JSON.
   * `lastModified` is the instant the underlying source last changed; omit it
   * when the source genuinely has no notion of change.
   */
  read: () => { data?: unknown; text?: string; lastModified?: string };
}

/** A descriptor resolved to a concrete body plus its freshness metadata. */
export interface LensResourceSnapshot {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  text: string;
  version: string;
  lastModified?: string;
}

/**
 * The instant this process resolved its config. The pairs, venues and status
 * resources are derived from a config snapshot frozen at import, so "when did
 * this change" for those sources is "when did this process start." Reporting the
 * boot time is honest about that — a restart with new env is a new version, and
 * a running process never silently mutates these.
 */
const BOOT_TIME = new Date().toISOString();

/**
 * Content-hash version. A client that cached a previous body can compare this
 * to decide whether its copy is still current without diffing the text. Deriving
 * it from the exact bytes we return keeps it truthful: same payload, same
 * version; any change, a new one.
 */
function computeVersion(text: string): string {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

/** Resolve the OpenAPI document path, honoring an operator override. */
function openapiPath(): string {
  if (process.env.LENS_OPENAPI_PATH) return process.env.LENS_OPENAPI_PATH;
  // Runs the same from src/mcp (tsx) and dist/mcp (build): the document lives at
  // the package root, two directories up from this module.
  return path.resolve(__dirname, '..', '..', 'openapi.json');
}

/** Serialize an object payload to the compact JSON that becomes the body. */
function jsonText(data: unknown): string {
  return JSON.stringify(data);
}

/**
 * The default set of Lens resources, derived only from `config` and the on-disk
 * OpenAPI document — deliberately with no database dependency, so the stdio MCP
 * server stays as lightweight as the payment client that hosts it. A process
 * that *does* have the richer runtime state (a registry with hot-added pairs, a
 * live health check) can pass its own descriptors to override these.
 */
export function defaultResources(): LensResourceDescriptor[] {
  return [
    {
      uri: 'lens://pairs',
      name: 'pairs',
      title: 'Watched pairs',
      description: 'The asset pairs Lens actively quotes on the configured network.',
      mimeType: 'application/json',
      read: () => ({
        data: {
          network: activeNetwork,
          pairs: config.pairs.map((p) => ({
            pairKey: p.pairKey,
            assetA: p.assetA,
            assetB: p.assetB,
          })),
        },
        lastModified: BOOT_TIME,
      }),
    },
    {
      uri: 'lens://venues',
      name: 'venues',
      title: 'Venues',
      description: 'The liquidity venues Lens reads prices from on the configured network.',
      mimeType: 'application/json',
      read: () => ({
        data: {
          network: activeNetwork,
          venues: [
            { name: 'SDEX', source: 'SDEX', kind: 'orderbook', enabled: true },
            { name: 'AMM', source: 'AMM', kind: 'orderbook', enabled: true },
            { name: 'Soroswap', source: 'soroswap_amm', kind: 'amm', enabled: config.soroswap.enabled },
            { name: 'Aquarius', source: 'aquarius_amm', kind: 'amm', enabled: config.aquarius.enabled },
          ],
        },
        lastModified: BOOT_TIME,
      }),
    },
    {
      uri: 'lens://openapi.json',
      name: 'openapi',
      title: 'OpenAPI document',
      description: 'The service OpenAPI 3 specification, served verbatim as JSON.',
      mimeType: 'application/json',
      read: () => {
        const file = openapiPath();
        const text = readFileSync(file, 'utf8');
        return { text, lastModified: new Date(statSync(file).mtimeMs).toISOString() };
      },
    },
    {
      uri: 'lens://status',
      name: 'status',
      title: 'Service status',
      description: 'Current network, endpoints, venue enablement and watched-pair count.',
      mimeType: 'application/json',
      read: () => {
        const generatedAt = new Date().toISOString();
        return {
          data: {
            network: activeNetwork,
            generatedAt,
            horizonUrl: config.horizon.url,
            rpcUrl: config.rpc.url,
            watchedPairCount: config.pairs.length,
            venues: {
              soroswap: config.soroswap.enabled,
              aquarius: config.aquarius.enabled,
              oracle: config.oracle.enabled,
            },
          },
          // Status is defined by being current: every read is a new version, so a
          // client knows it must not treat this as a long-lived cache.
          lastModified: generatedAt,
        };
      },
    },
  ];
}

/** Resolve a descriptor into the body plus version/freshness returned to clients. */
export function snapshotResource(descriptor: LensResourceDescriptor): LensResourceSnapshot {
  const { data, text: rawText, lastModified } = descriptor.read();
  const text = rawText ?? jsonText(data);
  return {
    uri: descriptor.uri,
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    mimeType: descriptor.mimeType,
    text,
    version: computeVersion(text),
    lastModified,
  };
}
