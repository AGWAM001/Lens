import { createLogger } from '../logger'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error js-yaml types
import YAML from 'js-yaml'
import Ajv, { type ErrorObject } from 'ajv'

const log = createLogger('liveValidator')

export interface SchemaMismatchDetail {
  path: string
  keyword: string
  message: string
  expected?: string
  actual?: unknown
}

export interface RouteCheckResult {
  path: string
  method: string
  resolvedUrl: string
  status: number | null
  valid: boolean
  skipped: boolean
  skipReason?: string
  errors?: SchemaMismatchDetail[]
  durationMs?: number
}

export interface ValidationSummary {
  timestamp: string
  baseUrl: string
  totalDocumented: number
  checked: number
  valid: number
  mismatched: number
  unreachable: number
  results: RouteCheckResult[]
}

/**
 * Recursively normalizes OpenAPI schemas to align with Ajv JSON Schema compilation.
 * Specifically fixes OpenAPI 3.0 `nullable: true` on objects without explicit `type`.
 */
export function normalizeOpenApiSchema(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  if (obj.nullable && !obj.type) {
    obj.type = 'object'
  }
  for (const key of Object.keys(obj)) {
    normalizeOpenApiSchema(obj[key])
  }
  return obj
}

/**
 * Loads and parses openapi.yaml from repository root.
 */
export function loadOpenApiSpec(customPath?: string): any {
  let specPath = customPath
  if (!specPath) {
    const cwdPath = resolve(process.cwd(), 'openapi.yaml')
    if (existsSync(cwdPath)) {
      specPath = cwdPath
    } else {
      specPath = resolve(__dirname, '../../openapi.yaml')
    }
  }
  const raw = readFileSync(specPath, 'utf8')
  const spec = YAML.load(raw) as any
  return normalizeOpenApiSchema(spec)
}

/**
 * Builds an Ajv instance initialized with all components schemas from OpenAPI spec.
 */
export function buildSpecAjv(spec: any): Ajv {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
  })

  // Register components schemas so #/components/schemas/... refs resolve seamlessly
  if (spec.components?.schemas) {
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      try {
        ajv.addSchema(schema as object, `#/components/schemas/${name}`)
      } catch {
        // Schema may have already been added
      }
    }
  }

  // Also register root document
  try {
    ajv.addSchema(spec, 'openapi.yaml')
  } catch {
    // Ignore if already added
  }

  return ajv
}

/**
 * Resolves path and query parameters into a realistic test request URL and body.
 */
export function resolveTestRequest(
  pathTemplate: string,
  method: string
): { urlPath: string; method: string; body?: string } {
  let url = pathTemplate
    .replace('{assetA}', 'XLM')
    .replace('{assetB}', 'USDC')
    .replace('{asset}', 'XLM')
    .replace('{id}', 'test-id-1')
    .replace('{keyId}', 'test-key-id-1')

  // Append sensible query params for endpoints requiring them
  if (pathTemplate.includes('/route')) {
    url += '?amount=100'
  } else if (pathTemplate.includes('/depth')) {
    url += '?amount=100'
  } else if (pathTemplate.includes('/history') && !url.includes('?')) {
    url += '?window=1h'
  } else if (pathTemplate.includes('/benchmark')) {
    url += '?target=USD'
  } else if (pathTemplate === '/basket') {
    url += '?asset=XLM&weight=1'
  } else if (pathTemplate === '/screener') {
    url += '?limit=5'
  }

  const httpMethod = method.toUpperCase()
  let body: string | undefined

  if (httpMethod === 'POST') {
    if (pathTemplate === '/graphql') {
      body = JSON.stringify({ query: '{ __typename }' })
    } else if (pathTemplate === '/verify') {
      body = JSON.stringify({
        paymentPayload: { scheme: 'exact' },
        paymentRequirements: { payTo: 'GDTEST' },
      })
    } else if (pathTemplate === '/settle') {
      body = JSON.stringify({
        paymentPayload: { scheme: 'exact' },
        paymentRequirements: { payTo: 'GDTEST' },
      })
    } else if (pathTemplate === '/webhooks') {
      body = JSON.stringify({
        url: 'https://example.com/webhook',
        assetA: 'XLM',
        assetB: 'USDC',
        threshold: 0.25,
        direction: 'above',
      })
    }
  }

  return { urlPath: url, method: httpMethod, body }
}

