import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('docs/database-schema.md completeness (#706)', () => {
  const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma')
  const docPath = path.resolve(__dirname, '../docs/database-schema.md')

  const schemaContent = fs.readFileSync(schemaPath, 'utf-8')
  const docContent = fs.readFileSync(docPath, 'utf-8')

  const mappedTables = [...schemaContent.matchAll(/@@map\("([^"]+)"\)/g)].map(m => m[1])

  it('finds all mapped tables in prisma/schema.prisma', () => {
    expect(mappedTables.length).toBeGreaterThan(0)
  })

  it('documents every @@map table from prisma/schema.prisma in docs/database-schema.md', () => {
    const missing = mappedTables.filter(table => !docContent.includes(`\`${table}\``))
    expect(missing).toEqual([])
  })

  it('removes the superseded Path Forward transition section and references committed migrations', () => {
    expect(docContent).not.toMatch(/Path Forward:\s*Transitioning to/i)
    expect(docContent).toContain('database-migrations.md')
    expect(docContent).toContain('schemaVerify.ts')
  })
})
