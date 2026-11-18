import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'
import YAML from 'js-yaml'
import { ERROR_CODES, ERROR_CODE_VALUES } from '../errors'

function readSpec(): any {
  const specPath = fileURLToPath(new URL('../../openapi.yaml', import.meta.url))
  const spec = YAML.load(readFileSync(specPath, 'utf8'))
  return spec
}

function collectCodesFromFile(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf8')
  const codes: string[] = []
  const re1 = /apiError\(\s*['"]([a-z0-9_]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re1.exec(content))) {
    codes.push(m[1])
  }
  const re2 = /\bcode:\s*['"]([a-z][a-z0-9_]*)['"]/g
  while ((m = re2.exec(content))) {
    codes.push(m[1])
  }
  return codes
}

function getModuleFiles(): string[] {
  const modules: string[] = []
  const routesDir = fileURLToPath(new URL('../routes', import.meta.url))
  for (const f of readdirSync(routesDir)) {
    if (f.endsWith('.ts')) modules.push(fileURLToPath(new URL(`../routes/${f}`, import.meta.url)))
  }
  const apiFiles = ['rest.ts', 'history.ts', 'admin.ts', 'auth.ts', 'usage.ts'].map(f =>
    fileURLToPath(new URL(`../api/${f}`, import.meta.url)),
  )
  modules.push(...apiFiles)
  modules.push(fileURLToPath(new URL('../middleware/network.ts', import.meta.url)))
  modules.push(fileURLToPath(new URL('../middleware/x402.ts', import.meta.url)))
  modules.push(fileURLToPath(new URL('../app.ts', import.meta.url)))
  return modules
}

describe('error codes', () => {
  it('documents the error code enum in openapi and keeps it in sync with ERROR_CODES', () => {
    const spec = readSpec()
    const enumVals = spec.components?.schemas?.ErrorCode?.enum as string[] | undefined
    expect(enumVals).toBeDefined()
    const expected = Object.keys(ERROR_CODES).sort()
    const actual = [...(enumVals || [])].sort()
    expect(actual).toEqual(expected)
  })

  it('no route/error-emitting module emits a code outside the enumerated set', () => {
    const allowed = new Set(Object.keys(ERROR_CODES))
    const modules = getModuleFiles()
    const all = modules.flatMap(collectCodesFromFile)
    const bad = all.filter(c => !allowed.has(c))
    expect(bad, `Codes outside set: ${JSON.stringify(bad)}`).toEqual([])
  })

  it('error code set is non-empty and matches values', () => {
    expect(ERROR_CODE_VALUES.length).toBeGreaterThan(0)
    expect(Object.keys(ERROR_CODES).length).toBe(ERROR_CODE_VALUES.length)
  })
})
