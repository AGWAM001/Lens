import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import ts from 'typescript'

const rootDir = resolve(__dirname, '../..')
const srcDir = resolve(rootDir, 'src')
const envExamplePath = resolve(rootDir, '.env.example')

/**
 * Explicit allow-list for environment variables that are deliberately
 * undocumented in .env.example.
 *
 * Each entry must contain an explicit rationale explaining why the variable
 * is omitted from .env.example (e.g., platform-injected, CI-only, or a
 * legacy/optional fallback whose primary counterpart is already documented).
 */
export const UNDOCUMENTED_ENV_ALLOW_LIST: Record<string, string> = {
  // Platform-injected & CI runtime variables
  CI: 'Standard continuous integration indicator injected by CI runners (e.g. GitHub Actions); not operator-configurable.',
  GITHUB_ACTIONS: 'Platform-injected environment variable present in GitHub Actions runners; not operator-configurable.',
  RENDER: 'Platform-injected environment variable set by the Render hosting platform; not operator-configurable.',

  // Optional per-network venue overrides where the shared fallback is documented in .env.example
  SOROSWAP_TOKEN_LIST_URL_TESTNET:
    'Optional per-network override; shared fallback SOROSWAP_TOKEN_LIST_URL is documented in .env.example.',
  SOROSWAP_TOKEN_LIST_URL_MAINNET:
    'Optional per-network override; shared fallback SOROSWAP_TOKEN_LIST_URL is documented in .env.example.',
  SOROSWAP_POLL_INTERVAL_MS_TESTNET:
    'Optional per-network override for polling interval; shared fallback SOROSWAP_POLL_INTERVAL_MS is documented in .env.example.',
  SOROSWAP_POLL_INTERVAL_MS_MAINNET:
    'Optional per-network override for polling interval; shared fallback SOROSWAP_POLL_INTERVAL_MS is documented in .env.example.',
  AQUARIUS_API_URL_TESTNET:
    'Optional per-network venue override; shared fallback AQUARIUS_API_URL is documented in .env.example.',
  AQUARIUS_API_URL_MAINNET:
    'Optional per-network venue override; shared fallback AQUARIUS_API_URL is documented in .env.example.',
  REFLECTOR_ENABLED_TESTNET:
    'Optional per-network feature flag override; enabled by default on testnet if reflectorContractId is configured.',
  REFLECTOR_ENABLED_MAINNET:
    'Optional per-network feature flag override; enabled by default on mainnet if reflectorContractId is configured.',

  // Legacy single-network fallbacks where paired network-specific variables are documented
  FACILITATOR_FEE_STROOPS:
    'Legacy unsuffixed fallback for testnet; FACILITATOR_FEE_STROOPS_TESTNET and FACILITATOR_FEE_STROOPS_MAINNET are documented in .env.example.',
}

/**
 * Parses .env.example and returns a Set of defined variable names.
 */
export function parseEnvExample(filePath: string): Set<string> {
  const content = readFileSync(filePath, 'utf8')
  const vars = new Set<string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (match) {
      vars.add(match[1])
    }
  }
  return vars
}

/**
 * Recursively collects all TypeScript source files in a directory,
 * excluding tests, mocks, and node_modules.
 */
export function getSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...getSourceFiles(fullPath))
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(fullPath)
    }
  }
  return files
}

export interface EnvRead {
  name: string
  file: string
  line: number
}

/**
 * Scans a source file's AST for process.env reads:
 * 1. process.env.VAR_NAME (and optional chaining process.env?.VAR_NAME)
 * 2. process.env['VAR_NAME'] / process.env["VAR_NAME"]
 * 3. Dynamic template literals process.env[`${PREFIX}_${suffix}`] which expand
 *    to TESTNET and MAINNET variants.
 */
export function extractEnvReadsFromSource(sourceCode: string, fileName: string): EnvRead[] {
  const sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true)
  const reads: EnvRead[] = []

  function addRead(name: string, node: ts.Node) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    reads.push({
      name,
      file: fileName,
      line: line + 1,
    })
  }

  function isProcessEnv(expr: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(expr) || ts.isPropertyAccessChain(expr)) {
      return expr.expression.getText(sourceFile) === 'process' && expr.name.getText(sourceFile) === 'env'
    }
    return false
  }

  function visit(node: ts.Node) {
    // 1. process.env.X or process?.env?.X
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
      if (isProcessEnv(node.expression)) {
        addRead(node.name.getText(sourceFile), node)
      }
    }

    // 2. process.env['X'] or process.env[`X_${suffix}`]
    if (ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) {
      if (isProcessEnv(node.expression)) {
        const arg = node.argumentExpression
        if (ts.isStringLiteral(arg)) {
          addRead(arg.text, node)
        } else if (ts.isTemplateExpression(arg)) {
          const head = arg.head.text
          if (head.endsWith('_')) {
            addRead(`${head}TESTNET`, node)
            addRead(`${head}MAINNET`, node)
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return reads
}

describe('.env.example drift guard', () => {
  // Parsing every file under src/ with the TypeScript compiler takes several
  // seconds on a cold filesystem cache (i.e. a fresh CI checkout), which trips
  // vitest's 5s default and makes this guard flaky. Give it real headroom.
  it('asserts each process.env read in source appears in .env.example or the allow-list', { timeout: 60_000 }, () => {
    const documentedVars = parseEnvExample(envExamplePath)
    const sourceFiles = getSourceFiles(srcDir)
    const allReads: EnvRead[] = []

    for (const file of sourceFiles) {
      const code = readFileSync(file, 'utf8')
      const reads = extractEnvReadsFromSource(code, relative(rootDir, file))
      allReads.push(...reads)
    }

    const missing = allReads.filter(
      (read) => !documentedVars.has(read.name) && !(read.name in UNDOCUMENTED_ENV_ALLOW_LIST)
    )

    if (missing.length > 0) {
      const grouped = new Map<string, string[]>()
      for (const m of missing) {
        if (!grouped.has(m.name)) grouped.set(m.name, [])
        grouped.get(m.name)!.push(`${m.file}:${m.line}`)
      }

      const formatted = Array.from(grouped.entries())
        .map(([varName, locs]) => `  - ${varName} (read at ${locs.join(', ')})`)
        .join('\n')

      expect.fail(
        `Found ${grouped.size} environment variable(s) read in source but missing from .env.example and not in allow-list:\n${formatted}\n\nPlease add them to .env.example with documentation, or to UNDOCUMENTED_ENV_ALLOW_LIST with an explicit rationale.`
      )
    }
  })

  it('fails when a new un-documented process.env read is encountered', () => {
    const sampleCode = `
      export function init() {
        const secret = process.env.SOME_BRAND_NEW_SECRET_VAR
        return secret
      }
    `
    const reads = extractEnvReadsFromSource(sampleCode, 'src/sample.ts')
    const documentedVars = parseEnvExample(envExamplePath)

    const missing = reads.filter(
      (read) => !documentedVars.has(read.name) && !(read.name in UNDOCUMENTED_ENV_ALLOW_LIST)
    )

    expect(missing).toHaveLength(1)
    expect(missing[0].name).toBe('SOME_BRAND_NEW_SECRET_VAR')
  })

  it('requires every allow-list entry to have an explicit rationale', () => {
    const entries = Object.entries(UNDOCUMENTED_ENV_ALLOW_LIST)
    expect(entries.length).toBeGreaterThan(0)

    for (const [varName, reason] of entries) {
      expect(
        typeof reason === 'string' && reason.trim().length > 15,
        `Allow-list entry ${varName} must have an explicit rationale explaining why it is omitted`
      ).toBe(true)
    }
  })
})
