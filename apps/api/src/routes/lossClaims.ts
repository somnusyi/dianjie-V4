import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { createSupplierStockBatchIncrease } from '../services/supplierStockBatch'
import dayjs from 'dayjs'
import { z } from 'zod'
import { notifyLossClaimResult } from '../services/notification'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'
import { resignOssUrls } from './upload'
import { fireAndForget as notify } from '../services/notify'
import { businessNoFloor, nextBusinessNo } from '../services/purchaseOrderIntegrity'
import { estimatedStoreInventory } from '../services/storeInventory'
import { lossClaimScope } from '../lib/loss-claim-scope'
import { lossClaimResolutionSchema, proratedLossQuantity } from '../services/lossClaimResolution'
import { withDocumentProductSnapshot } from '../lib/supply-document-snapshot'
import { setReceiptSettlementAmountInTransaction } from '../services/receiptSettlement'
import { arrivalDifferencesToCsv } from '../services/arrivalDifferenceExport'

const manualLossSchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().positive().max(1_000_000).refine(
      value => new Prisma.Decimal(value).decimalPlaces() <= 2,
      '报损数量最多保留 2 位小数',
    ),
    // 兼容旧客户端；服务端始终忽略该值并使用门店移动平均成本。
    unitPrice: z.number().optional(),
  }).strict()).min(1, '请填写报损明细').max(100),
  reason: z.string().trim().min(1, '请选择报损原因').max(30),
  description: z.string().trim().max(500).optional(),
  evidenceImages: z.array(z.string().max(2048)).max(9).optional(),
}).strict().superRefine((value, ctx) => {
  const productIds = value.items.map(item => item.productId)
  if (new Set(productIds).size !== productIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一食材不能重复报损' })
  }
})

const supplierLossSchema = z.object({
  purchaseOrderId: z.string().min(1),
  receiptId: z.string().min(1).optional(),
  kind: z.enum(['ARRIVAL_SHORTAGE', 'ARRIVAL_DAMAGE']).default('ARRIVAL_SHORTAGE'),
  description: z.string().trim().min(1, '请填写报损说明').max(500),
  reason: z.string().trim().max(30).optional(),
  evidenceImages: z.array(z.string().max(2048)).max(9).optional(),
  items: z.array(z.object({
    productId: z.string().min(1),
    receivedQty: z.number().nonnegative().max(1_000_000).refine(
      value => new Prisma.Decimal(value).decimalPlaces() <= 2,
      '实收数量最多保留 2 位小数',
    ),
    // 兼容旧客户端字段；应到量和单价始终取订单快照。
    orderedQty: z.number().optional(),
    unitPrice: z.number().optional(),
  }).strict()).min(1, '请填写报损明细').max(100),
}).strict().superRefine((value, ctx) => {
  const productIds = value.items.map(item => item.productId)
  if (new Set(productIds).size !== productIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一订单商品不能重复报损' })
  }
})

const lossClaimListQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'NEGOTIATING', 'RESOLVED', 'AUTO_APPROVED']).optional(),
  kind: z.enum(['ARRIVAL_SHORTAGE', 'ARRIVAL_DAMAGE', 'INTERNAL_WASTE', 'LEGACY_UNRESOLVED']).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  pageSize: z.string().regex(/^\d+$/).optional(),
  isManual: z.enum(['true', 'false']).optional(),
  createdAfter: z.string().max(40).optional(),
  createdBefore: z.string().max(40).optional(),
  keyword: z.string().trim().max(100).optional(),
}).strict()

function buildLossClaimWhere(
  user: { tenantId: string; storeId?: string | null; role: string; supplierId?: string | null },
  query: z.infer<typeof lossClaimListQuerySchema>,
) {
  const where: any = lossClaimScope(user)
  if (query.status) where.status = query.status
  if (query.kind) where.kind = query.kind
  if (query.isManual === 'true') where.isManual = true
  if (query.isManual === 'false') where.isManual = false
  const createdAt: any = {}
  if (query.createdAfter) {
    const from = new Date(query.createdAfter)
    if (Number.isNaN(from.getTime())) throw Object.assign(new Error('开始时间无效'), { statusCode: 400 })
    createdAt.gte = from
  }
  if (query.createdBefore) {
    const before = new Date(query.createdBefore)
    if (Number.isNaN(before.getTime())) throw Object.assign(new Error('结束时间无效'), { statusCode: 400 })
    createdAt.lt = before
  }
  if (Object.keys(createdAt).length) where.createdAt = createdAt
  if (query.keyword) {
    where.AND = [{
      OR: [
        { no: { contains: query.keyword, mode: 'insensitive' } },
        { description: { contains: query.keyword, mode: 'insensitive' } },
        { purchaseOrder: { no: { contains: query.keyword, mode: 'insensitive' } } },
        { deliveryOrder: { no: { contains: query.keyword, mode: 'insensitive' } } },
        { receipt: { no: { contains: query.keyword, mode: 'insensitive' } } },
        { store: { name: { contains: query.keyword, mode: 'insensitive' } } },
      ],
    }]
  }
  return where
}

async function nextLossClaimNo(tx: Prisma.TransactionClient, tenantId: string, period: string) {
  const latest = await tx.lossClaim.findFirst({
    where: { tenantId, no: { startsWith: `LC${period}` } },
    orderBy: { no: 'desc' },
    select: { no: true },
  })
  return nextBusinessNo(
    tx,
    tenantId,
    'LOSS_CLAIM',
    period,
    'LC',
    businessNoFloor(latest?.no, 'LC', period),
  )
}

