import type { FastifyBaseLogger } from 'fastify'
import { process_crashes_total } from './metrics'

type ProcessErrorLogger = Pick<FastifyBaseLogger, 'fatal'>
type ExitProcess = (code: number) => never

export function installProcessErrorHandlers(
  logger: ProcessErrorLogger,
  exit: ExitProcess = (code) => process.exit(code),
): () => void {
  const terminate = (event: string, error: unknown, details: Record<string, unknown> = {}) => {
    process_crashes_total.inc({ event })

    try {
      const logError = error instanceof Error
        ? error
        : new Error(`Fatal process error: ${String(error)}`, { cause: error })
      logger.fatal({ err: logError, ...details }, `Fatal process error: ${event}`)
    } finally {
      exit(1)
    }
  }

  const onUnhandledRejection = (reason: unknown) => {
    terminate('unhandledRejection', reason)
  }

  const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    terminate('uncaughtException', error, { origin })
  }

  process.on('unhandledRejection', onUnhandledRejection)
  process.on('uncaughtException', onUncaughtException)

  return () => {
    process.removeListener('unhandledRejection', onUnhandledRejection)
    process.removeListener('uncaughtException', onUncaughtException)
  }
}
