import { randomUUID } from 'crypto'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { inventoryReportAccess } from './inventoryReports'
import { businessDateKey } from '../lib/businessTime'
import { hashRequestBody } from '../lib/idempotency'

// 供应链/管理员：创建 -> PENDING；PENDING -> SHIPPED 或 REVOKED；SHIPPED -> RECEIVED。
// RECEIVED、REVOKED 为终态。记录操作者及时间，CAS 防止并发覆盖；当前仅登记调拨，不改写盘点快照。
const createSchema = z.object({
  fromStoreId: z.string().min(1), toStoreId: z.string().min(1), requestKey: z.string().uuid(),
  transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return !isNaN(+d) && d.toISOString().slice(0, 10) === v }),
  note: z.string().trim().max(500).default(''),
  items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().positive().max(99999999).multipleOf(0.000001), cost: z.number().min(0).max(99999999).multipleOf(0.000001), settlement: z.number().min(0).max(99999999).multipleOf(0.000001) })).min(1).max(100),
}).refine(v => v.fromStoreId !== v.toStoreId, '调出、调入门店不能相同').refine(v => new Set(v.items.map(i => i.productId)).size === v.items.length, '商品不能重复')
const include = { fromStore: { select: { id: true, no: true, name: true } }, toStore: { select: { id: true, no: true, name: true } }, items: true }
const serialize = (row: any) => ({ ...row, transferDate: businessDateKey(row.transferDate), items: row.items.map((i: any) => ({ ...i, quantity: Number(i.quantity), cost: Number(i.cost), settlement: Number(i.settlement), outAmount: Number(i.outAmount), inAmount: Number(i.inAmount) })) })

type TransferFingerprintSource = {
  fromStoreId: string
  toStoreId: string
  transferDate: string | Date
  note?: string | null
  items: Array<{
    productId: string
    quantity: Prisma.Decimal | number | string
    cost: Prisma.Decimal | number | string
    settlement: Prisma.Decimal | number | string
  }>
}

