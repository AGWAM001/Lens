import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const contributingPath = fileURLToPath(new URL('../CONTRIBUTING.md', import.meta.url))
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Extracts the names of `npm run <script>` invocations from a doc.
 *
 * Only the script name is captured, so `npm run seed -- --network testnet`
 * yields `seed` and `npm run readme:check` yields `readme:check`. Anything
 * that is not an `npm run` invocation (bare `npm test`, `npx prisma ...`,
 * the raw `prisma migrate diff ...` baseline command) is ignored by design:
 * this guard is about the `npm run` names a contributor would copy-paste.
 */
function extractNpmRunScripts(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    names.push(match[1])
  }
  return [...new Set(names)]
}

describe('CONTRIBUTING.md script references', () => {
  it('names only npm run scripts that exist in package.json', () => {
    const contributing = readFileSync(contributingPath, 'utf8')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string>
    }

    const named = extractNpmRunScripts(contributing)
    expect(named.length).toBeGreaterThan(0)

    const missing = named.filter((name) => !(name in packageJson.scripts))
    expect(
      missing,
      `CONTRIBUTING.md names npm run scripts that do not exist in package.json: ${missing.join(', ')}. ` +
        'Fix the doc or add the script — a contributor copy-pasting the command would get `npm error Missing script`.'
    ).toEqual([])
  })

  it('would catch a script that does not exist', () => {
    // Proves the check above is not vacuous: the extractor finds a bogus
    // name, and the lookup against package.json rejects it.
    const named = extractNpmRunScripts('Regenerate with `npm run definitely-not-a-script`.')
    expect(named).toEqual(['definitely-not-a-script'])

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect('definitely-not-a-script' in packageJson.scripts).toBe(false)
  })

  it('lists all five generated files in the Generated files section', () => {
    const contributing = readFileSync(contributingPath, 'utf8')
    for (const file of [
      'openapi.json',
      'README.md',
      'schema.graphql',
      'clients/typescript/src/schema.d.ts',
      'prisma/migrations/0_init/migration.sql',
    ]) {
      expect(contributing, `CONTRIBUTING.md must list generated file ${file}`).toContain(file)
    }
  })
})
