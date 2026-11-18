import { snapshot_retention_path } from '../metrics'
import { createLogger } from '../logger'

const log = createLogger('job:retention-status')

export type RetentionPath = 'starting' | 'redis_queue' | 'in_process'

let activePath: RetentionPath = 'starting'

export function setRetentionPath(path: RetentionPath): void {
  if (path === activePath) return
  activePath = path
  for (const label of ['starting', 'redis_queue', 'in_process'] as const) {
    snapshot_retention_path.set({ path: label }, label === path ? 1 : 0)
  }
  // The house logger, not console: it is what redactSecrets runs through, and
  // `logger.test.ts` fails the build on a console.* call anywhere in src/.
  log.info({ path }, 'snapshot retention path changed')
}

export function getRetentionPath(): RetentionPath {
  return activePath
}
