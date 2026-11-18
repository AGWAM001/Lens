import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { toBarePath } from '../src/openapi/coverage'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SPEC_PATH = join(ROOT, 'openapi.yaml')

// Route groups, matched by path prefix in order. Every GET route must match a
// group or appear in SKIPPED, so a new route cannot be dropped silently.
const GROUPS: { name: string; prefixes: string[] }[] = [
  // /impact sits with price: it answers what a trade of a given size costs,
  // which is the same question /book and the depth routes answer.
  //
  // /assets sits beside /pairs for the same reason: both answer "what does Lens
  // track", one by instrument and one by market, and a caller reaching for one
  // usually wants the other in the same breath.
  { name: 'price', prefixes: ['/price/', '/candles', '/book', '/prices/', '/pools', '/pairs', '/impact', '/assets'] },
  {
    name: 'analytics',
    prefixes: [
      '/volumes', '/spreads', '/compare', '/screener', '/benchmark', '/pegs', '/basket',
      '/tvl', '/rates', '/dispersion', '/movers', '/correlation', '/coverage', '/premium',
    ],
  },
  { name: 'service', prefixes: ['/status', '/supported', '/discovery', '/usage', '/venues', '/snapshot'] },
]

// GET routes deliberately without a snippet, with the reason.
const SKIPPED: Record<string, string> = {
  '/graphql': 'GraphQL query documents are covered in docs/graphql.md',
  '/live': 'Orchestrator liveness probe, not a data API call',
  '/ready': 'Orchestrator readiness probe, not a data API call',
}

// Non-GET operations (POST, DELETE) are not generated. They need request bodies,
// admin keys, or signed payment payloads that cannot be runnable from the spec alone.

interface Param {
  name: string
  in: string
  required?: boolean
  example?: unknown
  schema?: { default?: unknown; example?: unknown }
  $ref?: string
}
interface Operation {
  operationId: string
  security?: Record<string, unknown>[]
  parameters?: Param[]
}
interface Spec {
  paths: Record<string, Record<string, Operation>>
  components: { parameters: Record<string, Param> }
}

interface Built {
  operationId: string
  path: string
  query: [string, string][]
  gated: boolean
  apiKey: boolean
}

export function loadSpec(): Spec {
  return YAML.load(readFileSync(SPEC_PATH, 'utf8')) as Spec
}

function resolveParam(spec: Spec, p: Param): { param: Param; isNetwork: boolean } {
  if (p.$ref) {
    const key = p.$ref.split('/').pop() as string
    const resolved = spec.components.parameters[key]
    if (!resolved) throw new Error(`Unknown parameter ref ${p.$ref}`)
    return { param: resolved, isNetwork: key === 'NetworkQuery' }
  }
  return { param: p, isNetwork: false }
}

function valueFor(param: Param): unknown {
  if (param.example !== undefined) return param.example
  if (param.schema?.example !== undefined) return param.schema.example
  throw new Error(
    `Required parameter "${param.name}" has no example in openapi.yaml. Add one to the spec rather than guessing a value here.`,
  )
}

function build(spec: Spec, path: string, op: Operation): Built {
  let resolvedPath = path
  const query: [string, string][] = []

  for (const raw of op.parameters ?? []) {
    const { param, isNetwork } = resolveParam(spec, raw)
    if (param.in === 'path') {
      const v = valueFor(param)
      resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(String(v)))
    } else if (param.in === 'query' && (param.required || isNetwork)) {
      const v = isNetwork ? param.schema?.default : valueFor(param)
      const values = Array.isArray(v) ? v : [v]
      for (const x of values) query.push([param.name, String(x)])
    }
  }

  const security = op.security ?? []
  return {
    operationId: op.operationId,
    path: resolvedPath,
    query,
    gated: security.some((s) => 'x402' in s),
    apiKey: security.some((s) => 'apiKeyAuth' in s),
  }
}

function collect(spec: Spec): Map<string, Built[]> {
  const byGroup = new Map<string, Built[]>(GROUPS.map((g) => [g.name, []]))
  for (const [path, methods] of Object.entries(spec.paths)) {
    const get = methods.get
    if (!get) continue
    // Every documented path carries the /v1 prefix since 97c50bf. The groups
    // and the skip list below are keyed on the canonical bare route, so match
    // on that; the snippet itself still renders the versioned URL, which is
    // the one callers should use.
    const bare = toBarePath(path)
    if (bare in SKIPPED) continue
    const group = GROUPS.find((g) => g.prefixes.some((p) => bare.startsWith(p)))
    if (!group) {
      throw new Error(
        `GET ${bare} is not in a snippet group or SKIPPED in scripts/gen-snippets.ts`,
      )
    }
    byGroup.get(group.name)!.push(build(spec, path, get))
  }
  return byGroup
}

