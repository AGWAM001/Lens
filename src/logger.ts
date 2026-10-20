/**
 * Structured logging.
 *
 * Every module logs through a pino logger with a stable `component` field
 * (`ingester:amm`, `job:snapshot-retention`, `route:price`, …) so operators can
 * filter logs without guessing which `[bracket]` prefix a message came from.
 *
 * - Level is controlled by `LOG_LEVEL` (default `info`). Standard pino levels:
 *   trace, debug, info, warn, error, fatal, silent.
 * - Production emits newline-delimited JSON; development pretty-prints for
 *   humans. Switch is `NODE_ENV === 'production'`.
 * - Values of secret-looking environment variables (DATABASE_URL, *_KEY,
 *   *_SECRET, *_TOKEN, *_PASSWORD) are scrubbed from every line before it is
 *   written, and request auth headers are redacted via pino's `redact`.
 *
 * `logger.ts` must not import `config.ts`: the config module imports this one,
 * so it reads `process.env` directly to avoid a cycle.
 */

import pino, { type Logger, type DestinationStream } from 'pino'

/** Default level when `LOG_LEVEL` is unset. */
export const DEFAULT_LOG_LEVEL = 'info'

/** True when logs should be rendered for humans rather than emitted as JSON. */
export const prettyEnabled = process.env.NODE_ENV !== 'production'

/**
 * Secret environment variables scrubbed out of serialized log lines. A name
 * counts as secret if it is a known connection-string variable or ends with /
 * contains KEY, SECRET, TOKEN or PASSWORD.
 */
const SECRET_URL_NAMES = new Set(['DATABASE_URL', 'DIRECT_DATABASE_URL', 'REDIS_URL'])
const SECRET_NAME_RE = /(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD)/i

/**
 * Minimum length a value must have before it is treated as a secret worth
 * scrubbing. Guards against clobbering ordinary log content with the literal
 * "true"/"false" from boolean-looking flags such as `REQUIRE_API_KEY`.
 */
const MIN_SECRET_LENGTH = 16

/**
 * All secret values currently present in the environment, including the
 * password embedded in a connection-string URL so that driver error messages
 * (which often echo only the credentials) are covered too.
 */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue
    if (SECRET_URL_NAMES.has(name) || SECRET_NAME_RE.test(name)) {
      secrets.add(value)
      if (SECRET_URL_NAMES.has(name)) {
        try {
          const password = new URL(value).password
          if (password && password.length >= 4) secrets.add(password)
        } catch {
          // Not a parseable URL — the full value is still scrubbed above.
        }
      }
    }
  }
  return [...secrets]
}

/**
 * Replaces every secret value in `text` with `[redacted]`. Applied to the
 * fully-serialized line so secrets cannot slip through nested fields.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const secret of secretValues(env)) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]')
  }
  return out
}

/**
 * Paths pino redacts before serialization. Request auth headers and common
 * credential field names, matched at any depth.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'req.headers["x-payment"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'headers["x-admin-token"]',
  'headers["x-payment"]',
  'password',
  'secret',
  'token',
  'apiKey',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
]

interface PrettyLine {
  time?: string
  level?: string | number
  component?: string
  msg?: string
  err?: { type?: string; message?: string; stack?: string }
  [key: string]: unknown
}

const LEVEL_COLOR: Record<string, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
}
const RESET = '\x1b[0m'

/**
 * Renders one NDJSON pino line as a single human-readable line (development).
 * Falls back to the raw line if it is not JSON.
 */
export function formatPretty(line: string): string {
  let obj: PrettyLine
  try {
    obj = JSON.parse(line) as PrettyLine
  } catch {
    return line
  }

  const time = typeof obj.time === 'string' ? obj.time.slice(11, 23) : ''
  const level = String(obj.level ?? '').toLowerCase()
  const color = LEVEL_COLOR[level] ?? ''
  const label = color ? `${color}${level.toUpperCase().padEnd(5)}${RESET}` : level.toUpperCase().padEnd(5)
  const component = obj.component ? `[${obj.component}] ` : ''

  const { time: _t, level: _l, component: _c, msg, err, ...extra } = obj
  const extraKeys = Object.keys(extra).filter((key) => extra[key] !== undefined)

  let out = `${time} ${label} ${component}${msg ?? ''}`
  if (extraKeys.length > 0) {
    out += ` ${JSON.stringify(extra)}`
  }
  if (err) out += `\n${err.stack ?? err.message ?? ''}`
  return `${out}\n`
}

export interface BuildLoggerOptions {
  /** pino level; defaults to `LOG_LEVEL` or `info`. */
  level?: string
  /** Pretty (human) output. Defaults to `NODE_ENV !== 'production'`. */
  pretty?: boolean
  /** Sink for serialized lines. Defaults to `process.stdout`. */
  destination?: DestinationStream
}

/**
 * Builds a pino logger. Factory form is used by tests to capture output;
 * application code should use the shared `logger` / `createLogger` below.
 */
export function buildLogger(opts: BuildLoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL
  const pretty = opts.pretty ?? prettyEnabled
  const destination = createDestination(pretty, opts.destination)
  return pino(loggerOptions(level), destination)
}

/**
 * pino options shared by the module-level logger and Fastify's request logger.
 * `level` is read from `LOG_LEVEL` when not given.
 */
export function loggerOptions(
  level: string = process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL
): pino.LoggerOptions {
  return {
    level,
    base: { service: 'lens' },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  }
}

/**
 * Wraps a sink so every serialized line is scrubbed of secret env values and,
 * in development, pretty-printed. `err` keys are serialized by pino itself.
 */
export function createDestination(
  pretty: boolean = prettyEnabled,
  sink: DestinationStream = process.stdout
): DestinationStream {
  return {
    write(line: string) {
      const safe = redactSecrets(line)
      sink.write(pretty ? formatPretty(safe) : safe)
    },
  }
}

/** Shared root logger. */
export const logger: Logger = buildLogger()

/**
 * Returns a logger tagged with a stable component name. Prefer one child per
 * module, created once at import time:
 *
 *   const log = createLogger('ingester:amm')
 *   log.info({ pool: pool.id }, 'ingested trades')
 *
 * HTTP handlers should derive from the request instead:
 *   req.log.child({ component: 'route:price' })
 */
export function createLogger(component: string): Logger {
  return logger.child({ component })
}
