import { Prisma, prisma } from '@dianjie/db'
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  assertDifferentReceiptReviewer,
  assertUpstreamPurchaseOrderTransition,
  requiresUpstreamReceiptReview,
  UpstreamReceiptReviewerConflictError,
  upstreamReceiptReviewReasons,
  UpstreamPurchaseOrderStatus,
} from '../domain/upstreamProcurement'
import { requireSupplierCapability } from '../lib/supplier-access'
import { upstreamFeatureEnabled, upstreamFeatureSnapshot } from '../lib/upstream-feature-flags'
import { businessDateRangeInclusive } from '../lib/businessTime'
import { nextUpstreamDocumentNo } from '../services/upstreamDocumentNo'
import {
  postUpstreamClaimLossInTransaction,
  postUpstreamReceiptInTransaction,
  reverseUpstreamReceiptInTransaction,
} from '../services/warehouseLedger'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const INTERNAL_ROLES = new Set(['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'])
const APPROVER_ROLES = new Set(['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'])
const FINANCE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN'])
const SETTLEMENT_READ_ROLES = new Set([...INTERNAL_ROLES, ...FINANCE_ROLES])
const idSchema = z.string().trim().min(1).max(64)
const decimalInput = z.coerce.number().finite().positive()
const nonNegativeDecimalInput = z.coerce.number().finite().min(0)
const isoDateInput = z.coerce.date()

const contractCreateSchema = z.object({
  supplierId: idSchema,
  contractNo: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(160),
  startsAt: isoDateInput,
  endsAt: isoDateInput.optional(),
  settlementCycle: z.enum(['FIXED_DAYS', 'MONTHLY', 'WEEKLY', 'ON_DELIVERY']).default('MONTHLY'),
  settlementDays: z.number().int().min(0).max(365).default(0),
  taxInclusive: z.boolean().default(true),
  defaultTaxRate: z.coerce.number().finite().min(0).max(1).optional(),
  currency: z.string().trim().length(3).default('CNY'),
  paymentMethod: z.string().trim().max(80).optional(),
  discrepancyRule: z.record(z.unknown()).optional(),
  attachments: z.array(z.record(z.unknown())).max(20).optional(),
  lines: z.array(z.object({
    upstreamSourceId: idSchema,
    unitPrice: decimalInput,
    taxRate: z.coerce.number().finite().min(0).max(1).optional(),
    packageMultiple: decimalInput.default(1),
    shortTolerancePct: z.coerce.number().finite().min(0).max(1).default(0),
    overTolerancePct: z.coerce.number().finite().min(0).max(1).default(0),
    startsAt: isoDateInput.optional(),
    endsAt: isoDateInput.optional(),
  })).min(1).max(500),
}).strict().superRefine((data, ctx) => {
  if (data.endsAt && data.endsAt < data.startsAt) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: '合同结束日期不能早于开始日期' })
  }
  const ids = data.lines.map(line => line.upstreamSourceId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: '合同商品不能重复' })
  }
})

const purchaseOrderCreateSchema = z.object({
  supplierId: idSchema,
  warehouseId: idSchema,
  contractId: idSchema,
  expectedArrivalAt: isoDateInput.optional(),
  origin: z.enum(['MANUAL', 'REPLENISHMENT', 'EMERGENCY', 'HISTORICAL_BACKFILL']).default('MANUAL'),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(160),
  lines: z.array(z.object({
    contractLineId: idSchema,
    quantity: decimalInput,
    temporaryUnitPrice: decimalInput.optional(),
  })).min(1).max(500),
}).strict().superRefine((data, ctx) => {
  const ids = data.lines.map(line => line.contractLineId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: '采购商品不能重复' })
  }
})

const revisionCreateSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  expectedArrivalAt: isoDateInput.optional(),
  lines: z.array(z.object({
    lineId: idSchema,
    quantity: decimalInput,
  })).min(1).max(500),
}).strict()

const revisionReviewSchema = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  note: z.string().trim().max(500).optional(),
}).strict()

const shipmentCreateSchema = z.object({
  supplierShipmentNo: z.string().trim().max(100).optional(),
  carrierName: z.string().trim().max(100).optional(),
  trackingNo: z.string().trim().max(100).optional(),
  driverName: z.string().trim().max(80).optional(),
  driverPhone: z.string().trim().max(40).optional(),
  vehicleNo: z.string().trim().max(40).optional(),
  expectedArrivalAt: isoDateInput.optional(),
  attachments: z.array(z.record(z.unknown())).max(20).optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(160),
  lines: z.array(z.object({
    purchaseOrderLineId: idSchema,
    shippedQty: decimalInput,
    batchNo: z.string().trim().max(80).optional(),
    manufactureDate: isoDateInput.optional(),
    expiryDate: isoDateInput.optional(),
    packageInfo: z.string().trim().max(240).optional(),
  }).superRefine((line, ctx) => {
    if (line.manufactureDate && line.expiryDate && line.expiryDate < line.manufactureDate) {
      ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: '到期日不能早于生产日期' })
    }
  })).min(1).max(500),
}).strict().superRefine((data, ctx) => {
  const ids = data.lines.map(line => line.purchaseOrderLineId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: '发货商品不能重复' })
  }
})

const receiptCreateSchema = z.object({
  arrivedAt: isoDateInput.optional(),
  finalForShipment: z.boolean().default(true),
  evidence: z.array(z.record(z.unknown())).max(20).optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(160),
  lines: z.array(z.object({
    shipmentLineId: idSchema,
    arrivedQty: nonNegativeDecimalInput,
    acceptedQty: nonNegativeDecimalInput,
    damagedQty: nonNegativeDecimalInput.default(0),
    rejectedQty: nonNegativeDecimalInput.default(0),
    batchNo: z.string().trim().max(80).optional(),
    manufactureDate: isoDateInput.optional(),
    expiryDate: isoDateInput.optional(),
    evidence: z.array(z.record(z.unknown())).max(20).optional(),
    note: z.string().trim().max(500).optional(),
  }).superRefine((line, ctx) => {
    if (line.acceptedQty + line.damagedQty + line.rejectedQty > line.arrivedQty + 0.000001) {
      ctx.addIssue({ code: 'custom', path: ['acceptedQty'], message: '合格、破损和拒收数量之和不能超过实到数量' })
    }
    if (line.manufactureDate && line.expiryDate && line.expiryDate < line.manufactureDate) {
      ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: '到期日不能早于生产日期' })
    }
  })).min(1).max(500),
}).strict().superRefine((data, ctx) => {
  const ids = data.lines.map(line => line.shipmentLineId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: '验收商品不能重复' })
  }
})

const postReceiptClaimSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160),
  description: z.string().trim().min(2).max(1000),
  evidence: z.array(z.record(z.unknown())).min(1).max(20),
  lines: z.array(z.object({
    receiptLineId: idSchema,
    affectedQty: decimalInput,
  })).min(1).max(100),
}).strict()

const receiptReversalSchema = z.object({
  reason: z.string().trim().min(2).max(240),
  idempotencyKey: z.string().trim().min(8).max(160),
}).strict()

const supplierClaimResponseSchema = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  response: z.string().trim().min(1).max(1000),
}).strict()

const claimResolutionSchema = z.object({
  responsibility: z.enum(['SUPPLIER', 'BUYER', 'SHARED']),
  resolution: z.enum(['DEDUCTION', 'REPLACEMENT', 'RETURN', 'SHARED_LOSS', 'BUYER_ABSORB', 'NO_ACTION']),
  resolvedAmount: nonNegativeDecimalInput,
  note: z.string().trim().max(1000).optional(),
}).strict()

const settlementGenerateSchema = z.object({
  supplierId: idSchema,
  periodStart: isoDateInput,
  periodEnd: isoDateInput,
  note: z.string().trim().max(500).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.periodEnd < data.periodStart) {
    ctx.addIssue({ code: 'custom', path: ['periodEnd'], message: '结算结束日期不能早于开始日期' })
  }
})

const settlementDisputeSchema = z.object({
  reason: z.string().trim().min(2).max(1000),
}).strict()

const settlementInvoiceAllocationSchema = z.object({
  invoiceId: idSchema,
  amount: decimalInput,
}).strict()

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value)
}

function money(value: Prisma.Decimal) {
  return value.toDecimalPlaces(4)
}

function ensureInternal(role: string, reply: any) {
  if (INTERNAL_ROLES.has(role)) return true
  reply.status(403).send({ error: '仅供应链内部人员可操作' })
  return false
}

function supplierScope(req: any, capability: 'upstream.order.read' | 'upstream.order.accept') {
  return requireSupplierCapability(req.user.role, req.user.supplierId, capability)
}

