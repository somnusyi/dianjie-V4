import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { Prisma, prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { ensureReceiptDerivatives } from '../services/receiptDerivatives'
import { invalidatePattern } from '../lib/cache'
import { notifyReceiptConfirmed } from '../services/notification'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'
import { parsePagination } from '../lib/pagination'
import { nextBusinessNo } from '../services/purchaseOrderIntegrity'
import {
  supplyDocumentStoreSelect,
  supplyDocumentSupplierSelect,
} from '../lib/supply-document-party-projection'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const RECEIPT_OPERATOR_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'ADMIN', 'SUPER_ADMIN'])
const RECEIPT_AMOUNT_MAX = new Prisma.Decimal('9999999999.99')
const receiptOperationalScalarSelect = {
  id: true,
  tenantId: true,
  no: true,
  storeId: true,
  supplierId: true,
  deliveryDate: true,
  totalAmount: true,
  status: true,
  note: true,
  createdById: true,
  confirmedAt: true,
  isManual: true,
  tempSupplierName: true,
  rejectReason: true,
  rejectedAt: true,
  purchaseOrderId: true,
  deliveryOrderId: true,
  invoiceId: true,
  supplierVerifiedAt: true,
  supplierVerifiedById: true,
  supplierVerifyNote: true,
  financeVerifiedAt: true,
  financeVerifiedById: true,
  financeVerifyNote: true,
  createdAt: true,
  updatedAt: true,
} as const
const receiptPaymentScheduleSelect = {
  id: true,
  status: true,
  dueAt: true,
  amount: true,
} as const

const receiptListFilterSchema = z.object({
  status: z.preprocess(
    value => value === '' ? undefined : value,
    z.enum(['DRAFT', 'PENDING', 'PENDING_CONFIRM', 'CONFIRMED', 'ACCOUNTED', 'VOID', 'REJECTED']).optional(),
  ),
  supplierId: z.string().trim().min(1).max(100).optional(),
  storeId: z.string().trim().min(1).max(100).optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
}).strict()

function canOperateReceipt(role: string | undefined) {
  return Boolean(role && RECEIPT_OPERATOR_ROLES.has(role))
}

function money(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value).toDecimalPlaces(2)
}

function lineAmount(quantity: Prisma.Decimal.Value, unitPrice: Prisma.Decimal.Value) {
  return money(new Prisma.Decimal(quantity).mul(unitPrice))
}

const receiptQuantitySchema = z.number().min(0).max(1_000_000).refine(
  value => new Prisma.Decimal(value).decimalPlaces() <= 2,
  '数量最多保留 2 位小数',
)
const receiptUnitPriceSchema = z.number().min(0).max(10_000_000).refine(
  value => new Prisma.Decimal(value).decimalPlaces() <= 2,
  '单价最多保留 2 位小数',
)