/**
 * Finds the matching schema for a given operation and HTTP status code.
 */
export function getResponseSchema(operation: any, statusCode: number): any | null {
  if (!operation.responses) return null

  // Direct status match, e.g. '200', '402', '400'
  const direct = operation.responses[String(statusCode)]
  if (direct?.content?.['application/json']?.schema) {
    return direct.content['application/json'].schema
  }

  // 2xx fallback
  if (statusCode >= 200 && statusCode < 300) {
    const fallback2xx = operation.responses['2XX'] || operation.responses['200']
    if (fallback2xx?.content?.['application/json']?.schema) {
      return fallback2xx.content['application/json'].schema
    }
  }

  // Default response schema fallback
  if (operation.responses.default?.content?.['application/json']?.schema) {
    return operation.responses.default.content['application/json'].schema
  }

  return null
}

/**
 * Validates a response body against the declared OpenAPI schema.
 */
export function validateResponseAgainstSchema(
  ajv: Ajv,
  schema: any,
  responseBody: unknown
): { valid: boolean; errors?: SchemaMismatchDetail[] } {
  let validate
  try {
    validate = ajv.compile(schema)
  } catch (err: any) {
    // If compilation fails due to schema quirks, return error
    return {
      valid: false,
      errors: [
        {
          path: '',
          keyword: 'compilation',
          message: `Schema compilation failed: ${err.message}`,
        },
      ],
    }
  }

  const valid = validate(responseBody)
  if (valid) {
    return { valid: true }
  }

  const errors: SchemaMismatchDetail[] = (validate.errors || []).map((err: ErrorObject) => ({
    path: err.instancePath || '/',
    keyword: err.keyword,
    message: err.message || 'validation failed',
    expected: JSON.stringify(err.params),
    actual: err.data,
  }))

  return { valid: false, errors }
}

/**
 * Checks an actual or mock response against the operation's schema in OpenAPI spec.
 */
export function checkResponseAgainstSpec(
  ajv: Ajv,
  spec: any,
  path: string,
  method: string,
  statusCode: number,
  responseBody: unknown
): RouteCheckResult {
  const normMethod = method.toLowerCase()
  const operation = spec.paths?.[path]?.[normMethod]
  const resolved = resolveTestRequest(path, normMethod)

  if (!operation) {
    return {
      path,
      method: normMethod,
      resolvedUrl: resolved.urlPath,
      status: statusCode,
      valid: false,
      skipped: false,
      errors: [{ path: '', keyword: 'not_found', message: `Route ${method} ${path} missing from spec` }],
    }
  }

  const schema = getResponseSchema(operation, statusCode)
  if (!schema) {
    // Some routes return 204 No Content with no body schema (e.g. DELETE)
    if (statusCode === 204 || !responseBody) {
      return {
        path,
        method: normMethod,
        resolvedUrl: resolved.urlPath,
        status: statusCode,
        valid: true,
        skipped: false,
      }
    }

    return {
      path,
      method: normMethod,
      resolvedUrl: resolved.urlPath,
      status: statusCode,
      valid: false,
      skipped: false,
      errors: [
        {
          path: '',
          keyword: 'schema_missing',
          message: `No schema documented for status ${statusCode} under ${normMethod.toUpperCase()} ${path}`,
        },
      ],
    }
  }

  const { valid, errors } = validateResponseAgainstSchema(ajv, schema, responseBody)

  return {
    path,
    method: normMethod,
    resolvedUrl: resolved.urlPath,
    status: statusCode,
    valid,
    skipped: false,
    errors,
  }
}

/**
 * Formats validation results into a comprehensive Markdown report.
 */
