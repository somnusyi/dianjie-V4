import { postStoreTransfer, transferRemaining } from '../services/storeTransferPosting'
import { randomUUID } from 'crypto'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { inventoryReportAccess } from './inventoryReports'
import { businessDateKey } from '../lib/businessTime'
import { hashRequestBody } from '../lib/idempotency'
import { revalueStoreConsumptionCosts } from '../services/inventoryCosting'

// 门店调拨由供应链审核推进，管理员保留兼容写入：创建 -> PENDING；
// PENDING -> SHIPPED 或 REVOKED；SHIPPED -> RECEIVED。
// RECEIVED、REVOKED 为终态。记录操作者及时间，CAS 防止并发覆盖；当前仅登记调拨，不改写盘点快照。
const createSchema = z.object({
  fromStoreId: z.string().min(1), toStoreId: z.string().min(1), requestKey: z.string().uuid(),
  transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return !isNaN(+d) && d.toISOString().slice(0, 10) === v }),
  note: z.string().trim().max(500).default(''),
  items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().positive().max(99999999).multipleOf(0.000001), cost: z.number().min(0).max(99999999).multipleOf(0.000001), settlement: z.number().min(0).max(99999999).multipleOf(0.000001) })).min(1).max(100),
}).refine(v => v.fromStoreId !== v.toStoreId, '调出、调入门店不能相同').refine(v => new Set(v.items.map(i => i.productId)).size === v.items.length, '商品不能重复')
const include = { fromStore: { select: { id: true, no: true, name: true } }, toStore: { select: { id: true, no: true, name: true } }, items: true }
const serialize = (row: any) => ({ ...row, transferDate: businessDateKey(row.transferDate), items: row.items.map((i: any) => ({ ...i, quantity: Number(i.quantity), cost: Number(i.cost), settlement: Number(i.settlement), outAmount: Number(i.outAmount), inAmount: Number(i.inAmount), receivedQuantity: Number(i.receivedQuantity ?? 0), returnedQuantity: Number(i.returnedQuantity ?? 0), damagedQuantity: Number(i.damagedQuantity ?? 0), pendingQuantity: Number(transferRemaining(i)) })) })

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
    if (!req.user?.tenantId) return reply.status(403).send({ error: '无权操作门店调拨' })
    const canRead = inventoryReportAccess(req.user.role)
    const canWrite = ['ADMIN', 'SUPER_ADMIN', 'SUPPLY_CHAIN'].includes(req.user.role)
    if (req.method === 'GET' ? !canRead : !canWrite) {
      return reply.status(403).send({ error: req.method === 'GET' ? '无权查看门店调拨' : '门店调拨须由供应链或管理员审核操作' })
    }
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
      && (row.requestFingerprint || transferRequestFingerprint(row)) === requestedFingerprint
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
          const row = await tx.storeTransfer.create({ data: { tenantId, no: `DB${businessDateKey().replace(/-/g, '')}-${randomUUID().slice(0, 8).toUpperCase()}`, fromStoreId: data.fromStoreId, toStoreId: data.toStoreId, transferDate: new Date(`${data.transferDate}T00:00:00Z`), note: data.note, requestKey: data.requestKey, requestFingerprint: requestedFingerprint, createdById: req.user.userId, items: { create: data.items.map(i => { const p = products.find(p => p.id === i.productId)!; return { productId: p.id, name: p.name, code: p.code, spec: p.spec, category: p.category, unit: p.inventoryUnit!, quantity: i.quantity, cost: i.cost, settlement: i.settlement, outAmount: new Prisma.Decimal(i.quantity).mul(i.cost).toDecimalPlaces(4), inAmount: new Prisma.Decimal(i.quantity).mul(i.settlement).toDecimalPlaces(4) } }) } }, include })
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
  const execute = async (req: any, reply: any, action: 'SHIP' | 'RECEIVE' | 'RETURN' | 'DAMAGE', requestKey: string, items?: Array<{ itemId: string; quantity: number }>, note?: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await prisma.$transaction(async tx => {
          let input = items
          if (action === 'RECEIVE' && !input) {
            const prior = await tx.storeTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { items: true } })
            if (!prior) throw Object.assign(new Error('调拨单不存在'), { statusCode: 404 })
            input = prior.items.map((i: any) => ({ itemId: i.id, quantity: Number(i.quantity) }))
          }
          return postStoreTransfer(tx, { tenantId: req.user.tenantId, transferId: req.params.id, actorId: req.user.userId, action, requestKey, items: input, note })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        if (action !== 'DAMAGE') {
          const storeId = action === 'RECEIVE' ? row.toStoreId : row.fromStoreId
          await revalueStoreConsumptionCosts(req.user.tenantId, storeId).catch(error => {
            req.log.error({ error, transferId: row.id, storeId }, 'transfer cost snapshot refresh failed')
          })
        }
        return serialize(row)
      } catch (error: any) {
        if (isSerializableConflict(error) && attempt < 2) continue
        if (error.statusCode) return reply.status(error.statusCode).send({ error: error.message })
        if (isSerializableConflict(error)) return reply.status(409).send({ error: '调拨库存正在更新，请重试' })
        throw error
      }
    }
  }
  app.patch('/:id/status', async (req: any, reply) => {
    const parsed = z.object({ status: z.enum(['SHIPPED', 'RECEIVED', 'REVOKED']) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: '调拨状态无效' })
    if (parsed.data.status !== 'REVOKED') return execute(req, reply, parsed.data.status === 'SHIPPED' ? 'SHIP' : 'RECEIVE', 'legacy:' + parsed.data.status)
    const row = await prisma.$transaction(async tx => {
      await tx.storeTransfer.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId, status: 'PENDING' }, data: { status: 'REVOKED', revokedAt: new Date(), revokedById: req.user.userId } })
      const row = await tx.storeTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include })
      if (!row) throw Object.assign(new Error('调拨单不存在'), { statusCode: 404 })
      if (row.status !== 'REVOKED') throw Object.assign(new Error('已发货调拨须通过差异处理退回'), { statusCode: 409 })
      return row
    })
    return serialize(row)
  })
  const processing = z.object({ requestKey: z.string().uuid(), items: z.array(z.object({ itemId: z.string().min(1), quantity: z.number().positive().max(99999999).multipleOf(0.000001) })).min(1).max(100), note: z.string().trim().max(500).optional() })
  app.post('/:id/receive', async (req: any, reply) => {
    const parsed = processing.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: '实收商品数量无效' })
    return execute(req, reply, 'RECEIVE', parsed.data.requestKey, parsed.data.items, parsed.data.note)
  })
  app.post('/:id/resolve-difference', async (req: any, reply) => {
    const parsed = processing.extend({ action: z.enum(['RETURN', 'DAMAGE']) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: '差异处理数据无效' })
    if (parsed.data.action === 'DAMAGE' && !parsed.data.note) return reply.status(400).send({ error: '请填写损坏处置说明' })
    return execute(req, reply, parsed.data.action, parsed.data.requestKey, parsed.data.items, parsed.data.note)
  })
}
