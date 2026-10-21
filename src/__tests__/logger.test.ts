import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import type { DestinationStream } from 'pino'
import { buildLogger, redactSecrets, secretValues } from '../logger'

const rootDir = resolve(__dirname, '../..')
const srcDir = resolve(rootDir, 'src')

/** Collects serialized log lines in memory instead of writing to stdout. */
function capture(): { lines: string[]; destination: DestinationStream } {
  const lines: string[] = []
  return { lines, destination: { write: (line: string) => { lines.push(line) } } }
}

/** Every non-test .ts file under src/. */
function sourceFiles(dir = srcDir): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...sourceFiles(full))
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(full)
    }
  }
  return files
}

describe('secret redaction', () => {
  it('scrubs a connection string and an API key value', () => {
    const dbUrl = 'postgresql://lens:CANARY-PASSWORD-123456@localhost:5432/lens'
    const apiKey = 'canary-api-key-value-0123456789'
    const env = { DATABASE_URL: dbUrl, ADMIN_API_KEY: apiKey }

    const line = `oops ${dbUrl} and ${apiKey} leaked`
    const scrubbed = redactSecrets(line, env)

    expect(scrubbed).not.toContain('CANARY-PASSWORD-123456')
    expect(scrubbed).not.toContain(apiKey)
    expect(scrubbed).toContain('[redacted]')
  })

  it('also scrubs the password embedded in a connection string on its own', () => {
    const dbUrl = 'postgresql://lens:S0me-CANARY-Passw0rd-long@db:5432/lens'
    const env = { DATABASE_URL: dbUrl }

    expect(secretValues(env)).toContain('S0me-CANARY-Passw0rd-long')
    expect(redactSecrets('driver said password=S0me-CANARY-Passw0rd-long', env)).not.toContain(
      'S0me-CANARY-Passw0rd-long'
    )
  })

  it('ignores boolean-looking flag values so ordinary log content survives', () => {
    const env = { REQUIRE_API_KEY: 'true' }
    expect(secretValues(env)).toEqual([])
    expect(redactSecrets('auth enabled: true', env)).toBe('auth enabled: true')
  })
})

describe('structured logger output', () => {
  it('emits JSON with a component field and a level label', () => {
    const { lines, destination } = capture()
    const log = buildLogger({ level: 'info', pretty: false, destination }).child({
      component: 'ingester:amm',
    })

    log.info({ pool: 'CABCDEF', trades: 3 }, 'ingested pool trades')

    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.component).toBe('ingester:amm')
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('ingested pool trades')
    expect(parsed.pool).toBe('CABCDEF')
    expect(parsed.trades).toBe(3)
    expect(parsed.service).toBe('lens')
  })

  it('never writes a secret value carried in an error or a field', () => {
    const dbUrl = 'postgresql://lens:CANARY-PASSWORD-123456@localhost:5432/lens'
    const apiKey = 'canary-api-key-value-0123456789'
    process.env.DATABASE_URL = dbUrl
    process.env.ADMIN_API_KEY = apiKey

    const { lines, destination } = capture()
    const log = buildLogger({ level: 'info', pretty: false, destination })

    log.error({ err: new Error(`connect failed for ${dbUrl}`) }, 'twap failed')
    log.info({ apiKey }, 'debug key')

    const output = lines.join('\n')
    expect(output).not.toContain('CANARY-PASSWORD-123456')
    expect(output).not.toContain(apiKey)
    expect(output).toContain('[redacted]')
  })

  it('renders human-readable lines in development mode', () => {
    const { lines, destination } = capture()
    const log = buildLogger({ level: 'info', pretty: true, destination }).child({
      component: 'job:snapshot-retention',
    })

    log.info({ network: 'testnet', pruned: 4 }, 'pruned snapshots')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[job:snapshot-retention]')
    expect(lines[0]).toContain('pruned snapshots')
    expect(lines[0]).toContain('INFO')
    expect(() => JSON.parse(lines[0])).toThrow()
  })

  it('respects the level and drops messages below it', () => {
    const { lines, destination } = capture()
    const log = buildLogger({ level: 'warn', pretty: false, destination })

    log.info('not emitted')
    log.warn('emitted')

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).msg).toBe('emitted')
  })
})

describe('logging hygiene', () => {
  /**
   * `src/mcp/` is exempt, and must stay exempt.
   *
   * The MCP server speaks its protocol over **stdout** (`StdioServerTransport`),
   * so stderr is the only stream it may write diagnostics to — and pino's
   * default destination is stdout. Routing these through the logger would
   * interleave log lines with protocol frames and break every client parsing
   * them. `console.error` is correct there, not an oversight.
   */
  // Both separators: `sourceFiles()` builds paths with the platform's, so a
  // forward-slash-only pattern silently matches nothing on Windows.
  const CONSOLE_ALLOWED = /[\\/]src[\\/]mcp[\\/]/

  it('leaves no console.* calls in non-test source', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      if (CONSOLE_ALLOWED.test(file)) continue
      const code = readFileSync(file, 'utf8')
      code.split('\n').forEach((line, i) => {
        if (/\bconsole\.\w+\s*\(/.test(line)) {
          offenders.push(`${relative(rootDir, file)}:${i + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('never passes a raw connection-string env value into a log call', () => {
    const logCall = /\b(?:log|logger|req\.log)\.(?:trace|debug|info|warn|error|fatal)\b/
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const code = readFileSync(file, 'utf8')
      code.split('\n').forEach((line, i) => {
        if (!logCall.test(line)) return
        if (line.includes('process.env.DATABASE_URL') || line.includes('process.env.DIRECT_DATABASE_URL')) {
          offenders.push(`${relative(rootDir, file)}:${i + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
