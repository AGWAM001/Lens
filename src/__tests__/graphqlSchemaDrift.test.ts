import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildSchema, findBreakingChanges, findDangerousChanges } from 'graphql'
import { schema as codeSchema } from '../api/graphql'
import { renderGraphQLSchema, schemaPath } from '../../scripts/generate-graphql-schema'

describe('GraphQL SDL schema artifact and drift guard', () => {
  it('committed schema.graphql matches the code-defined schema exactly', () => {
    const committedSchema = readFileSync(schemaPath, 'utf8')
    const generatedSchema = renderGraphQLSchema(codeSchema)

    if (committedSchema !== generatedSchema) {
      expect.fail(
        'schema.graphql is out of sync with src/api/graphql.ts schema definition.\n' +
        'Run `npm run graphql:schema:gen` to regenerate and commit schema.graphql.'
      )
    }

    expect(committedSchema).toBe(generatedSchema)
  })

  it('regenerates deterministically', () => {
    expect(renderGraphQLSchema(codeSchema)).toBe(renderGraphQLSchema(codeSchema))
  })

  it('produces valid GraphQL SDL that client generators and validators can parse', () => {
    const committedSchema = readFileSync(schemaPath, 'utf8')
    const parsedSchema = buildSchema(committedSchema)

    expect(parsedSchema.getQueryType()).toBeDefined()
    expect(parsedSchema.getQueryType()?.name).toBe('Query')
    expect(parsedSchema.getSubscriptionType()).toBeDefined()
    expect(parsedSchema.getSubscriptionType()?.name).toBe('Subscription')

    const queryFields = parsedSchema.getQueryType()?.getFields()
    expect(queryFields?.getPrice).toBeDefined()
    expect(queryFields?.getBestRoute).toBeDefined()
    expect(queryFields?.getPriceHistory).toBeDefined()
    expect(queryFields?.listPairs).toBeDefined()

    const subscriptionFields = parsedSchema.getSubscriptionType()?.getFields()
    expect(subscriptionFields?.priceUpdated).toBeDefined()
  })

  it('fails drift guard when a field is added to code without refreshing schema.graphql', () => {
    const driftingCodeSchema = `${codeSchema}\nextend type Query { driftProbeTestField: String }`
    const committedSchema = readFileSync(schemaPath, 'utf8')
    const newlyGenerated = renderGraphQLSchema(driftingCodeSchema)

    expect(committedSchema).not.toBe(newlyGenerated)
  })

  it('detects and flags breaking changes when fields or arguments are removed or altered', () => {
    const originalSchemaObj = buildSchema(readFileSync(schemaPath, 'utf8'))

    // Simulate a breaking change: removing a field from AggregatedPrice
    const breakingSchemaString = codeSchema.replace('sdexPrice: Float!', '')
    const breakingSchemaObj = buildSchema(breakingSchemaString)

    const breakingChanges = findBreakingChanges(originalSchemaObj, breakingSchemaObj)
    expect(breakingChanges.length).toBeGreaterThan(0)
    expect(breakingChanges.some(c => c.description.includes('sdexPrice'))).toBe(true)
  })

  it('detects non-breaking (safe or dangerous) additions cleanly', () => {
    const originalSchemaObj = buildSchema(readFileSync(schemaPath, 'utf8'))

    // Non-breaking addition of a nullable field to Query
    const backwardCompatibleSchemaString = `${codeSchema}\nextend type Query { ping: String }`
    const newSchemaObj = buildSchema(backwardCompatibleSchemaString)

    const breakingChanges = findBreakingChanges(originalSchemaObj, newSchemaObj)
    expect(breakingChanges).toHaveLength(0)

    const dangerousChanges = findDangerousChanges(originalSchemaObj, newSchemaObj)
    // Adding an optional query field is safe
    expect(Array.isArray(dangerousChanges)).toBe(true)
  })
})
