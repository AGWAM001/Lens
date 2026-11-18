import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSchema, printSchema } from 'graphql'
import { schema as rawSchema } from '../src/api/graphql'

export const schemaPath = fileURLToPath(new URL('../schema.graphql', import.meta.url))

/**
 * Normalizes and formats the GraphQL schema string into canonical SDL format.
 *
 * Deterministic by construction: `graphql.buildSchema` parses the SDL and
 * `graphql.printSchema` normalizes type order, whitespace, and descriptions,
 * guaranteeing byte-for-byte identical output regardless of source formatting.
 */
export function renderGraphQLSchema(raw?: string): string {
  const source = raw ?? rawSchema
  const schemaObj = buildSchema(source)
  return printSchema(schemaObj).trim() + '\n'
}

/** Regenerates `schema.graphql` from code definition in place. */
export function generateGraphQLSchema(): void {
  writeFileSync(schemaPath, renderGraphQLSchema())
}

// Run only when invoked directly (`npm run graphql:schema:gen`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateGraphQLSchema()
  console.log('Generated schema.graphql')
}
