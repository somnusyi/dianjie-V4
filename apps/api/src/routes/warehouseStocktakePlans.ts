import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  createWarehouseStocktakePlan,
  listWarehouseStocktakePlans,
  listWarehouseStocktakeProductPolicies,
  updateWarehouseStocktakePlan,
  upsertWarehouseStocktakeProductPolicy,
} from '../services/warehouseStocktakePlans'
import { WAREHOUSE_STOCKTAKE_AUDIT_ROLES, WAREHOUSE_STOCKTAKE_READ_ROLES } from '../services/warehouseStocktake'
import { MAX_WAREHOUSE_STOCKTAKE_ITEMS } from '../services/warehouseStocktakeConstants'

const id = z.string().trim().min(1).max(64)
const rule = z.enum(['ALL_ENABLED', 'HISTORICAL_MOVEMENT', 'PERIOD_MOVEMENT_OR_OPENING', 'BOOK_NONZERO_AS_OF', 'FIXED_PLAN_PRODUCTS'])
const planBody = z.object({
  name: z.string().trim().min(1).max(120),
  warehouseId: id.optional().nullable(),
  countScope: z.enum(['ALL', 'DAILY', 'WEEKLY', 'SELECTED']),
  selectionRule: rule,
  periodUnit: z.enum(['DAY', 'WEEK', 'MONTH']).optional().nullable(),
  productIds: z.array(id).max(MAX_WAREHOUSE_STOCKTAKE_ITEMS).default([]),
  note: z.string().trim().max(500).optional().nullable(),
})

export const warehouseStocktakePlanRoutes: FastifyPluginAsync = async app => {
  const auth = (roles: readonly string[]) => ({
    preHandler: [(app as any).authenticate, async (req: any, reply: any) => {
      if (!req.user?.tenantId || !roles.includes(req.user.role)) return reply.status(403).send({ error: '无权操作盘点方案' })
    }],
  })
  app.setErrorHandler((error: any, _req, reply) => reply.status(error.statusCode || 500).send({ error: error.statusCode ? error.message : '盘点方案操作失败，请稍后重试' }))

  app.get('/', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => {
    const parsed = z.object({ enabledOnly: z.coerce.boolean().default(false) }).safeParse(req.query || {})
    return listWarehouseStocktakePlans(req.user.tenantId, parsed.success ? parsed.data.enabledOnly : false)
  })
  app.post('/', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any, reply) => {
    const parsed = planBody.extend({ requestKey: z.string().trim().min(8).max(160) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const result = await createWarehouseStocktakePlan({ tenantId: req.user.tenantId, userId: req.user.userId, ...parsed.data })
    return reply.status(result.replayed ? 200 : 201).send(result)
  })
  app.patch('/:id', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any, reply) => {
    const parsed = planBody.extend({
      rowVersion: z.number().int().nonnegative(),
      status: z.enum(['ENABLED', 'DISABLED']).optional(),
      requestKey: z.string().trim().min(8).max(160),
    }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return updateWarehouseStocktakePlan({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.get('/policies/:warehouseId', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any, reply) => {
    const warehouseId = id.safeParse(req.params.warehouseId)
    if (!warehouseId.success) return reply.status(400).send({ error: warehouseId.error.issues[0].message })
    return listWarehouseStocktakeProductPolicies(req.user.tenantId, warehouseId.data)
  })
  app.put('/policies/:warehouseId/:productId', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any, reply) => {
    const params = z.object({ warehouseId: id, productId: id }).safeParse(req.params)
    const body = z.object({
      canCount: z.boolean(), defaultIncluded: z.boolean(), reason: z.string().trim().max(500).optional().nullable(), rowVersion: z.number().int().nonnegative(),
      requestKey: z.string().trim().min(8).max(160),
    }).safeParse(req.body)
    if (!params.success) return reply.status(400).send({ error: params.error.issues[0].message })
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    return upsertWarehouseStocktakeProductPolicy({ tenantId: req.user.tenantId, userId: req.user.userId, ...params.data, ...body.data })
  })
}
