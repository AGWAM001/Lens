import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import { fetchWithTimeout } from '../fetch'

describe('fetchWithTimeout', () => {
  let server: http.Server | null = null

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
  })

  it('proves a hung server causes a rejected promise within the deadline, not a pending one', async () => {
    // Start an HTTP server that accepts the connection and never writes any response bytes
    server = http.createServer((_req, _res) => {
      // Hangs indefinitely
    })

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/hang`

    const timeoutMs = 150
    const start = Date.now()

    let caughtError: any = null
    try {
      await fetchWithTimeout(url, { timeoutMs })
    } catch (err) {
      caughtError = err
    }

    const elapsed = Date.now() - start

    expect(caughtError).not.toBeNull()
    // In Node.js, an AbortSignal.timeout() abort produces a TimeoutError (DOMException)
    expect(caughtError.name === 'TimeoutError' || caughtError.name === 'AbortError').toBe(true)
    // Verify it settled within or close to the deadline rather than hanging forever
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(2000)
  })

  it('rejects if response body streaming hangs indefinitely', async () => {
    server = http.createServer((_req, res) => {
      // Send headers but never end the response
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('partial')
    })

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/hang-body`

    let caughtError: any = null
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 150 })
      await res.text()
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).not.toBeNull()
    expect(caughtError.name === 'TimeoutError' || caughtError.name === 'AbortError').toBe(true)
  })

  it('resolves successfully when server responds within deadline', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/ok`

    const res = await fetchWithTimeout(url, { timeoutMs: 1000 })
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data).toEqual({ ok: true })
  })

  it('respects caller-provided abort signals combined with timeout', async () => {
    server = http.createServer((_req, _res) => {})

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/caller-abort`

    const controller = new AbortController()
    const promise = fetchWithTimeout(url, {
      signal: controller.signal,
      timeoutMs: 5000,
    })

    controller.abort(new Error('user aborted'))

    await expect(promise).rejects.toThrow()
  })
})
