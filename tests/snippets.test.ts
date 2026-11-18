import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderSnippets } from '../scripts/gen-snippets'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('generated snippets', () => {
  it('render deterministically', () => {
    expect(renderSnippets()).toEqual(renderSnippets())
  })

  it('committed files match the generator', () => {
    for (const [path, content] of Object.entries(renderSnippets())) {
      expect(existsSync(join(ROOT, path)), `missing ${path}`).toBe(true)
      // Normalise line endings before comparing, as tests/readme.test.ts does.
      // The committed files are LF, but a Windows checkout hands them back as
      // CRLF, and a byte-compare then reports drift on a file nobody touched.
      expect(readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n'), path).toBe(
        content.replace(/\r\n/g, '\n'),
      )
    }
  })

  it('contain no placeholder hosts or addresses', () => {
    for (const content of Object.values(renderSnippets())) {
      expect(content).not.toMatch(/example\.com|localhost|REPLACE|your-oracle/)
    }
  })
})