const manualReceiptSchema = z.object({
  storeId: z.string().min(1),
  supplierId: z.string().min(1),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '到货日期格式应为 YYYY-MM-DD'),
  note: z.string().max(500).optional(),
  tempSupplierName: z.string().max(100).optional(),
  tempBankAccount: z.string().max(100).optional(),
  tempBankName: z.string().max(100).optional(),
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: receiptQuantitySchema.refine(value => value > 0, '数量必须大于 0'),
    unitPrice: receiptUnitPriceSchema,
  }).strict()).min(1).max(500),
}).strict().superRefine((value, ctx) => {
  const parsed = new Date(`${value.deliveryDate}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.deliveryDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveryDate'], message: '到货日期无效' })
  }
  const ids = value.items.map(item => item.productId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一商品不能重复录入' })
  }
})

const confirmWithLossSchema = z.object({
  description: z.string().trim().min(1, '请填写报损说明').max(500),
  evidenceImages: z.array(z.string().min(1)).min(1, '请上传证据图片').max(9),
  items: z.array(z.object({
    productId: z.string().min(1),
    receivedQty: receiptQuantitySchema,
  }).strict()).min(1).max(500),
}).strict().superRefine((value, ctx) => {
  const ids = value.items.map(item => item.productId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一商品不能重复提交' })
  }
})

const receiptVerifySchema = z.object({
  actor: z.enum(['supplier', 'finance']),
  note: z.string().max(500).optional(),
}).strict()

const receiptVerifyRevokeSchema = z.object({
  actor: z.enum(['supplier', 'finance']),
}).strict()

export const receiptRoutes: FastifyPluginAsync = async (app) => {

  // ── 列表 ──────────────────────────────────────────
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, storeId } = req.user
    const parsedFilters = receiptListFilterSchema.safeParse(req.query || {})
    if (!parsedFilters.success) return reply.status(400).send({ error: parsedFilters.error.issues[0].message })
    const { status, supplierId, storeId: qStore, page = '1', pageSize = '20' } = parsedFilters.data as any
    const where: any = { tenantId }
    if (status) where.status = status
    // 供应商: 强制按自家 supplierId 过滤
    if (isSupplierRole(role)) where.supplierId = req.user.supplierId || '__NONE__'
    else if (supplierId) where.supplierId = supplierId
    if (isStoreScoped(role)) where.storeId = storeId || '__NONE__'
    else if (qStore) where.storeId = qStore

    const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 100 })
    if (!pagination) return reply.status(400).send({ error: '分页参数格式不正确' })
    const { page: p, pageSize: ps } = pagination
    const skip = (p - 1) * ps

    const [items, total] = await Promise.all([
      prisma.receipt.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip, take: ps,
        select: {
          ...receiptOperationalScalarSelect,
          store: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, name: true, unit: true } } } },
          paymentSchedule: { select: receiptPaymentScheduleSelect },
        },
      }),
      prisma.receipt.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  // ── 详情 ──────────────────────────────────────────
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, storeId } = req.user
    const detailWhere: any = { id: req.params.id, tenantId }
    if (isSupplierRole(role)) detailWhere.supplierId = req.user.supplierId || '__NONE__'
    if (isStoreScoped(role)) detailWhere.storeId = storeId || '__NONE__'
    const receipt = await prisma.receipt.findFirst({
      where: detailWhere,
      select: {
        ...receiptOperationalScalarSelect,
        store: { select: supplyDocumentStoreSelect },
        supplier: { select: supplyDocumentSupplierSelect },
        createdBy: { select: { id: true, name: true } },
        items: {
          include: {
            product: {
              select: { id: true, code: true, name: true, spec: true, category: true, unit: true },
            },
          },
        },
        paymentSchedule: { select: receiptPaymentScheduleSelect },
      },
    })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在' })
    return receipt
  })

  // ── 补录入库单（非采购单流程，手动录入）────────────
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId: userStoreId } = req.user
    if (!canOperateReceipt(role)) return reply.status(403).send({ error: '仅门店店长、厨师长或品牌管理员可补录入库单' })
    const body = manualReceiptSchema.safeParse(req.body)

    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const { storeId, supplierId, deliveryDate, note, items, tempSupplierName, tempBankAccount, tempBankName } = body.data

    if (isStoreScoped(role) && (!userStoreId || storeId !== userStoreId)) {
      return reply.status(403).send({ error: '只能为自己门店创建入库单' })
    }
    const [store, supplier, products] = await Promise.all([
      prisma.store.findFirst({ where: { id: storeId, tenantId }, select: { id: true } }),
      prisma.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { id: true } }),
      prisma.product.findMany({
        where: { tenantId, supplierId, id: { in: items.map(item => item.productId) } },
        select: { id: true, code: true, name: true, spec: true, unit: true, category: true },
      }),
    ])
    if (!store) return reply.status(400).send({ error: '门店不存在或不属于当前租户' })
    if (!supplier) return reply.status(400).send({ error: '供应商不存在或不属于当前租户' })
    if (products.length !== items.length) {
      return reply.status(400).send({ error: '存在不属于当前租户或供应商的商品' })
    }

    const productById = new Map(products.map(product => [product.id, product]))
    const normalizedItems = items.map(item => {
      const unitPrice = money(item.unitPrice)
      return { ...item, unitPrice, amount: lineAmount(item.quantity, unitPrice) }
    })
    const totalAmount = normalizedItems.reduce(
      (sum, item) => sum.add(item.amount),
      new Prisma.Decimal(0),
    ).toDecimalPlaces(2)
    if (normalizedItems.some(item => item.amount.gt(RECEIPT_AMOUNT_MAX))) {
      return reply.status(400).send({ error: '入库单单行金额超过系统上限' })
    }
    if (totalAmount.gt(RECEIPT_AMOUNT_MAX)) {
      return reply.status(400).send({ error: '入库单总金额超过系统上限' })
    }
    const ym = dayjs().format('YYYYMM')
    const receipt = await prisma.$transaction(async tx => {
      const latest = await tx.receipt.findFirst({
        where: { tenantId, no: { startsWith: `RK${ym}` } }, orderBy: { no: 'desc' }, select: { no: true },
      })
      const floor = Number(latest?.no.slice(`RK${ym}`.length) || 0)
      const no = await nextBusinessNo(tx, tenantId, 'RECEIPT', ym, 'RK', Number.isFinite(floor) ? floor : 0)
      const created = await tx.receipt.create({
        data: {
          tenantId, no, storeId, supplierId, createdById: userId,
          deliveryDate: new Date(`${deliveryDate}T00:00:00.000Z`),
          totalAmount, note,
          status: 'DRAFT',
          isManual: true,
          tempSupplierName, tempBankAccount, tempBankName,
          items: {
            create: normalizedItems.map(item => ({
              productId: item.productId,
              quantity: new Prisma.Decimal(item.quantity),
              unitPrice: item.unitPrice,
              amount: item.amount,
              productCodeSnapshot: productById.get(item.productId)?.code || null,
              productNameSnapshot: productById.get(item.productId)?.name || null,
              productSpecSnapshot: productById.get(item.productId)?.spec || null,
              productUnitSnapshot: productById.get(item.productId)?.unit || null,
              productCategorySnapshot: productById.get(item.productId)?.category || null,
            })),
          },
        },
        include: { items: true },
      })
      await tx.opLog.create({
        data: { tenantId, userId, action: `补录入库单 ${no}`, target: no, entityType: 'Receipt', targetId: created.id },
      })
      return created
    })

    void invalidatePattern(`dashboard:stats:${tenantId}:*`)
    void invalidatePattern(`stores:list:${tenantId}:*`)
    return reply.status(201).send(receipt)
  })

  // ── 供应商标记送达（自动生成入库单）────────────────
  // 由 orders 路由的 /ship 调用，这里提供给直接操作的场景
  app.patch('/:id/mark-delivered', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅对应供应商或品牌管理员可标记送达' })
    }
    const where: any = { id: req.params.id, tenantId, status: 'DRAFT' }
    if (isSupplierRole(role)) where.supplierId = supplierId || '__NONE__'
    const receipt = await prisma.receipt.findFirst({ where })
    if (!receipt) return reply.status(400).send({ error: '入库单不存在或状态不对' })
    const claimed = await prisma.receipt.updateMany({ where, data: { status: 'PENDING_CONFIRM' } })
    if (claimed.count !== 1) return reply.status(409).send({ error: '入库单已被处理，请刷新后查看' })
    return { success: true }
  })

  // ── 店长确认入库（完全正常）─────────────────────────
  app.patch('/:id/confirm', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    if (!canOperateReceipt(role)) return reply.status(403).send({ error: '仅门店店长、厨师长或品牌管理员可确认入库' })
    const scopeWhere: any = { id: req.params.id, tenantId }
    if (isStoreScoped(role)) scopeWhere.storeId = storeId || '__NONE__'
    const pendingWhere = { ...scopeWhere, status: { in: ['DRAFT', 'PENDING', 'PENDING_CONFIRM'] as const } }
    let receipt = await prisma.receipt.findFirst({
      where: pendingWhere,
      include: { supplier: true },
    })
    let duplicated = false
    let confirmedAt = new Date()
    if (receipt) {
      const claimed = await prisma.receipt.updateMany({
        where: pendingWhere,
        data: { status: 'CONFIRMED', confirmedAt },
      })
      if (claimed.count !== 1) return reply.status(409).send({ error: '入库单已被处理，请刷新后查看' })
    } else {
      // 主状态可能已提交，但凭证/账期/对账派生曾短暂失败。允许客户端重试补偿。
      receipt = await prisma.receipt.findFirst({
        where: { ...scopeWhere, status: { in: ['CONFIRMED', 'ACCOUNTED'] } },
        include: { supplier: true },
      })
      if (!receipt?.confirmedAt) return reply.status(404).send({ error: '入库单不存在或状态不可确认' })
      confirmedAt = receipt.confirmedAt
      duplicated = true
    }

    // 按全额确保凭证与账期派生；总仓 HEADQ_WAREHOUSE 在账期分支短路。
    const derivativeResult = await ensureReceiptDerivatives(receipt.id)
    if (!derivativeResult.voucher.ok) {
      req.log.error({ receiptId: receipt.id, error: derivativeResult.voucher.error }, '入库凭证生成失败，等待每日补偿')
    }
    if (!derivativeResult.finance.ok) throw new Error(derivativeResult.finance.error)
    const isHeadq = receipt.supplier.sourceType === 'HEADQ_WAREHOUSE'

    if (!duplicated) {
      await prisma.opLog.create({
        data: {
          tenantId, userId,
          action: isHeadq
            ? `确认入库 ${receipt.no} (总仓内部调拨, 不建账期)`
            : `确认入库 ${receipt.no}, 账期已创建`,
          target: receipt.no, entityType: 'Receipt', targetId: receipt.id,
        },
      })
    }
    void invalidatePattern(`dashboard:stats:${tenantId}:*`)
    void invalidatePattern(`stores:list:${tenantId}:*`)
    if (!duplicated) {
      const store = await prisma.store.findUnique({ where: { id: receipt.storeId }, select: { name: true } })
      void notifyReceiptConfirmed(tenantId, receipt.no, store?.name || '', false, 0)
    }
    return {
      message: isHeadq ? '总仓入库确认 (内部调拨, 不建账期)' : '入库确认成功，账期已自动创建',
      duplicated,
    }
  })

  // ── 店长报损入库（部分收货，按实收金额生成账期）──────
  app.patch('/:id/confirm-with-loss', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    if (!canOperateReceipt(role)) return reply.status(403).send({ error: '仅门店店长、厨师长或品牌管理员可报损入库' })
    const body = confirmWithLossSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })

    const where: any = { id: req.params.id, tenantId, status: { in: ['PENDING', 'PENDING_CONFIRM'] } }
    if (isStoreScoped(role)) where.storeId = storeId || '__NONE__'
    const receipt = await prisma.receipt.findFirst({
      where,
      include: {
        supplier: true,
        deliveryOrder: { select: { id: true, items: { select: { id: true, productId: true } } } },
        items: { include: { product: true } },
      },
    })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在' })

    const { description, evidenceImages, items: receivedItems } = body.data
    const submittedByProduct = new Map(receivedItems.map(item => [item.productId, item.receivedQty]))
    const receiptProductIds = new Set(receipt.items.map(item => item.productId))
    if (submittedByProduct.size !== receipt.items.length || [...submittedByProduct.keys()].some(id => !receiptProductIds.has(id))) {
      return reply.status(400).send({ error: '必须且只能提交入库单中的全部商品明细' })
    }

    const calculatedItems = receipt.items.map(original => {
      const receivedQty = new Prisma.Decimal(submittedByProduct.get(original.productId)!)
      const orderedQty = new Prisma.Decimal(original.quantity)
      if (receivedQty.gt(orderedQty)) {
        throw { statusCode: 400, message: `${original.product.name} 实收数量不能大于应收数量 ${orderedQty.toString()}` }
      }
      const lossQty = orderedQty.sub(receivedQty)
      return {
        original,
        receivedQty,
        lossQty,
        actualAmount: lineAmount(receivedQty, original.unitPrice),
        lossAmount: lineAmount(lossQty, original.unitPrice),
      }
    })
    const deliveryItemByProduct = new Map(
      (receipt.deliveryOrder?.items || []).map(item => [item.productId, item.id]),
    )
    const actualAmount = calculatedItems.reduce((sum, item) => sum.add(item.actualAmount), new Prisma.Decimal(0)).toDecimalPlaces(2)
    const lossItemsData = calculatedItems.filter(item => item.lossQty.gt(0)).map(item => ({
      productId: item.original.productId,
      deliveryOrderItemId: deliveryItemByProduct.get(item.original.productId) || null,
      orderedQty: item.original.quantity,
      receivedQty: item.receivedQty,
      lossQty: item.lossQty,
      unitPrice: item.original.unitPrice,
      lossAmount: item.lossAmount,
      productCodeSnapshot: item.original.productCodeSnapshot || item.original.product.code,
      productNameSnapshot: item.original.productNameSnapshot || item.original.product.name,
      productSpecSnapshot: item.original.productSpecSnapshot || item.original.product.spec,
      productUnitSnapshot: item.original.productUnitSnapshot || item.original.product.unit,
      productCategorySnapshot: item.original.productCategorySnapshot || item.original.product.category,
    }))
    const totalLossAmount = lossItemsData.reduce((sum, item) => sum.add(item.lossAmount), new Prisma.Decimal(0)).toDecimalPlaces(2)
    const confirmedAt = new Date()
    const ym = dayjs(confirmedAt).format('YYYYMM')

    await prisma.$transaction(async tx => {
      const claimed = await tx.receipt.updateMany({
        where,
        data: { status: 'CONFIRMED', confirmedAt, totalAmount: actualAmount },
      })
      if (claimed.count !== 1) throw { statusCode: 409, message: '入库单已被处理，请刷新后查看' }

      for (const item of calculatedItems) {
        await tx.receiptItem.update({
          where: { id: item.original.id },
          data: { quantity: item.receivedQty, amount: item.actualAmount },
        })
      }

      if (lossItemsData.length > 0) {
        const latest = await tx.lossClaim.findFirst({
          where: { tenantId, no: { startsWith: `LC${ym}` } }, orderBy: { no: 'desc' }, select: { no: true },
        })
        const floor = Number(latest?.no.slice(`LC${ym}`.length) || 0)
        const lcNo = await nextBusinessNo(tx, tenantId, 'LOSS_CLAIM', ym, 'LC', Number.isFinite(floor) ? floor : 0)
        await tx.lossClaim.create({
          data: {
            tenantId, no: lcNo,
            kind: 'ARRIVAL_SHORTAGE',
            payableBasis: 'NET_AT_RECEIPT',
            purchaseOrderId: receipt.purchaseOrderId,
            deliveryOrderId: receipt.deliveryOrderId,
            receiptId: receipt.id,
            storeId: receipt.storeId,
            supplierId: receipt.supplierId,
            totalLossAmount,
            description,
            evidenceImages,
            status: 'APPROVED',
            createdById: userId,
            items: { create: lossItemsData },
          },
        })
      }

      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `报损入库 ${receipt.no}，实收 ¥${actualAmount.toFixed(2)}，损耗 ¥${totalLossAmount.toFixed(2)}`,
          target: receipt.no, entityType: 'Receipt', targetId: receipt.id,
        },
      })

      if (receipt.purchaseOrderId) {
        const pendingClaims = await tx.lossClaim.count({
          where: { purchaseOrderId: receipt.purchaseOrderId, tenantId, status: { in: ['PENDING', 'NEGOTIATING'] } },
        })
        if (pendingClaims === 0) {
          await tx.purchaseOrder.updateMany({
            where: { id: receipt.purchaseOrderId, tenantId, status: 'RECEIVED' },
            data: { status: 'COMPLETED' },
          })
        }
      }
    })

    const derivativeResult = await ensureReceiptDerivatives(receipt.id)
    if (!derivativeResult.voucher.ok) {
      req.log.error({ receiptId: receipt.id, error: derivativeResult.voucher.error }, '报损入库凭证生成失败，等待每日补偿')
    }
    if (!derivativeResult.finance.ok) throw new Error(derivativeResult.finance.error)

    const store = await prisma.store.findUnique({ where: { id: receipt.storeId }, select: { name: true } })
    void notifyReceiptConfirmed(tenantId, receipt.no, store?.name || '', totalLossAmount.gt(0), totalLossAmount.toNumber())
    return {
      message: `报损入库成功，账期按实收金额 ¥${actualAmount.toFixed(2)} 生成`,
      actualAmount: actualAmount.toNumber(),
      totalLossAmount: totalLossAmount.toNumber(),
    }
  })

  // ── 拒收 ──────────────────────────────────────────
  app.patch('/:id/reject', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    if (!canOperateReceipt(role)) return reply.status(403).send({ error: '仅门店店长、厨师长或品牌管理员可拒收入库单' })
    const parsed = z.object({ reason: z.string().trim().min(1, '请填写拒收原因').max(500) }).strict().safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { reason } = parsed.data

    const where: any = { id: req.params.id, tenantId, status: { in: ['PENDING', 'PENDING_CONFIRM'] } }
    if (isStoreScoped(role)) where.storeId = storeId || '__NONE__'
    const receipt = await prisma.receipt.findFirst({
      where,
    })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在或不可拒收' })

    await prisma.$transaction(async tx => {
      const claimed = await tx.receipt.updateMany({
        where,
        data: { status: 'REJECTED', rejectReason: reason, rejectedAt: new Date() },
      })
      if (claimed.count !== 1) throw { statusCode: 409, message: '入库单已被处理，请刷新后查看' }
      await tx.opLog.create({
        data: { tenantId, userId, action: `拒收入库单 ${receipt.no}：${reason}`, target: receipt.no, entityType: 'Receipt', targetId: receipt.id },
      })
    })

    return { message: '已拒收，请联系供应商协商处理' }
  })

  // ── 作废（草稿/补录单）───────────────────────────
  app.patch('/:id/void', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    if (!canOperateReceipt(role)) return reply.status(403).send({ error: '仅门店店长、厨师长或品牌管理员可作废入库单' })
    const where: any = { id: req.params.id, tenantId }
    if (isStoreScoped(role)) where.storeId = storeId || '__NONE__'
    const receipt = await prisma.receipt.findFirst({ where })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在' })
    if (['ACCOUNTED', 'VOID', 'CONFIRMED'].includes(receipt.status)) {
      return reply.status(400).send({ error: '当前状态不可作废' })
    }

    const voidableWhere = { ...where, status: { notIn: ['ACCOUNTED', 'VOID', 'CONFIRMED'] as const } }
    await prisma.$transaction(async tx => {
      const claimed = await tx.receipt.updateMany({ where: voidableWhere, data: { status: 'VOID' } })
      if (claimed.count !== 1) throw { statusCode: 409, message: '入库单已被处理，请刷新后查看' }
      await tx.paymentSchedule.updateMany({
        where: { receiptId: receipt.id, status: { in: ['PENDING', 'NOTIFIED'] } },
        data: { status: 'CANCELLED' },
      })
      await tx.opLog.create({ data: { tenantId, userId, action: `作废入库单 ${receipt.no}`, target: receipt.no, entityType: 'Receipt', targetId: receipt.id } })
    })
    return { message: '已作废' }
  })

  // ── P1-1: 三方核对 (供应商 / 财务) ─────────────────
  // PATCH /api/receipts/:id/verify  body: { actor: 'supplier' | 'finance', note? }
  // 门店店长 = createdBy (隐含, 入库时已发生)
  // 厨师长 = status=RECEIVED + confirmedAt (现有流程)
  // 供应商 = supplierVerifiedAt (新加)
  // 财务 = financeVerifiedAt (新加, 三方齐了才可标)
  app.patch('/:id/verify', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, supplierId } = req.user
    const parsed = receiptVerifySchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { actor, note } = parsed.data

    if (actor === 'supplier' && !['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'FINANCE', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '供应商核对仅供应商或财务可执行' })
    }
    if (actor === 'finance' && !['FINANCE', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '财务核对仅财务/老板可执行' })
    }

    return prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "receipts"
        WHERE "id" = ${req.params.id} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `)
      if (locked.length !== 1) {
        throw Object.assign(new Error('入库单不存在'), { statusCode: 404 })
      }

      const receiptWhere: any = { id: req.params.id, tenantId }
      if (actor === 'supplier' && isSupplierRole(role)) receiptWhere.supplierId = supplierId || '__NONE__'
      const receipt = await tx.receipt.findFirst({
        where: receiptWhere,
        include: { supplier: { select: { name: true, sourceType: true } } },
      })
      if (!receipt) throw Object.assign(new Error('入库单不存在'), { statusCode: 404 })

      // 财务核对要求: 门店已建 + 厨师长已 confirm + 供应商已核对。
      // 所有核对/撤销先锁定同一入库单，避免财务核对越过并发供应商撤销。
      if (actor === 'finance') {
        if (!receipt.confirmedAt) {
          throw Object.assign(new Error('厨师长尚未确认, 无法财务核对'), { statusCode: 400 })
        }
        const srcType = receipt.supplier.sourceType
        const autoSupplier = srcType === 'B2B_PLATFORM' || srcType === 'HEADQ_WAREHOUSE'
        if (!receipt.supplierVerifiedAt && !autoSupplier) {
          throw Object.assign(new Error('供应商尚未核对, 无法财务核对'), { statusCode: 400 })
        }
      }

      const now = new Date()
      const updateData: any = {}
      if (actor === 'supplier') {
        updateData.supplierVerifiedAt = now
        updateData.supplierVerifiedById = userId
        if (note != null) updateData.supplierVerifyNote = note
      } else {
        updateData.financeVerifiedAt = now
        updateData.financeVerifiedById = userId
        if (note != null) updateData.financeVerifyNote = note
      }
      await tx.receipt.update({ where: { id: receipt.id }, data: updateData })
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `${actor === 'supplier' ? '供应商' : '财务'}核对入库单 ${receipt.no} (${receipt.supplier.name})`,
          target: receipt.no, entityType: 'Receipt', targetId: receipt.id,
        },
      })
      return { ok: true, actor, at: now }
    })
  })

  // 撤销核对 (改错了可以撤)
  app.patch('/:id/verify/revoke', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['FINANCE', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '撤销核对仅财务/老板可执行' })
    }
    const parsed = receiptVerifyRevokeSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { actor } = parsed.data
    return prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "receipts"
        WHERE "id" = ${req.params.id} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `)
      if (locked.length !== 1) {
        throw Object.assign(new Error('入库单不存在'), { statusCode: 404 })
      }
      const receipt = await tx.receipt.findFirst({ where: { id: req.params.id, tenantId } })
      if (!receipt) throw Object.assign(new Error('入库单不存在'), { statusCode: 404 })

      const updateData: any = {}
      if (actor === 'supplier') {
        updateData.supplierVerifiedAt = null; updateData.supplierVerifiedById = null; updateData.supplierVerifyNote = null
        // 撤销供应商核对自动级联撤销财务核对
        updateData.financeVerifiedAt = null; updateData.financeVerifiedById = null; updateData.financeVerifyNote = null
      } else {
        updateData.financeVerifiedAt = null; updateData.financeVerifiedById = null; updateData.financeVerifyNote = null
      }
      await tx.receipt.update({ where: { id: receipt.id }, data: updateData })
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `${actor === 'supplier' ? '供应商' : '财务'}撤销核对入库单 ${receipt.no}`,
          target: receipt.no, entityType: 'Receipt', targetId: receipt.id,
        },
      })
      return { ok: true }
    })
  })
}
