import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
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

  documentedRoutes.forEach(({ method, path }, i) => {
    it(`should have ${method} ${path} registered (matches documented curl route)`, () => {
      expect(registeredPaths.has(`${method} ${path}`)).toBe(true)
    })
  })
})