function transferRequestFingerprint(source: TransferFingerprintSource) {
  const transferDate = typeof source.transferDate === 'string'
    ? source.transferDate
    : businessDateKey(source.transferDate)
  return hashRequestBody({
    domain: 'store-transfer-create-v1',
    fromStoreId: source.fromStoreId,
    toStoreId: source.toStoreId,
    transferDate,
    note: (source.note || '').trim(),
    items: source.items
      .map(item => ({
        productId: item.productId,
        quantity: new Prisma.Decimal(item.quantity).toFixed(6),
        cost: new Prisma.Decimal(item.cost).toFixed(6),
        settlement: new Prisma.Decimal(item.settlement).toFixed(6),
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
  }, 'application/json')
}

function isSerializableConflict(error: any) {
  if (error?.code === 'P2034') return true
  if (error?.code !== 'P2010') return false
  const databaseCode = String(error?.meta?.code || '')
  const databaseMessage = String(error?.meta?.message || error?.message || '')
  return databaseCode === '40001' || /could not serialize|serialization failure|SQLSTATE\s*40001/i.test(databaseMessage)
}

export const storeTransferRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', (app as any).authenticate)
  app.addHook('preHandler', async (req: any, reply) => {
    if (!req.user?.tenantId || !inventoryReportAccess(req.user.role, req.method !== 'GET')) return reply.status(403).send({ error: '无权操作门店调拨' })
  })
  app.get('/', async (req: any) => {
    const rows = await prisma.storeTransfer.findMany({ where: { tenantId: req.user.tenantId }, include, orderBy: { createdAt: 'desc' }, take: 1001 })
    if (rows.length > 1000) throw Object.assign(new Error('调拨单超过 1000 条，请使用报表按日期查询'), { statusCode: 422 })
    return rows.map(serialize)
  })
  app.get('/products', async (req: any) => prisma.product.findMany({ where: { tenantId: req.user.tenantId, status: 'ENABLED', inventoryUnit: { not: null }, unitConversionStatus: 'VERIFIED' }, select: { id: true, code: true, name: true, inventoryUnit: true }, orderBy: { code: 'asc' }, take: 2000 }))
  app.post('/', async (req: any, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const data = parsed.data; const tenantId = req.user.tenantId
    const requestedFingerprint = transferRequestFingerprint(data)
    const replayMatches = (row: any) => row.createdById === req.user.userId
      && transferRequestFingerprint(row) === requestedFingerprint
    const replay = () => prisma.storeTransfer.findUnique({
      where: { tenantId_requestKey: { tenantId, requestKey: data.requestKey } },
      include,
    })

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await prisma.$transaction(async tx => {
          // 同一租户+请求键串行化，避免并发请求都读到“不存在”后双写。
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`store-transfer:${tenantId}:${data.requestKey}`}))::text AS locked`
          const existing = await tx.storeTransfer.findUnique({ where: { tenantId_requestKey: { tenantId, requestKey: data.requestKey } }, include })
          if (existing) {
            if (!replayMatches(existing)) throw Object.assign(new Error('同一幂等键不能用于不同的调拨请求'), { statusCode: 409 })
            return { row: existing, replayed: true }
          }
          const stores = await tx.store.count({ where: { tenantId, id: { in: [data.fromStoreId, data.toStoreId] }, status: 'ENABLED' } })
          if (stores !== 2) throw Object.assign(new Error('门店不存在、已停用或不属于当前租户'), { statusCode: 400 })
          const products = await tx.product.findMany({ where: { tenantId, id: { in: data.items.map(i => i.productId) }, status: 'ENABLED', unitConversionStatus: 'VERIFIED' } })
          if (products.length !== data.items.length || products.some(p => !p.inventoryUnit)) throw Object.assign(new Error('商品不可用或库存单位未确认'), { statusCode: 400 })
          const row = await tx.storeTransfer.create({ data: { tenantId, no: `DB${businessDateKey().replace(/-/g, '')}-${randomUUID().slice(0, 8).toUpperCase()}`, fromStoreId: data.fromStoreId, toStoreId: data.toStoreId, transferDate: new Date(`${data.transferDate}T00:00:00Z`), note: data.note, requestKey: data.requestKey, createdById: req.user.userId, items: { create: data.items.map(i => { const p = products.find(p => p.id === i.productId)!; return { productId: p.id, name: p.name, code: p.code, spec: p.spec, category: p.category, unit: p.inventoryUnit!, quantity: i.quantity, cost: i.cost, settlement: i.settlement, outAmount: new Prisma.Decimal(i.quantity).mul(i.cost).toDecimalPlaces(4), inAmount: new Prisma.Decimal(i.quantity).mul(i.settlement).toDecimalPlaces(4) } }) } }, include })
          return { row, replayed: false }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        return reply.status(result.replayed ? 200 : 201).send(serialize(result.row))
      } catch (error: any) {
        if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
        const serializableConflict = isSerializableConflict(error)
        if (error?.code === 'P2002' || serializableConflict) {
          const existing = await replay()
          if (existing) {
            if (!replayMatches(existing)) return reply.status(409).send({ error: '同一幂等键不能用于不同的调拨请求' })
            return reply.status(200).send(serialize(existing))
          }
          if (serializableConflict && attempt < 3) continue
          if (serializableConflict) return reply.status(409).send({ error: '调拨请求正在处理，请刷新后重试' })
        }
        throw error
      }
    }
    return reply.status(409).send({ error: '调拨请求正在处理，请刷新后重试' })
  })
  app.patch('/:id/status', async (req: any, reply) => {
    const parsed = z.object({ status: z.enum(['SHIPPED', 'RECEIVED', 'REVOKED']) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: '调拨状态无效' })
    const status = parsed.data.status; const expected = status === 'RECEIVED' ? 'SHIPPED' : 'PENDING'
    const actor = status === 'SHIPPED' ? { shippedAt: new Date(), shippedById: req.user.userId } : status === 'RECEIVED' ? { receivedAt: new Date(), receivedById: req.user.userId } : { revokedAt: new Date(), revokedById: req.user.userId }
    const result = await prisma.$transaction(async tx => {
      const updated = await tx.storeTransfer.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId, status: expected }, data: { status, ...actor } })
      const row = await tx.storeTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include })
      if (!row) throw Object.assign(new Error('调拨单不存在'), { statusCode: 404 })
      if (!updated.count && row.status !== status) throw Object.assign(new Error('状态已变化，请刷新后重试'), { statusCode: 409 })
      return row
    })
    return serialize(result)
  })
}
