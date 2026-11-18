/**
 * Enforce process.env isolation across the suite.
 *
 * Root cause of intermittent auth.test.ts / pairs.test.ts (and rotating
 * victims like networkVenueConfig.test.ts) failures: Vitest 4's default pool
 * is already `forks`, so files do not run concurrently in one process. What
 * leaks instead is `process.env` *within* a fork - a reused child process runs
 * several files sequentially, so a key one file sets is still set when the
 * next file starts, and any suite that assumes a clean environment fails
 * depending on the order the files happen to be scheduled in.
 *
 * This setup file snapshots `process.env` before every test and restores it
 * afterwards so mutations cannot leak to the next test in the same worker.
 * Combined with `pool: 'forks'` in vitest.config.ts (separate process per
 * concurrent file), cross-file leakage is eliminated without giving up
 * file parallelism.
 */
import { beforeEach, afterEach } from 'vitest'

// Keep the shared pino logger quiet during tests unless a run overrides it.
// This is read when src/logger.ts first imports, before any test module runs.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'

let envSnapshot: Record<string, string | undefined>

beforeEach(() => {
  envSnapshot = { ...process.env }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
