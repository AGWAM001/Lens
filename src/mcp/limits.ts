/**
 * Size bounds for MCP tool results (#416).
 *
 * A tool result is written straight into the agent's context window, so an
 * unbounded one is self-inflicted denial of service: a node with a large
 * resource list — or a hostile one returning megabytes — leaves the agent no
 * context to do its actual task, and the failure is blamed on the model.
 * Everything here exists to keep a result small *and* to say so in the result:
 * silent truncation would make a partial answer look like a complete one.
 *
 * Two independent ceilings:
 *   - the body read from upstream is capped while streaming, so an oversized
 *     response is never buffered in full (`readBodyCapped`);
 *   - the text handed to the agent is capped, and collections are additionally
 *     capped by item count and reported as a page with a total
 *     (`boundSerialized`).
 */

/** Keys that hold a page's items when the payload is an object. */
const COLLECTION_KEYS = ['resources', 'results', 'items']

/**
 * Operator-configurable bounds, resolved from the `MCP_*` env in config.ts and
 * overridable per server for tests.
 */
export interface McpLimits {
  maxResultBytes: number
  maxUpstreamBytes: number
  defaultPageLimit: number
  maxPageLimit: number
}

export interface ResultBudget {
  /** Maximum size, in UTF-8 bytes, of the text handed to the agent. */
  maxBytes: number
  /** Maximum number of collection items echoed, whatever the byte headroom is. */
  maxItems: number
  /** The page offset the result came from, echoed back so the agent can continue. */
  offset: number
  /** How the agent asks for more. Included verbatim in every truncated result. */
  notice: string
  /**
   * True when the payload is already known to be incomplete — the body read was
   * cut off upstream. Labels the result truncated even if what survives fits.
   */
  knownTruncated?: boolean
}

export interface BoundedResult {
  text: string
  truncated: boolean
}

export interface CappedBody {
  text: string
  /** True when the upstream body was larger than the cap, so `text` is incomplete. */
  exceeded: boolean
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Cut `text` down to at most `maxBytes` without splitting a UTF-8 sequence. */
function sliceToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  return new TextDecoder('utf-8').decode(bytes)
}

interface Collection {
  items: unknown[]
  /** Item count as reported by the payload itself, when it knows better than us. */
  total: number
  key: string | null
  container: Record<string, unknown> | null
}

/**
 * Find the collection to page through, if any: a top-level array, or an object
 * with an array under a known collection key (`resources`, `results`, `items`)
 * or, failing that, its first array-valued key.
 */
function findCollection(value: unknown): Collection | null {
  if (Array.isArray(value)) {
    return { items: value, total: value.length, key: null, container: null }
  }
  if (typeof value !== 'object' || value === null) return null

  const container = value as Record<string, unknown>
  const keys = Object.keys(container).filter((k) => Array.isArray(container[k]))
  const key = COLLECTION_KEYS.find((k) => keys.includes(k)) ?? keys[0]
  if (!key) return null

  const items = container[key] as unknown[]
  const reportedTotal = typeof container.total === 'number' ? container.total : items.length
  return { items, total: Math.max(reportedTotal, items.length), key, container }
}

function assemblePage(collection: Collection, count: number, budget: ResultBudget): string {
  const page = collection.items.slice(0, count)
  const metadata = {
    total: collection.total,
    limit: count,
    offset: budget.offset,
    truncated: true,
    notice: budget.notice,
  }
  if (collection.container && collection.key) {
    return JSON.stringify({ ...collection.container, [collection.key]: page, ...metadata })
  }
  return JSON.stringify({ items: page, ...metadata })
}

/** Largest page that fits the byte budget, or null when not even metadata fits. */
function boundCollection(collection: Collection, budget: ResultBudget): BoundedResult | null {
  const max = Math.min(collection.items.length, budget.maxItems)
  let lo = 0
  let hi = max
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (byteLength(assemblePage(collection, mid, budget)) <= budget.maxBytes) lo = mid
    else hi = mid - 1
  }

  const text = assemblePage(collection, lo, budget)
  if (byteLength(text) > budget.maxBytes) return null
  return { text, truncated: true }
}

