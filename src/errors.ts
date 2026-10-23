import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

export const INTERNAL_ERROR_CODE = 'internal_error'
export const INTERNAL_ERROR_MESSAGE = 'An internal server error occurred.'

export interface InternalErrorResponse {
  code: typeof INTERNAL_ERROR_CODE
  message: typeof INTERNAL_ERROR_MESSAGE
  correlationId: string
}

export function getCorrelationId(req?: FastifyRequest): string {
  const headerId = req?.headers?.['x-correlation-id'] || req?.headers?.['x-request-id']
  if (typeof headerId === 'string' && headerId.length > 0) {
    return headerId
  }
  if (typeof req?.id === 'string' && req.id.length > 0) {
    return req.id
  }
  return randomUUID()
}

export function createInternalErrorBody(correlationId: string): InternalErrorResponse {
  return {
    code: INTERNAL_ERROR_CODE,
    message: INTERNAL_ERROR_MESSAGE,
    correlationId,
  }
}

export function sendInternalError(
  reply: FastifyReply,
  req: FastifyRequest,
  err: unknown,
  logMessage = 'Internal server error',
): FastifyReply {
  const correlationId = getCorrelationId(req)
  const log = req?.log ?? reply?.log
  if (log && typeof log.error === 'function') {
    log.error({ err, correlationId }, logMessage)
  }

  return reply.status(500).send(createInternalErrorBody(correlationId))
}
