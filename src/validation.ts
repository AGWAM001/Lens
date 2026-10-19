import { z } from 'zod'

/**
 * Machine-readable code for every validation error produced by
 * {@link formatValidationError}. Callers can branch on this instead of
 * parsing the human-readable message.
 */
export const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'

/**
 * Turn a zod validation error into the standard error shape.
 *
 * Every route uses this one formatter so a caller sees the same shape for
 * the same class of mistake, no matter which route rejected the request.
 * Messages name the parameter and what was expected.
 *
 * @param error the zod error to format
 * @param code optional machine-readable code override (defaults to
 *             {@link VALIDATION_ERROR_CODE}); used for rejections that are
 *             not plain validation errors, e.g. unsupported parameters.
 */
export function formatValidationError(
  error: z.ZodError,
  code: string = VALIDATION_ERROR_CODE
): {
  error: string
  code: string
} {
  const issue = error.issues[0]
  const param = issue.path.length > 0 ? issue.path.join('.') : 'parameters'
  return {
    error: `Invalid ${param}: ${issue.message}`,
    code,
  }
}