export function formatMarkdownReport(summary: ValidationSummary): string {
  const mismatchRows = summary.results
    .filter(r => !r.valid && !r.skipped)
    .map(r => {
      const errorMsg = (r.errors || []).map(e => `\`${e.path}\`: ${e.message}`).join('<br>')
      return `| \`${r.method.toUpperCase()}\` | \`${r.resolvedUrl}\` | \`${r.status ?? 'N/A'}\` | ${errorMsg} |`
    })

  const mismatchesTable =
    mismatchRows.length > 0
      ? `### Schema Mismatches Detected (${summary.mismatched})\n\n| Method | Endpoint | HTTP Status | Mismatch Details |\n|---|---|---|---|\n${mismatchRows.join('\n')}\n`
      : `### Schema Mismatches\n\nNo schema mismatches detected. All tested responses match their published OpenAPI specification.\n`

  const allRouteRows = summary.results.map(r => {
    const statusIcon = r.skipped ? '⏭️ SKIPPED' : r.valid ? '✅ VALID' : '❌ MISMATCH'
    return `| \`${r.method.toUpperCase()}\` | \`${r.resolvedUrl}\` | \`${r.status ?? 'N/A'}\` | ${statusIcon} | ${r.durationMs ? `${r.durationMs}ms` : '-'} |`
  })

  return `## Live Service Spec Drift Report

**Generated:** ${summary.timestamp}  
**Target Host:** \`${summary.baseUrl}\`  
**Overall Status:** ${summary.mismatched === 0 ? '🟢 HEALTHY (No Drift)' : `⚠️ DRIFT DETECTED (${summary.mismatched} mismatches)`}

### Summary

| Metric | Count |
|---|---|
| Documented Routes | ${summary.totalDocumented} |
| Live Endpoints Checked | ${summary.checked} |
| Schema Conforming | ${summary.valid} |
| Schema Mismatches | ${summary.mismatched} |
| Unreachable / Network Errors | ${summary.unreachable} |

${mismatchesTable}
### Full Route Verification Matrix

| Method | Request Path | Response Status | Conformance | Duration |
|---|---|---|---|---|
${allRouteRows.join('\n')}

---
*Reported automatically by the scheduled live spec validation check. This check reports drift rather than failing CI builds.*
`
}

/**
 * Updates an existing issue or opens a single issue, ensuring reports append rather than multiply.
 */
export async function postOrUpdateGitHubReport(
  reportMarkdown: string,
  options: { repo?: string; token?: string; issueTitle?: string; label?: string } = {}
): Promise<{ action: 'appended' | 'created' | 'summary_only'; issueNumber?: number }> {
  // Precedence: options.token > GITHUB_TOKEN > GH_TOKEN.
  // In automated GitHub Actions CI runners, GITHUB_TOKEN is injected natively into the runner environment.
  // GH_TOKEN is supported as a fallback when running under CLI contexts (e.g. GitHub CLI `gh`).
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? 'Divinity-Labs/Lens'
  const title = options.issueTitle ?? 'Live Service Spec Drift Report'
  const label = options.label ?? 'live-spec-report'

  // If in GitHub Actions, always write to GITHUB_STEP_SUMMARY
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const fs = await import('node:fs')
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, reportMarkdown + '\n')
    } catch {
      // Ignore step summary write error
    }
  }

  if (!token) {
    return { action: 'summary_only' }
  }

  const headers = {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Lens-LiveSpecValidator',
    'Content-Type': 'application/json',
  }

  try {
    // 1. Search for existing issue with this label/title
    const searchRes = await fetch(
      `https://api.github.com/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=10`,
      { headers }
    )

    if (searchRes.ok) {
      const issues = (await searchRes.json()) as any[]
      const existing = issues.find(i => i.title.includes(title) || i.title.includes('Spec Drift'))

      if (existing) {
        // Append comment to existing issue rather than opening a new one
        await fetch(`https://api.github.com/repos/${repo}/issues/${existing.number}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ body: reportMarkdown }),
        })

        // Also update issue body with current status overview
        await fetch(`https://api.github.com/repos/${repo}/issues/${existing.number}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ body: reportMarkdown }),
        })

        return { action: 'appended', issueNumber: existing.number }
      }
    }

    // 2. No existing issue found -> create the single tracking issue
    const createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title,
        body: reportMarkdown,
        labels: [label, 'automated', 'area:tests'],
      }),
    })

    if (createRes.ok) {
      const created = (await createRes.json()) as any
      return { action: 'created', issueNumber: created.number }
    }
  } catch (err) {
    log.warn({ err }, 'liveValidator: GitHub issue update failed')
  }

  return { action: 'summary_only' }
}
