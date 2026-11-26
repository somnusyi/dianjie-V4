import { postStoreTransfer, transferRemaining } from '../services/storeTransferPosting'
import { randomUUID } from 'crypto'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { inventoryReportAccess } from './inventoryReports'
import { businessDateKey } from '../lib/businessTime'
import { hashRequestBody } from '../lib/idempotency'
import { revalueStoreConsumptionCosts } from '../services/inventoryCosting'
import { storeScopeOf } from '../lib/auth-scope'
import { canCreateTransfer, isTransferStoreActor, sameConfirmedBrand, TRANSFER_REVIEW_ROLES } from '../lib/store-transfer-access'
import { transferMatchesCurrentBrand, visibleStoreTransferBrand } from '../lib/store-transfer-brand-visibility'

// 调出门店店长创建待审单；供应链审核后在同一事务中完成出入库。
// 待审单可由调出店长或供应链撤回；历史发货和差异接口仅供供应链处理。
// 品牌快照和双方门店的当前品牌用于限制门店查看、重放及撤回。
const createSchema = z.object({
  fromStoreId: z.string().min(1), toStoreId: z.string().min(1), requestKey: z.string().uuid(),
  transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return !isNaN(+d) && d.toISOString().slice(0, 10) === v }),
  note: z.string().trim().max(500).default(''),
  items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().positive().max(99999999).multipleOf(0.000001), cost: z.number().min(0).max(99999999).multipleOf(0.000001), settlement: z.number().min(0).max(99999999).multipleOf(0.000001) })).min(1).max(100),
}).refine(v => v.fromStoreId !== v.toStoreId, '调出、调入门店不能相同').refine(v => new Set(v.items.map(i => i.productId)).size === v.items.length, '商品不能重复')
const include = { fromStore: { select: { id: true, no: true, name: true, brandCode: true } }, toStore: { select: { id: true, no: true, name: true, brandCode: true } }, items: true }
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
    const canRead = inventoryReportAccess(req.user.role) || isTransferStoreActor(req.user)
    const canWrite = TRANSFER_REVIEW_ROLES.has(req.user.role) || req.user.role === 'MANAGER'
    if (req.method === 'GET' ? !canRead : !canWrite) {
      return reply.status(403).send({ error: req.method === 'GET' ? '无权查看门店调拨' : '门店调拨须由供应链或管理员审核操作' })
    }
  })
  app.get('/', async (req: any) => {
    const scope = storeScopeOf(req.user)
    const where: any = { tenantId: req.user.tenantId }
    if (scope !== null) {
      if (!scope.length) return []
      const assigned = await prisma.store.findMany({ where: { tenantId: req.user.tenantId, id: { in: scope } }, select: { brandCode: true } })
      const brand = visibleStoreTransferBrand(assigned)
      if (assigned.length !== scope.length || !brand) return []
      where.OR = [{ fromStoreId: { in: scope } }, { toStoreId: { in: scope } }]
      where.brandCode = brand
      where.fromStore = { brandCode: brand }
      where.toStore = { brandCode: brand }
    }
    const rows = await prisma.storeTransfer.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 1001 })
    if (rows.length > 1000) throw Object.assign(new Error('调拨单超过 1000 条，请使用报表按日期查询'), { statusCode: 422 })
    return (scope === null ? rows : rows.filter(row => transferMatchesCurrentBrand(row, where.brandCode))).map(serialize)
  })
  app.get('/products', async (req: any) => prisma.product.findMany({ where: { tenantId: req.user.tenantId, status: 'ENABLED', inventoryUnit: { not: null }, unitConversionStatus: 'VERIFIED' }, select: { id: true, code: true, name: true, inventoryUnit: true }, orderBy: { code: 'asc' }, take: 2000 }))
  app.get('/eligible-stores', async (req: any, reply) => {
    if (req.user.role !== 'MANAGER') return reply.status(403).send({ error: '仅店长可选择调拨目标' })
    const scope = storeScopeOf(req.user) ?? []
    if (!scope.length) return { sources: [], destinations: [] }
    const sourceStores = await prisma.store.findMany({ where: { tenantId: req.user.tenantId, id: { in: scope }, status: 'ENABLED' }, select: { id: true, no: true, name: true, brandCode: true } })
    const brands = [...new Set(sourceStores.map(store => store.brandCode))]
    if (brands.length !== 1 || !brands[0]) return { sources: [], destinations: [] }
    const candidates = await prisma.store.findMany({ where: { tenantId: req.user.tenantId, brandCode: brands[0], status: 'ENABLED' }, select: { id: true, no: true, name: true }, orderBy: { no: 'asc' } })
    return { sources: sourceStores.map(({ brandCode: _brandCode, ...store }) => store), destinations: candidates }
  })
  app.post('/', async (req: any, reply) => {
    if (req.user.role !== 'MANAGER') return reply.status(403).send({ error: '仅调出门店店长可发起调拨' })
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const data = parsed.data; const tenantId = req.user.tenantId
    if (!canCreateTransfer(req.user, data.fromStoreId)) return reply.status(403).send({ error: '只能由调出门店店长发起本店调拨' })
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
            if (!existing.brandCode || !transferMatchesCurrentBrand(existing, existing.brandCode)) throw Object.assign(new Error('门店品牌已变更，无法重放调拨请求'), { statusCode: 403 })
            return { row: existing, replayed: true }
          }
          const stores = await tx.store.findMany({ where: { tenantId, id: { in: [data.fromStoreId, data.toStoreId] }, status: 'ENABLED' }, select: { id: true, brandCode: true } })
          if (stores.length !== 2) throw Object.assign(new Error('门店不存在、已停用或不属于当前租户'), { statusCode: 400 })
          if (!sameConfirmedBrand(stores.find(store => store.id === data.fromStoreId)!, stores.find(store => store.id === data.toStoreId)!)) throw Object.assign(new Error('门店品牌未确认或调拨目标不属于同一品牌'), { statusCode: 403 })
          const products = await tx.product.findMany({ where: { tenantId, id: { in: data.items.map(i => i.productId) }, status: 'ENABLED', unitConversionStatus: 'VERIFIED' } })
          if (products.length !== data.items.length || products.some(p => !p.inventoryUnit)) throw Object.assign(new Error('商品不可用或库存单位未确认'), { statusCode: 400 })
          const row = await tx.storeTransfer.create({ data: { tenantId, no: `DB${businessDateKey().replace(/-/g, '')}-${randomUUID().slice(0, 8).toUpperCase()}`, brandCode: stores[0].brandCode, fromStoreId: data.fromStoreId, toStoreId: data.toStoreId, transferDate: new Date(`${data.transferDate}T00:00:00Z`), note: data.note, requestKey: data.requestKey, requestFingerprint: requestedFingerprint, createdById: req.user.userId, items: { create: data.items.map(i => { const p = products.find(p => p.id === i.productId)!; return { productId: p.id, name: p.name, code: p.code, spec: p.spec, category: p.category, unit: p.inventoryUnit!, quantity: i.quantity, cost: i.cost, settlement: i.settlement, outAmount: new Prisma.Decimal(i.quantity).mul(i.cost).toDecimalPlaces(4), inAmount: new Prisma.Decimal(i.quantity).mul(i.settlement).toDecimalPlaces(4) } }) } }, include })
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
            if (!existing.brandCode || !transferMatchesCurrentBrand(existing, existing.brandCode)) return reply.status(403).send({ error: '门店品牌已变更，无法重放调拨请求' })
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
  app.post('/:id/approve', async (req: any, reply) => {
    if (!TRANSFER_REVIEW_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅供应链可审核门店调拨' })
    let row: any
    for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
    row = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`store-transfer-approve:${req.user.tenantId}:${req.params.id}`}))::text AS locked`
      const current = await tx.storeTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include })
      if (!current) throw Object.assign(new Error('调拨单不存在'), { statusCode: 404 })
      if (current.status === 'RECEIVED' && current.approvedAt) return current
      if (current.status !== 'PENDING') throw Object.assign(new Error('只有待审核调拨单可以审核'), { statusCode: 409 })
      if (current.approvedAt) throw Object.assign(new Error('调拨单正在审核，请刷新'), { statusCode: 409 })
      const stores = await tx.store.findMany({ where: { tenantId: req.user.tenantId, id: { in: [current.fromStoreId, current.toStoreId] } }, select: { id: true, brandCode: true } })
      if (stores.length !== 2 || !current.brandCode || !sameConfirmedBrand(stores.find(store => store.id === current.fromStoreId)!, stores.find(store => store.id === current.toStoreId)!) || stores[0].brandCode !== current.brandCode) {
        throw Object.assign(new Error('门店品牌已变更或未确认，不能审核调拨'), { statusCode: 403 })
      }
      await tx.storeTransfer.update({ where: { id: current.id }, data: { approvedAt: new Date(), approvedById: req.user.userId } })
      await postStoreTransfer(tx, { tenantId: req.user.tenantId, transferId: current.id, actorId: req.user.userId, action: 'SHIP', requestKey: `approve-ship:${current.id}` })
      await postStoreTransfer(tx, { tenantId: req.user.tenantId, transferId: current.id, actorId: req.user.userId, action: 'RECEIVE', requestKey: `approve-receive:${current.id}`, items: current.items.map(item => ({ itemId: item.id, quantity: Number(item.quantity) })) })
      await tx.opLog.create({ data: { tenantId: req.user.tenantId, userId: req.user.userId, role: req.user.role, action: `审核通过门店调拨 ${current.no}，库存即时转移`, entityType: 'StoreTransfer', targetId: current.id } })
      return tx.storeTransfer.update({ where: { id: current.id }, data: { shippedAt: null, shippedById: null, receivedById: null }, include })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (isSerializableConflict(error) && attempt < 3) continue
      if (isSerializableConflict(error)) return reply.status(409).send({ error: '调拨正在处理，请刷新后重试' })
      throw error
    }
    break
    }
    await Promise.all([row.fromStoreId, row.toStoreId].map((storeId: string) => revalueStoreConsumptionCosts(req.user.tenantId, storeId).catch(error => {
      req.log.error({ error, transferId: row.id, storeId }, 'transfer cost snapshot refresh failed')
    })))
    return serialize(row)
  })
  const execute = async (req: any, reply: any, action: 'SHIP' | 'RECEIVE' | 'RETURN' | 'DAMAGE', requestKey: string, items?: Array<{ itemId: string; quantity: number }>, note?: string) => {
    if (action === 'SHIP' || !TRANSFER_REVIEW_ROLES.has(req.user.role)) return reply.status(403).send({ error: '新调拨单由供应链审核后自动完成库存转移' })
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
    if (parsed.data.status !== 'REVOKED') return reply.status(403).send({ error: '新调拨单由供应链审核后自动完成库存转移' })
    const existing = await prisma.storeTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include })
    if (!existing) return reply.status(404).send({ error: '调拨单不存在' })
    const reviewer = TRANSFER_REVIEW_ROLES.has(req.user.role)
    if (!reviewer && (!canCreateTransfer(req.user, existing.fromStoreId) || !existing.brandCode || !transferMatchesCurrentBrand(existing, existing.brandCode))) return reply.status(404).send({ error: '调拨单不存在' })
    if (existing.approvedAt && !TRANSFER_REVIEW_ROLES.has(req.user.role)) return reply.status(403).send({ error: '已审核调拨须由供应链驳回' })
    const row = await prisma.$transaction(async tx => {
      const current = await tx.storeTransfer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include })
      if (!current) throw Object.assign(new Error('调拨单不存在'), { statusCode: 404 })
      if (!reviewer && (!canCreateTransfer(req.user, current.fromStoreId) || !current.brandCode || !transferMatchesCurrentBrand(current, current.brandCode))) throw Object.assign(new Error('调拨单不存在'), { statusCode: 404 })
      if (current.approvedAt && !reviewer) throw Object.assign(new Error('已审核调拨须由供应链驳回'), { statusCode: 403 })
      const updated = await tx.storeTransfer.updateMany({ where: { id: current.id, tenantId: req.user.tenantId, status: 'PENDING' }, data: { status: 'REVOKED', revokedAt: new Date(), revokedById: req.user.userId } })
      if (updated.count !== 1) throw Object.assign(new Error('只有待审核调拨单可以撤回'), { statusCode: 409 })
      return tx.storeTransfer.findUniqueOrThrow({ where: { id: current.id }, include })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
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
