import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'

const sourcePath = fileURLToPath(new URL('../openapi.yaml', import.meta.url))
const destinationPath = fileURLToPath(new URL('../openapi.json', import.meta.url))

/**
 * Renders the committed `openapi.json` from `openapi.yaml`.
 *
 * Exported (rather than inlined in the CLI) so `tests/openapi.test.ts` can
 * assert that the committed JSON is exactly what the generator produces — the
 * spec is auto-published from openapi.json on every push, so a stale committed
 * file is a broken public contract even though the source YAML looks right.
 *
 * Deterministic by construction: `js-yaml` preserves document key order and
 * `JSON.stringify` is stable for a fixed object, so the same YAML always yields
 * byte-identical output. The test runs it twice to guarantee that.
 */
export function renderOpenApiJson(yamlSource?: string): string {
  const source = yamlSource ?? readFileSync(sourcePath, 'utf8')
  const document = YAML.load(source)
  return JSON.stringify(document, null, 2) + '\n'
}

/** Regenerates `openapi.json` from `openapi.yaml`, in place. */
export function generateOpenApi(): void {
  writeFileSync(destinationPath, renderOpenApiJson())
}

// Run only when invoked directly (`npm run openapi:gen`), not when imported by
// the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateOpenApi()
  console.log('Generated openapi.json')
}
