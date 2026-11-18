import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { rewriteVersionedApiUrl } from '../src/api/versioning'
import type { FastifyInstance, RouteOptions } from 'fastify'
import fs from 'fs'
import path from 'path'

function extractRestRoutesFromReadme(): Array<{ method: string; path: string }> {
  const readmePath = path.resolve(__dirname, '../README.md')
  const content = fs.readFileSync(readmePath, 'utf-8')

  const routes: Array<{ method: string; path: string }> = []

  // Parse markdown table: | METHOD | `/path` | DESCRIPTION |
  const tableRegex = /^\|\s*(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s*\|\s*\`([^\`]+)\`\s*\|/gm
  let match: RegExpMatchArray | null
  while ((match = tableRegex.exec(content)) !== null) {
    const method = match[1]
    let rawPath = match[2]
    // Strip leading/trailing backticks and whitespace
    rawPath = rawPath.replace(/^[`]+|[`]+$/g, '').trim()
    // Strip query parameters (Fastify registers path templates without query strings)
    const pathWithoutQuery = rawPath.split('?')[0]
    routes.push({ method, path: pathWithoutQuery })
  }

  return routes
}

describe('REST route regression: documented curl route exists', () => {
  let app: FastifyInstance
  let registeredPaths: Set<string>
  const documentedRoutes = extractRestRoutesFromReadme()

  beforeAll(async () => {
    registeredPaths = new Set()
    app = await buildApp({
      onRoute: (route: RouteOptions) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method]
        for (const method of methods) {
          if (method === 'HEAD' || method === 'OPTIONS') continue
          const path = route.url ?? route.template
          if (path) registeredPaths.add(`${method} ${path}`)
        }
      },
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  documentedRoutes.forEach(({ method, path }) => {
    it(`should resolve ${method} ${path} onto a registered route (matches documented curl route)`, () => {
      // README documents the canonical `/v1` form, but routes are registered
      // once at their bare path and `/v1` is resolved by rewriteUrl at request
      // time (see src/api/versioning.ts). Asking the route table for the
      // documented path directly would therefore always miss. Resolving it the
      // way a real request is resolved checks the rewrite as well as the route.
      const resolved = rewriteVersionedApiUrl({ url: path })
      expect(registeredPaths.has(`${method} ${resolved}`)).toBe(true)
    })
  })
})