async function scopedPurchaseOrder(req: any, id: string) {
  const { tenantId, role } = req.user
  const supplierId = INTERNAL_ROLES.has(role) ? undefined : supplierScope(req, 'upstream.order.read')
  return prisma.upstreamPurchaseOrder.findFirst({
    where: { id, tenantId, ...(supplierId ? { supplierId } : {}) },
    include: {
      supplier: { select: { id: true, name: true, no: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      lines: { orderBy: { lineNo: 'asc' } },
      revisions: { orderBy: { revisionNo: 'desc' } },
      shipments: { orderBy: { createdAt: 'desc' } },
    },
  })
}

export const upstreamProcurementRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    if (!upstreamFeatureEnabled('UPSTREAM_PROCUREMENT_ENABLED')) {
      return reply.status(503).send({ error: '上游采购模块尚未启用' })
    }
  })

  app.get('/feature-status', auth(app), async () => upstreamFeatureSnapshot())

  app.get('/setup-options', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可查看采购配置' })
    const supplierId = typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined
    const [suppliers, warehouses, sources] = await Promise.all([
      prisma.supplier.findMany({
        where: { tenantId, status: 'ENABLED', businessScopes: { has: 'WAREHOUSE_UPSTREAM' } },
        select: {
          id: true,
          no: true,
          name: true,
          creditType: true,
          creditDays: true,
          upstreamReceiptReviewThreshold: true,
          postReceiptClaimHours: true,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.warehouse.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { createdAt: 'asc' },
      }),
      supplierId
        ? prisma.productUpstreamSource.findMany({
            where: { tenantId, supplierId, isActive: true },
            select: {
              id: true,
              supplierId: true,
              supplierSku: true,
              purchaseUnit: true,
              inventoryUnitsPerPurchaseUnit: true,
              quotedUnitPrice: true,
              minOrderQty: true,
              leadTimeDays: true,
              product: { select: { id: true, code: true, name: true, spec: true, inventoryUnit: true, unit: true } },
            },
            orderBy: { product: { name: 'asc' } },
          })
        : Promise.resolve([]),
    ])
    return { suppliers, warehouses, sources }
  })

  app.get('/workbench', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user

    if (INTERNAL_ROLES.has(role)) {
      const [orders, shipments, receipts, claims, statements] = await Promise.all([
        prisma.upstreamPurchaseOrder.count({
          where: { tenantId, status: { in: ['PENDING_APPROVAL', 'CHANGE_PROPOSED'] } },
        }),
        prisma.upstreamShipment.count({
          where: { tenantId, status: { in: ['SHIPPED', 'PARTIALLY_RECEIVED'] } },
        }),
        prisma.upstreamReceipt.count({
          where: { tenantId, status: { in: ['DRAFT', 'INSPECTING', 'PENDING_REVIEW'] } },
        }),
        prisma.upstreamArrivalClaim.count({
          where: {
            tenantId,
            status: { in: ['SUPPLIER_ACCEPTED', 'SUPPLIER_REJECTED', 'ARBITRATION', 'AUTO_ACCEPTED'] },
          },
        }),
        prisma.upstreamSettlementStatement.count({
          where: { tenantId, status: 'DISPUTED' },
        }),
      ])
      return {
        audience: 'INTERNAL',
        total: orders + shipments + receipts + claims + statements,
        counts: { orders, shipments, receipts, claims, statements },
      }
    }

    if (role === 'FINANCE') {
      const statements = await prisma.upstreamSettlementStatement.count({
        where: { tenantId, status: 'CONFIRMED' },
      })
      return {
        audience: 'FINANCE',
        total: statements,
        counts: { orders: 0, shipments: 0, receipts: 0, claims: 0, statements },
      }
    }

    let supplierId: string
    try {
      supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.order.read')
    } catch (error: any) {
      return reply.status(error?.statusCode || 403).send({ error: error?.message || '无权限' })
    }
    const [orders, shipments, claims, statements] = await Promise.all([
      prisma.upstreamPurchaseOrder.count({
        where: {
          tenantId,
          supplierId,
          status: { in: ['SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED'] },
        },
      }),
      prisma.upstreamShipment.count({
        where: { tenantId, supplierId, status: 'DRAFT' },
      }),
      prisma.upstreamArrivalClaim.count({
        where: { tenantId, supplierId, status: 'PENDING_SUPPLIER' },
      }),
      prisma.upstreamSettlementStatement.count({
        where: { tenantId, supplierId, status: 'SENT_TO_SUPPLIER' },
      }),
    ])
    return {
      audience: 'SUPPLIER',
      total: orders + shipments + claims + statements,
      counts: { orders, shipments, receipts: 0, claims, statements },
    }
  })

  async function postReceipt(req: any, reply: any, review: boolean) {
    if (!upstreamFeatureEnabled('UPSTREAM_RECEIPT_POSTING_ENABLED')) {
      return reply.status(503).send({ error: '上游收货入账当前处于灰度关闭状态' })
    }
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可确认收货' })
    const receiptId = idSchema.safeParse(req.params.id)
    if (!receiptId.success) return reply.status(400).send({ error: '收货单标识格式不正确' })

    try {
      const result = await prisma.$transaction(async tx => {
        const preliminary = await tx.upstreamReceipt.findFirst({
          where: { id: receiptId.data, tenantId },
          select: { purchaseOrderId: true },
        })
        if (!preliminary) return null
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-po:${preliminary.purchaseOrderId}`}))::text AS locked`
        const receipt = await tx.upstreamReceipt.findFirst({
          where: {
            id: receiptId.data,
            tenantId,
            status: review ? 'PENDING_REVIEW' : 'INSPECTING',
          },
          include: {
            supplier: true,
            purchaseOrder: { include: { lines: true } },
            shipment: { include: { lines: true } },
            lines: {
              include: {
                product: { select: { category: true } },
                purchaseOrderLine: true,
                shipmentLine: true,
              },
            },
          },
        })
        if (!receipt) return null
        if (review) assertDifferentReceiptReviewer(receipt.inspectorId || '', userId)

        const sensitiveCategories = new Set(receipt.supplier.upstreamSensitiveCategories)
        const reviewInput = {
          payableAmount: Number(receipt.payableAmount),
          reviewAmountThreshold: Number(receipt.supplier.upstreamReceiptReviewThreshold),
          hasOverReceipt: receipt.lines.some(line => line.overageQty.gt(0)),
          hasTemporaryPrice: receipt.purchaseOrder.hasTemporaryPrice,
          hasSensitiveCategory: receipt.lines.some(line => sensitiveCategories.has(line.product.category)),
        }
        const reviewReasons = upstreamReceiptReviewReasons(reviewInput)
        if (!review && requiresUpstreamReceiptReview(reviewInput)) {
          const pending = await tx.upstreamReceipt.update({
            where: { id: receipt.id },
            data: {
              status: 'PENDING_REVIEW',
              inspectorId: userId,
              reviewReasons,
              rowVersion: { increment: 1 },
            },
            include: { lines: true },
          })
          await tx.opLog.create({
            data: {
              tenantId,
              userId,
              role,
              action: '上游收货提交复核',
              entityType: 'UpstreamReceipt',
              target: receipt.no,
              targetId: receipt.id,
              metadata: { reviewReasons },
            },
          })
          return { pendingReview: true, receipt: pending }
        }

        const orderLineById = new Map(receipt.purchaseOrder.lines.map(line => [line.id, line]))
        for (const line of receipt.lines) {
          const orderLine = orderLineById.get(line.purchaseOrderLineId)!
          const target = orderLine.confirmedQty || orderLine.orderedQty
          const maximum = target.times(decimal(1).plus(orderLine.overTolerancePct))
          if (orderLine.receivedQty.plus(line.acceptedQty).greaterThan(maximum)) {
            throw Object.assign(
              new Error(`${orderLine.productNameSnapshot} 累计合格收货超过合同允许上限 ${maximum.toString()} ${orderLine.purchaseUnit}`),
              { statusCode: 409 },
            )
          }
        }

        const ledgerLines = receipt.lines.filter(line => line.acceptedQty.gt(0)).map(line => ({
          receiptLineId: line.id,
          productId: line.productId,
          productName: line.purchaseOrderLine.productNameSnapshot,
          purchaseQuantity: line.acceptedQty,
          purchaseUnit: line.purchaseUnit,
          conversionFactor: line.inventoryUnitsPerPurchaseUnit,
          inventoryQuantity: line.inventoryAcceptedQty,
          inventoryUnit: line.inventoryUnit,
          totalAmount: line.payableAmount,
          batchNo: line.batchNo,
          manufactureDate: line.manufactureDate,
          expiryDate: line.expiryDate,
        }))
        if (ledgerLines.length > 0) {
          await postUpstreamReceiptInTransaction(tx, {
            tenantId,
            warehouseId: receipt.warehouseId,
            supplierId: receipt.supplierId,
            supplierName: receipt.supplier.name,
            receiptId: receipt.id,
            receiptNo: receipt.no,
            userId,
            effectiveAt: receipt.arrivedAt || new Date(),
            lines: ledgerLines,
          })
        }

        for (const line of receipt.lines) {
          await tx.upstreamPurchaseOrderLine.update({
            where: { id: line.purchaseOrderLineId },
            data: { receivedQty: { increment: line.acceptedQty } },
          })
          const orderLine = orderLineById.get(line.purchaseOrderLineId)!
          orderLine.receivedQty = orderLine.receivedQty.plus(line.acceptedQty)
        }

        const claimCandidates = receipt.lines.flatMap(line => {
          const candidates: Array<{ type: 'SHORTAGE' | 'DAMAGE' | 'QUALITY' | 'OVERAGE'; qty: Prisma.Decimal }> = []
          if (line.shortageQty.gt(0)) candidates.push({ type: 'SHORTAGE', qty: line.shortageQty })
          if (line.damagedQty.gt(0)) candidates.push({ type: 'DAMAGE', qty: line.damagedQty })
          if (line.rejectedQty.gt(0)) candidates.push({ type: 'QUALITY', qty: line.rejectedQty })
          if (line.overageQty.gt(0)) candidates.push({ type: 'OVERAGE', qty: line.overageQty })
          return candidates.map(candidate => ({ line, ...candidate }))
        })
        const claimIds: string[] = []
        for (const candidate of claimCandidates) {
          const no = await nextUpstreamDocumentNo(tx, tenantId, 'claim')
          const amount = money(candidate.qty.times(candidate.line.unitPrice))
          const claim = await tx.upstreamArrivalClaim.create({
            data: {
              tenantId,
              no,
              purchaseOrderId: receipt.purchaseOrderId,
              receiptId: receipt.id,
              supplierId: receipt.supplierId,
              type: candidate.type,
              claimedAmount: amount,
              description: `${candidate.line.purchaseOrderLine.productNameSnapshot} 到货${candidate.type}`,
              evidence: candidate.line.evidence || receipt.evidence || undefined,
              responseDueAt: new Date(Date.now() + receipt.supplier.postReceiptClaimHours * 3_600_000),
              createdById: userId,
            },
          })
          await tx.upstreamArrivalClaimLine.create({
            data: {
              tenantId,
              claimId: claim.id,
              receiptLineId: candidate.line.id,
              purchaseOrderLineId: candidate.line.purchaseOrderLineId,
              productId: candidate.line.productId,
              affectedQty: candidate.qty,
              purchaseUnit: candidate.line.purchaseUnit,
              unitPrice: candidate.line.unitPrice,
              claimedAmount: amount,
            },
          })
          claimIds.push(claim.id)
        }

        // 采购单是否履约完成看“已发数量是否全部完成到货核对”，而不是只看
        // 合格入库数。破损、拒收和短缺会进入差异单，但不应让采购单永久卡在
        // PARTIALLY_RECEIVED；只有供应商尚未发完或某一发货单尚未收完才保持部分收货。
        const orderShipmentLines = await tx.upstreamShipmentLine.findMany({
          where: {
            shipment: {
              tenantId,
              purchaseOrderId: receipt.purchaseOrderId,
              status: { not: 'CANCELLED' },
            },
          },
          include: {
            receiptLines: {
              where: { receipt: { status: 'POSTED' } },
              select: { receiptId: true, arrivedQty: true, shortageQty: true },
            },
          },
        })
        const allDispatched = receipt.purchaseOrder.lines.every(line =>
          line.shippedQty.greaterThanOrEqualTo(line.confirmedQty || line.orderedQty))
        const allDispatchedQuantitiesInspected = orderShipmentLines.every(line => {
          const previouslyAccounted = line.receiptLines.reduce(
            (sum, item) => sum.plus(item.arrivedQty).plus(item.shortageQty),
            decimal(0),
          )
          const currentLine = receipt.lines.find(item => item.shipmentLineId === line.id)
          return previouslyAccounted
            .plus(currentLine?.arrivedQty || decimal(0))
            .plus(currentLine?.shortageQty || decimal(0))
            .greaterThanOrEqualTo(line.shippedQty)
        })
        const nextOrderStatus = allDispatched && allDispatchedQuantitiesInspected
          ? 'RECEIVED'
          : 'PARTIALLY_RECEIVED'
        const now = new Date()
        if (receipt.shipment) {
          const priorLines = await tx.upstreamReceiptLine.findMany({
            where: {
              shipmentLineId: { in: receipt.shipment.lines.map(line => line.id) },
              receiptId: { not: receipt.id },
              receipt: { status: 'POSTED' },
            },
            select: { shipmentLineId: true, arrivedQty: true, shortageQty: true },
          })
          const processed = new Map<string, Prisma.Decimal>()
          for (const line of priorLines) {
            if (!line.shipmentLineId) continue
            processed.set(
              line.shipmentLineId,
              (processed.get(line.shipmentLineId) || decimal(0)).plus(line.arrivedQty).plus(line.shortageQty),
            )
          }
          for (const line of receipt.lines) {
            if (!line.shipmentLineId) continue
            processed.set(
              line.shipmentLineId,
              (processed.get(line.shipmentLineId) || decimal(0)).plus(line.arrivedQty).plus(line.shortageQty),
            )
          }
          const shipmentReceived = receipt.shipment.lines.every(line =>
            (processed.get(line.id) || decimal(0)).greaterThanOrEqualTo(line.shippedQty))
          await tx.upstreamShipment.update({
            where: { id: receipt.shipment.id },
            data: { status: shipmentReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
          })
        }
        await tx.upstreamPurchaseOrder.update({
          where: { id: receipt.purchaseOrderId },
          data: { status: nextOrderStatus, rowVersion: { increment: 1 } },
        })
        const posted = await tx.upstreamReceipt.update({
          where: { id: receipt.id },
          data: {
            status: 'POSTED',
            inspectorId: receipt.inspectorId || userId,
            reviewReasons,
            reviewerId: review ? userId : null,
            reviewedAt: review ? now : null,
            postedAt: now,
            rowVersion: { increment: 1 },
          },
          include: { lines: true },
        })
        await tx.upstreamPurchaseOrderEvent.create({
          data: {
            tenantId,
            purchaseOrderId: receipt.purchaseOrderId,
            action: 'POST_RECEIPT',
            fromStatus: receipt.purchaseOrder.status,
            toStatus: nextOrderStatus,
            actorId: userId,
            actorRole: role,
            metadata: { receiptId: receipt.id, receiptNo: receipt.no, claimIds },
          },
        })
        return { pendingReview: false, receipt: posted, claimIds }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 })
      if (!result) return reply.status(409).send({ error: '收货单不存在或当前状态不可确认' })
      return result
    } catch (error: any) {
      if (error instanceof UpstreamReceiptReviewerConflictError) {
        return reply.status(409).send({ error: error.message })
      }
      if (
        error?.code === 'P2034'
        || (error?.code === 'P2010' && String(error?.meta?.code || '') === '40001')
      ) {
        return reply.status(409).send({ error: '收货单正在被处理，请刷新后查看结果' })
      }
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  }

  app.get('/contracts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const supplierId = INTERNAL_ROLES.has(role)
      ? (typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined)
      : supplierScope(req, 'upstream.order.read')
    return prisma.upstreamSupplierContract.findMany({
      where: { tenantId, ...(supplierId ? { supplierId } : {}) },
      include: { supplier: { select: { id: true, no: true, name: true } }, lines: true },
      orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
      take: 200,
    })
  })

  app.post('/contracts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const parsed = contractCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    const supplier = await prisma.supplier.findFirst({
      where: {
        id: d.supplierId,
        tenantId,
        status: 'ENABLED',
        businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
      },
      select: { id: true },
    })
    if (!supplier) return reply.status(400).send({ error: '请选择已启用的上游供应商' })

    const sourceIds = d.lines.map(line => line.upstreamSourceId)
    const sources = await prisma.productUpstreamSource.findMany({
      where: { id: { in: sourceIds }, tenantId, supplierId: d.supplierId, isActive: true },
      include: { product: true },
    })
    if (sources.length !== sourceIds.length) {
      return reply.status(400).send({ error: '合同商品来源不存在、已停用或不属于该供应商' })
    }
    const sourceById = new Map(sources.map(source => [source.id, source]))

    const contract = await prisma.$transaction(async tx => {
      const previous = await tx.upstreamSupplierContract.findFirst({
        where: { tenantId, supplierId: d.supplierId, contractNo: d.contractNo },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
      const created = await tx.upstreamSupplierContract.create({
        data: {
          tenantId,
          supplierId: d.supplierId,
          contractNo: d.contractNo,
          version: (previous?.version || 0) + 1,
          title: d.title,
          startsAt: d.startsAt,
          endsAt: d.endsAt || null,
          settlementCycle: d.settlementCycle,
          settlementDays: d.settlementDays,
          taxInclusive: d.taxInclusive,
          defaultTaxRate: d.defaultTaxRate ?? null,
          currency: d.currency.toUpperCase(),
          paymentMethod: d.paymentMethod || null,
          discrepancyRule: d.discrepancyRule as Prisma.InputJsonValue | undefined,
          attachments: d.attachments as Prisma.InputJsonValue | undefined,
          createdById: userId,
          lines: {
            create: d.lines.map(line => {
              const source = sourceById.get(line.upstreamSourceId)!
              return {
                productId: source.productId,
                upstreamSourceId: source.id,
                productCodeSnapshot: source.product.code,
                productNameSnapshot: source.product.name,
                productSpecSnapshot: source.product.spec,
                supplierSkuSnapshot: source.supplierSku,
                purchaseUnit: source.purchaseUnit,
                inventoryUnit: source.product.inventoryUnit || source.product.unit,
                inventoryUnitsPerPurchaseUnit: source.inventoryUnitsPerPurchaseUnit,
                unitPrice: line.unitPrice,
                taxRate: line.taxRate ?? d.defaultTaxRate ?? 0,
                minOrderQty: source.minOrderQty,
                packageMultiple: line.packageMultiple,
                leadTimeDays: source.leadTimeDays,
                shortTolerancePct: line.shortTolerancePct,
                overTolerancePct: line.overTolerancePct,
                startsAt: line.startsAt || d.startsAt,
                endsAt: line.endsAt || d.endsAt || null,
              }
            }),
          },
        },
        include: { lines: true },
      })
      await tx.opLog.create({
        data: {
          tenantId,
          userId,
          role,
          action: '创建上游供应商合同',
          entityType: 'UpstreamSupplierContract',
          target: `${created.contractNo}-V${created.version}`,
          targetId: created.id,
        },
      })
      return created
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    return reply.status(201).send(contract)
  })

  app.post('/contracts/:id/activate', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const idParsed = idSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '合同标识格式不正确' })
    const now = new Date()
    const result = await prisma.$transaction(async tx => {
      const contract = await tx.upstreamSupplierContract.findFirst({
        where: { id: idParsed.data, tenantId },
        include: { lines: { where: { isActive: true } } },
      })
      if (!contract) return { status: 404, error: '合同不存在' } as const
      if (contract.status !== 'DRAFT') return { status: 409, error: '只有草稿合同可以生效' } as const
      if (contract.lines.length === 0) return { status: 400, error: '合同至少需要一个有效商品' } as const
      await tx.upstreamSupplierContract.updateMany({
        where: {
          tenantId,
          supplierId: contract.supplierId,
          contractNo: contract.contractNo,
          status: 'ACTIVE',
          id: { not: contract.id },
        },
        data: { status: 'TERMINATED', terminatedAt: now },
      })
      const active = await tx.upstreamSupplierContract.update({
        where: { id: contract.id },
        data: { status: 'ACTIVE', activatedAt: now },
        include: { lines: true },
      })
      await tx.opLog.create({
        data: { tenantId, userId, role, action: '启用上游供应商合同', entityType: 'UpstreamSupplierContract', targetId: contract.id },
      })
      return { status: 200, active } as const
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    return result.active
  })

  app.get('/purchase-orders', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    const supplierId = INTERNAL_ROLES.has(role)
      ? (typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined)
      : supplierScope(req, 'upstream.order.read')
    const status = typeof req.query?.status === 'string' ? req.query.status : undefined
    return prisma.upstreamPurchaseOrder.findMany({
      where: { tenantId, ...(supplierId ? { supplierId } : {}), ...(status ? { status: status as any } : {}) },
      include: {
        supplier: { select: { id: true, no: true, name: true } },
        warehouse: { select: { id: true, code: true, name: true } },
        _count: { select: { lines: true, shipments: true, receipts: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  })

  app.get('/purchase-orders/:id', auth(app), async (req: any, reply: any) => {
    const idParsed = idSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '采购单标识格式不正确' })
    const order = await scopedPurchaseOrder(req, idParsed.data)
    if (!order) return reply.status(404).send({ error: '采购单不存在' })
    return order
  })

  app.post('/purchase-orders', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const parsed = purchaseOrderCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    const [supplier, warehouse, contract] = await Promise.all([
      prisma.supplier.findFirst({
        where: { id: d.supplierId, tenantId, status: 'ENABLED', businessScopes: { has: 'WAREHOUSE_UPSTREAM' } },
        select: { id: true },
      }),
      prisma.warehouse.findFirst({ where: { id: d.warehouseId, tenantId, isActive: true }, select: { id: true } }),
      prisma.upstreamSupplierContract.findFirst({
        where: { id: d.contractId, tenantId, supplierId: d.supplierId, status: 'ACTIVE' },
        select: { id: true, currency: true, taxInclusive: true },
      }),
    ])
    if (!supplier) return reply.status(400).send({ error: '上游供应商不存在或已停用' })
    if (!warehouse) return reply.status(400).send({ error: '总仓不存在或已停用' })
    if (!contract) return reply.status(400).send({ error: '请选择该供应商已生效的合同' })

    const contractLineIds = d.lines.map(line => line.contractLineId)
    const contractLines = await prisma.upstreamSupplierContractLine.findMany({
      where: { id: { in: contractLineIds }, tenantId, contractId: contract.id, isActive: true },
    })
    if (contractLines.length !== contractLineIds.length) {
      return reply.status(400).send({ error: '采购商品不属于所选合同或已停用' })
    }
    const contractLineById = new Map(contractLines.map(line => [line.id, line]))

    try {
      const order = await prisma.$transaction(async tx => {
        const no = await nextUpstreamDocumentNo(tx, tenantId, 'purchaseOrder')
        let amountWithoutTax = decimal(0)
        let taxAmount = decimal(0)
        let totalAmount = decimal(0)
        let hasTemporaryPrice = false
        const lines = d.lines.map((input, index) => {
          const source = contractLineById.get(input.contractLineId)!
          const quantity = decimal(input.quantity)
          if (quantity.lessThan(source.minOrderQty)) {
            throw Object.assign(new Error(`${source.productNameSnapshot} 低于合同起订量`), { statusCode: 400 })
          }
          const multiple = decimal(source.packageMultiple)
          if (!quantity.dividedBy(multiple).isInteger()) {
            throw Object.assign(new Error(`${source.productNameSnapshot} 必须按 ${multiple.toString()} 的整倍数采购`), { statusCode: 400 })
          }
          const unitPrice = decimal(input.temporaryUnitPrice ?? source.unitPrice)
          const temporary = input.temporaryUnitPrice !== undefined && !unitPrice.equals(source.unitPrice)
          hasTemporaryPrice ||= temporary
          const baseAmount = money(quantity.times(unitPrice))
          const rate = decimal(source.taxRate)
          const lineWithoutTax = contract.taxInclusive && rate.greaterThan(0)
            ? money(baseAmount.dividedBy(decimal(1).plus(rate)))
            : baseAmount
          const lineTax = contract.taxInclusive
            ? money(baseAmount.minus(lineWithoutTax))
            : money(lineWithoutTax.times(rate))
          const lineTotal = contract.taxInclusive ? baseAmount : money(lineWithoutTax.plus(lineTax))
          amountWithoutTax = amountWithoutTax.plus(lineWithoutTax)
          taxAmount = taxAmount.plus(lineTax)
          totalAmount = totalAmount.plus(lineTotal)
          return {
            lineNo: index + 1,
            productId: source.productId,
            contractLineId: source.id,
            productCodeSnapshot: source.productCodeSnapshot,
            productNameSnapshot: source.productNameSnapshot,
            productSpecSnapshot: source.productSpecSnapshot,
            supplierSkuSnapshot: source.supplierSkuSnapshot,
            purchaseUnit: source.purchaseUnit,
            inventoryUnit: source.inventoryUnit,
            inventoryUnitsPerPurchaseUnit: source.inventoryUnitsPerPurchaseUnit,
            orderedQty: quantity,
            unitPrice,
            taxRate: rate,
            amountWithoutTax: lineWithoutTax,
            taxAmount: lineTax,
            totalAmount: lineTotal,
            shortTolerancePct: source.shortTolerancePct,
            overTolerancePct: source.overTolerancePct,
            isTemporaryPrice: temporary,
          }
        })
        const created = await tx.upstreamPurchaseOrder.create({
          data: {
            tenantId,
            no,
            supplierId: d.supplierId,
            warehouseId: d.warehouseId,
            contractId: contract.id,
            expectedArrivalAt: d.expectedArrivalAt || null,
            origin: d.origin,
            currency: contract.currency,
            taxInclusive: contract.taxInclusive,
            amountWithoutTax: money(amountWithoutTax),
            taxAmount: money(taxAmount),
            totalAmount: money(totalAmount),
            hasTemporaryPrice,
            idempotencyKey: d.idempotencyKey || null,
            note: d.note || null,
            createdById: userId,
            lines: { create: lines },
          },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        })
        await tx.upstreamPurchaseOrderEvent.create({
          data: {
            tenantId,
            purchaseOrderId: created.id,
            action: 'CREATE',
            toStatus: 'DRAFT',
            actorId: userId,
            actorRole: role,
          },
        })
        await tx.opLog.create({
          data: { tenantId, userId, role, action: '创建上游采购单', entityType: 'UpstreamPurchaseOrder', target: no, targetId: created.id },
        })
        return created
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return reply.status(201).send(order)
    } catch (error: any) {
      if (error?.code === 'P2002' && d.idempotencyKey) {
        const existing = await prisma.upstreamPurchaseOrder.findFirst({ where: { tenantId, idempotencyKey: d.idempotencyKey }, include: { lines: true } })
        if (existing) return reply.status(200).send(existing)
      }
      if (error?.statusCode === 400) return reply.status(400).send({ error: error.message })
      throw error
    }
  })

  async function internalOrderTransition(req: any, reply: any, from: UpstreamPurchaseOrderStatus, to: UpstreamPurchaseOrderStatus) {
    const { tenantId, role, userId } = req.user
    if (!APPROVER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const idParsed = idSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '采购单标识格式不正确' })
    assertUpstreamPurchaseOrderTransition(from, to)
    const now = new Date()
    const result = await prisma.$transaction(async tx => {
      const changed = await tx.upstreamPurchaseOrder.updateMany({
        where: { id: idParsed.data, tenantId, status: from },
        data: {
          status: to,
          rowVersion: { increment: 1 },
          ...(to === 'SUBMITTED_TO_SUPPLIER' ? { approvedById: userId, submittedAt: now } : {}),
        },
      })
      if (changed.count !== 1) return null
      await tx.upstreamPurchaseOrderEvent.create({
        data: { tenantId, purchaseOrderId: idParsed.data, action: to, fromStatus: from, toStatus: to, actorId: userId, actorRole: role },
      })
      return tx.upstreamPurchaseOrder.findUnique({ where: { id: idParsed.data }, include: { lines: true } })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (!result) return reply.status(409).send({ error: `采购单当前状态不是 ${from}` })
    return result
  }

  app.post('/purchase-orders/:id/submit-for-approval', auth(app), (req: any, reply: any) =>
    internalOrderTransition(req, reply, 'DRAFT', 'PENDING_APPROVAL'))

  app.post('/purchase-orders/:id/approve-and-send', auth(app), (req: any, reply: any) =>
    internalOrderTransition(req, reply, 'PENDING_APPROVAL', 'SUBMITTED_TO_SUPPLIER'))

  app.post('/purchase-orders/:id/accept', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.order.accept')
    const idParsed = idSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '采购单标识格式不正确' })
    assertUpstreamPurchaseOrderTransition('SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED')
    const now = new Date()
    const result = await prisma.$transaction(async tx => {
      const changed = await tx.upstreamPurchaseOrder.updateMany({
        where: { id: idParsed.data, tenantId, supplierId, status: 'SUBMITTED_TO_SUPPLIER' },
        data: { status: 'SUPPLIER_ACCEPTED', supplierAcceptedAt: now, rowVersion: { increment: 1 } },
      })
      if (changed.count !== 1) return null
      await tx.upstreamPurchaseOrderEvent.create({
        data: {
          tenantId,
          purchaseOrderId: idParsed.data,
          action: 'SUPPLIER_ACCEPT',
          fromStatus: 'SUBMITTED_TO_SUPPLIER',
          toStatus: 'SUPPLIER_ACCEPTED',
          actorId: userId,
          actorRole: role,
        },
      })
      return tx.upstreamPurchaseOrder.findUnique({ where: { id: idParsed.data }, include: { lines: true } })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (!result) return reply.status(409).send({ error: '采购单不存在、无权访问或当前不可接单' })
    return result
  })

  app.post('/purchase-orders/:id/propose-change', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.order.accept')
    const idParsed = idSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '采购单标识格式不正确' })
    const parsed = revisionCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    const result = await prisma.$transaction(async tx => {
      const order = await tx.upstreamPurchaseOrder.findFirst({
        where: { id: idParsed.data, tenantId, supplierId, status: { in: ['SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED'] } },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      })
      if (!order) return null
      const lineById = new Map(order.lines.map(line => [line.id, line]))
      if (d.lines.some(line => !lineById.has(line.lineId))) {
        throw Object.assign(new Error('改单包含不属于该采购单的商品'), { statusCode: 400 })
      }
      const afterLines = order.lines.map(line => ({
        id: line.id,
        quantity: d.lines.find(input => input.lineId === line.id)?.quantity ?? Number(line.orderedQty),
      }))
      const revisionNo = order.currentRevisionNo + 1
      const revision = await tx.upstreamPurchaseOrderRevision.create({
        data: {
          tenantId,
          purchaseOrderId: order.id,
          revisionNo,
          reason: d.reason,
          beforeSnapshot: {
            expectedArrivalAt: order.expectedArrivalAt?.toISOString() || null,
            lines: order.lines.map(line => ({ id: line.id, quantity: line.orderedQty.toString() })),
          },
          afterSnapshot: {
            expectedArrivalAt: d.expectedArrivalAt?.toISOString() || order.expectedArrivalAt?.toISOString() || null,
            lines: afterLines,
          },
          requestedById: userId,
          requestedByRole: role,
        },
      })
      await tx.upstreamPurchaseOrder.update({
        where: { id: order.id },
        data: { status: 'CHANGE_PROPOSED', currentRevisionNo: revisionNo, rowVersion: { increment: 1 } },
      })
      await tx.upstreamPurchaseOrderEvent.create({
        data: {
          tenantId,
          purchaseOrderId: order.id,
          action: 'PROPOSE_CHANGE',
          fromStatus: order.status,
          toStatus: 'CHANGE_PROPOSED',
          actorId: userId,
          actorRole: role,
          metadata: { revisionNo },
        },
      })
      return revision
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (!result) return reply.status(409).send({ error: '采购单不存在、无权访问或当前不可改单' })
    return reply.status(201).send(result)
  })

  app.post('/purchase-orders/:id/revisions/:revisionId/review', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!APPROVER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const orderId = idSchema.safeParse(req.params.id)
    const revisionId = idSchema.safeParse(req.params.revisionId)
    if (!orderId.success || !revisionId.success) return reply.status(400).send({ error: '单据标识格式不正确' })
    const parsed = revisionReviewSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    const result = await prisma.$transaction(async tx => {
      const revision = await tx.upstreamPurchaseOrderRevision.findFirst({
        where: { id: revisionId.data, tenantId, purchaseOrderId: orderId.data, status: 'PENDING' },
      })
      if (!revision) return null
      const order = await tx.upstreamPurchaseOrder.findFirst({
        where: { id: orderId.data, tenantId, status: 'CHANGE_PROPOSED', currentRevisionNo: revision.revisionNo },
        include: { lines: true },
      })
      if (!order) return null
      const now = new Date()
      if (d.decision === 'REJECT') {
        await tx.upstreamPurchaseOrderRevision.update({
          where: { id: revision.id },
          data: { status: 'REJECTED', reviewedById: userId, reviewedAt: now, reviewNote: d.note || null },
        })
        await tx.upstreamPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'SUBMITTED_TO_SUPPLIER', rowVersion: { increment: 1 } },
        })
        return { decision: 'REJECT', orderId: order.id }
      }

      const after = revision.afterSnapshot as any
      const quantities = new Map<string, number>((after.lines || []).map((line: any) => [line.id, Number(line.quantity)]))
      if (order.lines.some(line => !quantities.has(line.id) || !(quantities.get(line.id)! > 0))) {
        throw Object.assign(new Error('改单数量快照不完整或无效'), { statusCode: 400 })
      }
      let amountWithoutTax = decimal(0)
      let taxAmount = decimal(0)
      let totalAmount = decimal(0)
      for (const line of order.lines) {
        const quantity = decimal(quantities.get(line.id)!)
        const baseAmount = money(quantity.times(line.unitPrice))
        const lineWithoutTax = order.taxInclusive && line.taxRate.greaterThan(0)
          ? money(baseAmount.dividedBy(decimal(1).plus(line.taxRate)))
          : baseAmount
        const lineTax = order.taxInclusive
          ? money(baseAmount.minus(lineWithoutTax))
          : money(lineWithoutTax.times(line.taxRate))
        const lineTotal = order.taxInclusive ? baseAmount : money(lineWithoutTax.plus(lineTax))
        await tx.upstreamPurchaseOrderLine.update({
          where: { id: line.id },
          data: { orderedQty: quantity, amountWithoutTax: lineWithoutTax, taxAmount: lineTax, totalAmount: lineTotal },
        })
        amountWithoutTax = amountWithoutTax.plus(lineWithoutTax)
        taxAmount = taxAmount.plus(lineTax)
        totalAmount = totalAmount.plus(lineTotal)
      }
      await tx.upstreamPurchaseOrderRevision.update({
        where: { id: revision.id },
        data: { status: 'ACCEPTED', reviewedById: userId, reviewedAt: now, reviewNote: d.note || null },
      })
      await tx.upstreamPurchaseOrder.update({
        where: { id: order.id },
        data: {
          status: 'SUPPLIER_ACCEPTED',
          expectedArrivalAt: after.expectedArrivalAt ? new Date(after.expectedArrivalAt) : order.expectedArrivalAt,
          amountWithoutTax: money(amountWithoutTax),
          taxAmount: money(taxAmount),
          totalAmount: money(totalAmount),
          supplierAcceptedAt: now,
          rowVersion: { increment: 1 },
        },
      })
      await tx.upstreamPurchaseOrderEvent.create({
        data: {
          tenantId,
          purchaseOrderId: order.id,
          action: 'ACCEPT_REVISION',
          fromStatus: 'CHANGE_PROPOSED',
          toStatus: 'SUPPLIER_ACCEPTED',
          actorId: userId,
          actorRole: role,
          metadata: { revisionNo: revision.revisionNo },
        },
      })
      return { decision: 'ACCEPT', orderId: order.id }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (!result) return reply.status(409).send({ error: '改单不存在或已处理' })
    return result
  })

  app.get('/shipments', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    const supplierId = INTERNAL_ROLES.has(role)
      ? (typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined)
      : requireSupplierCapability(role, req.user.supplierId, 'upstream.order.read')
    return prisma.upstreamShipment.findMany({
      where: { tenantId, ...(supplierId ? { supplierId } : {}) },
      include: {
        purchaseOrder: { select: { id: true, no: true, status: true, expectedArrivalAt: true } },
        lines: { include: { purchaseOrderLine: { select: { productNameSnapshot: true, productSpecSnapshot: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  })

  app.post('/purchase-orders/:id/shipments', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.order.ship')
    const orderId = idSchema.safeParse(req.params.id)
    if (!orderId.success) return reply.status(400).send({ error: '采购单标识格式不正确' })
    const parsed = shipmentCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    try {
      const shipment = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-po:${orderId.data}`}))::text AS locked`
        const order = await tx.upstreamPurchaseOrder.findFirst({
          where: {
            id: orderId.data,
            tenantId,
            supplierId,
            status: { in: ['SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED'] },
          },
          include: { lines: true },
        })
        if (!order) return null
        const orderLineById = new Map(order.lines.map(line => [line.id, line]))
        for (const input of d.lines) {
          const line = orderLineById.get(input.purchaseOrderLineId)
          if (!line) throw Object.assign(new Error('发货明细不属于该采购单'), { statusCode: 400 })
          const ordered = line.confirmedQty || line.orderedQty
          const remaining = ordered.minus(line.shippedQty)
          if (decimal(input.shippedQty).greaterThan(remaining)) {
            throw Object.assign(new Error(`${line.productNameSnapshot} 发货数量超过剩余可发数量 ${remaining.toString()} ${line.purchaseUnit}`), { statusCode: 400 })
          }
        }

        const no = await nextUpstreamDocumentNo(tx, tenantId, 'shipment')
        const created = await tx.upstreamShipment.create({
          data: {
            tenantId,
            no,
            purchaseOrderId: order.id,
            supplierId,
            warehouseId: order.warehouseId,
            supplierShipmentNo: d.supplierShipmentNo || null,
            carrierName: d.carrierName || null,
            trackingNo: d.trackingNo || null,
            driverName: d.driverName || null,
            driverPhone: d.driverPhone || null,
            vehicleNo: d.vehicleNo || null,
            expectedArrivalAt: d.expectedArrivalAt || null,
            attachments: d.attachments as Prisma.InputJsonValue | undefined,
            note: d.note || null,
            idempotencyKey: d.idempotencyKey || null,
            createdById: userId,
            lines: {
              create: d.lines.map(input => {
                const line = orderLineById.get(input.purchaseOrderLineId)!
                return {
                  purchaseOrderLineId: line.id,
                  productId: line.productId,
                  shippedQty: input.shippedQty,
                  purchaseUnit: line.purchaseUnit,
                  batchNo: input.batchNo || null,
                  manufactureDate: input.manufactureDate || null,
                  expiryDate: input.expiryDate || null,
                  packageInfo: input.packageInfo || null,
                }
              }),
            },
          },
          include: { lines: true },
        })
        await tx.upstreamPurchaseOrderEvent.create({
          data: {
            tenantId,
            purchaseOrderId: order.id,
            action: 'CREATE_SHIPMENT_DRAFT',
            actorId: userId,
            actorRole: role,
            metadata: { shipmentId: created.id, shipmentNo: created.no },
          },
        })
        return created
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      if (!shipment) return reply.status(409).send({ error: '采购单不存在、无权访问或当前不可发货' })
      return reply.status(201).send(shipment)
    } catch (error: any) {
      if (error?.code === 'P2002' && d.idempotencyKey) {
        const existing = await prisma.upstreamShipment.findFirst({ where: { tenantId, idempotencyKey: d.idempotencyKey }, include: { lines: true } })
        if (existing) return reply.status(200).send(existing)
      }
      if (error?.statusCode === 400) return reply.status(400).send({ error: error.message })
      throw error
    }
  })

  app.post('/shipments/:id/dispatch', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.order.ship')
    const shipmentId = idSchema.safeParse(req.params.id)
    if (!shipmentId.success) return reply.status(400).send({ error: '发货单标识格式不正确' })

    const result = await prisma.$transaction(async tx => {
      const preliminary = await tx.upstreamShipment.findFirst({
        where: { id: shipmentId.data, tenantId, supplierId },
        select: { purchaseOrderId: true },
      })
      if (!preliminary) return null
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-po:${preliminary.purchaseOrderId}`}))::text AS locked`
      const shipment = await tx.upstreamShipment.findFirst({
        where: { id: shipmentId.data, tenantId, supplierId, status: 'DRAFT' },
        include: { lines: true },
      })
      if (!shipment) return null
      const order = await tx.upstreamPurchaseOrder.findFirst({
        where: {
          id: shipment.purchaseOrderId,
          tenantId,
          supplierId,
          status: { in: ['SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED'] },
        },
        include: { lines: true },
      })
      if (!order) return null
      const orderLineById = new Map(order.lines.map(line => [line.id, line]))
      for (const shipmentLine of shipment.lines) {
        const orderLine = orderLineById.get(shipmentLine.purchaseOrderLineId)
        if (!orderLine) throw Object.assign(new Error('发货明细与采购单不一致'), { statusCode: 409 })
        const ordered = orderLine.confirmedQty || orderLine.orderedQty
        if (orderLine.shippedQty.plus(shipmentLine.shippedQty).greaterThan(ordered)) {
          throw Object.assign(new Error(`${orderLine.productNameSnapshot} 累计发货数量超过确认数量`), { statusCode: 409 })
        }
      }
      for (const shipmentLine of shipment.lines) {
        await tx.upstreamPurchaseOrderLine.update({
          where: { id: shipmentLine.purchaseOrderLineId },
          data: { shippedQty: { increment: shipmentLine.shippedQty } },
        })
        const orderLine = orderLineById.get(shipmentLine.purchaseOrderLineId)!
        orderLine.shippedQty = orderLine.shippedQty.plus(shipmentLine.shippedQty)
      }
      const fullyShipped = order.lines.every(line => line.shippedQty.greaterThanOrEqualTo(line.confirmedQty || line.orderedQty))
      const nextStatus = fullyShipped ? 'SHIPPED' : 'PARTIALLY_SHIPPED'
      const now = new Date()
      await tx.upstreamShipment.update({
        where: { id: shipment.id },
        data: { status: 'SHIPPED', shippedAt: now },
      })
      await tx.upstreamPurchaseOrder.update({
        where: { id: order.id },
        data: { status: nextStatus, rowVersion: { increment: 1 } },
      })
      await tx.upstreamPurchaseOrderEvent.create({
        data: {
          tenantId,
          purchaseOrderId: order.id,
          action: 'DISPATCH_SHIPMENT',
          fromStatus: order.status,
          toStatus: nextStatus,
          actorId: userId,
          actorRole: role,
          metadata: { shipmentId: shipment.id, shipmentNo: shipment.no },
        },
      })
      return tx.upstreamShipment.findUnique({ where: { id: shipment.id }, include: { lines: true } })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (!result) return reply.status(409).send({ error: '发货单不存在、已发货或当前采购单不可发货' })
    return result
  })

  app.get('/receipts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可查看总仓收货单' })
    const supplierId = typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined
    return prisma.upstreamReceipt.findMany({
      where: { tenantId, ...(supplierId ? { supplierId } : {}) },
      include: {
        supplier: { select: { id: true, no: true, name: true } },
        purchaseOrder: { select: { id: true, no: true, status: true } },
        shipment: { select: { id: true, no: true, status: true } },
        _count: { select: { lines: true, claims: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  })

  app.get('/receipts/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可查看总仓收货单' })
    const receiptId = idSchema.safeParse(req.params.id)
    if (!receiptId.success) return reply.status(400).send({ error: '收货单标识格式不正确' })
    const receipt = await prisma.upstreamReceipt.findFirst({
      where: { id: receiptId.data, tenantId },
      include: {
        supplier: {
          select: { id: true, no: true, name: true, postReceiptClaimHours: true },
        },
        purchaseOrder: { select: { id: true, no: true, status: true } },
        shipment: { select: { id: true, no: true, status: true } },
        lines: {
          include: {
            purchaseOrderLine: {
              select: { productCodeSnapshot: true, productNameSnapshot: true, productSpecSnapshot: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!receipt) return reply.status(404).send({ error: '收货单不存在' })
    return receipt
  })

  app.post('/shipments/:id/receipts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可创建收货单' })
    const shipmentId = idSchema.safeParse(req.params.id)
    if (!shipmentId.success) return reply.status(400).send({ error: '发货单标识格式不正确' })
    const parsed = receiptCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    try {
      const result = await prisma.$transaction(async tx => {
        const preliminary = await tx.upstreamShipment.findFirst({
          where: { id: shipmentId.data, tenantId },
          select: { purchaseOrderId: true },
        })
        if (!preliminary) return null
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-po:${preliminary.purchaseOrderId}`}))::text AS locked`
        if (d.idempotencyKey) {
          const existing = await tx.upstreamReceipt.findFirst({
            where: { tenantId, idempotencyKey: d.idempotencyKey },
            include: { lines: true },
          })
          if (existing) {
            if (existing.shipmentId !== shipmentId.data) {
              throw Object.assign(new Error('幂等键已用于其他发货单'), { statusCode: 409 })
            }
            return { receipt: existing, replayed: true }
          }
        }
        const shipment = await tx.upstreamShipment.findFirst({
          where: { id: shipmentId.data, tenantId, status: { in: ['SHIPPED', 'PARTIALLY_RECEIVED'] } },
          include: {
            supplier: { select: { id: true } },
            purchaseOrder: { include: { lines: true } },
            lines: true,
          },
        })
        if (!shipment) return null
        const shipmentLineById = new Map(shipment.lines.map(line => [line.id, line]))
        const orderLineById = new Map(shipment.purchaseOrder.lines.map(line => [line.id, line]))
        if (d.lines.some(line => !shipmentLineById.has(line.shipmentLineId))) {
          throw Object.assign(new Error('验收明细不属于该发货单'), { statusCode: 400 })
        }
        const priorReceiptLines = await tx.upstreamReceiptLine.findMany({
          where: {
            shipmentLineId: { in: d.lines.map(line => line.shipmentLineId) },
            receipt: { status: { not: 'REVERSED' } },
          },
          select: {
            shipmentLineId: true,
            arrivedQty: true,
            acceptedQty: true,
            receipt: { select: { status: true } },
          },
        })
        const priorArrived = new Map<string, Prisma.Decimal>()
        const priorAcceptedByOrderLine = new Map<string, Prisma.Decimal>()
        for (const line of priorReceiptLines) {
          if (!line.shipmentLineId) continue
          priorArrived.set(line.shipmentLineId, (priorArrived.get(line.shipmentLineId) || decimal(0)).plus(line.arrivedQty))
          const shipmentLine = shipmentLineById.get(line.shipmentLineId)
          if (shipmentLine && line.receipt.status !== 'POSTED') {
            priorAcceptedByOrderLine.set(
              shipmentLine.purchaseOrderLineId,
              (priorAcceptedByOrderLine.get(shipmentLine.purchaseOrderLineId) || decimal(0)).plus(line.acceptedQty),
            )
          }
        }

        let payableAmount = decimal(0)
        const receiptLines = d.lines.map(input => {
          const shipmentLine = shipmentLineById.get(input.shipmentLineId)!
          const orderLine = orderLineById.get(shipmentLine.purchaseOrderLineId)!
          const arrived = decimal(input.arrivedQty)
          const accepted = decimal(input.acceptedQty)
          const previousArrived = priorArrived.get(shipmentLine.id) || decimal(0)
          const shortage = d.finalForShipment
            ? Prisma.Decimal.max(decimal(0), shipmentLine.shippedQty.minus(previousArrived).minus(arrived))
            : decimal(0)
          const overage = Prisma.Decimal.max(decimal(0), previousArrived.plus(arrived).minus(shipmentLine.shippedQty))
          const orderAccepted = orderLine.receivedQty.plus(priorAcceptedByOrderLine.get(orderLine.id) || decimal(0)).plus(accepted)
          const target = orderLine.confirmedQty || orderLine.orderedQty
          const maximum = target.times(decimal(1).plus(orderLine.overTolerancePct))
          if (orderAccepted.greaterThan(maximum)) {
            throw Object.assign(
              new Error(`${orderLine.productNameSnapshot} 合格验收数量超过合同允许上限 ${maximum.toString()} ${orderLine.purchaseUnit}`),
              { statusCode: 400 },
            )
          }
          const linePayable = money(accepted.times(orderLine.unitPrice))
          payableAmount = payableAmount.plus(linePayable)
          const manufactureDate = input.manufactureDate || shipmentLine.manufactureDate
          const expiryDate = input.expiryDate || shipmentLine.expiryDate
          return {
            purchaseOrderLineId: orderLine.id,
            shipmentLineId: shipmentLine.id,
            productId: orderLine.productId,
            orderedQty: target,
            shippedQty: shipmentLine.shippedQty,
            arrivedQty: arrived,
            acceptedQty: accepted,
            damagedQty: input.damagedQty,
            rejectedQty: input.rejectedQty,
            shortageQty: shortage,
            overageQty: overage,
            purchaseUnit: orderLine.purchaseUnit,
            inventoryUnit: orderLine.inventoryUnit,
            inventoryUnitsPerPurchaseUnit: orderLine.inventoryUnitsPerPurchaseUnit,
            inventoryAcceptedQty: accepted.times(orderLine.inventoryUnitsPerPurchaseUnit).toDecimalPlaces(6),
            unitPrice: orderLine.unitPrice,
            payableAmount: linePayable,
            batchNo: input.batchNo || shipmentLine.batchNo || null,
            manufactureDate: manufactureDate || null,
            expiryDate: expiryDate || null,
            evidence: input.evidence as Prisma.InputJsonValue | undefined,
            note: input.note || null,
          }
        })
        const no = await nextUpstreamDocumentNo(tx, tenantId, 'receipt')
        const created = await tx.upstreamReceipt.create({
          data: {
            tenantId,
            no,
            purchaseOrderId: shipment.purchaseOrderId,
            shipmentId: shipment.id,
            supplierId: shipment.supplierId,
            warehouseId: shipment.warehouseId,
            arrivedAt: d.arrivedAt || new Date(),
            payableAmount: money(payableAmount),
            idempotencyKey: d.idempotencyKey || null,
            evidence: d.evidence as Prisma.InputJsonValue | undefined,
            note: d.note || null,
            finalForShipment: d.finalForShipment,
            createdById: userId,
            lines: { create: receiptLines },
          },
          include: { lines: true },
        })
        await tx.opLog.create({
          data: { tenantId, userId, role, action: '创建上游收货单', entityType: 'UpstreamReceipt', target: no, targetId: created.id },
        })
        return { receipt: created, replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      if (!result) return reply.status(409).send({ error: '发货单不存在或当前不可验收' })
      return reply.status(result.replayed ? 200 : 201).send(result.receipt)
    } catch (error: any) {
      if (error?.code === 'P2002' && d.idempotencyKey) {
        const existing = await prisma.upstreamReceipt.findFirst({ where: { tenantId, idempotencyKey: d.idempotencyKey }, include: { lines: true } })
        if (existing) return reply.status(200).send(existing)
      }
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/receipts/:id/start-inspection', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可验收' })
    const receiptId = idSchema.safeParse(req.params.id)
    if (!receiptId.success) return reply.status(400).send({ error: '收货单标识格式不正确' })
    const changed = await prisma.upstreamReceipt.updateMany({
      where: { id: receiptId.data, tenantId, status: 'DRAFT' },
      data: { status: 'INSPECTING', inspectionStartedAt: new Date(), inspectorId: userId, rowVersion: { increment: 1 } },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '收货单不存在或已开始验收' })
    return prisma.upstreamReceipt.findUnique({ where: { id: receiptId.data }, include: { lines: true } })
  })

  app.post('/receipts/:id/confirm', auth(app), (req: any, reply: any) => postReceipt(req, reply, false))
  app.post('/receipts/:id/review-and-post', auth(app), (req: any, reply: any) => postReceipt(req, reply, true))

  app.post('/receipts/:id/reverse', auth(app), async (req: any, reply: any) => {
    if (!upstreamFeatureEnabled('UPSTREAM_RECEIPT_POSTING_ENABLED')) {
      return reply.status(503).send({ error: '上游收货入账当前处于灰度关闭状态' })
    }
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可冲销收货' })
    const receiptId = idSchema.safeParse(req.params.id)
    if (!receiptId.success) return reply.status(400).send({ error: '收货单标识格式不正确' })
    const parsed = receiptReversalSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    try {
      const result = await prisma.$transaction(async tx => {
        const preliminary = await tx.upstreamReceipt.findFirst({
          where: { id: receiptId.data, tenantId },
          select: { purchaseOrderId: true },
        })
        if (!preliminary) return null
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-po:${preliminary.purchaseOrderId}`}))::text AS locked`
        const receipt = await tx.upstreamReceipt.findFirst({
          where: { id: receiptId.data, tenantId },
          include: {
            purchaseOrder: { include: { lines: true } },
            shipment: { include: { lines: true } },
            lines: {
              include: {
                settlementLines: { select: { statement: { select: { status: true, no: true } } } },
              },
            },
            claims: { select: { status: true, no: true } },
          },
        })
        if (!receipt) return null
        if (receipt.status === 'REVERSED') {
          return { replayed: true, receipt }
        }
        if (receipt.status !== 'POSTED') {
          throw Object.assign(new Error('只有已入账且未冲销的收货单可以冲销'), { statusCode: 409 })
        }
        const activeClaim = receipt.claims.find(claim => claim.status !== 'CANCELLED')
        if (activeClaim) {
          throw Object.assign(new Error(`收货单已关联差异单 ${activeClaim.no}，请先办结业务再按实盘调整处理`), { statusCode: 409 })
        }
        const activeSettlement = receipt.lines
          .flatMap(line => line.settlementLines)
          .find(line => line.statement.status !== 'CANCELLED')
        if (activeSettlement) {
          throw Object.assign(new Error(`收货单已进入对账单 ${activeSettlement.statement.no}，不能直接冲销`), { statusCode: 409 })
        }

        await reverseUpstreamReceiptInTransaction(tx, {
          tenantId,
          warehouseId: receipt.warehouseId,
          receiptId: receipt.id,
          receiptNo: receipt.no,
          userId,
          reason: d.reason,
        })

        const receivedAfter = new Map<string, Prisma.Decimal>()
        for (const orderLine of receipt.purchaseOrder.lines) {
          receivedAfter.set(orderLine.id, orderLine.receivedQty)
        }
        for (const line of receipt.lines) {
          const nextReceived = Prisma.Decimal.max(
            decimal(0),
            (receivedAfter.get(line.purchaseOrderLineId) || decimal(0)).minus(line.acceptedQty),
          )
          receivedAfter.set(line.purchaseOrderLineId, nextReceived)
          await tx.upstreamPurchaseOrderLine.update({
            where: { id: line.purchaseOrderLineId },
            data: { receivedQty: nextReceived },
          })
        }

        if (receipt.shipment) {
          const otherReceiptLines = await tx.upstreamReceiptLine.findMany({
            where: {
              shipmentLineId: { in: receipt.shipment.lines.map(line => line.id) },
              receiptId: { not: receipt.id },
              receipt: { status: 'POSTED' },
            },
            select: { shipmentLineId: true, arrivedQty: true },
          })
          const arrivedByShipmentLine = new Map<string, Prisma.Decimal>()
          for (const line of otherReceiptLines) {
            if (!line.shipmentLineId) continue
            arrivedByShipmentLine.set(
              line.shipmentLineId,
              (arrivedByShipmentLine.get(line.shipmentLineId) || decimal(0)).plus(line.arrivedQty),
            )
          }
          const fullyReceived = receipt.shipment.lines.every(line =>
            (arrivedByShipmentLine.get(line.id) || decimal(0)).greaterThanOrEqualTo(line.shippedQty))
          const partiallyReceived = [...arrivedByShipmentLine.values()].some(value => value.gt(0))
          await tx.upstreamShipment.update({
            where: { id: receipt.shipment.id },
            data: { status: fullyReceived ? 'RECEIVED' : partiallyReceived ? 'PARTIALLY_RECEIVED' : 'SHIPPED' },
          })
        }

        const fullyReceived = receipt.purchaseOrder.lines.every(line =>
          (receivedAfter.get(line.id) || decimal(0)).greaterThanOrEqualTo(line.confirmedQty || line.orderedQty))
        const partiallyReceived = [...receivedAfter.values()].some(value => value.gt(0))
        const fullyShipped = receipt.purchaseOrder.lines.every(line =>
          line.shippedQty.greaterThanOrEqualTo(line.confirmedQty || line.orderedQty))
        const partiallyShipped = receipt.purchaseOrder.lines.some(line => line.shippedQty.gt(0))
        const nextOrderStatus = fullyReceived
          ? 'RECEIVED'
          : partiallyReceived
            ? 'PARTIALLY_RECEIVED'
            : fullyShipped
              ? 'SHIPPED'
              : partiallyShipped
                ? 'PARTIALLY_SHIPPED'
                : 'SUPPLIER_ACCEPTED'
        const reversedAt = new Date()
        await tx.upstreamPurchaseOrder.update({
          where: { id: receipt.purchaseOrderId },
          data: { status: nextOrderStatus, rowVersion: { increment: 1 } },
        })
        const reversed = await tx.upstreamReceipt.update({
          where: { id: receipt.id },
          data: { status: 'REVERSED', reversedAt, rowVersion: { increment: 1 } },
          include: { lines: true },
        })
        await tx.upstreamPurchaseOrderEvent.create({
          data: {
            tenantId,
            purchaseOrderId: receipt.purchaseOrderId,
            action: 'REVERSE_RECEIPT',
            fromStatus: receipt.purchaseOrder.status,
            toStatus: nextOrderStatus,
            actorId: userId,
            actorRole: role,
            metadata: {
              receiptId: receipt.id,
              receiptNo: receipt.no,
              reason: d.reason,
              idempotencyKey: d.idempotencyKey,
            },
          },
        })
        await tx.opLog.create({
          data: {
            tenantId,
            userId,
            role,
            action: '冲销上游采购收货',
            entityType: 'UpstreamReceipt',
            target: receipt.no,
            targetId: receipt.id,
            metadata: { reason: d.reason, idempotencyKey: d.idempotencyKey },
          },
        })
        return { replayed: false, receipt: reversed }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 })
      if (!result) return reply.status(404).send({ error: '收货单不存在' })
      return result
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.get('/arrival-claims', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    const supplierId = INTERNAL_ROLES.has(role)
      ? (typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined)
      : requireSupplierCapability(role, req.user.supplierId, 'upstream.order.read')
    return prisma.upstreamArrivalClaim.findMany({
      where: { tenantId, ...(supplierId ? { supplierId } : {}) },
      include: {
        purchaseOrder: { select: { id: true, no: true } },
        receipt: { select: { id: true, no: true, postedAt: true } },
        lines: { include: { product: { select: { code: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  })

  app.post('/receipts/:id/post-receipt-claims', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可补报到货异常' })
    const receiptId = idSchema.safeParse(req.params.id)
    if (!receiptId.success) return reply.status(400).send({ error: '收货单标识格式不正确' })
    const parsed = postReceiptClaimSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-receipt:${receiptId.data}`}))::text AS locked`
        const receipt = await tx.upstreamReceipt.findFirst({
          where: { id: receiptId.data, tenantId, status: 'POSTED' },
          include: { supplier: true, lines: { include: { purchaseOrderLine: true } } },
        })
        if (!receipt || !receipt.postedAt) return null
        const deadline = new Date(receipt.postedAt.getTime() + receipt.supplier.postReceiptClaimHours * 3_600_000)
        if (deadline < new Date()) {
          throw Object.assign(new Error(`已超过收货后 ${receipt.supplier.postReceiptClaimHours} 小时补报时限`), { statusCode: 409 })
        }
        const receiptLineById = new Map(receipt.lines.map(line => [line.id, line]))
        if (d.lines.some(line => !receiptLineById.has(line.receiptLineId))) {
          throw Object.assign(new Error('补报明细不属于该收货单'), { statusCode: 400 })
        }
        const priorClaimLines = await tx.upstreamArrivalClaimLine.findMany({
          where: {
            receiptLineId: { in: d.lines.map(line => line.receiptLineId) },
            claim: { status: { not: 'CANCELLED' }, type: 'POST_RECEIPT_DAMAGE' },
          },
          select: { receiptLineId: true, affectedQty: true },
        })
        const alreadyClaimed = new Map<string, Prisma.Decimal>()
        for (const line of priorClaimLines) {
          alreadyClaimed.set(line.receiptLineId, (alreadyClaimed.get(line.receiptLineId) || decimal(0)).plus(line.affectedQty))
        }
        let claimedAmount = decimal(0)
        for (const input of d.lines) {
          const receiptLine = receiptLineById.get(input.receiptLineId)!
          const cumulative = (alreadyClaimed.get(input.receiptLineId) || decimal(0)).plus(input.affectedQty)
          if (cumulative.greaterThan(receiptLine.acceptedQty)) {
            throw Object.assign(new Error(`${receiptLine.purchaseOrderLine.productNameSnapshot} 累计补报数量不能超过原合格收货数量`), { statusCode: 400 })
          }
          claimedAmount = claimedAmount.plus(decimal(input.affectedQty).times(receiptLine.unitPrice))
        }
        const no = await nextUpstreamDocumentNo(tx, tenantId, 'claim')
        const claim = await tx.upstreamArrivalClaim.create({
          data: {
            tenantId,
            no,
            purchaseOrderId: receipt.purchaseOrderId,
            receiptId: receipt.id,
            supplierId: receipt.supplierId,
            type: 'POST_RECEIPT_DAMAGE',
            claimedAmount: money(claimedAmount),
            description: d.description,
            evidence: d.evidence as Prisma.InputJsonValue,
            responseDueAt: deadline,
            idempotencyKey: d.idempotencyKey,
            createdById: userId,
          },
        })
        for (const input of d.lines) {
          const receiptLine = receiptLineById.get(input.receiptLineId)!
          await tx.upstreamArrivalClaimLine.create({
            data: {
              tenantId,
              claimId: claim.id,
              receiptLineId: receiptLine.id,
              purchaseOrderLineId: receiptLine.purchaseOrderLineId,
              productId: receiptLine.productId,
              affectedQty: input.affectedQty,
              purchaseUnit: receiptLine.purchaseUnit,
              unitPrice: receiptLine.unitPrice,
              claimedAmount: money(decimal(input.affectedQty).times(receiptLine.unitPrice)),
            },
          })
        }
        await tx.opLog.create({
          data: { tenantId, userId, role, action: '收货后补报到货异常', entityType: 'UpstreamArrivalClaim', target: no, targetId: claim.id },
        })
        return tx.upstreamArrivalClaim.findUnique({ where: { id: claim.id }, include: { lines: true } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      if (!result) return reply.status(404).send({ error: '已入账收货单不存在' })
      return reply.status(201).send(result)
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const existing = await prisma.upstreamArrivalClaim.findFirst({
          where: { tenantId, idempotencyKey: d.idempotencyKey },
          include: { lines: true },
        })
        if (existing) return reply.status(200).send(existing)
      }
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/arrival-claims/:id/respond', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.claim.respond')
    const claimId = idSchema.safeParse(req.params.id)
    if (!claimId.success) return reply.status(400).send({ error: '差异单标识格式不正确' })
    const parsed = supplierClaimResponseSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const changed = await prisma.upstreamArrivalClaim.updateMany({
      where: { id: claimId.data, tenantId, supplierId, status: 'PENDING_SUPPLIER' },
      data: {
        status: d.decision === 'ACCEPT' ? 'SUPPLIER_ACCEPTED' : 'SUPPLIER_REJECTED',
        supplierResponse: d.response,
        supplierRespondedAt: new Date(),
      },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '差异单不存在、无权访问或已处理' })
    await prisma.opLog.create({
      data: { tenantId, userId, role, action: `供应商${d.decision === 'ACCEPT' ? '接受' : '拒绝'}到货差异`, entityType: 'UpstreamArrivalClaim', targetId: claimId.data },
    })
    return prisma.upstreamArrivalClaim.findUnique({ where: { id: claimId.data }, include: { lines: true } })
  })

  app.post('/arrival-claims/:id/start-arbitration', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const claimId = idSchema.safeParse(req.params.id)
    if (!claimId.success) return reply.status(400).send({ error: '差异单标识格式不正确' })
    const changed = await prisma.upstreamArrivalClaim.updateMany({
      where: { id: claimId.data, tenantId, status: 'SUPPLIER_REJECTED' },
      data: { status: 'ARBITRATION', arbitratedById: userId },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '只有供应商已拒绝的差异才能仲裁' })
    return prisma.upstreamArrivalClaim.findUnique({ where: { id: claimId.data }, include: { lines: true } })
  })

  app.post('/arrival-claims/:id/resolve', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const claimId = idSchema.safeParse(req.params.id)
    if (!claimId.success) return reply.status(400).send({ error: '差异单标识格式不正确' })
    const parsed = claimResolutionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-claim:${claimId.data}`}))::text AS locked`
      const claim = await tx.upstreamArrivalClaim.findFirst({
        where: { id: claimId.data, tenantId, status: { in: ['SUPPLIER_ACCEPTED', 'ARBITRATION', 'AUTO_ACCEPTED'] } },
        include: {
          receipt: true,
          lines: { include: { receiptLine: { include: { purchaseOrderLine: true } }, product: true } },
        },
      })
      if (!claim) return null
      if (decimal(d.resolvedAmount).greaterThan(claim.claimedAmount)) {
        throw Object.assign(new Error('确认金额不能超过差异申请金额'), { statusCode: 400 })
      }
      if (claim.type === 'POST_RECEIPT_DAMAGE') {
        await postUpstreamClaimLossInTransaction(tx, {
          tenantId,
          warehouseId: claim.receipt.warehouseId,
          supplierId: claim.supplierId,
          claimId: claim.id,
          claimNo: claim.no,
          userId,
          effectiveAt: new Date(),
          lines: claim.lines.map(line => ({
            claimLineId: line.id,
            productId: line.productId,
            productName: line.product.name,
            purchaseQuantity: line.affectedQty,
            purchaseUnit: line.purchaseUnit,
            conversionFactor: line.receiptLine.inventoryUnitsPerPurchaseUnit,
            inventoryQuantity: line.affectedQty.times(line.receiptLine.inventoryUnitsPerPurchaseUnit),
            inventoryUnit: line.receiptLine.inventoryUnit,
          })),
        })
      }
      const resolvedAt = new Date()
      const saved = await tx.upstreamArrivalClaim.update({
        where: { id: claim.id },
        data: {
          status: 'RESOLVED',
          responsibility: d.responsibility,
          resolution: d.resolution,
          resolvedAmount: d.resolvedAmount,
          description: d.note ? `${claim.description}\n处理说明：${d.note}` : claim.description,
          resolvedById: userId,
          resolvedAt,
        },
        include: { lines: true },
      })
      const resolvedTotal = decimal(d.resolvedAmount)
      for (const line of claim.lines) {
        const share = claim.claimedAmount.isZero()
          ? decimal(0)
          : money(resolvedTotal.times(line.claimedAmount).dividedBy(claim.claimedAmount))
        await tx.upstreamArrivalClaimLine.update({
          where: { id: line.id },
          data: { resolvedAmount: share },
        })
      }
      await tx.opLog.create({
        data: { tenantId, userId, role, action: '办结上游到货差异', entityType: 'UpstreamArrivalClaim', target: claim.no, targetId: claim.id, metadata: d },
      })
      return saved
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (!result) return reply.status(409).send({ error: '差异单不存在或当前不可办结' })
    return result
  })

  app.get('/settlement-statements', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    const supplierId = SETTLEMENT_READ_ROLES.has(role)
      ? (typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined)
      : requireSupplierCapability(role, req.user.supplierId, 'settlement.read')
    return prisma.upstreamSettlementStatement.findMany({
      where: { tenantId, ...(supplierId ? { supplierId } : {}) },
      include: {
        supplier: { select: { id: true, no: true, name: true } },
        _count: { select: { lines: true, invoiceAllocations: true } },
      },
      orderBy: [{ periodEnd: 'desc' }, { version: 'desc' }],
      take: 200,
    })
  })

  app.get('/settlement-statements/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const supplierId = SETTLEMENT_READ_ROLES.has(role)
      ? undefined
      : requireSupplierCapability(role, req.user.supplierId, 'settlement.read')
    const statement = await prisma.upstreamSettlementStatement.findFirst({
      where: { id: statementId.data, tenantId, ...(supplierId ? { supplierId } : {}) },
      include: {
        supplier: { select: { id: true, no: true, name: true } },
        lines: { orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }] },
        invoiceAllocations: { include: { invoice: true } },
      },
    })
    if (!statement) return reply.status(404).send({ error: '对账单不存在' })
    return statement
  })

  app.post('/settlement-statements/generate', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可生成对账单' })
    const parsed = settlementGenerateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const { start, end: endDate, endExclusive } = businessDateRangeInclusive(d.periodStart, d.periodEnd)

    const supplier = await prisma.supplier.findFirst({
      where: { id: d.supplierId, tenantId, status: 'ENABLED', businessScopes: { has: 'WAREHOUSE_UPSTREAM' } },
      select: { id: true },
    })
    if (!supplier) return reply.status(400).send({ error: '上游供应商不存在或已停用' })

    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-settlement:${tenantId}:${d.supplierId}:${start.toISOString()}:${endExclusive.toISOString()}`}))::text AS locked`
      const [receiptLines, claims, previousVersion] = await Promise.all([
        tx.upstreamReceiptLine.findMany({
          where: {
            receipt: {
              tenantId,
              supplierId: d.supplierId,
              status: 'POSTED',
              postedAt: { gte: start, lt: endExclusive },
            },
            settlementLines: { none: { statement: { status: { not: 'CANCELLED' } } } },
          },
          include: { receipt: true, purchaseOrderLine: true },
          orderBy: { createdAt: 'asc' },
        }),
        tx.upstreamArrivalClaim.findMany({
          where: {
            tenantId,
            supplierId: d.supplierId,
            status: 'RESOLVED',
            resolvedAt: { gte: start, lt: endExclusive },
            responsibility: { in: ['SUPPLIER', 'SHARED'] },
            resolution: { in: ['DEDUCTION', 'SHARED_LOSS'] },
            settlementLines: { none: { statement: { status: { not: 'CANCELLED' } } } },
          },
          orderBy: { resolvedAt: 'asc' },
        }),
        tx.upstreamSettlementStatement.findFirst({
          where: { tenantId, supplierId: d.supplierId, periodStart: start, periodEnd: endDate },
          orderBy: { version: 'desc' },
          select: { version: true },
        }),
      ])
      if (receiptLines.length === 0 && claims.length === 0) {
        return { empty: true } as const
      }
      const receiptAmount = receiptLines.reduce((sum, line) => sum.plus(line.payableAmount), decimal(0))
      const deductionAmount = claims.reduce((sum, claim) => sum.plus(claim.resolvedAmount || 0), decimal(0))
      const payableAmount = money(receiptAmount.minus(deductionAmount))
      const no = await nextUpstreamDocumentNo(tx, tenantId, 'settlement')
      const statement = await tx.upstreamSettlementStatement.create({
        data: {
          tenantId,
          no,
          supplierId: d.supplierId,
          periodStart: start,
          periodEnd: endDate,
          receiptAmount: money(receiptAmount),
          deductionAmount: money(deductionAmount),
          payableAmount,
          version: (previousVersion?.version || 0) + 1,
          note: d.note || null,
          createdById: userId,
        },
      })
      for (const line of receiptLines) {
        await tx.upstreamSettlementLine.create({
          data: {
            tenantId,
            statementId: statement.id,
            sourceType: 'RECEIPT',
            sourceId: line.id,
            sourceNo: line.receipt.no,
            businessDate: line.receipt.postedAt || line.receipt.createdAt,
            receiptLineId: line.id,
            description: `${line.purchaseOrderLine.productNameSnapshot} 合格收货 ${line.acceptedQty.toString()} ${line.purchaseUnit}`,
            originalAmount: line.payableAmount,
            payableAmount: line.payableAmount,
          },
        })
      }
      for (const claim of claims) {
        const amount = claim.resolvedAmount || decimal(0)
        await tx.upstreamSettlementLine.create({
          data: {
            tenantId,
            statementId: statement.id,
            sourceType: 'CLAIM',
            sourceId: claim.id,
            sourceNo: claim.no,
            businessDate: claim.resolvedAt || claim.createdAt,
            claimId: claim.id,
            description: `到货差异扣款：${claim.description}`,
            originalAmount: amount,
            adjustmentAmount: amount.negated(),
            payableAmount: amount.negated(),
          },
        })
      }
      const orderIds = [...new Set(receiptLines.map(line => line.receipt.purchaseOrderId))]
      if (orderIds.length) {
        await tx.upstreamPurchaseOrder.updateMany({
          where: { id: { in: orderIds }, tenantId, status: 'RECEIVED' },
          data: { status: 'SETTLEMENT_PENDING', rowVersion: { increment: 1 } },
        })
      }
      await tx.opLog.create({
        data: { tenantId, userId, role, action: '生成上游月度对账单', entityType: 'UpstreamSettlementStatement', target: no, targetId: statement.id },
      })
      return { empty: false, statementId: statement.id } as const
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 })
    if (result.empty) return reply.status(409).send({ error: '该结算周期没有新的已入账收货或已办结扣款' })
    const statement = await prisma.upstreamSettlementStatement.findUnique({
      where: { id: result.statementId },
      include: { lines: { orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }] } },
    })
    return reply.status(201).send(statement)
  })

  app.post('/settlement-statements/:id/send', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const changed = await prisma.upstreamSettlementStatement.updateMany({
      where: { id: statementId.data, tenantId, status: { in: ['DRAFT', 'DISPUTED'] } },
      data: { status: 'SENT_TO_SUPPLIER', buyerConfirmedById: userId, buyerConfirmedAt: new Date() },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '对账单不存在或当前不可发送' })
    return prisma.upstreamSettlementStatement.findUnique({ where: { id: statementId.data }, include: { lines: true } })
  })

  app.post('/settlement-statements/:id/confirm', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.settlement.confirm')
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const changed = await prisma.upstreamSettlementStatement.updateMany({
      where: { id: statementId.data, tenantId, supplierId, status: 'SENT_TO_SUPPLIER' },
      data: { status: 'CONFIRMED', supplierConfirmedById: userId, supplierConfirmedAt: new Date() },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '对账单不存在、无权访问或当前不可确认' })
    return prisma.upstreamSettlementStatement.findUnique({ where: { id: statementId.data }, include: { lines: true } })
  })

  app.post('/settlement-statements/:id/dispute', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.settlement.confirm')
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const parsed = settlementDisputeSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const changed = await prisma.upstreamSettlementStatement.updateMany({
      where: { id: statementId.data, tenantId, supplierId, status: 'SENT_TO_SUPPLIER' },
      data: { status: 'DISPUTED', note: parsed.data.reason, supplierConfirmedById: userId, supplierConfirmedAt: new Date() },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '对账单不存在、无权访问或当前不可提出异议' })
    return prisma.upstreamSettlementStatement.findUnique({ where: { id: statementId.data }, include: { lines: true } })
  })

  app.post('/settlement-statements/:id/lock', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可锁定对账单' })
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const changed = await prisma.upstreamSettlementStatement.updateMany({
      where: { id: statementId.data, tenantId, status: 'CONFIRMED' },
      data: { status: 'LOCKED', lockedById: userId, lockedAt: new Date() },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '只有双方已确认的对账单可以锁定' })
    return prisma.upstreamSettlementStatement.findUnique({ where: { id: statementId.data }, include: { lines: true } })
  })

  app.post('/settlement-statements/:id/invoices', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可关联发票' })
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const parsed = settlementInvoiceAllocationSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-statement:${statementId.data}`}))::text AS locked`
      const statement = await tx.upstreamSettlementStatement.findFirst({
        where: { id: statementId.data, tenantId, status: { in: ['LOCKED', 'INVOICED'] } },
        include: { invoiceAllocations: true },
      })
      if (!statement) return null
      const invoice = await tx.invoice.findFirst({
        where: { id: d.invoiceId, tenantId, supplierId: statement.supplierId, status: 'VERIFIED' },
        include: { upstreamSettlementAllocations: true },
      })
      if (!invoice) throw Object.assign(new Error('已审核发票不存在或不属于该供应商'), { statusCode: 400 })
      const allocatedToStatement = statement.invoiceAllocations.reduce((sum, item) => sum.plus(item.amount), decimal(0))
      const allocatedToInvoice = invoice.upstreamSettlementAllocations.reduce((sum, item) => sum.plus(item.amount), decimal(0))
      const amount = decimal(d.amount)
      if (allocatedToStatement.plus(amount).greaterThan(statement.payableAmount)) {
        throw Object.assign(new Error('发票分配金额超过对账单应付余额'), { statusCode: 400 })
      }
      if (allocatedToInvoice.plus(amount).greaterThan(invoice.amount)) {
        throw Object.assign(new Error('分配金额超过发票可用余额'), { statusCode: 400 })
      }
      await tx.upstreamSettlementInvoiceAllocation.create({
        data: { tenantId, statementId: statement.id, invoiceId: invoice.id, amount, createdById: userId },
      })
      const fullyInvoiced = allocatedToStatement.plus(amount).greaterThanOrEqualTo(statement.payableAmount)
      if (fullyInvoiced && statement.status === 'LOCKED') {
        await tx.upstreamSettlementStatement.update({ where: { id: statement.id }, data: { status: 'INVOICED' } })
      }
      return { statementId: statement.id }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (!result) return reply.status(409).send({ error: '对账单不存在或尚未锁定' })
    return prisma.upstreamSettlementStatement.findUnique({
      where: { id: result.statementId },
      include: { lines: true, invoiceAllocations: { include: { invoice: true } } },
    })
  })
}
