import {
  loadOpenApiSpec,
  buildSpecAjv,
  resolveTestRequest,
  checkResponseAgainstSpec,
  formatMarkdownReport,
  postOrUpdateGitHubReport,
  type RouteCheckResult,
  type ValidationSummary,
} from '../src/openapi/liveValidator'

async function run() {
  const spec = loadOpenApiSpec()
  const ajv = buildSpecAjv(spec)
  const baseUrl = (process.env.LIVE_API_URL || process.env.LENS_URL || 'http://localhost:3002').replace(/\/+$/, '')

  console.log(`[live-spec] Target service: ${baseUrl}`)
  console.log(`[live-spec] Validating documented routes in openapi.yaml against live service...`)

  const results: RouteCheckResult[] = []
  const paths = Object.keys(spec.paths || {})

  let checkedCount = 0
  let validCount = 0
  let mismatchCount = 0
  let unreachableCount = 0

  for (const path of paths) {
    const operations = spec.paths[path]
    for (const [method, operation] of Object.entries(operations)) {
      if (['parameters', 'summary', 'description', '$ref'].includes(method)) continue

      const resolved = resolveTestRequest(path, method)
      const targetUrl = `${baseUrl}${resolved.urlPath}`
      const startTime = Date.now()

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 6000)

        const fetchOptions: RequestInit = {
          method: resolved.method,
          headers: {
            'User-Agent': 'Lens-LiveSpecValidator/1.0',
            ...(resolved.body ? { 'Content-Type': 'application/json' } : {}),
          },
          signal: controller.signal,
        }
        if (resolved.body) {
          fetchOptions.body = resolved.body
        }

        const res = await fetch(targetUrl, fetchOptions)
        clearTimeout(timeout)
        const durationMs = Date.now() - startTime

        let body: any = null
        const contentType = res.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          try {
            body = await res.json()
          } catch {
            body = null
          }
        }

        const check = checkResponseAgainstSpec(ajv, spec, path, method, res.status, body)
        check.durationMs = durationMs
        results.push(check)

        checkedCount++
        if (check.valid) {
          validCount++
          console.log(`  ✓ ${method.toUpperCase()} ${resolved.urlPath} [${res.status}] (${durationMs}ms)`)
        } else {
          mismatchCount++
          console.log(`  ✗ ${method.toUpperCase()} ${resolved.urlPath} [${res.status}] - Schema mismatch:`)
          for (const err of check.errors || []) {
            console.log(`      path: ${err.path || '/'}, message: ${err.message}`)
          }
        }
      } catch (err: any) {
        unreachableCount++
        const durationMs = Date.now() - startTime
        console.log(`  ⚠ ${method.toUpperCase()} ${resolved.urlPath} - Unreachable (${err.message})`)
        results.push({
          path,
          method,
          resolvedUrl: resolved.urlPath,
          status: null,
          valid: false,
          skipped: true,
          skipReason: `Network error: ${err.message}`,
          durationMs,
        })
      }
    }
  }

  const summary: ValidationSummary = {
    timestamp: new Date().toISOString(),
    baseUrl,
    totalDocumented: paths.length,
    checked: checkedCount,
    valid: validCount,
    mismatched: mismatchCount,
    unreachable: unreachableCount,
    results,
  }

  const markdown = formatMarkdownReport(summary)
  console.log('\n--- Summary Report ---')
  console.log(markdown)

  // Report to single tracking GitHub issue if configured
  const githubResult = await postOrUpdateGitHubReport(markdown)
  if (githubResult.action === 'appended') {
    console.log(`[live-spec] Appended results to existing tracking issue #${githubResult.issueNumber}`)
  } else if (githubResult.action === 'created') {
    console.log(`[live-spec] Created initial tracking issue #${githubResult.issueNumber}`)
  } else {
    console.log(`[live-spec] Report output complete (CI step summary written if available)`)
  }

  // Acceptance criteria: "It reports rather than fails the build, since the live service is not in CI's control."
  process.exit(0)
}

run().catch(err => {
  console.error('[live-spec] Fatal error:', err)
  process.exit(0)
})
