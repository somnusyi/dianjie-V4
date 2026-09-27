import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { createWarehouseStocktake, getWarehouseStocktake, saveWarehouseStocktakePartition, transitionWarehouseStocktake, STOCKTAKE_READ_ROLES, STOCKTAKE_WRITE_ROLES, STOCKTAKE_AUDIT_ROLES } from '../services/warehouseStocktake'
const id = z.string().trim().min(1).max(64)
const quantity = z.string().regex(/^\d{1,10}(\.\d{1,6})?$/, '数量/单价应为非负数，最多6位小数')
const createSchema = z.object({ warehouseId: id, countDate: z.string().date(), note: z.string().trim().max(240).optional(), partitions: z.array(z.object({ name: z.string().trim().min(1).max(80), assignedToId: id, productIds: z.array(id).min(1).max(200) })).min(1).max(30) }).refine(value => value.partitions.reduce((sum, partition) => sum + partition.productIds.length, 0) <= 200, '每张盘点单最多200项，请按仓库/区域分单')
const saveSchema = z.object({ version: z.number().int().nonnegative(), lines: z.array(z.object({ id, quantity, unitCost: quantity.optional(), reason: z.string().trim().max(240).optional() })).min(1).max(200) })
export const warehouseStocktakeRoutes: FastifyPluginAsync = async app => {
  const auth = (roles: string[]) => ({ preHandler: [(app as any).authenticate, async (req: any, reply: any) => { if (!req.user?.tenantId || !roles.includes(req.user.role)) return reply.status(403).send({ error: '无权操作总仓盘点' }) }] })
  app.setErrorHandler((error: any, _req, reply) => {
    if (['P2034', 'P2002'].includes(error?.code) || error?.code === 'P2010' && error?.meta?.code === '40001') return reply.status(409).send({ error: '盘点单正在被其他人更新，请刷新后重试' })
    reply.status(error.statusCode || 500).send({ error: error.statusCode ? error.message : '盘点操作失败，请稍后重试' })
  })
  app.get('/options', auth(STOCKTAKE_READ_ROLES), async (req: any) => {
    const tenantId = req.user.tenantId
    const [warehouses, users, products] = await Promise.all([
      prisma.warehouse.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } }),
      prisma.user.findMany({ where: { tenantId, role: { in: STOCKTAKE_WRITE_ROLES as any } }, select: { id: true, name: true } }),
      prisma.product.findMany({ where: { tenantId, status: 'ENABLED', unitConversionStatus: 'VERIFIED' }, select: { id: true, code: true, name: true, inventoryUnit: true, unit: true }, orderBy: { code: 'asc' } }),
    ])
    return { warehouses, users, products }
  })
  app.get('/', auth(STOCKTAKE_READ_ROLES), async (req: any) => prisma.warehouseStocktake.findMany({ where: { tenantId: req.user.tenantId }, include: { warehouse: true, _count: { select: { lines: true, partitions: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }))
  app.get('/:id/review', auth(STOCKTAKE_READ_ROLES), async (req: any) => {
    const count = await getWarehouseStocktake(req.user.tenantId, req.params.id)
    return { ...count, countDate: count.countDate.toISOString().slice(0, 10), store: { name: count.warehouse.name }, items: count.partitions.flatMap(partition => partition.lines.map(line => ({ id: line.id, productCodeSnapshot: line.productCode, productNameSnapshot: line.productName, productSpecSnapshot: null, unitSnapshot: line.inventoryUnit, bookQuantity: Number(line.bookQuantity), countedQuantity: line.countedQuantity == null ? null : Number(line.countedQuantity), differenceQuantity: line.differenceQuantity == null ? null : Number(line.differenceQuantity), differenceAmount: line.differenceAmount == null ? null : Number(line.differenceAmount), reasonCode: 'OTHER', reasonNote: `${partition.name}：${line.reason || '—'}`, evidenceKeys: [], evidenceUrls: [] }))) }
  })
  app.get('/:id', auth(STOCKTAKE_READ_ROLES), async (req: any) => getWarehouseStocktake(req.user.tenantId, req.params.id))
  app.post('/', auth(STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return reply.status(201).send(await createWarehouseStocktake({ ...parsed.data, tenantId: req.user.tenantId, userId: req.user.userId }))
  })
  app.put('/:id/partitions/:partitionId', auth(STOCKTAKE_WRITE_ROLES), async (req: any, reply) => {
    const parsed = saveSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return saveWarehouseStocktakePartition({ ...parsed.data, tenantId: req.user.tenantId, userId: req.user.userId, id: req.params.id, partitionId: req.params.partitionId })
  })
  for (const action of ['submit', 'approve', 'reject', 'cancel'] as const) app.post(`/:id/${action}`, auth(['approve', 'reject'].includes(action) ? STOCKTAKE_AUDIT_ROLES : STOCKTAKE_WRITE_ROLES), async (req: any) => transitionWarehouseStocktake(req.user.tenantId, req.user.userId, req.params.id, action))
}