async function refundSupplierStockInTransaction(
  tx: Prisma.TransactionClient,
  claim: any,
  operatorId: string,
  reason: string,
  acceptedDeductAmount?: Prisma.Decimal.Value,
) {
  if (!claim.items || claim.items.length === 0) return 0
  let movementCount = 0
  for (const it of claim.items) {
    const productId = it.productId
    const fullLossQty = new Prisma.Decimal(it.lossQty)
    const refundQty = acceptedDeductAmount === undefined
      ? fullLossQty
      : proratedLossQuantity(fullLossQty, acceptedDeductAmount, claim.totalLossAmount)
    if (!productId || refundQty.lte(0)) continue
    const existing = await tx.supplierStockMovement.findFirst({
      where: { tenantId: claim.tenantId, sourceType: 'LossClaim', sourceId: claim.id, productId },
      select: { id: true },
    })
    if (existing) continue
    const product = await tx.product.findFirst({
      where: { id: productId, tenantId: claim.tenantId, supplierId: claim.supplierId || '__NONE__' },
      select: { id: true, supplierId: true },
    })
    if (!product?.supplierId) throw new Error(`报损 ${claim.no} 的商品 ${productId} 不属于责任供应商`)
    const updated = await tx.product.update({
      where: { id: product.id },
      data: { stock: { increment: refundQty } },
      select: { stock: true },
    })
    const movement = await tx.supplierStockMovement.create({
      data: {
        tenantId: claim.tenantId, supplierId: product.supplierId, productId,
        delta: refundQty, balanceAfter: updated.stock,
        type: 'ADJUSTMENT' as any,
        reason: `${reason}, 回补未送达 ${refundQty.toString()}`,
        sourceType: 'LossClaim', sourceId: claim.id,
        createdById: operatorId,
      },
    })
    await createSupplierStockBatchIncrease(tx, {
      tenantId: claim.tenantId,
      supplierId: product.supplierId,
      productId,
      quantity: refundQty,
      movementId: movement.id,
      createdById: operatorId,
      kind: 'RETURN',
    })
    movementCount += 1
  }
  return movementCount
}

/**
 * 协商路径的库存回补兼容入口。库存和流水原子提交，并按 claim+product 幂等。
 * 正常供应商同意与 24h 自动同意应调用 approveLossClaimAtomically，确保状态也在同一事务。
 */
export async function refundSupplierStockOnLossApproved(
  claim: any,
  operatorId: string,
  reason: string,
  acceptedDeductAmount?: Prisma.Decimal.Value,
) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`loss-handle:${claim.id}`}))::text AS locked`
    return refundSupplierStockInTransaction(tx, claim, operatorId, reason, acceptedDeductAmount)
  })
}

export async function approveLossClaimAtomically(params: {
  claimId: string
  tenantId: string
  operatorId: string
  reason: string
  automatic?: boolean
  handlerNote?: string | null
}) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`loss-handle:${params.claimId}`}))::text AS locked`
    const claim = await tx.lossClaim.findFirst({
      where: { id: params.claimId, tenantId: params.tenantId, isManual: false },
      include: { items: true, purchaseOrder: { include: { receipt: true } } },
    })
    if (!claim) return { transitioned: false, duplicated: false, claim: null }
    if (claim.status === 'APPROVED' || claim.status === 'AUTO_APPROVED') {
      return { transitioned: false, duplicated: true, claim }
    }
    if (claim.status !== 'PENDING') return { transitioned: false, duplicated: false, claim }

    let payableAdjustment = '入库时已按实收净额计算，本次不重复调整应付'
    if (claim.payableBasis === 'GROSS_PENDING_CLAIM') {
      const receiptId = payableReceiptIdForClaim(claim)
      if (!receiptId) throw new Error(`补报差异 ${claim.no} 未绑定收货单`)
      const schedule = await tx.paymentSchedule.findUnique({ where: { receiptId } })
      if (!schedule || schedule.status !== 'ON_HOLD') {
        throw new Error(`补报差异 ${claim.no} 的账期未处于冻结状态`)
      }
      const nextAmount = schedule.amount.sub(claim.totalLossAmount)
      if (nextAmount.lt(0)) throw new Error(`补报差异 ${claim.no} 超过收货单应付金额`)
      await setReceiptSettlementAmountInTransaction(tx, {
        receiptId,
        amount: nextAmount,
        scheduleStatus: 'PENDING',
      })
      payableAdjustment = `应付 ${schedule.amount.toFixed(2)} → ${nextAmount.toFixed(2)}`
    } else if (claim.payableBasis === 'NET_AT_RECEIPT' && claim.receiptId) {
      const schedule = await tx.paymentSchedule.findUnique({ where: { receiptId: claim.receiptId } })
      if (schedule?.status === 'ON_HOLD') {
        await setReceiptSettlementAmountInTransaction(tx, {
          receiptId: claim.receiptId,
          amount: schedule.amount,
          scheduleStatus: 'PENDING',
        })
      }
    }
    await refundSupplierStockInTransaction(tx, claim, params.operatorId, params.reason)
    const status = params.automatic ? 'AUTO_APPROVED' : 'APPROVED'
    await tx.lossClaim.update({
      where: { id: claim.id },
      data: {
        status,
        autoApproved: Boolean(params.automatic),
        handledAt: new Date(),
        handledById: params.automatic ? null : params.operatorId,
        handlerNote: params.handlerNote || null,
      },
    })
    await tx.opLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.operatorId,
        action: params.automatic
          ? `[自动] 到货差异 ${claim.no} 24h 自动确认；${payableAdjustment}；回补供应商库存`
          : `供应商确认到货差异 ${claim.no}；${payableAdjustment}；回补供应商库存`,
        target: claim.no,
        entityType: 'LossClaim',
        targetId: claim.id,
      },
    })
    return { transitioned: true, duplicated: false, claim: { ...claim, status } }
  })
}

