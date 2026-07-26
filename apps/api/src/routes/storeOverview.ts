import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { isSupplierRole } from '../lib/auth-scope'
import { isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { getStoreOverview } from '../services/storeOverview'

const OVERVIEW_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPLY_CHAIN'])

function canViewStoreOverview(role: string | undefined | null): boolean {
  if (!role) return false
  return OVERVIEW_ROLES.has(role) || isInternalSupplyChainRole(role)
}

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
}
