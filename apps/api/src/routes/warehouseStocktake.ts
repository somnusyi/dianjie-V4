import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  approveWarehouseStocktake,
  cancelWarehouseStocktake,
  createWarehouseStocktake,
  getWarehouseStocktake,
  listWarehouseStocktakes,
  rejectWarehouseStocktake,
  saveWarehouseStocktakeSection,
  submitWarehouseStocktake,
  warehouseStocktakeOptions,
  WAREHOUSE_STOCKTAKE_AUDIT_ROLES,
  WAREHOUSE_STOCKTAKE_READ_ROLES,
  WAREHOUSE_STOCKTAKE_WRITE_ROLES,
} from '../services/warehouseStocktake'

const id = z.string().trim().min(1).max(64)
const decimal = z.union([z.number().nonnegative().max(99_999_999), z.string().regex(/^\d{1,10}(\.\d{1,6})?$/)])
const createSchema = z.object({
  requestKey: z.string().trim().min(8).max(160),
  warehouseId: id,
  countDate: z.string().date(),
  note: z.string().trim().max(500).optional().nullable(),
  sections: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    assignedToId: id,
    productIds: z.array(id).min(1).max(500),
  })).min(1).max(50),
}).superRefine((value, context) => {
  if (value.sections.reduce((sum, section) => sum + section.productIds.length, 0) > 1_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sections'], message: '每张盘点单最多1000项' })
  }
})
const saveSchema = z.object({
  rowVersion: z.number().int().nonnegative(),
  submit: z.boolean().default(false),
  items: z.array(z.object({
    itemId: id,
    countedQuantity: decimal,
    countedUnitCost: decimal.optional().nullable(),
    reason: z.string().trim().max(240).optional().nullable(),
  })).min(1).max(1_000),
})
const rowVersionSchema = z.object({ rowVersion: z.number().int().nonnegative() })
const reasonSchema = z.object({ reason: z.string().trim().min(2).max(500) })
const cancelSchema = reasonSchema.extend({ rowVersion: z.number().int().nonnegative() })

export const warehouseStocktakeRoutes: FastifyPluginAsync = async app => {
  const auth = (roles: readonly string[]) => ({
    preHandler: [(app as any).authenticate, async (req: any, reply: any) => {
      if (!req.user?.tenantId || !roles.includes(req.user.role)) return reply.status(403).send({ error: '无权操作总仓盘点' })
    }],
  })

  app.setErrorHandler((error: any, _req, reply) => {
    if (['P2002', 'P2034'].includes(error?.code) || (error?.code === 'P2010' && String(error?.meta?.code || '') === '40001')) return reply.status(409).send({ error: '盘点单正在被其他人更新，请刷新后重试' })
    return reply.status(error.statusCode || 500).send({ error: error.statusCode ? error.message : '盘点操作失败，请稍后重试' })
  })

  app.get('/options', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => warehouseStocktakeOptions(req.user.tenantId))
  app.get('/', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any, reply) => {
    const parsed = z.object({
      status: z.enum(['DRAFT', 'COUNTING', 'REVIEWING', 'CONFIRMED', 'CANCELLED']).optional(),
      warehouseId: id.optional(), q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return listWarehouseStocktakes({ tenantId: req.user.tenantId, ...parsed.data })
  })
  app.get('/:id/review', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => {
    const row = await getWarehouseStocktake(req.user.tenantId, req.params.id)
    return {
      ...row,
      countDate: row.countDate.toISOString().slice(0, 10),
      source: 'warehouse',
      store: { name: row.warehouse.name },
      items: row.sections.flatMap(section => section.items.map(item => ({
        id: item.id,
        productCodeSnapshot: item.productCodeSnapshot,
        productNameSnapshot: item.productNameSnapshot,
        productSpecSnapshot: item.productSpecSnapshot,
        unitSnapshot: item.inventoryUnit,
        bookQuantity: Number(item.bookQuantity),
        countedQuantity: item.countedQuantity == null ? null : Number(item.countedQuantity),
        differenceQuantity: item.differenceQuantity == null ? null : Number(item.differenceQuantity),
        differenceAmount: item.differenceValue == null ? null : Number(item.differenceValue),
        reasonCode: 'OTHER',
        reasonNote: `${section.name}：${item.reason || '—'}`,
        evidenceKeys: [], evidenceUrls: [],
      }))),
    }
  })
  app.get('/:id', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => getWarehouseStocktake(req.user.tenantId, req.params.id))
  app.post('/', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const result = await createWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, ...parsed.data })
    return reply.status(result.replayed ? 200 : 201).send(result)
  })
  app.put('/:id/sections/:sectionId', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = saveSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return saveWarehouseStocktakeSection({
      tenantId: req.user.tenantId, userId: req.user.userId, stocktakeId: req.params.id, sectionId: req.params.sectionId, ...parsed.data,
    })
  })
  app.post('/:id/submit', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = rowVersionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return submitWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/approve', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any) => approveWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id }))
  app.post('/:id/reject', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any, reply) => {
    const parsed = reasonSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return rejectWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/cancel', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = cancelSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return cancelWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  // No reverse/unapprove endpoint by design: CONFIRMED is terminal.
}
