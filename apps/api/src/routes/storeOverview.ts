import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { isSupplierRole } from '../lib/auth-scope'
import { isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { getStoreConsumptionRanking, getStoreOverview } from '../services/storeOverview'

const OVERVIEW_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPLY_CHAIN'])

function canViewStoreOverview(role: string | undefined | null): boolean {
  if (!role) return false
  return OVERVIEW_ROLES.has(role) || isInternalSupplyChainRole(role)
}

const consumptionRankingQuerySchema = z.object({
  days: z.coerce.number().int().refine(
    value => value === 7 || value === 30 || value === 90,
    '时间范围仅支持 7、30 或 90 天',
  ).default(30),
  dimension: z.enum(['PRODUCT', 'CATEGORY']).default('PRODUCT'),
}).strict()

export const storeOverviewRoutes: FastifyPluginAsync = async (app) => {
  const auth = (app as any).authenticate

  app.get('/:storeId/overview', { preHandler: [auth] }, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const { storeId } = req.params

    if (isSupplierRole(role)) {
      return reply.status(403).send({ error: '无权访问门店概览' })
    }

    if (!canViewStoreOverview(role)) {
      return reply.status(403).send({ error: '无权访问门店概览' })
    }

    const store = await prisma.store.findFirst({
      where: { id: storeId, tenantId },
      select: { id: true },
    })
    if (!store) {
      return reply.status(404).send({ error: '门店不存在' })
    }

    return getStoreOverview(tenantId, storeId)
  })

  app.get('/:storeId/consumption-ranking', { preHandler: [auth] }, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const { storeId } = req.params

    if (isSupplierRole(role) || !canViewStoreOverview(role)) {
      return reply.status(403).send({ error: '无权访问门店消耗排行' })
    }

    const parsed = consumptionRankingQuerySchema.safeParse(req.query || {})
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message })
    }

    const store = await prisma.store.findFirst({
      where: { id: storeId, tenantId },
      select: { id: true },
    })
    if (!store) {
      return reply.status(404).send({ error: '门店不存在' })
    }

    return getStoreConsumptionRanking(
      tenantId,
      storeId,
      parsed.data.days as 7 | 30 | 90,
      parsed.data.dimension,
    )
  })
}
