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
import { installNetworkGuard, takeNetworkViolations } from './tests/support/networkGuard'

// Keep the shared pino logger quiet during tests unless a run overrides it.
// This is read when src/logger.ts first imports, before any test module runs.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'

// #226: no test reaches a real host. A blocked attempt errors at once (no DNS
// wait, no HTTP timeout) and is recorded, and the afterEach below fails the test
// that made it - adapters swallow fetch errors by design, so the error alone
// would let a test pass on the degraded path. Loopback stays allowed.
installNetworkGuard()

let envSnapshot: Record<string, string | undefined>

beforeEach(() => {
  envSnapshot = { ...process.env }
  // Attempts made at import time or in a previous file's teardown belong to no
  // test in this one; drop them rather than blaming the first test.
  takeNetworkViolations()
})

afterEach(() => {
  const attempts = takeNetworkViolations()
  if (attempts.length > 0) {
    const targets = [...new Set(attempts.map((a) => a.target))].join(', ')
    throw new Error(
      `This test tried to reach the network (${targets}). Tests run against recorded ` +
        'fixtures only - see tests/fixtures/venues/README.md.'
    )
  }
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