/**
 * 检查采购订单关联的所有报损是否全部结案，
 * 如果是，将订单状态从 RECEIVED → COMPLETED
 */
async function tryCompleteOrder(purchaseOrderId: string, tenantId: string) {
  const pendingClaims = await prisma.lossClaim.count({
    where: {
      purchaseOrderId,
      tenantId,
      status: { in: ['PENDING', 'NEGOTIATING'] },
    },
  })
  if (pendingClaims === 0) {
    await prisma.purchaseOrder.updateMany({
      where: { id: purchaseOrderId, tenantId, status: 'RECEIVED' },
      data: { status: 'COMPLETED' },
    })
  }
}

function payableReceiptIdForClaim(claim: {
  receiptId?: string | null
  purchaseOrder?: { receiptId?: string | null } | null
}) {
  // New claims bind the exact receipt. purchaseOrder.receiptId is only a
  // compatibility pointer to one receipt and is unsafe for split deliveries.
  return claim.receiptId || claim.purchaseOrder?.receiptId || null
}

export const lossClaimRoutes: FastifyPluginAsync = async (app) => {

  // ── 列表 ──────────────────────────────────────────
  app.get('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, storeId, role, supplierId: userSupplierId } = req.user
    const parsed = lossClaimListQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { page, pageSize } = parsed.data
    let where: any
    try {
      where = buildLossClaimWhere({ tenantId, storeId, role, supplierId: userSupplierId }, parsed.data)
    } catch (error: any) {
      return reply.status(error?.statusCode || 400).send({ error: error.message })
    }

    // Keep the legacy array response when no pagination was requested. Newer
    // clients opt in with page/pageSize and receive the standard list envelope.
    const paginated = page !== undefined || pageSize !== undefined
    const p = Math.max(1, Number.parseInt(String(page || '1'), 10) || 1)
    const ps = Math.min(100, Math.max(1, Number.parseInt(String(pageSize || '20'), 10) || 20))
    const total = paginated ? await prisma.lossClaim.count({ where }) : 0

    const claims = await prisma.lossClaim.findMany({
      where, orderBy: { createdAt: 'desc' },
      ...(paginated ? { skip: (p - 1) * ps, take: ps } : {}),
      include: {
        store: { select: { name: true } },
        supplier: { select: { name: true } },
        purchaseOrder: { select: { id: true, no: true } },
        deliveryOrder: { select: { id: true, no: true } },
        receipt: { select: { id: true, no: true } },
        createdBy: { select: { name: true } },
        handledBy: { select: { name: true, role: true } },
        items: { include: { product: { select: { name: true, unit: true, spec: true } } } },
      },
    })
    // OSS 签名 1h 过期 → 读取时统一重签,前端不会再看到裂图
    const items = claims.map((c) => ({
      ...c,
      items: c.items.map(withDocumentProductSnapshot),
      evidenceImages: resignOssUrls(c.evidenceImages),
    }))
    return paginated ? { items, total, page: p, pageSize: ps } : items
  })

  app.get('/export', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role, supplierId } = req.user
    const parsed = lossClaimListQuerySchema.omit({ page: true, pageSize: true }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    let where: any
    try {
      where = buildLossClaimWhere({ tenantId, storeId, role, supplierId }, parsed.data)
    } catch (error: any) {
      return reply.status(error?.statusCode || 400).send({ error: error.message })
    }
    const total = await prisma.lossClaim.count({ where })
    if (total > 20_000) {
      return reply.status(413).send({ error: '导出超过 20000 条，请缩小日期或筛选范围' })
    }
    const claims = await prisma.lossClaim.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        store: { select: { name: true } },
        purchaseOrder: { select: { no: true } },
        deliveryOrder: { select: { no: true } },
        receipt: { select: { no: true } },
        items: { include: { product: { select: { name: true, unit: true } } } },
      },
    })
    const exportRows = claims.map(claim => ({
      ...claim,
      items: claim.items.map(withDocumentProductSnapshot),
    }))
    await prisma.opLog.create({
      data: {
        tenantId, userId, role,
        action: `导出到货差异 ${total} 条`, entityType: 'LossClaimExport',
        metadata: {
          supplierId: supplierId || null, storeId: storeId || null, count: total,
          filters: parsed.data,
        },
      },
    })
    const suffix = parsed.data.createdAfter?.slice(0, 7) || dayjs().format('YYYY-MM')
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`到货差异_${suffix}.csv`)}`)
      .header('Cache-Control', 'private, no-store')
      .send(arrivalDifferencesToCsv(exportRows))
  })

  // ── 单笔详情 / 打印数据 ─────────────────────────────
  app.get('/:id', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, storeId, role, supplierId } = req.user
    const id = String(req.params?.id || '').trim()
    if (!id || id.length > 100) return reply.status(400).send({ error: '报损单 ID 无效' })

    const claim = await prisma.lossClaim.findFirst({
      where: { id, ...lossClaimScope({ tenantId, storeId, role, supplierId }) },
      include: {
        tenant: { select: { name: true, logo: true } },
        store: { select: { no: true, name: true, address: true, phone: true } },
        supplier: { select: { no: true, name: true, contactName: true, contactPhone: true } },
        purchaseOrder: { select: { id: true, no: true, createdAt: true } },
        deliveryOrder: { select: { id: true, no: true, shippedAt: true, receivedAt: true } },
        receipt: { select: { id: true, no: true, deliveryDate: true, totalAmount: true } },
        createdBy: { select: { name: true, role: true } },
        handledBy: { select: { name: true, role: true } },
        items: {
          orderBy: { id: 'asc' },
          include: {
            product: { select: { code: true, name: true, category: true, unit: true, spec: true } },
          },
        },
      },
    })
    if (!claim) return reply.status(404).send({ error: '报损单不存在或无权查看' })

    return {
      ...claim,
      items: claim.items.map(withDocumentProductSnapshot),
      evidenceImages: resignOssUrls(claim.evidenceImages),
    }
  })

  // ── 创建报损申请（门店）──────────────────────────
  app.post('/', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, storeId: userStoreId, role } = req.user

    // P0: 仅门店人员/管理员可创建针对采购订单的报损 (供应商不能给自己创建)
    if (!['MANAGER', 'KITCHEN_LEAD', 'PURCHASER', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw { statusCode: 403, message: '无权创建报损申请' }
    }
    const parsed = supplierLossSchema.safeParse(req.body)
    if (!parsed.success) throw { statusCode: 400, message: parsed.error.issues[0].message }
    const { purchaseOrderId, receiptId, kind, description, evidenceImages, items, reason } = parsed.data
    const lossReason = reason || null
    // 证据改为可选 (2026-06 客户要求): 不强制上传, 无证据时供应商更易拒赔

    // 加 store scope: 店长/厨师长 只能给自己门店建报损
    const orderWhere: any = { id: purchaseOrderId, tenantId }
    if (isStoreScoped(role)) orderWhere.storeId = userStoreId || '__NONE__'
    const order = await prisma.purchaseOrder.findFirst({
      where: orderWhere,
      include: { items: { include: { product: { select: { code: true, name: true, spec: true, unit: true, category: true } } } } },
    })
    if (!order) throw { statusCode: 404, message: '采购订单不存在' }

    // 验收后补报必须落到唯一的收货/配送事实。单次配送订单兼容旧客户端
    // 省略 receiptId；分批配送必须由客户端明确选择，禁止猜“主收货单”。
    const eligibleReceipts = await prisma.receipt.findMany({
      where: {
        tenantId,
        purchaseOrderId,
        status: { in: ['CONFIRMED', 'ACCOUNTED'] },
        ...(isStoreScoped(role) ? { storeId: userStoreId || '__NONE__' } : {}),
      },
      orderBy: { deliveryDate: 'desc' },
      include: {
        paymentSchedule: true,
        deliveryOrder: { include: { items: true } },
      },
    })
    const selectedReceipt = receiptId
      ? eligibleReceipts.find(receipt => receipt.id === receiptId)
      : eligibleReceipts.length === 1 ? eligibleReceipts[0] : null
    if (!selectedReceipt) {
      if (!receiptId && eligibleReceipts.length > 1) {
        throw { statusCode: 409, message: '该订单有多张收货单，请先选择本次补报对应的收货单' }
      }
      throw { statusCode: 404, message: '未找到可补报的已确认收货单' }
    }
    if (!selectedReceipt.deliveryOrder || !selectedReceipt.paymentSchedule) {
      throw { statusCode: 409, message: '该收货单履约或账期数据不完整，请先完成数据修复' }
    }
    const poItemMap = new Map(order.items.map((it: any) => [it.productId, it]))
    const submittedByProduct = new Map(items.map(item => [item.productId, item]))
    const deliveryLines = selectedReceipt.deliveryOrder.items.filter(line => submittedByProduct.has(line.productId))
    if (deliveryLines.length !== submittedByProduct.size) {
      throw { statusCode: 400, message: '补报商品不属于所选配送单' }
    }

    // 计算24小时自动批准时间
    const autoApproveAt = dayjs().add(24, 'hour').toDate()
    const ym = dayjs().format('YYYYMM')
    const claim = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`late-loss:${selectedReceipt.id}`}))::text AS locked`
      const openClaim = await tx.lossClaim.findFirst({
        where: {
          receiptId: selectedReceipt.id,
          isManual: false,
          status: { in: ['PENDING', 'REJECTED', 'NEGOTIATING'] },
        },
        select: { no: true, status: true },
      })
      if (openClaim) {
        throw { statusCode: 409, message: `收货单已有未结差异 ${openClaim.no}，请处理完成后再补报` }
      }
      const priorItems = await tx.lossClaimItem.findMany({
        where: { deliveryOrderItemId: { in: deliveryLines.map(line => line.id) } },
        select: {
          deliveryOrderItemId: true,
          lossQty: true,
          lossClaim: { select: { status: true, totalLossAmount: true, resolvedDeductAmount: true } },
        },
      })
      const reservedClaimQty = new Map<string, Prisma.Decimal>()
      for (const prior of priorItems) {
        const full = new Prisma.Decimal(prior.lossQty)
        const effective = prior.lossClaim.status === 'RESOLVED'
          ? proratedLossQuantity(full, prior.lossClaim.resolvedDeductAmount || 0, prior.lossClaim.totalLossAmount)
          : full
        reservedClaimQty.set(
          prior.deliveryOrderItemId || '',
          (reservedClaimQty.get(prior.deliveryOrderItemId || '') || new Prisma.Decimal(0)).add(effective),
        )
      }
      let totalLossAmount = new Prisma.Decimal(0)
      const itemsData = deliveryLines.flatMap(line => {
        const input = submittedByProduct.get(line.productId)!
        const expected = new Prisma.Decimal(line.shippedQty)
        const received = Prisma.Decimal.max(0, Prisma.Decimal.min(expected, new Prisma.Decimal(input.receivedQty)))
        const requested = expected.sub(received).toDecimalPlaces(2)
        if (requested.lte(0)) return []
        const alreadyClaimed = reservedClaimQty.get(line.id) || new Prisma.Decimal(0)
        const remaining = Prisma.Decimal.max(0, expected.sub(alreadyClaimed))
        if (requested.gt(remaining)) {
          const productName = line.productNameSnapshot || (poItemMap.get(line.productId) as any)?.product?.name || line.productId
          throw { statusCode: 409, message: `${productName} 本次差异 ${requested} 超过尚可补报 ${remaining}` }
        }
        const amount = requested.mul(line.unitPriceSnapshot).toDecimalPlaces(2)
        totalLossAmount = totalLossAmount.add(amount)
        const poi: any = poItemMap.get(line.productId)
        return [{
          productId: line.productId,
          deliveryOrderItemId: line.id,
          orderedQty: line.orderedQtySnapshot,
          receivedQty: received,
          lossQty: requested,
          unitPrice: line.unitPriceSnapshot,
          lossAmount: amount,
          productCodeSnapshot: line.productCodeSnapshot || poi?.product?.code || null,
          productNameSnapshot: line.productNameSnapshot || poi?.product?.name || null,
          productSpecSnapshot: line.productSpecSnapshot || poi?.product?.spec || null,
          productUnitSnapshot: line.productUnitSnapshot || poi?.product?.unit || null,
          productCategorySnapshot: line.productCategorySnapshot || poi?.product?.category || null,
        }]
      })
      if (itemsData.length === 0) {
        throw { statusCode: 400, message: '没有需要补报的到货差异' }
      }
      const held = await tx.paymentSchedule.updateMany({
        where: {
          receiptId: selectedReceipt.id,
          status: { in: ['PENDING', 'NOTIFIED', 'PENDING_APPROVAL', 'APPROVED', 'OVERDUE'] },
        },
        data: { status: 'ON_HOLD' },
      })
      if (held.count !== 1) {
        throw { statusCode: 409, message: '该收货单账期正在付款、已支付或已冻结，不能直接补报' }
      }
      const no = await nextLossClaimNo(tx, tenantId, ym)
      const created = await tx.lossClaim.create({
        data: {
          tenantId, no,
          kind,
          payableBasis: 'GROSS_PENDING_CLAIM',
          purchaseOrderId,
          deliveryOrderId: selectedReceipt.deliveryOrderId,
          receiptId: selectedReceipt.id,
          storeId: order.storeId,
          supplierId: order.supplierId,
          totalLossAmount: totalLossAmount.toDecimalPlaces(2),
          reason: lossReason,
          description,
          evidenceImages: Array.isArray(evidenceImages) ? evidenceImages.slice(0, 9) : [],
          status: 'PENDING',
          createdById: userId,
          items: { create: itemsData },
        },
        include: { items: { include: { product: true } } },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `验收后补报到货差异 ${no}，涉及 ¥${totalLossAmount.toFixed(2)}，冻结收货单 ${selectedReceipt.no} 账期`,
          target: no, entityType: 'LossClaim', targetId: created.id,
          metadata: { autoApproveAt },
        },
      })
      return created
    })
    const no = claim.no

    // 通知供应商 (M2 触达层)
    if (order.supplierId) {
      const store = await prisma.store.findUnique({ where: { id: order.storeId }, select: { name: true } })
      const itemPreview = claim.items.slice(0, 2).map((it) => `${it.product?.name || ''} 损 ${it.lossQty}`).join('/')
      notify({
        tenantId, event: 'LOSS_PENDING',
        eventKey: `LC:${claim.id}:PENDING`,
        payload: {
          lossId: claim.id, lossNo: no, orderId: purchaseOrderId,
          storeName: store?.name || '', amount: Number(claim.totalLossAmount),
          itemPreview,
        },
        toSupplierIds: [order.supplierId],
      })
    }

    return { ...claim, autoApproveAt }
  })

  // ── 店内自有报损（盘点路径）─────────────────────────
  // 不与供应商挂钩、不扣账期, 只影响 P&L
  app.post('/manual', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, storeId: userStoreId, role } = req.user
    if (!['MANAGER', 'KITCHEN_LEAD', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权创建报损' })
    }
    const parsed = manualLossSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { items, reason, description, evidenceImages } = parsed.data

    const storeId = userStoreId
    if (!storeId) return reply.status(400).send({ error: '当前账号未绑定门店' })

    const inventory = await estimatedStoreInventory(tenantId, storeId)
    if (inventory.summary.status !== 'AVAILABLE') {
      return reply.status(409).send({ error: '当前门店尚无库存盘点基准，不能计算报损成本' })
    }
    const inventoryByProduct = new Map(inventory.items.map(item => [item.id, item]))
    const products = await prisma.product.findMany({
      where: { tenantId, id: { in: items.map(item => item.productId) } },
      select: { id: true, code: true, name: true, spec: true, unit: true, category: true },
    })
    if (products.length !== items.length) return reply.status(400).send({ error: '存在不属于当前租户的食材' })
    const productById = new Map(products.map(product => [product.id, product]))
    const productNames = new Map(products.map(product => [product.id, product.name]))
    const missingCost = items.find(item => !inventoryByProduct.has(item.productId))
    if (missingCost) {
      return reply.status(409).send({ error: `食材“${productNames.get(missingCost.productId) || missingCost.productId}”未进入门店库存基准，不能计算报损成本` })
    }

    let totalLossAmount = new Prisma.Decimal(0)
    const itemsData = items.map(item => {
      const lossQty = new Prisma.Decimal(item.quantity)
      const unitPrice = new Prisma.Decimal(inventoryByProduct.get(item.productId)!.avgUnitCost).toDecimalPlaces(2)
      const lossAmount = lossQty.mul(unitPrice).toDecimalPlaces(2)
      totalLossAmount = totalLossAmount.add(lossAmount)
      return {
        productId: item.productId,
        orderedQty: lossQty,
        receivedQty: 0,
        lossQty,
        unitPrice,
        lossAmount,
        productCodeSnapshot: productById.get(item.productId)?.code || null,
        productNameSnapshot: productById.get(item.productId)?.name || null,
        productSpecSnapshot: productById.get(item.productId)?.spec || null,
        productUnitSnapshot: productById.get(item.productId)?.unit || null,
        productCategorySnapshot: productById.get(item.productId)?.category || null,
      }
    })

    // 阈值审批: ≥¥500 进 PENDING 等总厨审, ≥¥3000 通知老板. 防止店员私自录大额损耗
    const NEED_REVIEW_THRESHOLD = 500
    const needsReview = totalLossAmount.gte(NEED_REVIEW_THRESHOLD)
    const initialStatus = needsReview ? 'PENDING' : 'AUTO_APPROVED'
    const ym = dayjs().format('YYYYMM')
    const claim = await prisma.$transaction(async tx => {
      const no = await nextLossClaimNo(tx, tenantId, ym)
      const created = await tx.lossClaim.create({
        data: {
          tenantId, no,
          kind: 'INTERNAL_WASTE',
          payableBasis: 'NOT_APPLICABLE',
          storeId,
          purchaseOrderId: null,
          supplierId: null,
          reason,
          isManual: true,
          totalLossAmount: totalLossAmount.toDecimalPlaces(2),
          description: description || `${reason} · 店内盘点`,
          evidenceImages: evidenceImages || [],
          status: initialStatus as any,
          autoApproved: !needsReview,
          createdById: userId,
          items: { create: itemsData },
        },
        include: { items: { include: { product: true } } },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `店内报损 ${no} ¥${totalLossAmount.toFixed(2)} ${needsReview ? '(待总厨审)' : '(阈值内自动通过)'}`,
          target: no, entityType: 'LossClaim', targetId: created.id,
          metadata: { costBasis: 'STORE_MOVING_AVERAGE' },
        },
      })
      return created
    })
    const no = claim.no

    // 超阈值时通知总厨 (阈值 ¥500) + 老板 (阈值 ¥3000)
    if (needsReview) {
      try {
        const { sendNotification } = await import('../services/notification')
        const isHigh = totalLossAmount.gte(3000)
        const recipients = isHigh ? ['CHEF_DIRECTOR', 'ADMIN'] : ['CHEF_DIRECTOR']
        for (const r of recipients) {
          void sendNotification({
            tenantId, recipientRole: r as any,
            type: 'LOSS_CLAIM_PENDING' as any,
            title: `店内报损待审 ¥${totalLossAmount.toFixed(0)}`,
            body: `${no} 原因:${reason}, ${items.length} 项 · 待你审`,
            refType: 'LossClaim', refId: claim.id,
          })
        }
      } catch {}
    }

    return reply.status(201).send(claim)
  })

  // ── 供应商处理报损 ────────────────────────────────
  app.patch('/:id/handle', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { action, note } = req.body as any  // approve | reject

    if (!['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB', 'ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    if (!['approve', 'reject'].includes(action)) throw { statusCode: 400, message: 'action 必须是 approve 或 reject' }
    if (action === 'reject' && (!note || !note.trim())) throw { statusCode: 400, message: '拒绝时必须填写原因' }

    // P0: 加 supplier scope, 避免 supplier A 处理 supplier B 的报损; 排除店内自有盘点报损 (isManual)
    const claimWhere: any = { id, tenantId, status: 'PENDING', isManual: false }
    if (isSupplierRole(role)) claimWhere.supplierId = req.user.supplierId || '__NONE__'
    const claim = await prisma.lossClaim.findFirst({
      where: claimWhere,
      include: { purchaseOrder: { include: { receipt: true } }, items: true },
    })
    if (!claim) throw { statusCode: 400, message: '报损申请不存在或已处理' }

    if (action === 'approve') {
      // P0 修复设计: receipt.totalAmount 已经是实收金额, schedule.amount 已经按实收, 不再扣
      // 改为回补供应商库存 (我们 ship 时按订单量扣了, 短量没送的应该补回来)
      const approved = await approveLossClaimAtomically({
        claimId: claim.id,
        tenantId,
        operatorId: userId,
        reason: '供应商同意报损 ' + claim.no,
        handlerNote: note,
      })
      if (!approved.transitioned) {
        if (approved.duplicated) return { success: true, action, duplicated: true }
        throw { statusCode: 409, message: '报损已被其他操作处理，请刷新后查看' }
      }

      // 财务凭证: 报损 → 借:销售费用-报损 / 贷:库存商品
      try {
        const [store, supplier] = await Promise.all([
          prisma.store.findUnique({ where: { id: claim.storeId }, select: { name: true } }),
          claim.supplierId ? prisma.supplier.findUnique({ where: { id: claim.supplierId }, select: { name: true } }) : Promise.resolve(null),
        ])
        const { voucherForLossApproved } = await import('../services/voucher')
        voucherForLossApproved({
          tenantId, lossClaimId: claim.id, lossClaimNo: claim.no,
          storeName: store?.name || '门店',
          supplierName: supplier?.name || '供应商',
          amount: Number(claim.totalLossAmount),
          date: new Date(),
        })
      } catch (e: any) {
        console.error('[voucher] 报损凭证生成失败', e)
      }

      notify({
        tenantId, event: 'LOSS_AGREED',
        eventKey: `LOSS:${claim.id}:AGREED`,
        payload: { lossNo: claim.no, amount: Number(claim.totalLossAmount), orderId: claim.purchaseOrderId },
        toStoreIds: claim.storeId ? [claim.storeId] : undefined,
      })
    } else {
      // 入库时已净额扣除的差异：拒绝时先加回争议金额再冻结。
      // 验收后补报：账期仍是原全额且创建时已冻结，拒绝时不能再加回。
      // claim.purchaseOrder 理论可空 (manual 报损), 上面 isManual=false 已过滤
      const payableReceiptId = payableReceiptIdForClaim(claim)
      if (!payableReceiptId) {
        throw { statusCode: 500, message: '订单收据未生成, 无法回退账期' }
      }
      const rejected = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`loss-handle:${claim.id}`}))::text AS locked`
        const fresh = await tx.lossClaim.findFirst({ where: claimWhere, select: { id: true } })
        if (!fresh) return false
        const schedule = await tx.paymentSchedule.findUnique({
          where: { receiptId: payableReceiptId },
        })
        if (!schedule) throw { statusCode: 409, message: '报损关联账期不存在' }
        const grossPending = claim.payableBasis === 'GROSS_PENDING_CLAIM'
        if (grossPending) {
          if (schedule.status !== 'ON_HOLD') throw { statusCode: 409, message: '补报差异账期未冻结，不能提交异议' }
        } else {
          if (!['PENDING', 'NOTIFIED', 'PENDING_APPROVAL', 'APPROVED', 'OVERDUE', 'ON_HOLD'].includes(schedule.status)) {
            throw { statusCode: 409, message: '账期当前不可进入差异仲裁' }
          }
          await setReceiptSettlementAmountInTransaction(tx, {
            receiptId: payableReceiptId,
            amount: schedule.amount.add(claim.totalLossAmount),
            scheduleStatus: 'ON_HOLD',
          })
        }
        await tx.lossClaim.update({
          where: { id },
          data: { status: 'REJECTED', handledAt: new Date(), handledById: userId, handlerNote: note },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: grossPending
              ? `供应商对补报差异 ${claim.no} 提出异议，原应付金额不变，继续冻结待仲裁`
              : `供应商对到货差异 ${claim.no} 提出异议，账期金额加回 ¥${claim.totalLossAmount} 并冻结待仲裁`,
            target: claim.no, entityType: 'LossClaim', targetId: id,
          },
        })
        return true
      })
      if (!rejected) return { success: true, action, duplicated: true }

      // 通知总厨仲裁 (M2 触达层)
      const [store, supplier] = await Promise.all([
        prisma.store.findUnique({ where: { id: claim.storeId }, select: { name: true } }),
        claim.supplierId ? prisma.supplier.findUnique({ where: { id: claim.supplierId }, select: { name: true } }) : Promise.resolve(null),
      ])
      notify({
        tenantId, event: 'LOSS_REJECTED',
        eventKey: `LC:${claim.id}:REJECTED`,
        payload: {
          lossId: claim.id, lossNo: claim.no,
          storeName: store?.name || '', supplierName: supplier?.name || '',
          amount: Number(claim.totalLossAmount),
        },
      })
    }

    // 检查该订单所有报损是否全部结案
    if (claim.purchaseOrderId) void tryCompleteOrder(claim.purchaseOrderId, tenantId)

    void notifyLossClaimResult(tenantId, claim.no, action, Number(claim.totalLossAmount))
    return { success: true, action }
  })

  // ── 总厨审核店内报损 (isManual=true, ≥¥500 阈值进 PENDING) ──
  app.patch('/:id/manual-review', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { action, note } = (req.body || {}) as any
    if (!['CHEF_DIRECTOR', 'CHEF', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅总厨/老板可审核店内报损' })
    }
    if (!['approve', 'reject'].includes(action)) {
      return reply.status(400).send({ error: 'action 必须 approve/reject' })
    }
    if (action === 'reject' && (!note || !String(note).trim())) {
      return reply.status(400).send({ error: '拒绝时必须填写原因' })
    }
    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED'
    const reviewed = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`loss-handle:${id}`}))::text AS locked`
      const claim = await tx.lossClaim.findFirst({
        where: { id, tenantId, isManual: true, status: 'PENDING' },
      })
      if (!claim) return null
      await tx.lossClaim.update({
        where: { id },
        data: { status: newStatus as any, handledAt: new Date(), handledById: userId, handlerNote: note || null },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `[总厨审] 店内报损 ${claim.no} ¥${claim.totalLossAmount} → ${action === 'approve' ? '通过' : '驳回'}${note ? ' (' + String(note).slice(0,80) + ')' : ''}`,
          target: claim.no, entityType: 'LossClaim', targetId: id,
        },
      })
      return claim
    })
    if (!reviewed) return reply.status(409).send({ error: '报损不存在、非待审或已被其他操作处理' })
    // 通知发起人
    try {
      const { sendNotification } = await import('../services/notification')
      void sendNotification({
        tenantId, recipientRole: 'KITCHEN_LEAD' as any,
        type: 'LOSS_CLAIM_RESULT' as any,
        title: action === 'approve' ? '店内报损通过' : '店内报损被驳回',
        body: `${reviewed.no} ${action === 'approve' ? '已计入损耗' : '驳回, 请核对实物'}${note ? ' · ' + String(note).slice(0,40) : ''}`,
        refType: 'LossClaim', refId: id,
      })
    } catch {}
    return { success: true }
  })

  // ── 门店协商解决（被拒绝后）──────────────────────
  app.patch('/:id/resolve', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any

    if (!['CHEF_DIRECTOR', 'CHEF', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw { statusCode: 403, message: '仅总厨可仲裁争议报损' }
    }
    const parsed = lossClaimResolutionSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const deduct = new Prisma.Decimal(parsed.data.finalDeductAmount).toDecimalPlaces(2)
    const note = parsed.data.note || null

    const resolution = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`loss-handle:${id}`}))::text AS locked`
      const claim = await tx.lossClaim.findFirst({
        where: { id, tenantId, isManual: false },
        include: { purchaseOrder: { include: { receipt: true } }, items: true },
      })
      if (!claim) throw { statusCode: 404, message: '报损申请不存在' }
      if (claim.status === 'RESOLVED') {
        return {
          claim,
          duplicated: true,
          finalDeductAmount: Number(claim.resolvedDeductAmount || 0),
        }
      }
      if (claim.status !== 'REJECTED') throw { statusCode: 409, message: '报损申请非待仲裁状态' }
      if (deduct.gt(claim.totalLossAmount)) {
        throw { statusCode: 400, message: `最终扣减不能超过报损总额 ¥${claim.totalLossAmount.toFixed(2)}` }
      }
      const receiptId = payableReceiptIdForClaim(claim)
      if (!receiptId) throw { statusCode: 409, message: '报损未关联可调整的收货与账期记录' }
      const schedule = await tx.paymentSchedule.findUnique({ where: { receiptId } })
      if (!schedule || schedule.status !== 'ON_HOLD') {
        throw { statusCode: 409, message: '账期记录不存在或已被其他流程处理' }
      }
      const nextAmount = schedule.amount.minus(deduct)
      if (nextAmount.lt(0)) throw { statusCode: 409, message: '仲裁后应付金额异常，请联系财务核对' }

      await refundSupplierStockInTransaction(
        tx,
        claim,
        userId,
        `协商最终扣减 ¥${deduct.toFixed(2)} 按比例回补`,
        deduct,
      )
      await setReceiptSettlementAmountInTransaction(tx, {
        receiptId,
        amount: nextAmount,
        scheduleStatus: 'PENDING',
      })
      await tx.lossClaim.update({
        where: { id: claim.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedNote: note,
          resolvedDeductAmount: deduct,
          resolvedById: userId,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId,
          userId,
          action: `[仲裁] ${claim.no} 总厨判: 扣 ¥${deduct.toFixed(2)}${note ? ` (${note.slice(0, 80)})` : ''}`,
          target: claim.no,
          entityType: 'LossClaim',
          targetId: id,
          metadata: {
            originalLossAmount: claim.totalLossAmount.toFixed(2),
            finalDeductAmount: deduct.toFixed(2),
            payableBefore: schedule.amount.toFixed(2),
            payableAfter: nextAmount.toFixed(2),
          },
        },
      })
      return { claim, duplicated: false, finalDeductAmount: Number(deduct) }
    })

    const claim = resolution.claim
    try {
      const { sendNotification } = await import('../services/notification')
      const body = `总厨仲裁: ${claim.no} 最终扣 ¥${resolution.finalDeductAmount.toFixed(2)}${note ? ' · ' + note.slice(0,40) : ''}`
      for (const r of ['MANAGER', 'KITCHEN_LEAD', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF']) {
        void sendNotification({
          tenantId, recipientRole: r as any, type: 'LOSS_CLAIM_RESULT' as any,
          title: '报损争议已仲裁', body, refType: 'LossClaim', refId: id,
        })
      }
    } catch {}

    if (!resolution.duplicated && claim.purchaseOrderId) void tryCompleteOrder(claim.purchaseOrderId, tenantId)
    return { success: true, duplicated: resolution.duplicated, finalDeductAmount: resolution.finalDeductAmount }
  })
}