/**
 * Last resort for payloads with no pageable collection (or whose items are
 * individually enormous): keep a prefix of the compact serialization and label
 * it, rather than returning a document that only parses by accident.
 */
function boundSerializedText(value: unknown, budget: ResultBudget): BoundedResult {
  const compact = JSON.stringify(value) ?? 'null'
  const body = typeof value === 'string' ? value : compact
  const wrap = (chars: number) =>
    JSON.stringify({
      truncated: true,
      fullBytes: byteLength(compact),
      notice: budget.notice,
      partial: body.slice(0, chars),
    })

  let lo = 0
  let hi = body.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (byteLength(wrap(mid)) <= budget.maxBytes) lo = mid
    else hi = mid - 1
  }

  const text = wrap(lo)
  return { text: sliceToBytes(text, budget.maxBytes), truncated: true }
}

/**
 * Serialize a tool result compactly (indentation is for humans, and costs
 * context) and within `budget.maxBytes`. A truncated result always carries
 * `truncated: true`, a total, the page that was returned, and the notice
 * explaining how to ask for the rest.
 */
export function boundSerialized(value: unknown, budget: ResultBudget): BoundedResult {
  if (budget.knownTruncated) {
    // Already a fragment — the upstream read was cut off. Label it instead of
    // risking that it reads back as a complete answer.
    return boundSerializedText(value, budget)
  }

  const compact = JSON.stringify(value) ?? 'null'
  if (typeof value === 'string' && byteLength(value) <= budget.maxBytes) {
    // Plain-text answers stay plain text: quoting them would change what the
    // agent reads for a resource that never produced JSON.
    return { text: value, truncated: false }
  }

  const collection = findCollection(value)
  if (byteLength(compact) <= budget.maxBytes && (!collection || collection.items.length <= budget.maxItems)) {
    return { text: compact, truncated: false }
  }

  if (collection) {
    const paged = boundCollection(collection, budget)
    if (paged) return paged
  }
  return boundSerializedText(value, budget)
}

interface BodyReader {
  read(): Promise<{ done?: boolean; value?: unknown }>
  cancel(): Promise<void>
  releaseLock(): void
}

interface ReadableBody {
  getReader(): BodyReader
}

function bodyStream(res: Response): ReadableBody | null {
  const body = (res as { body?: unknown }).body
  if (!body || typeof (body as ReadableBody).getReader !== 'function') return null
  return body as ReadableBody
}

/**
 * Read a response body up to `maxBytes`, stopping the read (and cancelling the
 * stream, which closes the connection) as soon as the cap is passed. A hostile
 * server therefore never gets its whole body buffered here.
 *
 * Responses that expose no readable stream — test doubles, or a transport that
 * has already buffered the body — fall back to `res.text()` and report the
 * overflow; the cap is still honoured, only after the damage is done.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  const stream = bodyStream(res)
  if (!stream) {
    const text = await res.text()
    if (byteLength(text) <= maxBytes) return { text, exceeded: false }
    return { text: sliceToBytes(text, maxBytes), exceeded: true }
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let received = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = value as Uint8Array | undefined
      if (!chunk || chunk.byteLength === 0) continue

      received += chunk.byteLength
      if (received > maxBytes) {
        // Keep the part that fits, drop the rest, and stop reading — the point
        // is that the overshoot never lands in memory at all.
        const kept = chunk.subarray(0, chunk.byteLength - (received - maxBytes))
        text += decoder.decode(kept)
        await reader.cancel().catch(() => undefined)
        return { text, exceeded: true }
      }
      text += decoder.decode(chunk, { stream: true })
    }
    text += decoder.decode()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released by cancel()
    }
  }

  return { text, exceeded: false }
}
