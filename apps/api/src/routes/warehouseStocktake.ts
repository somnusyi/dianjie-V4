import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { MAX_WAREHOUSE_STOCKTAKE_ITEMS } from '../services/warehouseStocktakeConstants'
import { buildWarehouseStocktakeWorkbook } from '../services/warehouseStocktakeArtifacts'
import {
  abandonWarehouseStocktakePrintJob,
  completeWarehouseStocktakePrintJob,
  getWarehouseStocktakePrintJob,
  prepareWarehouseStocktakePrintJob,
} from '../services/warehouseStocktakePrint'
import {
  addWarehouseStocktakeItems,
  approveWarehouseStocktake,
  reviewWarehouseStocktake,
  cancelWarehouseStocktake,
  createWarehouseStocktake,
  deleteWarehouseStocktake,
  executeWarehouseStocktakeBatch,
  getWarehouseStocktake,
  generateFormalWarehouseStocktake,
  generateFormalWarehouseStocktakes,
  listWarehouseStocktakes,
  listWarehouseStocktakeLogs,
  removeWarehouseStocktakeItems,
  reorderWarehouseStocktakeItems,
  rejectWarehouseStocktake,
  reverseWarehouseStocktakeApproval,
  refreshWarehouseStocktakeUnits,
  saveWarehouseStocktakeSection,
  submitWarehouseStocktake,
  updateWarehouseStocktakeHeader,
  warehouseStocktakeOptions,
  withdrawWarehouseStocktake,
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
  countScope: z.enum(['ALL', 'DAILY', 'WEEKLY', 'SELECTED']).optional(),
  planId: id.optional().nullable(),
  selectionRule: z.enum(['ALL_ENABLED', 'HISTORICAL_MOVEMENT', 'PERIOD_MOVEMENT_OR_OPENING', 'BOOK_NONZERO_AS_OF', 'FIXED_PLAN_PRODUCTS', 'MANUAL_SELECTED']).optional().nullable(),
  periodUnit: z.enum(['DAY', 'WEEK', 'MONTH']).optional().nullable(),
  selectionFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional().nullable(),
  documentType: z.enum(['MULTI', 'FORMAL']).optional(),
  note: z.string().trim().max(500).optional().nullable(),
  sections: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    assignedToId: id,
    productIds: z.array(id).min(1).max(MAX_WAREHOUSE_STOCKTAKE_ITEMS),
  })).min(1).max(50),
}).superRefine((value, context) => {
  if (value.sections.reduce((sum, section) => sum + section.productIds.length, 0) > MAX_WAREHOUSE_STOCKTAKE_ITEMS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sections'], message: `每张盘点单最多${MAX_WAREHOUSE_STOCKTAKE_ITEMS}项` })
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
  })).min(1).max(MAX_WAREHOUSE_STOCKTAKE_ITEMS),
})
const rowVersionSchema = z.object({ rowVersion: z.number().int().nonnegative() })
const reasonSchema = z.object({ reason: z.string().trim().min(2).max(500) })
const cancelSchema = reasonSchema.extend({ rowVersion: z.number().int().nonnegative() })
const lifecycleRequestSchema = z.object({
  rowVersion: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(8).max(160),
})
const withdrawSchema = lifecycleRequestSchema.extend({ reason: z.string().trim().max(500).optional().nullable() })
const rejectSchema = lifecycleRequestSchema.extend({ reason: z.string().trim().min(2).max(500) })
const headerSchema = lifecycleRequestSchema.extend({
  countDate: z.string().date(),
  note: z.string().trim().max(500).optional().nullable(),
})
const addItemsSchema = lifecycleRequestSchema.extend({
  sectionId: id,
  productIds: z.array(id).min(1).max(MAX_WAREHOUSE_STOCKTAKE_ITEMS),
})
const removeItemsSchema = lifecycleRequestSchema.extend({ itemIds: z.array(id).min(1).max(MAX_WAREHOUSE_STOCKTAKE_ITEMS) })
const reorderItemsSchema = lifecycleRequestSchema.extend({
  sectionId: id,
  itemIds: z.array(id).min(1).max(MAX_WAREHOUSE_STOCKTAKE_ITEMS),
})
const reverseApprovalSchema = reasonSchema.extend({
  rowVersion: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(8).max(160),
})
const generateFormalSchema = z.object({
  sourceIds: z.array(id).min(1).max(200),
  countScope: z.enum(['SELECTED', 'DAILY', 'WEEKLY', 'ALL']),
})
const batchSchema = z.object({
  requestKey: z.string().trim().min(8).max(160),
  items: z.array(z.object({ id, rowVersion: z.number().int().nonnegative() })).min(1).max(100)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, '不能重复选择同一张盘点单'),
  ignoreInvalid: z.boolean().default(true),
  reason: z.string().trim().min(2).max(500).optional(),
})
const printJobSchema = z.object({
  requestKey: z.string().trim().min(8).max(160),
  ids: z.array(id).min(1).max(50).refine(ids => new Set(ids).size === ids.length, '不能重复选择同一张盘点单'),
})
const printJobTransitionSchema = z.object({ requestKey: z.string().trim().min(8).max(160) })

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

  app.get('/logs', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => {
    const rows = await prisma.opLog.findMany({ where: { tenantId: req.user.tenantId, entityType: 'WarehouseStocktake' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, select: { id: true, target: true, action: true, createdAt: true, userId: true } })
    const actors = await prisma.user.findMany({ where: { tenantId: req.user.tenantId, id: { in: rows.flatMap(row => row.userId ? [row.userId] : []) } }, select: { id: true, name: true } })
    const names = new Map(actors.map(actor => [actor.id, actor.name]))
    return { items: rows.map(row => ({ id: row.id, no: row.target, action: row.action, createdAt: row.createdAt, actor: row.userId ? names.get(row.userId) || '—' : '—' })) }
  })
  app.get('/options', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => warehouseStocktakeOptions(req.user.tenantId))
  const batchHandler = (action: 'SUBMIT' | 'APPROVE' | 'FINAL_REVIEW' | 'REVERSE_APPROVAL' | 'DELETE') => async (req: any, reply: any) => {
    const parsed = batchSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return executeWarehouseStocktakeBatch({ tenantId: req.user.tenantId, userId: req.user.userId, action, ...parsed.data })
  }
  app.post('/batch/submit', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), batchHandler('SUBMIT'))
  app.post('/batch/approve', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), batchHandler('APPROVE'))
  app.post('/batch/final-review', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), batchHandler('FINAL_REVIEW'))
  app.post('/batch/reverse-approval', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), batchHandler('REVERSE_APPROVAL'))
  app.post('/batch/delete', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), batchHandler('DELETE'))
  app.post('/print-jobs', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any, reply) => {
    const parsed = printJobSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const result = await prepareWarehouseStocktakePrintJob({ tenantId: req.user.tenantId, userId: req.user.userId, ...parsed.data })
    return reply.status(result.replayed ? 200 : 201).send(result)
  })
  app.get('/print-jobs/:jobId', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => getWarehouseStocktakePrintJob(req.user.tenantId, req.user.userId, req.params.jobId))
  app.post('/print-jobs/:jobId/complete', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any, reply) => {
    const parsed = printJobTransitionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return completeWarehouseStocktakePrintJob({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.jobId, ...parsed.data })
  })
  app.post('/print-jobs/:jobId/abandon', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any, reply) => {
    const parsed = printJobTransitionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return abandonWarehouseStocktakePrintJob({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.jobId, ...parsed.data })
  })
  app.get('/', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any, reply) => {
    const parsed = z.object({
      status: z.enum(['DRAFT', 'COUNTING', 'REVIEWING', 'CONFIRMED', 'CANCELLED']).optional(),
      documentType: z.enum(['LEGACY', 'MULTI', 'FORMAL']).optional(),
      warehouseId: id.optional(), q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return listWarehouseStocktakes({ tenantId: req.user.tenantId, ...parsed.data })
  })
  app.get('/:id/logs', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any, reply) => {
    const parsed = id.safeParse(req.params.id)
    const query = z.object({ cursor: z.string().trim().max(160).optional() }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })
    return listWarehouseStocktakeLogs(req.user.tenantId, parsed.data, query.data.cursor)
  })
  app.get('/:id/review', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => {
    const row = await getWarehouseStocktake(req.user.tenantId, req.params.id)
    return {
      ...row,
      countDate: row.countDate.toISOString().slice(0, 10),
      source: 'warehouse',
      items: row.sections.flatMap(section => section.items.map(item => ({
        id: item.id,
        productCodeSnapshot: item.productCodeSnapshot,
        productNameSnapshot: item.productNameSnapshot,
        productSpecSnapshot: item.productSpecSnapshot,
        storageLocationSnapshot: item.storageLocationSnapshot,
        additionSource: item.additionSource,
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
  app.get('/:id/export', auth(WAREHOUSE_STOCKTAKE_READ_ROLES), async (req: any) => {
    const row = await getWarehouseStocktake(req.user.tenantId, req.params.id)
    const filename = `盘点单-${row.no.replace(/[\\/:*?"<>|]/g, '-')}.xlsx`
    return { filename, fileBase64: (await buildWarehouseStocktakeWorkbook(row)).toString('base64') }
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
  app.patch('/:id/header', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = headerSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return updateWarehouseStocktakeHeader({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/items', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = addItemsSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return addWarehouseStocktakeItems({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/items/remove', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = removeItemsSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return removeWarehouseStocktakeItems({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/items/reorder', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = reorderItemsSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return reorderWarehouseStocktakeItems({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/refresh-units', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = rowVersionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return refreshWarehouseStocktakeUnits({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/submit', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = rowVersionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return submitWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/withdraw', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = withdrawSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return withdrawWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/final-review', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any) => reviewWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id }))
  app.post('/generate-formal-batch', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any, reply) => {
    const parsed = generateFormalSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return generateFormalWarehouseStocktakes({ tenantId: req.user.tenantId, userId: req.user.userId, ...parsed.data })
  })
  app.post('/:id/generate-formal', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any) => generateFormalWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id }))
  app.post('/:id/approve', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any) => approveWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id }))
  app.post('/:id/reject', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any, reply) => {
    const parsed = rejectSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return rejectWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/delete', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = rejectSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return deleteWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/reverse-approval', auth(WAREHOUSE_STOCKTAKE_AUDIT_ROLES), async (req: any, reply) => {
    const parsed = reverseApprovalSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return reverseWarehouseStocktakeApproval({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
  app.post('/:id/cancel', auth(WAREHOUSE_STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = cancelSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return cancelWarehouseStocktake({ tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, ...parsed.data })
  })
}
