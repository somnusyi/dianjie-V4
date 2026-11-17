import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { previewWarehouseStocktakeSelection } from '../services/warehouseStocktakeSelection'
import { WAREHOUSE_STOCKTAKE_READ_ROLES } from '../services/warehouseStocktake'
import { MAX_WAREHOUSE_STOCKTAKE_ITEMS } from '../services/warehouseStocktakeConstants'

const id = z.string().trim().min(1).max(64)
const previewSchema = z.object({
  warehouseId: id,
  countDate: z.string().date(),
  countScope: z.enum(['ALL', 'DAILY', 'WEEKLY', 'SELECTED']),
  planId: id.optional().nullable(),
  selectionRule: z.enum(['ALL_ENABLED', 'HISTORICAL_MOVEMENT', 'PERIOD_MOVEMENT_OR_OPENING', 'BOOK_NONZERO_AS_OF', 'FIXED_PLAN_PRODUCTS', 'MANUAL_SELECTED']).optional().nullable(),
  periodUnit: z.enum(['DAY', 'WEEK', 'MONTH']).optional().nullable(),
  manualProductIds: z.array(id).max(MAX_WAREHOUSE_STOCKTAKE_ITEMS).optional(),
}).strict()

export const warehouseStocktakeSelectionRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate, async (req: any, reply: any) => {
    if (!req.user?.tenantId || !WAREHOUSE_STOCKTAKE_READ_ROLES.includes(req.user.role)) return reply.status(403).send({ error: '无权预览盘点圈定' })
  }] }
  app.setErrorHandler((error: any, _req, reply) => reply.status(error.statusCode || 500).send({
    error: error.statusCode ? error.message : '盘点圈定失败，请稍后重试',
    ...(error.code ? { code: error.code } : {}),
    ...(typeof error.blockerCount === 'number' ? { blockerCount: error.blockerCount } : {}),
    ...(error.firstIssue ? { firstIssue: error.firstIssue } : {}),
  }))
  app.post('/preview', auth, async (req: any, reply) => {
    const parsed = previewSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return previewWarehouseStocktakeSelection({ tenantId: req.user.tenantId, ...parsed.data })
  })
}
