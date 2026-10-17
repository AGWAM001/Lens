import { config } from './config'

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number
}

/**
 * Wraps global fetch with an AbortSignal timeout deadline.
 *
 * @param input - URL or Request object
 * @param init - Request options, optionally including timeoutMs or signal
 * @returns Response
 * @throws TimeoutError / DOMException when the request exceeds the timeout deadline
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init?: FetchWithTimeoutOptions
): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? config.http?.timeoutMs ?? 10_000

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal

  return fetch(input, {
    ...init,
    signal,
  })
}
