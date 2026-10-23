import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import { process_crashes_total } from '../metrics'
import { installProcessErrorHandlers } from '../processErrorHandlers'

describe('installProcessErrorHandlers', () => {
  afterEach(() => {
    process_crashes_total.reset()
  })

  it.each([
    ['unhandledRejection', 'unhandledRejection'] as const,
    ['uncaughtException', 'uncaughtException'] as const,
  ])('logs the full %s error and exits without continuing', async (event) => {
    const error = new Error(`test ${event} failure`)
    const logger = { fatal: vi.fn() } as unknown as FastifyBaseLogger
    const exitError = new Error('process exited')
    const exit = vi.fn((): never => { throw exitError })
    const uninstall = installProcessErrorHandlers(logger, exit)

    try {
      const handler = process.listeners(event).at(-1)
      expect(handler).toBeDefined()

      let continued = false
      expect(() => {
        if (event === 'unhandledRejection') {
          ;(handler as (reason: unknown, promise: Promise<unknown>) => void)(
            error,
            Promise.resolve(),
          )
        } else {
          ;(handler as (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void)(
            error,
            'uncaughtException',
          )
        }
        continued = true
      }).toThrow(exitError)

      expect(continued).toBe(false)
      expect(logger.fatal).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({ message: error.message, stack: error.stack }),
        }),
        `Fatal process error: ${event}`,
      )
      expect((logger.fatal as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
        .toBeLessThan(exit.mock.invocationCallOrder[0])
      expect(exit).toHaveBeenCalledWith(1)
      expect(await process_crashes_total.get()).toMatchObject({
        values: [expect.objectContaining({ value: 1, labels: { event } })],
      })
    } finally {
      uninstall()
    }
  })
})