const REQUIRE_ENV_TS = `function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(\`Set \${name} before running this snippet\`)
  return value
}`

function renderTs(group: string, ops: Built[]): string {
  const needsPay = ops.some((o) => o.gated)
  const lines: string[] = [
    '// Generated by scripts/gen-snippets.ts from openapi.yaml. Do not edit by hand.',
    `// Run: LENS_BASE_URL=<live URL> npx tsx snippets/typescript/${group}.ts`,
    '',
  ]
  if (needsPay) {
    lines.push(
      `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch'`,
      `import { ExactStellarScheme } from '@x402/stellar/exact/client'`,
      `import { createEd25519Signer } from '@x402/stellar'`,
      '',
    )
  }
  lines.push(REQUIRE_ENV_TS, '', `const BASE_URL = requireEnv('LENS_BASE_URL')`)
  if (needsPay) {
    lines.push(
      `// Requires STELLAR_SECRET (testnet). Payments are signed for stellar:testnet.`,
      `const signer = createEd25519Signer(requireEnv('STELLAR_SECRET'), 'stellar:testnet')`,
      `const payFetch = wrapFetchWithPaymentFromConfig(fetch, {`,
      `  schemes: [{ network: 'stellar:*', client: new ExactStellarScheme(signer) }],`,
      `})`,
    )
  }

  for (const op of ops) {
    const fetchFn = op.gated ? 'payFetch' : 'fetch'
    lines.push('')
    lines.push(`// ${op.operationId}: GET ${op.path}${op.gated ? ' (x402-gated)' : ''}`)
    lines.push('{')
    lines.push(`  const url = new URL(${JSON.stringify(op.path)}, BASE_URL)`)
    if (op.query.length > 0) {
      lines.push(`  url.search = new URLSearchParams(${JSON.stringify(op.query)}).toString()`)
    }
    if (op.apiKey) {
      lines.push(`  const headers: Record<string, string> = { Authorization: 'Bearer ' + requireEnv('LENS_API_KEY') }`)
    } else {
      lines.push(`  const headers: Record<string, string> = {}`)
    }
    lines.push(`  const res = await ${fetchFn}(url, { headers })`)
    lines.push(`  console.log(${JSON.stringify(op.operationId)}, res.status, await res.json())`)
    lines.push('}')
  }
  return lines.join('\n') + '\n'
}

const REQUIRE_ENV_PY = `def require_env(name):
    value = os.environ.get(name)
    if not value:
        sys.exit(f"Set {name} before running this snippet")
    return value`

function renderPy(group: string, ops: Built[]): string {
  const needsPay = ops.some((o) => o.gated)
  const needsKey = ops.some((o) => o.apiKey)
  const lines: string[] = [
    '# Generated by scripts/gen-snippets.ts from openapi.yaml. Do not edit by hand.',
    `# Run: LENS_BASE_URL=<live URL> python snippets/python/${group}.py   (needs: pip install requests)`,
    '',
    'import os',
    'import sys',
    'import requests',
    '',
    REQUIRE_ENV_PY,
    '',
    'BASE_URL = require_env("LENS_BASE_URL")',
  ]
  if (needsPay) {
    lines.push(
      '# Base64 X-PAYMENT header produced by an x402 signer (see @x402/stellar).',
      'PAYMENT = require_env("LENS_X_PAYMENT")',
    )
  }
  if (needsKey) {
    lines.push('API_KEY = require_env("LENS_API_KEY")')
  }

  for (const op of ops) {
    let headers = '{}'
    if (op.gated) headers = '{"X-PAYMENT": PAYMENT}'
    else if (op.apiKey) headers = '{"Authorization": "Bearer " + API_KEY}'
    lines.push('')
    lines.push(`# ${op.operationId}: GET ${op.path}${op.gated ? ' (x402-gated)' : ''}`)
    lines.push(
      `res = requests.get(BASE_URL + ${JSON.stringify(op.path)}, params=${JSON.stringify(op.query)}, headers=${headers}, timeout=30)`,
    )
    lines.push(`print(${JSON.stringify(op.operationId)}, res.status_code, res.json())`)
  }
  return lines.join('\n') + '\n'
}

export function renderSnippets(spec: Spec = loadSpec()): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [group, ops] of collect(spec)) {
    if (ops.length === 0) continue
    files[`snippets/typescript/${group}.ts`] = renderTs(group, ops)
    files[`snippets/python/${group}.py`] = renderPy(group, ops)
  }
  return files
}

export function writeSnippets(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(ROOT, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

// Run only when invoked directly (`npm run snippets:gen`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeSnippets(renderSnippets())
  console.log('Generated snippets')
}