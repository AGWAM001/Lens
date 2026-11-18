import type { FastifyInstance } from 'fastify'
import { StrKey } from '@stellar/stellar-sdk'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network'
import {
  getTrackedAssets,
  resolveAssetMetadata,
  normalizeAsset,
} from '../services/assetMetadata'
import {
  assetsResponseSchema,
  assetDetailResponseSchema,
} from '../api/schemas'

import { apiError } from '../errors'
export async function registerAssetRoutes(app: FastifyInstance): Promise<void> {
  // GET /assets — list tracked assets with metadata and verification status
  app.get<{
    Querystring: {
      network?: string
      code?: string
      verified?: string | boolean
    }
  }>(
    '/assets',
    { config: { public: true }, schema: { response: { 200: assetsResponseSchema } } },
    async (req, reply) => {
      const network = (req.network ?? activeNetwork) as NetworkName
      const { code: codeFilter, verified: verifiedFilter } = req.query

      const tracked = await getTrackedAssets(network)

      let filtered = tracked
      if (codeFilter && typeof codeFilter === 'string' && codeFilter.trim().length > 0) {
        const targetCode = codeFilter.trim().toUpperCase()
        filtered = filtered.filter(a => a.code.toUpperCase() === targetCode)
      }

      const resolved = await Promise.all(
        filtered.map(asset => resolveAssetMetadata(asset, network)),
      )

      let finalAssets = resolved
      if (verifiedFilter !== undefined) {
        const wantVerified =
          verifiedFilter === true ||
          verifiedFilter === 'true' ||
          verifiedFilter === '1'
        finalAssets = finalAssets.filter(a => a.verified === wantVerified)
      }

      return {
        network,
        assets: finalAssets,
      }
    },
  )

  // GET /assets/:code — get metadata and verification status for a specific asset
  app.get<{
    Params: { code: string }
    Querystring: {
      network?: string
      issuer?: string
    }
  }>(
    '/assets/:code',
    { config: { public: true }, schema: { response: { 200: assetDetailResponseSchema } } },
    async (req, reply) => {
      const network = (req.network ?? activeNetwork) as NetworkName
      const rawCode = req.params.code
      if (!rawCode || rawCode.trim().length === 0) {
        return reply.status(400).send(apiError('missing_parameter', 'Asset code is required'))
      }

      let parsedCode = rawCode.trim()
      let parsedIssuer: string | null = req.query.issuer?.trim() ?? null

      if (parsedCode.includes(':')) {
        const [c, iss] = parsedCode.split(':')
        parsedCode = c.trim()
        if (iss && !parsedIssuer) {
          parsedIssuer = iss.trim()
        }
      }

      const isXlm =
        parsedCode.toUpperCase() === 'XLM' ||
        parsedCode.toUpperCase() === 'NATIVE'

      if (isXlm) {
        const meta = await resolveAssetMetadata({ code: 'XLM', issuer: null }, network)
        return {
          network,
          ...meta,
        }
      }

      const tracked = await getTrackedAssets(network)
      let matched = tracked.find(a => {
        if (a.code.toUpperCase() !== parsedCode.toUpperCase()) return false
        if (parsedIssuer) {
          return a.issuer === parsedIssuer
        }
        return true
      })

      // If not in tracked assets, but caller gave an explicit valid issuer address
      if (!matched && parsedIssuer && StrKey.isValidEd25519PublicKey(parsedIssuer)) {
        matched = normalizeAsset(parsedCode, parsedIssuer)
      }

      if (!matched) {
        return reply.status(404).send({
          ...apiError('not_found', `Asset "${rawCode}" not found on ${network}`),
        })
      }

      const meta = await resolveAssetMetadata(matched, network)
      return {
        network,
        ...meta,
      }
    },
  )
}
