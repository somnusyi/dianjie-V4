import { Prisma, prisma } from '@dianjie/db'
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  assertDifferentReceiptReviewer,
  assertUpstreamPurchaseOrderTransition,
  requiresUpstreamReceiptReview,
  UpstreamReceiptReviewerConflictError,
  upstreamReceiptReviewReasons,
  upstreamReceiptPriceReviewFlags,
  UpstreamPurchaseOrderStatus,
} from '../domain/upstreamProcurement'
import { requireSupplierCapability } from '../lib/supplier-access'
import { upstreamFeatureEnabled, upstreamFeatureSnapshot } from '../lib/upstream-feature-flags'
import { businessDateKey, businessDateRangeInclusive } from '../lib/businessTime'
import { hashRequestBody } from '../lib/idempotency'
import { nextUpstreamDocumentNo } from '../services/upstreamDocumentNo'
import { evaluateReceiptEvidenceCompleteness } from '../services/receiptEvidencePolicy'
import {
  approveUpstreamPurchaseReturn,
  cancelUpstreamPurchaseReturn,
  createUpstreamPurchaseReturn,
  getUpstreamPurchaseReturn,
  listReturnableUpstreamReceiptLines,
  listUpstreamPurchaseReturns,
  receiveUpstreamPurchaseReturn,
  rejectUpstreamPurchaseReturn,
  submitUpstreamPurchaseReturn,
} from '../services/upstreamPurchaseReturns'
import { postUpstreamClaimLossInTransaction, postUpstreamReceiptInTransaction, reverseUpstreamReceiptInTransaction } from '../services/warehouseLedger'
import { assertWarehouseDocumentObjects, signOssKey } from './upload'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
// Keep the API aligned with the guarded supply-chain workspace: tenant ADMIN
// can enter this workspace and may act as the required second receipt reviewer.
const INTERNAL_ROLES = new Set(['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'])
const APPROVER_ROLES = new Set(['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'])
const FINANCE_ROLES = new Set(['FINANCE', 'SUPER_ADMIN'])
const SETTLEMENT_READ_ROLES = new Set([...INTERNAL_ROLES, ...FINANCE_ROLES])
const POST_RECEIPT_SHORTAGE_ORDER_STATUSES = new Set<UpstreamPurchaseOrderStatus>(['RECEIVED', 'SETTLEMENT_PENDING', 'CLOSED'])
const idSchema = z.string().trim().min(1).max(64)
const decimalInput = z.coerce.number().finite().positive()
const nonNegativeDecimalInput = z.coerce.number().finite().min(0)
const isoDateInput = z.coerce.date()
const qualityEvidenceItemSchema = z.object({
  key: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(160),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']),
  size: z.number().int().positive().max(10 * 1024 * 1024),
}).strict()
const qualityEvidenceSchema = z.array(qualityEvidenceItemSchema).max(20)

function jsonDepth(value: unknown, depth = 0): number {
  if (!value || typeof value !== 'object') return depth
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  if (children.length === 0) return depth + 1
  return Math.max(...children.map((child) => jsonDepth(child, depth + 1)))
}

const boundedCriteriaSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) ctx.addIssue({ code: 'custom', message: '请至少填写一项质量标准' })
  if (Object.keys(value).length > 50) ctx.addIssue({ code: 'custom', message: '质量标准项不能超过50项' })
  if (jsonDepth(value) > 6) ctx.addIssue({ code: 'custom', message: '质量标准层级不能超过6层' })
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 20 * 1024) ctx.addIssue({ code: 'custom', message: '质量标准内容不能超过20KB' })
})

const qualityStandardCreateSchema = z.object({
  productId: idSchema,
  title: z.string().trim().min(2).max(160),
  criteria: boundedCriteriaSchema,
  effectiveAt: isoDateInput,
  requestKey: z.string().trim().min(8).max(160),
}).strict()

const priceStandardCreateSchema = z.object({
  productId: idSchema,
  supplierId: idSchema,
  purchaseUnit: z.string().trim().min(1).max(16),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  taxInclusive: z.boolean(),
  unitPrice: decimalInput,
  effectiveAt: isoDateInput,
  requestKey: z.string().trim().min(8).max(160),
}).strict()

const standardDeactivateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(2).max(500),
  requestKey: z.string().trim().min(8).max(160),
}).strict()

const receiptReviewSchema = z.object({
  priceExceptionReason: z.string().trim().min(2).max(500).optional(),
}).strict()

const contractCreateSchema = z
  .object({
    supplierId: idSchema,
    // 合同编号会打印/导出到正式单据: 限制长度与字符集, 挡住脚本注入和超长文本
    contractNo: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\w一-龥（）()【】\[\]#\-—_./·:：\s]+$/, '合同编号只能包含文字、数字和常用符号'),
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
    idempotencyKey: z.string().trim().min(8).max(160),
    lines: z
      .array(
        z.object({
          upstreamSourceId: idSchema,
          unitPrice: decimalInput,
          taxRate: z.coerce.number().finite().min(0).max(1).optional(),
          packageMultiple: decimalInput.default(1),
          shortTolerancePct: z.coerce.number().finite().min(0).max(1).default(0),
          overTolerancePct: z.coerce.number().finite().min(0).max(1).default(0),
          startsAt: isoDateInput.optional(),
          endsAt: isoDateInput.optional(),
        })
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.endsAt && data.endsAt < data.startsAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: '合同结束日期不能早于开始日期',
      })
    }
    const ids = data.lines.map((line) => line.upstreamSourceId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: '合同商品不能重复',
      })
    }
  })

export function upstreamContractRequestFingerprint(input: z.infer<typeof contractCreateSchema>) {
  return hashRequestBody(canonicalJson(input), 'upstream-supplier-contract-v1')
}

const purchaseOrderCreateSchema = z
  .object({
    supplierId: idSchema,
    warehouseId: idSchema,
    contractId: idSchema,
    expectedArrivalAt: isoDateInput.optional(),
    origin: z.enum(['MANUAL', 'REPLENISHMENT', 'EMERGENCY', 'HISTORICAL_BACKFILL']).default('MANUAL'),
    note: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().min(8).max(160),
    lines: z
      .array(
        z.object({
          contractLineId: idSchema,
          quantity: decimalInput,
          temporaryUnitPrice: decimalInput.optional(),
        })
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((data, ctx) => {
    const ids = data.lines.map((line) => line.contractLineId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: '采购商品不能重复',
      })
    }
  })

const revisionCreateSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    expectedArrivalAt: isoDateInput.optional(),
    lines: z
      .array(
        z.object({
          lineId: idSchema,
          quantity: decimalInput,
        })
      )
      .min(1)
      .max(500),
  })
  .strict()

const revisionReviewSchema = z
  .object({
    decision: z.enum(['ACCEPT', 'REJECT']),
    note: z.string().trim().max(500).optional(),
  })
  .strict()

const shipmentCreateSchema = z
  .object({
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
    lines: z
      .array(
        z
          .object({
            purchaseOrderLineId: idSchema,
            shippedQty: decimalInput,
            batchNo: z.string().trim().max(80).optional(),
            manufactureDate: isoDateInput.optional(),
            expiryDate: isoDateInput.optional(),
            packageInfo: z.string().trim().max(240).optional(),
          })
          .superRefine((line, ctx) => {
            if (line.manufactureDate && line.expiryDate && line.expiryDate < line.manufactureDate) {
              ctx.addIssue({
                code: 'custom',
                path: ['expiryDate'],
                message: '到期日不能早于生产日期',
              })
            }
          })
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((data, ctx) => {
    const ids = data.lines.map((line) => line.purchaseOrderLineId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: '发货商品不能重复',
      })
    }
  })

const receiptCreateSchema = z
  .object({
    arrivedAt: isoDateInput.optional(),
    finalForShipment: z.boolean().default(true),
    evidence: z.array(z.record(z.unknown())).max(20).optional(),
    note: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().min(8).max(160),
    lines: z
      .array(
        z
          .object({
            shipmentLineId: idSchema,
            arrivedQty: nonNegativeDecimalInput,
            acceptedQty: nonNegativeDecimalInput,
            damagedQty: nonNegativeDecimalInput.default(0),
            rejectedQty: nonNegativeDecimalInput.default(0),
            batchNo: z.string().trim().max(80).optional(),
            manufactureDate: isoDateInput.optional(),
            expiryDate: isoDateInput.optional(),
            evidence: z.array(z.record(z.unknown())).max(20).optional(),
            qualityResult: z.enum(['PASS', 'FAIL']).optional(),
            qualityEvidence: qualityEvidenceSchema.optional(),
            qualityDisposition: z.string().trim().max(500).optional(),
            note: z.string().trim().max(500).optional(),
          })
          .superRefine((line, ctx) => {
            if (line.acceptedQty + line.damagedQty + line.rejectedQty > line.arrivedQty + 0.000001) {
              ctx.addIssue({
                code: 'custom',
                path: ['acceptedQty'],
                message: '合格、破损和拒收数量之和不能超过实到数量',
              })
            }
            if (line.manufactureDate && line.expiryDate && line.expiryDate < line.manufactureDate) {
              ctx.addIssue({
                code: 'custom',
                path: ['expiryDate'],
                message: '到期日不能早于生产日期',
              })
            }
            if (line.qualityResult === 'FAIL') {
              if (line.acceptedQty > 0) ctx.addIssue({ code: 'custom', path: ['acceptedQty'], message: '质量验收不合格的数量不能作为合格入库' })
              if (line.rejectedQty <= 0) ctx.addIssue({ code: 'custom', path: ['rejectedQty'], message: '质量验收不合格时必须填写拒收数量' })
              if (!line.qualityEvidence?.length) ctx.addIssue({ code: 'custom', path: ['qualityEvidence'], message: '质量验收不合格必须上传证据' })
              if (!line.qualityDisposition?.trim()) ctx.addIssue({ code: 'custom', path: ['qualityDisposition'], message: '质量验收不合格必须填写处置结果' })
            }
          })
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((data, ctx) => {
    const ids = data.lines.map((line) => line.shipmentLineId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: '验收商品不能重复',
      })
    }
    // 全 0 收货单没有业务意义, 还会白占一次人工复核
    const hasAnyQuantity = data.lines.some((line) => line.arrivedQty > 0 || line.acceptedQty > 0 || line.damagedQty > 0 || line.rejectedQty > 0)
    if (!hasAnyQuantity) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: '收货数量不能全部为 0，请至少填写一项实到数量',
      })
    }
  })

const purchaseReturnCreateSchema = z
  .object({
    supplierId: idSchema,
    warehouseId: idSchema,
    reason: z.string().trim().min(2).max(240),
    note: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().min(8).max(160),
    lines: z
      .array(
        z
          .object({
            receiptLineId: idSchema,
            purchaseQuantity: decimalInput,
            note: z.string().trim().max(240).optional(),
          })
          .strict()
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((data, ctx) => {
    const ids = data.lines.map((line) => line.receiptLineId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: '同一收货明细不能重复退货',
      })
    }
  })

const purchaseReturnReasonSchema = z
  .object({
    reason: z.string().trim().min(2).max(240),
  })
  .strict()

const purchaseReturnReceiveSchema = z
  .object({
    note: z.string().trim().max(240).optional(),
  })
  .strict()

const postReceiptClaimSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(160),
    type: z.enum(['SHORTAGE', 'POST_RECEIPT_DAMAGE']).default('POST_RECEIPT_DAMAGE'),
    description: z.string().trim().min(2).max(1000),
    evidence: z.array(z.record(z.unknown())).min(1).max(20),
    lines: z
      .array(
        z
          .object({
            purchaseOrderLineId: idSchema.optional(),
            receiptLineId: idSchema.optional(),
            affectedQty: decimalInput,
          })
          .superRefine((line, ctx) => {
            if (!line.purchaseOrderLineId && !line.receiptLineId) {
              ctx.addIssue({ code: 'custom', message: '补报商品标识必填' })
            }
          })
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((data, ctx) => {
    const lineKeys = data.lines.map((line) => line.purchaseOrderLineId || line.receiptLineId)
    if (new Set(lineKeys).size !== lineKeys.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: '同一商品不能重复补报',
      })
    }
  })

const receiptReversalSchema = z
  .object({
    reason: z.string().trim().min(2).max(240),
    idempotencyKey: z.string().trim().min(8).max(160),
  })
  .strict()

const supplierClaimResponseSchema = z
  .object({
    decision: z.enum(['ACCEPT', 'REJECT']),
    response: z.string().trim().min(1).max(1000),
    evidence: z
      .array(
        z.object({
          url: z.string().trim().min(1).max(500),
          name: z.string().trim().max(200).optional(),
        })
      )
      .max(4)
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // 手册要求异议必须带举证照片
    if (data.decision === 'REJECT' && !(data.evidence && data.evidence.length > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: '提出异议时至少上传 1 张举证照片',
      })
    }
  })

const claimResolutionSchema = z
  .object({
    responsibility: z.enum(['SUPPLIER', 'BUYER', 'SHARED']),
    resolution: z.enum(['DEDUCTION', 'REPLACEMENT', 'RETURN', 'SHARED_LOSS', 'BUYER_ABSORB', 'NO_ACTION']),
    resolvedAmount: nonNegativeDecimalInput,
    note: z.string().trim().max(1000).optional(),
  })
  .strict()

const settlementGenerateSchema = z
  .object({
    supplierId: idSchema,
    periodStart: isoDateInput,
    periodEnd: isoDateInput,
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.periodEnd < data.periodStart) {
      ctx.addIssue({
        code: 'custom',
        path: ['periodEnd'],
        message: '结算结束日期不能早于开始日期',
      })
    }
  })

const settlementDisputeSchema = z
  .object({
    reason: z.string().trim().min(2).max(1000),
  })
  .strict()

const settlementInvoiceAllocationSchema = z
  .object({
    invoiceId: idSchema,
    amount: decimalInput,
  })
  .strict()

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value)
}

function money(value: Prisma.Decimal) {
  return value.toDecimalPlaces(4)
}

type UpstreamSettlementClaimDeductionInput = {
  type: string
  resolvedAmount: Prisma.Decimal.Value | null
  lines?: Array<{
    receiptLine?: {
      acceptedQty: Prisma.Decimal.Value
      arrivedQty: Prisma.Decimal.Value
      overageQty: Prisma.Decimal.Value
      unitPrice: Prisma.Decimal.Value
    } | null
  }>
}

/**
 * Only amounts that were already included in receipt payable may be deducted
 * again during settlement. Initial shortage/damage/quality quantities were
 * excluded from acceptedQty. Overage is mixed: only its accepted portion was
 * paid, so cap the deduction to that included amount.
 */
export function upstreamSettlementClaimDeduction(claim: UpstreamSettlementClaimDeductionInput) {
  const resolvedAmount = Prisma.Decimal.max(decimal(0), decimal(claim.resolvedAmount || 0))
  if (claim.type === 'POST_RECEIPT_DAMAGE') return money(resolvedAmount)
  if (claim.type !== 'OVERAGE') return decimal(0)

  const includedOverageAmount = (claim.lines || []).reduce((sum, line) => {
    if (!line.receiptLine) return sum
    const receiptLine = line.receiptLine
    const overageQty = decimal(receiptLine.overageQty)
    const regularArrivedQty = Prisma.Decimal.max(decimal(0), decimal(receiptLine.arrivedQty).minus(overageQty))
    const acceptedOverageQty = Prisma.Decimal.min(overageQty, Prisma.Decimal.max(decimal(0), decimal(receiptLine.acceptedQty).minus(regularArrivedQty)))
    return sum.plus(acceptedOverageQty.times(receiptLine.unitPrice))
  }, decimal(0))
  return money(Prisma.Decimal.min(resolvedAmount, includedOverageAmount))
}

type PostReceiptClaimInput = z.infer<typeof postReceiptClaimSchema>
type PostReceiptClaimReceipt = {
  lines: any[]
  purchaseOrder: { lines: any[] }
}

export function normalizePostReceiptClaimLines(input: PostReceiptClaimInput, receipt: PostReceiptClaimReceipt) {
  const receiptLineById = new Map(receipt.lines.map((line) => [line.id, line]))
  const orderLineById = new Map(receipt.purchaseOrder.lines.map((line) => [line.id, line]))
  const normalized = input.lines.map((lineInput) => {
    const receiptLine = lineInput.receiptLineId ? receiptLineById.get(lineInput.receiptLineId) : undefined
    if (lineInput.receiptLineId && !receiptLine) {
      throw Object.assign(new Error('补报明细不属于该收货单'), {
        statusCode: 400,
      })
    }
    const purchaseOrderLineId = lineInput.purchaseOrderLineId || receiptLine?.purchaseOrderLineId
    const purchaseOrderLine = purchaseOrderLineId ? orderLineById.get(purchaseOrderLineId) : undefined
    if (!purchaseOrderLine) {
      throw Object.assign(new Error('补报商品不属于该收货单对应的采购单'), {
        statusCode: 400,
      })
    }
    if (receiptLine && receiptLine.purchaseOrderLineId !== purchaseOrderLine.id) {
      throw Object.assign(new Error('收货明细与采购商品不匹配'), {
        statusCode: 400,
      })
    }
    if (input.type === 'POST_RECEIPT_DAMAGE' && !receiptLine) {
      throw Object.assign(new Error(`${purchaseOrderLine.productNameSnapshot} 本次没有合格收货数量，不能按收货后破损补报`), { statusCode: 400 })
    }
    return { input: lineInput, receiptLine, purchaseOrderLine }
  })

  const seenPurchaseOrderLineIds = new Set<string>()
  for (const line of normalized) {
    if (seenPurchaseOrderLineIds.has(line.purchaseOrderLine.id)) {
      throw Object.assign(new Error('同一商品不能重复补报'), {
        statusCode: 400,
      })
    }
    seenPurchaseOrderLineIds.add(line.purchaseOrderLine.id)
  }
  return normalized
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)])
    )
  }
  return value
}

export function standardReplacementArchiveRequestKey(kind: 'quality' | 'price', requestKey: string, fingerprint: string) {
  return `replace:${hashRequestBody({ requestKey, fingerprint }, `${kind}-standard-replacement-v1`)}`
}

export function upstreamReceiptRequestFingerprint(shipmentId: string, input: z.infer<typeof receiptCreateSchema>) {
  return hashRequestBody({
    shipmentId,
    arrivedAt: input.arrivedAt?.toISOString() || null,
    finalForShipment: input.finalForShipment,
    evidence: canonicalJson(input.evidence || []),
    note: input.note || null,
    lines: input.lines
      .map((line) => ({
        shipmentLineId: line.shipmentLineId,
        arrivedQty: decimal(line.arrivedQty).toString(),
        acceptedQty: decimal(line.acceptedQty).toString(),
        damagedQty: decimal(line.damagedQty).toString(),
        rejectedQty: decimal(line.rejectedQty).toString(),
        batchNo: line.batchNo || null,
        manufactureDate: line.manufactureDate?.toISOString() || null,
        expiryDate: line.expiryDate?.toISOString() || null,
        evidence: canonicalJson(line.evidence || []),
        qualityResult: line.qualityResult || null,
        qualityEvidence: canonicalJson(line.qualityEvidence || []),
        qualityDisposition: line.qualityDisposition || null,
        note: line.note || null,
      }))
      .sort((left, right) => left.shipmentLineId.localeCompare(right.shipmentLineId)),
  }, 'upstream-receipt-create-v2')
}

export function postReceiptClaimRequestFingerprint(input: { receiptId: string; claim: PostReceiptClaimInput; normalizedLines: ReturnType<typeof normalizePostReceiptClaimLines> }) {
  return hashRequestBody(
    {
      receiptId: input.receiptId,
      type: input.claim.type,
      description: input.claim.description,
      evidence: canonicalJson(input.claim.evidence),
      lines: input.normalizedLines
        .map((line) => ({
          purchaseOrderLineId: line.purchaseOrderLine.id,
          receiptLineId: line.receiptLine?.id || null,
          affectedQty: decimal(line.input.affectedQty).toString(),
        }))
        .sort((left, right) => left.purchaseOrderLineId.localeCompare(right.purchaseOrderLineId)),
    },
    'upstream-post-receipt-claim-v1'
  )
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

const standardListQuerySchema = z.object({
  productId: idSchema.optional(),
  supplierId: idSchema.optional(),
  includeArchived: z.enum(['0', '1']).optional().default('0').transform((value) => value === '1'),
}).strict()

async function standardActor(tenantId: string, userId: string) {
  const actor = await prisma.user.findFirst({
    where: { tenantId, id: userId, status: 'ACTIVE' },
    select: { id: true, name: true, role: true },
  })
  if (!actor) throw Object.assign(new Error('操作人账号不存在或已停用'), { statusCode: 403 })
  return actor
}

function qualityStandardView(record: any) {
  return {
    id: record.id,
    productId: record.productId,
    version: record.version,
    title: record.title,
    criteria: record.criteria,
    effectiveAt: record.effectiveAt,
    active: record.active,
    createdByName: record.createdByNameSnapshot,
    createdByRole: record.createdByRoleSnapshot,
    createdAt: record.createdAt,
    archivedAt: record.archivedAt,
    archivedByName: record.archivedByNameSnapshot,
    archivedByRole: record.archivedByRoleSnapshot,
    ...(record.product ? { product: record.product } : {}),
  }
}

function priceStandardView(record: any) {
  return {
    id: record.id,
    productId: record.productId,
    supplierId: record.supplierId,
    version: record.version,
    purchaseUnit: record.purchaseUnit,
    currency: record.currency,
    taxInclusive: record.taxInclusive,
    unitPrice: record.unitPrice,
    effectiveAt: record.effectiveAt,
    active: record.active,
    createdByName: record.createdByNameSnapshot,
    createdByRole: record.createdByRoleSnapshot,
    createdAt: record.createdAt,
    archivedAt: record.archivedAt,
    archivedByName: record.archivedByNameSnapshot,
    archivedByRole: record.archivedByRoleSnapshot,
    ...(record.product ? { product: record.product } : {}),
    ...(record.supplier ? { supplier: record.supplier } : {}),
  }
}

async function runStandardTransaction<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation()
    } catch (error: any) {
      lastError = error
      if (!['P2002', 'P2034'].includes(error?.code) || attempt === 2) throw error
    }
  }
  throw lastError
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
        where: {
          tenantId,
          status: 'ENABLED',
          businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
        },
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
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  spec: true,
                  inventoryUnit: true,
                  unit: true,
                },
              },
            },
            orderBy: { product: { name: 'asc' } },
          })
        : Promise.resolve([]),
    ])
    return { suppliers, warehouses, sources }
  })

  app.get('/quality-standards', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureInternal(role, reply)) return
    const parsed = standardListQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const records = await prisma.productQualityStandard.findMany({
      where: {
        tenantId,
        ...(parsed.data.productId ? { productId: parsed.data.productId } : {}),
        ...(!parsed.data.includeArchived ? { active: true } : {}),
      },
      include: { product: { select: { id: true, code: true, name: true, spec: true } } },
      orderBy: [{ product: { name: 'asc' } }, { version: 'desc' }],
    })
    return records.map(qualityStandardView)
  })

  app.post('/quality-standards', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const parsed = qualityStandardCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    if (businessDateKey(d.effectiveAt) > businessDateKey()) return reply.status(400).send({ error: '暂不支持未来日期生效，请在生效当日更新质量标准' })
    const fingerprint = hashRequestBody(canonicalJson({
      productId: d.productId,
      title: d.title,
      criteria: d.criteria,
      effectiveAt: d.effectiveAt.toISOString(),
    }), 'product-quality-standard-v1')
    try {
      const actor = await standardActor(tenantId, userId)
      const result = await runStandardTransaction(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`quality-standard:${tenantId}:${d.productId}`}))::text AS locked`
        const replay = await tx.productQualityStandard.findFirst({ where: { tenantId, requestKey: d.requestKey } })
        if (replay) {
          if (replay.requestFingerprint !== fingerprint) throw Object.assign(new Error('同一 requestKey 不能用于不同质量标准'), { statusCode: 409 })
          return { record: replay, replayed: true }
        }
        const product = await tx.product.findFirst({ where: { tenantId, id: d.productId }, select: { id: true, name: true } })
        if (!product) throw Object.assign(new Error('商品不存在'), { statusCode: 400 })
        const latest = await tx.productQualityStandard.findFirst({
          where: { tenantId, productId: d.productId },
          orderBy: { version: 'desc' },
          select: { version: true },
        })
        const now = new Date()
        await tx.productQualityStandard.updateMany({
          where: { tenantId, productId: d.productId, active: true },
          data: {
            active: false,
            archivedAt: now,
            archivedById: actor.id,
            archivedByNameSnapshot: actor.name,
            archivedByRoleSnapshot: actor.role,
            archiveRequestKey: standardReplacementArchiveRequestKey('quality', d.requestKey, fingerprint),
            archiveRequestFingerprint: fingerprint,
          },
        })
        const record = await tx.productQualityStandard.create({
          data: {
            tenantId,
            productId: d.productId,
            version: (latest?.version || 0) + 1,
            title: d.title,
            criteria: canonicalJson(d.criteria) as Prisma.InputJsonValue,
            effectiveAt: d.effectiveAt,
            createdById: actor.id,
            createdByNameSnapshot: actor.name,
            createdByRoleSnapshot: actor.role,
            requestKey: d.requestKey,
            requestFingerprint: fingerprint,
          },
        })
        await tx.opLog.create({
          data: {
            tenantId,
            userId,
            role,
            action: '更新商品质量验收标准',
            entityType: 'ProductQualityStandard',
            target: product.name,
            targetId: record.id,
            metadata: { productId: product.id, version: record.version },
          },
        })
        return { record, replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }))
      return reply.status(result.replayed ? 200 : 201).send(qualityStandardView(result.record))
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (['P2002', 'P2034'].includes(error?.code)) return reply.status(409).send({ error: '质量标准正在被其他人更新，请刷新后重试' })
      throw error
    }
  })

  app.post('/quality-standards/:id/deactivate', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const standardId = idSchema.safeParse(req.params.id)
    const parsed = standardDeactivateSchema.safeParse(req.body)
    if (!standardId.success) return reply.status(400).send({ error: '标准标识格式不正确' })
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const fingerprint = hashRequestBody({ standardId: standardId.data, expectedVersion: d.expectedVersion, reason: d.reason }, 'quality-standard-deactivate-v1')
    try {
      const actor = await standardActor(tenantId, userId)
      const result = await runStandardTransaction(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`quality-standard-id:${tenantId}:${standardId.data}`}))::text AS locked`
        const replay = await tx.productQualityStandard.findFirst({ where: { tenantId, archiveRequestKey: d.requestKey } })
        if (replay) {
          if (replay.id !== standardId.data || replay.archiveRequestFingerprint !== fingerprint) throw Object.assign(new Error('同一 requestKey 不能用于不同停用操作'), { statusCode: 409 })
          return { record: replay, replayed: true }
        }
        const current = await tx.productQualityStandard.findFirst({ where: { tenantId, id: standardId.data } })
        if (!current) throw Object.assign(new Error('质量标准不存在'), { statusCode: 404 })
        if (!current.active || current.version !== d.expectedVersion) throw Object.assign(new Error('质量标准已变更，请刷新后再停用'), { statusCode: 409 })
        const record = await tx.productQualityStandard.update({
          where: { id: current.id },
          data: {
            active: false,
            archivedAt: new Date(),
            archivedById: actor.id,
            archivedByNameSnapshot: actor.name,
            archivedByRoleSnapshot: actor.role,
            archiveRequestKey: d.requestKey,
            archiveRequestFingerprint: fingerprint,
          },
        })
        await tx.opLog.create({ data: { tenantId, userId, role, action: '停用商品质量验收标准', entityType: 'ProductQualityStandard', targetId: record.id, metadata: { reason: d.reason, version: record.version } } })
        return { record, replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }))
      return reply.status(200).send(qualityStandardView(result.record))
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (['P2002', 'P2034'].includes(error?.code)) return reply.status(409).send({ error: '质量标准正在被更新，请刷新后重试' })
      throw error
    }
  })

  app.get('/price-standards', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureInternal(role, reply)) return
    const parsed = standardListQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const records = await prisma.productPurchasePriceStandard.findMany({
      where: {
        tenantId,
        ...(parsed.data.productId ? { productId: parsed.data.productId } : {}),
        ...(parsed.data.supplierId ? { supplierId: parsed.data.supplierId } : {}),
        ...(!parsed.data.includeArchived ? { active: true } : {}),
      },
      include: {
        product: { select: { id: true, code: true, name: true, spec: true } },
        supplier: { select: { id: true, no: true, name: true } },
      },
      orderBy: [{ product: { name: 'asc' } }, { version: 'desc' }],
    })
    return records.map(priceStandardView)
  })

  app.post('/price-standards', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const parsed = priceStandardCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    if (businessDateKey(d.effectiveAt) > businessDateKey()) return reply.status(400).send({ error: '暂不支持未来日期生效，请在生效当日更新价格标准' })
    const normalizedPrice = decimal(d.unitPrice).toFixed(6)
    const fingerprint = hashRequestBody(canonicalJson({
      productId: d.productId,
      supplierId: d.supplierId,
      purchaseUnit: d.purchaseUnit,
      currency: d.currency,
      taxInclusive: d.taxInclusive,
      unitPrice: normalizedPrice,
      effectiveAt: d.effectiveAt.toISOString(),
    }), 'product-purchase-price-standard-v1')
    try {
      const actor = await standardActor(tenantId, userId)
      const result = await runStandardTransaction(() => prisma.$transaction(async (tx) => {
        const scopeKey = `price-standard:${tenantId}:${d.productId}:${d.supplierId}:${d.purchaseUnit}:${d.currency}:${d.taxInclusive}`
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${scopeKey}))::text AS locked`
        const replay = await tx.productPurchasePriceStandard.findFirst({ where: { tenantId, requestKey: d.requestKey } })
        if (replay) {
          if (replay.requestFingerprint !== fingerprint) throw Object.assign(new Error('同一 requestKey 不能用于不同价格标准'), { statusCode: 409 })
          return { record: replay, replayed: true }
        }
        const [product, supplier, source] = await Promise.all([
          tx.product.findFirst({ where: { tenantId, id: d.productId }, select: { id: true, name: true } }),
          tx.supplier.findFirst({
            where: { tenantId, id: d.supplierId, status: 'ENABLED', businessScopes: { has: 'WAREHOUSE_UPSTREAM' } },
            select: { id: true, name: true },
          }),
          tx.productUpstreamSource.findFirst({
            where: {
              tenantId,
              supplierId: d.supplierId,
              productId: d.productId,
              purchaseUnit: d.purchaseUnit,
              isActive: true,
            },
            select: { id: true },
          }),
        ])
        if (!product) throw Object.assign(new Error('商品不存在'), { statusCode: 400 })
        if (!supplier) throw Object.assign(new Error('上游供应商不存在或已停用'), { statusCode: 400 })
        if (!source) throw Object.assign(new Error('该供应商与商品没有启用中的同采购单位供货关系'), { statusCode: 400 })
        const latest = await tx.productPurchasePriceStandard.findFirst({
          where: { tenantId, productId: d.productId, supplierId: d.supplierId, purchaseUnit: d.purchaseUnit, currency: d.currency, taxInclusive: d.taxInclusive },
          orderBy: { version: 'desc' },
          select: { version: true },
        })
        const now = new Date()
        await tx.productPurchasePriceStandard.updateMany({
          where: { tenantId, productId: d.productId, supplierId: d.supplierId, purchaseUnit: d.purchaseUnit, currency: d.currency, taxInclusive: d.taxInclusive, active: true },
          data: {
            active: false,
            archivedAt: now,
            archivedById: actor.id,
            archivedByNameSnapshot: actor.name,
            archivedByRoleSnapshot: actor.role,
            archiveRequestKey: standardReplacementArchiveRequestKey('price', d.requestKey, fingerprint),
            archiveRequestFingerprint: fingerprint,
          },
        })
        const record = await tx.productPurchasePriceStandard.create({
          data: {
            tenantId,
            productId: d.productId,
            supplierId: d.supplierId,
            version: (latest?.version || 0) + 1,
            purchaseUnit: d.purchaseUnit,
            currency: d.currency,
            taxInclusive: d.taxInclusive,
            unitPrice: normalizedPrice,
            effectiveAt: d.effectiveAt,
            createdById: actor.id,
            createdByNameSnapshot: actor.name,
            createdByRoleSnapshot: actor.role,
            requestKey: d.requestKey,
            requestFingerprint: fingerprint,
          },
        })
        await tx.opLog.create({
          data: {
            tenantId,
            userId,
            role,
            action: '更新商品标准采购价',
            entityType: 'ProductPurchasePriceStandard',
            target: `${supplier.name} / ${product.name}`,
            targetId: record.id,
            metadata: { productId: product.id, supplierId: supplier.id, version: record.version, purchaseUnit: d.purchaseUnit, currency: d.currency, taxInclusive: d.taxInclusive },
          },
        })
        return { record, replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }))
      return reply.status(result.replayed ? 200 : 201).send(priceStandardView(result.record))
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (['P2002', 'P2034'].includes(error?.code)) return reply.status(409).send({ error: '价格标准正在被其他人更新，请刷新后重试' })
      throw error
    }
  })

  app.post('/price-standards/:id/deactivate', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const standardId = idSchema.safeParse(req.params.id)
    const parsed = standardDeactivateSchema.safeParse(req.body)
    if (!standardId.success) return reply.status(400).send({ error: '标准标识格式不正确' })
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const fingerprint = hashRequestBody({ standardId: standardId.data, expectedVersion: d.expectedVersion, reason: d.reason }, 'price-standard-deactivate-v1')
    try {
      const actor = await standardActor(tenantId, userId)
      const result = await runStandardTransaction(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`price-standard-id:${tenantId}:${standardId.data}`}))::text AS locked`
        const replay = await tx.productPurchasePriceStandard.findFirst({ where: { tenantId, archiveRequestKey: d.requestKey } })
        if (replay) {
          if (replay.id !== standardId.data || replay.archiveRequestFingerprint !== fingerprint) throw Object.assign(new Error('同一 requestKey 不能用于不同停用操作'), { statusCode: 409 })
          return { record: replay, replayed: true }
        }
        const current = await tx.productPurchasePriceStandard.findFirst({ where: { tenantId, id: standardId.data } })
        if (!current) throw Object.assign(new Error('价格标准不存在'), { statusCode: 404 })
        if (!current.active || current.version !== d.expectedVersion) throw Object.assign(new Error('价格标准已变更，请刷新后再停用'), { statusCode: 409 })
        const record = await tx.productPurchasePriceStandard.update({
          where: { id: current.id },
          data: {
            active: false,
            archivedAt: new Date(),
            archivedById: actor.id,
            archivedByNameSnapshot: actor.name,
            archivedByRoleSnapshot: actor.role,
            archiveRequestKey: d.requestKey,
            archiveRequestFingerprint: fingerprint,
          },
        })
        await tx.opLog.create({ data: { tenantId, userId, role, action: '停用商品标准采购价', entityType: 'ProductPurchasePriceStandard', targetId: record.id, metadata: { reason: d.reason, version: record.version } } })
        return { record, replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }))
      return reply.status(200).send(priceStandardView(result.record))
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (['P2002', 'P2034'].includes(error?.code)) return reply.status(409).send({ error: '价格标准正在被更新，请刷新后重试' })
      throw error
    }
  })

  app.get('/workbench', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user

    if (INTERNAL_ROLES.has(role)) {
      const [orders, shipments, receipts, claims, statements] = await Promise.all([
        prisma.upstreamPurchaseOrder.count({
          where: {
            tenantId,
            status: { in: ['PENDING_APPROVAL', 'CHANGE_PROPOSED'] },
          },
        }),
        prisma.upstreamShipment.count({
          where: {
            tenantId,
            status: { in: ['SHIPPED', 'PARTIALLY_RECEIVED'] },
          },
        }),
        prisma.upstreamReceipt.count({
          where: {
            tenantId,
            status: { in: ['DRAFT', 'INSPECTING', 'PENDING_REVIEW'] },
          },
        }),
        prisma.upstreamArrivalClaim.count({
          where: {
            tenantId,
            status: {
              in: ['SUPPLIER_ACCEPTED', 'SUPPLIER_REJECTED', 'ARBITRATION', 'AUTO_ACCEPTED'],
            },
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
          status: {
            in: ['SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED'],
          },
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
    const reviewParsed = receiptReviewSchema.safeParse(req.body || {})
    if (!reviewParsed.success) return reply.status(400).send({ error: reviewParsed.error.issues[0].message })
    const reviewData = reviewParsed.data

    try {
      const result = await prisma.$transaction(
        async (tx) => {
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
                  product: { select: { category: true, evidenceRequirement: true, requiredEvidenceTypes: true } },
                  purchaseOrderLine: true,
                  shipmentLine: true,
                },
              },
            },
          })
          if (!receipt) return null
          if (review) assertDifferentReceiptReviewer(receipt.inspectorId || '', userId)

          const sensitiveCategories = new Set(receipt.supplier.upstreamSensitiveCategories)
          const { hasAboveStandardPrice, hasTemporaryPriceWithoutStandard } = upstreamReceiptPriceReviewFlags(
            receipt.lines.map((line) => ({
              unitPrice: line.unitPrice,
              standardUnitPriceSnapshot: line.standardUnitPriceSnapshot,
              isTemporaryPrice: line.purchaseOrderLine.isTemporaryPrice,
            }))
          )
          const reviewInput = {
            payableAmount: Number(receipt.payableAmount),
            reviewAmountThreshold: Number(receipt.supplier.upstreamReceiptReviewThreshold),
            hasOverReceipt: receipt.lines.some((line) => line.overageQty.gt(0)),
            // 逐行判断：有标准价的行只在超标时复核；无标准价的临时价行仍按旧规则复核。
            hasTemporaryPrice: hasTemporaryPriceWithoutStandard,
            hasAboveStandardPrice,
            hasSensitiveCategory: receipt.lines.some((line) => sensitiveCategories.has(line.product.category)),
          }
          const reviewReasons = upstreamReceiptReviewReasons(reviewInput)
          if (review && reviewReasons.includes('ABOVE_STANDARD_PRICE') && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
            throw Object.assign(new Error('实际采购价高于标准价，仅管理员可批准价格例外'), { statusCode: 403 })
          }
          if (review && reviewReasons.includes('ABOVE_STANDARD_PRICE') && !reviewData.priceExceptionReason) {
            throw Object.assign(new Error('实际采购价高于标准价，复核人必须填写价格例外原因'), { statusCode: 400 })
          }
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

          const orderLineById = new Map(receipt.purchaseOrder.lines.map((line) => [line.id, line]))
          for (const line of receipt.lines) {
            const orderLine = orderLineById.get(line.purchaseOrderLineId)!
            const target = orderLine.confirmedQty || orderLine.orderedQty
            const maximum = target.times(decimal(1).plus(orderLine.overTolerancePct))
            if (orderLine.receivedQty.plus(line.acceptedQty).greaterThan(maximum)) {
              // 分清场景: 已收满多为「重复登记/页面没刷新」, 与真正的超上限是两回事
              const alreadyFull = orderLine.receivedQty.greaterThanOrEqualTo(maximum)
              throw Object.assign(
                new Error(
                  alreadyFull
                    ? `${orderLine.productNameSnapshot} 已完成全部收货，该发货单可能刚被他人验收，请刷新页面核对状态`
                    : `${orderLine.productNameSnapshot} 累计合格收货超过合同允许上限 ${maximum.toString()} ${orderLine.purchaseUnit}`
                ),
                { statusCode: 409 }
              )
            }
          }

          const ledgerLines = receipt.lines
            .filter((line) => line.acceptedQty.gt(0))
            .map((line) => ({
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
          const evidenceCompleteness = await evaluateReceiptEvidenceCompleteness(tx, {
            tenantId,
            supplierId: receipt.supplierId,
            businessAt: receipt.arrivedAt || new Date(),
            lines: receipt.lines,
          })
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

          const claimCandidates = receipt.lines.flatMap((line) => {
            const candidates: Array<{
              type: 'SHORTAGE' | 'DAMAGE' | 'QUALITY' | 'OVERAGE'
              qty: Prisma.Decimal
            }> = []
            if (line.shortageQty.gt(0)) candidates.push({ type: 'SHORTAGE', qty: line.shortageQty })
            if (line.damagedQty.gt(0)) candidates.push({ type: 'DAMAGE', qty: line.damagedQty })
            if (line.rejectedQty.gt(0)) candidates.push({ type: 'QUALITY', qty: line.rejectedQty })
            if (line.overageQty.gt(0)) candidates.push({ type: 'OVERAGE', qty: line.overageQty })
            return candidates.map((candidate) => ({ line, ...candidate }))
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
                select: {
                  receiptId: true,
                  arrivedQty: true,
                  shortageQty: true,
                },
              },
            },
          })
          const allDispatched = receipt.purchaseOrder.lines.every((line) => line.shippedQty.greaterThanOrEqualTo(line.confirmedQty || line.orderedQty))
          const allDispatchedQuantitiesInspected = orderShipmentLines.every((line) => {
            const previouslyAccounted = line.receiptLines.reduce((sum, item) => sum.plus(item.arrivedQty).plus(item.shortageQty), decimal(0))
            const currentLine = receipt.lines.find((item) => item.shipmentLineId === line.id)
            return previouslyAccounted
              .plus(currentLine?.arrivedQty || decimal(0))
              .plus(currentLine?.shortageQty || decimal(0))
              .greaterThanOrEqualTo(line.shippedQty)
          })
          const nextOrderStatus = allDispatched && allDispatchedQuantitiesInspected ? 'RECEIVED' : 'PARTIALLY_RECEIVED'
          const now = new Date()
          const priceExceptionApprover = review && reviewReasons.includes('ABOVE_STANDARD_PRICE')
            ? await tx.user.findFirst({ where: { tenantId, id: userId, status: 'ACTIVE' }, select: { id: true, name: true, role: true } })
            : null
          if (review && reviewReasons.includes('ABOVE_STANDARD_PRICE') && !priceExceptionApprover) {
            throw Object.assign(new Error('价格例外复核人账号不存在或已停用'), { statusCode: 403 })
          }
          if (receipt.shipment) {
            const priorLines = await tx.upstreamReceiptLine.findMany({
              where: {
                shipmentLineId: {
                  in: receipt.shipment.lines.map((line) => line.id),
                },
                receiptId: { not: receipt.id },
                receipt: { status: 'POSTED' },
              },
              select: {
                shipmentLineId: true,
                arrivedQty: true,
                shortageQty: true,
              },
            })
            const processed = new Map<string, Prisma.Decimal>()
            for (const line of priorLines) {
              if (!line.shipmentLineId) continue
              processed.set(line.shipmentLineId, (processed.get(line.shipmentLineId) || decimal(0)).plus(line.arrivedQty).plus(line.shortageQty))
            }
            for (const line of receipt.lines) {
              if (!line.shipmentLineId) continue
              processed.set(line.shipmentLineId, (processed.get(line.shipmentLineId) || decimal(0)).plus(line.arrivedQty).plus(line.shortageQty))
            }
            const shipmentReceived = receipt.shipment.lines.every((line) => (processed.get(line.id) || decimal(0)).greaterThanOrEqualTo(line.shippedQty))
            await tx.upstreamShipment.update({
              where: { id: receipt.shipment.id },
              data: {
                status: shipmentReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
              },
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
              ...(priceExceptionApprover ? {
                priceExceptionReason: reviewData.priceExceptionReason,
                priceExceptionApprovedById: priceExceptionApprover.id,
                priceExceptionApprovedByNameSnapshot: priceExceptionApprover.name,
                priceExceptionApprovedByRoleSnapshot: priceExceptionApprover.role,
                priceExceptionApprovedAt: now,
              } : {}),
              evidenceCompletenessSnapshot: evidenceCompleteness as Prisma.InputJsonValue,
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
              metadata: {
                receiptId: receipt.id,
                receiptNo: receipt.no,
                claimIds,
                reviewReasons,
                ...(priceExceptionApprover ? {
                  priceExceptionReason: reviewData.priceExceptionReason,
                  priceExceptionApprovedById: priceExceptionApprover.id,
                  priceExceptionApprovedByNameSnapshot: priceExceptionApprover.name,
                  priceExceptionApprovedByRoleSnapshot: priceExceptionApprover.role,
                } : {}),
              },
            },
          })
          return { pendingReview: false, receipt: posted, claimIds }
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 20_000,
        }
      )
      if (!result) return reply.status(409).send({ error: '收货单不存在或当前状态不可确认' })
      return result
    } catch (error: any) {
      if (error instanceof UpstreamReceiptReviewerConflictError) {
        return reply.status(409).send({ error: error.message })
      }
      if (error?.code === 'P2034' || (error?.code === 'P2010' && String(error?.meta?.code || '') === '40001')) {
        return reply.status(409).send({ error: '收货单正在被处理，请刷新后查看结果' })
      }
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  }

  app.get('/contracts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const supplierId = INTERNAL_ROLES.has(role) ? (typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined) : supplierScope(req, 'upstream.order.read')
    return prisma.upstreamSupplierContract.findMany({
      where: { tenantId, ...(supplierId ? { supplierId } : {}) },
      include: {
        supplier: { select: { id: true, no: true, name: true } },
        lines: true,
      },
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
    const requestFingerprint = upstreamContractRequestFingerprint(d)

    const replay = await prisma.upstreamSupplierContract.findUnique({
      where: {
        tenantId_idempotencyKey: { tenantId, idempotencyKey: d.idempotencyKey },
      },
      include: { lines: true },
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        return reply.status(409).send({ error: '同一幂等键不能用于不同合同内容' })
      }
      reply.header('Idempotent-Replay', 'true')
      return reply.status(200).send(replay)
    }

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

    const sourceIds = d.lines.map((line) => line.upstreamSourceId)
    const sources = await prisma.productUpstreamSource.findMany({
      where: {
        id: { in: sourceIds },
        tenantId,
        supplierId: d.supplierId,
        isActive: true,
      },
      include: { product: true },
    })
    if (sources.length !== sourceIds.length) {
      return reply.status(400).send({ error: '合同商品来源不存在、已停用或不属于该供应商' })
    }
    const sourceById = new Map(sources.map((source) => [source.id, source]))

    let contract
    try {
      contract = await prisma.$transaction(
        async (tx) => {
          const previous = await tx.upstreamSupplierContract.findFirst({
            where: {
              tenantId,
              supplierId: d.supplierId,
              contractNo: d.contractNo,
            },
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
              idempotencyKey: d.idempotencyKey,
              requestFingerprint,
              createdById: userId,
              lines: {
                create: d.lines.map((line) => {
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      )
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const concurrentReplay = await prisma.upstreamSupplierContract.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId,
              idempotencyKey: d.idempotencyKey,
            },
          },
          include: { lines: true },
        })
        if (concurrentReplay) {
          if (concurrentReplay.requestFingerprint !== requestFingerprint) {
            return reply.status(409).send({ error: '同一幂等键不能用于不同合同内容' })
          }
          reply.header('Idempotent-Replay', 'true')
          return reply.status(200).send(concurrentReplay)
        }
        return reply.status(409).send({ error: '合同版本已被其他操作更新，请刷新后重试' })
      }
      if (error?.code === 'P2034') {
        // Serializable 冲突时，同键的并发请求可能正在提交；短暂回读使败方回放首份合同。
        for (const delayMs of [0, 20, 50]) {
          if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
          const concurrentReplay = await prisma.upstreamSupplierContract.findUnique({
            where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: d.idempotencyKey } },
            include: { lines: true },
          })
          if (!concurrentReplay) continue
          if (concurrentReplay.requestFingerprint !== requestFingerprint) {
            return reply.status(409).send({ error: '同一幂等键不能用于不同合同内容' })
          }
          reply.header('Idempotent-Replay', 'true')
          return reply.status(200).send(concurrentReplay)
        }
        return reply.status(409).send({ error: '合同正在被其他人操作，请刷新后重试' })
      }
      throw error
    }

    return reply.status(201).send(contract)
  })

  app.post('/contracts/:id/activate', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const idParsed = idSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '合同标识格式不正确' })
    const now = new Date()
    const result = await prisma.$transaction(
      async (tx) => {
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
          data: {
            tenantId,
            userId,
            role,
            action: '启用上游供应商合同',
            entityType: 'UpstreamSupplierContract',
            targetId: contract.id,
          },
        })
        return { status: 200, active } as const
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    return result.active
  })

  app.get('/purchase-orders', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    const supplierId = INTERNAL_ROLES.has(role) ? (typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined) : supplierScope(req, 'upstream.order.read')
    const status = typeof req.query?.status === 'string' ? req.query.status : undefined
    return prisma.upstreamPurchaseOrder.findMany({
      where: {
        tenantId,
        ...(supplierId ? { supplierId } : {}),
        ...(status ? { status: status as any } : {}),
      },
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
        where: {
          id: d.supplierId,
          tenantId,
          status: 'ENABLED',
          businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
        },
        select: { id: true },
      }),
      prisma.warehouse.findFirst({
        where: { id: d.warehouseId, tenantId, isActive: true },
        select: { id: true },
      }),
      prisma.upstreamSupplierContract.findFirst({
        where: {
          id: d.contractId,
          tenantId,
          supplierId: d.supplierId,
          status: 'ACTIVE',
        },
        select: { id: true, currency: true, taxInclusive: true },
      }),
    ])
    if (!supplier) return reply.status(400).send({ error: '上游供应商不存在或已停用' })
    if (!warehouse) return reply.status(400).send({ error: '总仓不存在或已停用' })
    if (!contract) return reply.status(400).send({ error: '请选择该供应商已生效的合同' })

    const contractLineIds = d.lines.map((line) => line.contractLineId)
    const contractLines = await prisma.upstreamSupplierContractLine.findMany({
      where: {
        id: { in: contractLineIds },
        tenantId,
        contractId: contract.id,
        isActive: true,
      },
    })
    if (contractLines.length !== contractLineIds.length) {
      return reply.status(400).send({ error: '采购商品不属于所选合同或已停用' })
    }
    const contractLineById = new Map(contractLines.map((line) => [line.id, line]))
    const productIds = [...new Set(contractLines.map((line) => line.productId))]
    const todayBusinessRange = businessDateRangeInclusive(businessDateKey(), businessDateKey())
    const [qualityStandards, priceStandards] = await Promise.all([
      prisma.productQualityStandard.findMany({
        where: { tenantId, productId: { in: productIds }, active: true, effectiveAt: { lt: todayBusinessRange.endExclusive } },
      }),
      prisma.productPurchasePriceStandard.findMany({
        where: {
          tenantId,
          supplierId: d.supplierId,
          productId: { in: productIds },
          currency: contract.currency,
          taxInclusive: contract.taxInclusive,
          active: true,
          effectiveAt: { lt: todayBusinessRange.endExclusive },
        },
      }),
    ])
    const qualityStandardByProduct = new Map(qualityStandards.map((standard) => [standard.productId, standard]))
    const priceStandardByScope = new Map(priceStandards.map((standard) => [`${standard.productId}\u0000${standard.purchaseUnit}`, standard]))

    try {
      const order = await prisma.$transaction(
        async (tx) => {
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
            const qualityStandard = qualityStandardByProduct.get(source.productId)
            const priceStandard = priceStandardByScope.get(`${source.productId}\u0000${source.purchaseUnit}`)
            hasTemporaryPrice ||= temporary
            const baseAmount = money(quantity.times(unitPrice))
            const rate = decimal(source.taxRate)
            const lineWithoutTax = contract.taxInclusive && rate.greaterThan(0) ? money(baseAmount.dividedBy(decimal(1).plus(rate))) : baseAmount
            const lineTax = contract.taxInclusive ? money(baseAmount.minus(lineWithoutTax)) : money(lineWithoutTax.times(rate))
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
              standardUnitPriceSnapshot: priceStandard?.unitPrice || null,
              priceStandardCurrencySnapshot: priceStandard?.currency || null,
              priceStandardTaxInclusiveSnapshot: priceStandard?.taxInclusive ?? null,
              priceStandardId: priceStandard?.id || null,
              priceStandardVersionSnapshot: priceStandard?.version || null,
              qualityStandardId: qualityStandard?.id || null,
              qualityStandardVersionSnapshot: qualityStandard?.version || null,
              qualityCriteriaSnapshot: qualityStandard?.criteria || undefined,
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
            data: {
              tenantId,
              userId,
              role,
              action: '创建上游采购单',
              entityType: 'UpstreamPurchaseOrder',
              target: no,
              targetId: created.id,
            },
          })
          return created
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      )
      return reply.status(201).send(order)
    } catch (error: any) {
      if (error?.code === 'P2002' && d.idempotencyKey) {
        const existing = await prisma.upstreamPurchaseOrder.findFirst({
          where: { tenantId, idempotencyKey: d.idempotencyKey },
          include: { lines: true },
        })
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
    const result = await prisma.$transaction(
      async (tx) => {
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
          data: {
            tenantId,
            purchaseOrderId: idParsed.data,
            action: to,
            fromStatus: from,
            toStatus: to,
            actorId: userId,
            actorRole: role,
          },
        })
        return tx.upstreamPurchaseOrder.findUnique({
          where: { id: idParsed.data },
          include: { lines: true },
        })
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    if (!result) return reply.status(409).send({ error: `采购单当前状态不是 ${from}` })
    return result
  }

  app.post('/purchase-orders/:id/submit-for-approval', auth(app), (req: any, reply: any) => internalOrderTransition(req, reply, 'DRAFT', 'PENDING_APPROVAL'))

  app.post('/purchase-orders/:id/approve-and-send', auth(app), (req: any, reply: any) => internalOrderTransition(req, reply, 'PENDING_APPROVAL', 'SUBMITTED_TO_SUPPLIER'))

  app.post('/purchase-orders/:id/accept', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.order.accept')
    const idParsed = idSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '采购单标识格式不正确' })
    assertUpstreamPurchaseOrderTransition('SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED')
    const now = new Date()
    const result = await prisma.$transaction(
      async (tx) => {
        const changed = await tx.upstreamPurchaseOrder.updateMany({
          where: {
            id: idParsed.data,
            tenantId,
            supplierId,
            status: 'SUBMITTED_TO_SUPPLIER',
          },
          data: {
            status: 'SUPPLIER_ACCEPTED',
            supplierAcceptedAt: now,
            rowVersion: { increment: 1 },
          },
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
        return tx.upstreamPurchaseOrder.findUnique({
          where: { id: idParsed.data },
          include: { lines: true },
        })
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
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

    const result = await prisma.$transaction(
      async (tx) => {
        const order = await tx.upstreamPurchaseOrder.findFirst({
          where: {
            id: idParsed.data,
            tenantId,
            supplierId,
            status: { in: ['SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED'] },
          },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        })
        if (!order) return null
        const lineById = new Map(order.lines.map((line) => [line.id, line]))
        if (d.lines.some((line) => !lineById.has(line.lineId))) {
          throw Object.assign(new Error('改单包含不属于该采购单的商品'), {
            statusCode: 400,
          })
        }
        const afterLines = order.lines.map((line) => ({
          id: line.id,
          quantity: d.lines.find((input) => input.lineId === line.id)?.quantity ?? Number(line.orderedQty),
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
              lines: order.lines.map((line) => ({
                id: line.id,
                quantity: line.orderedQty.toString(),
              })),
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
          data: {
            status: 'CHANGE_PROPOSED',
            currentRevisionNo: revisionNo,
            rowVersion: { increment: 1 },
          },
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
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
    // 驳回必须留痕理由, 供应商和审计都能查到原因
    if (d.decision === 'REJECT' && !d.note) return reply.status(400).send({ error: '驳回改单必须填写理由' })

    const result = await prisma.$transaction(
      async (tx) => {
        const revision = await tx.upstreamPurchaseOrderRevision.findFirst({
          where: {
            id: revisionId.data,
            tenantId,
            purchaseOrderId: orderId.data,
            status: 'PENDING',
          },
        })
        if (!revision) return null
        const order = await tx.upstreamPurchaseOrder.findFirst({
          where: {
            id: orderId.data,
            tenantId,
            status: 'CHANGE_PROPOSED',
            currentRevisionNo: revision.revisionNo,
          },
          include: { lines: true },
        })
        if (!order) return null
        const now = new Date()
        if (d.decision === 'REJECT') {
          await tx.upstreamPurchaseOrderRevision.update({
            where: { id: revision.id },
            data: {
              status: 'REJECTED',
              reviewedById: userId,
              reviewedAt: now,
              reviewNote: d.note || null,
            },
          })
          await tx.upstreamPurchaseOrder.update({
            where: { id: order.id },
            data: {
              status: 'SUBMITTED_TO_SUPPLIER',
              rowVersion: { increment: 1 },
            },
          })
          return { decision: 'REJECT', orderId: order.id }
        }

        const after = revision.afterSnapshot as any
        const quantities = new Map<string, number>((after.lines || []).map((line: any) => [line.id, Number(line.quantity)]))
        if (order.lines.some((line) => !quantities.has(line.id) || !(quantities.get(line.id)! > 0))) {
          throw Object.assign(new Error('改单数量快照不完整或无效'), {
            statusCode: 400,
          })
        }
        let amountWithoutTax = decimal(0)
        let taxAmount = decimal(0)
        let totalAmount = decimal(0)
        for (const line of order.lines) {
          const quantity = decimal(quantities.get(line.id)!)
          const baseAmount = money(quantity.times(line.unitPrice))
          const lineWithoutTax = order.taxInclusive && line.taxRate.greaterThan(0) ? money(baseAmount.dividedBy(decimal(1).plus(line.taxRate))) : baseAmount
          const lineTax = order.taxInclusive ? money(baseAmount.minus(lineWithoutTax)) : money(lineWithoutTax.times(line.taxRate))
          const lineTotal = order.taxInclusive ? baseAmount : money(lineWithoutTax.plus(lineTax))
          await tx.upstreamPurchaseOrderLine.update({
            where: { id: line.id },
            data: {
              orderedQty: quantity,
              amountWithoutTax: lineWithoutTax,
              taxAmount: lineTax,
              totalAmount: lineTotal,
            },
          })
          amountWithoutTax = amountWithoutTax.plus(lineWithoutTax)
          taxAmount = taxAmount.plus(lineTax)
          totalAmount = totalAmount.plus(lineTotal)
        }
        await tx.upstreamPurchaseOrderRevision.update({
          where: { id: revision.id },
          data: {
            status: 'ACCEPTED',
            reviewedById: userId,
            reviewedAt: now,
            reviewNote: d.note || null,
          },
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    if (!result) return reply.status(409).send({ error: '改单不存在或已处理' })
    return result
  })

  app.get('/shipments', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    const supplierId = INTERNAL_ROLES.has(role)
      ? typeof req.query?.supplierId === 'string'
        ? req.query.supplierId
        : undefined
      : requireSupplierCapability(role, req.user.supplierId, 'upstream.order.read')
    return prisma.upstreamShipment.findMany({
      where: { tenantId, ...(supplierId ? { supplierId } : {}) },
      include: {
        purchaseOrder: {
          select: { id: true, no: true, status: true, expectedArrivalAt: true, currency: true },
        },
        lines: {
          include: {
            purchaseOrderLine: {
              select: {
                productId: true,
                productNameSnapshot: true,
                productSpecSnapshot: true,
                unitPrice: true,
                standardUnitPriceSnapshot: true,
                priceStandardCurrencySnapshot: true,
                priceStandardTaxInclusiveSnapshot: true,
                qualityStandardId: true,
                qualityStandardVersionSnapshot: true,
                qualityCriteriaSnapshot: true,
              },
            },
            // 已入账的收货数量, 前端据此判断发货单是否已收完 (隐藏「登记到货」入口)
            receiptLines: {
              where: { receipt: { status: 'POSTED' } },
              select: { arrivedQty: true, shortageQty: true },
            },
          },
        },
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
      const shipment = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-po:${orderId.data}`}))::text AS locked`
          const order = await tx.upstreamPurchaseOrder.findFirst({
            where: {
              id: orderId.data,
              tenantId,
              supplierId,
              status: {
                in: ['SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED'],
              },
            },
            include: { lines: true },
          })
          if (!order) return null
          const orderLineById = new Map(order.lines.map((line) => [line.id, line]))
          for (const input of d.lines) {
            const line = orderLineById.get(input.purchaseOrderLineId)
            if (!line)
              throw Object.assign(new Error('发货明细不属于该采购单'), {
                statusCode: 400,
              })
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
                create: d.lines.map((input) => {
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      )
      if (!shipment) return reply.status(409).send({ error: '采购单不存在、无权访问或当前不可发货' })
      return reply.status(201).send(shipment)
    } catch (error: any) {
      if (error?.code === 'P2002' && d.idempotencyKey) {
        const existing = await prisma.upstreamShipment.findFirst({
          where: { tenantId, idempotencyKey: d.idempotencyKey },
          include: { lines: true },
        })
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

    const result = await prisma.$transaction(
      async (tx) => {
        const preliminary = await tx.upstreamShipment.findFirst({
          where: { id: shipmentId.data, tenantId, supplierId },
          select: { purchaseOrderId: true },
        })
        if (!preliminary) return null
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-po:${preliminary.purchaseOrderId}`}))::text AS locked`
        const shipment = await tx.upstreamShipment.findFirst({
          where: {
            id: shipmentId.data,
            tenantId,
            supplierId,
            status: 'DRAFT',
          },
          include: { lines: true },
        })
        if (!shipment) return null
        const order = await tx.upstreamPurchaseOrder.findFirst({
          where: {
            id: shipment.purchaseOrderId,
            tenantId,
            supplierId,
            status: {
              in: ['SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED'],
            },
          },
          include: { lines: true },
        })
        if (!order) return null
        const orderLineById = new Map(order.lines.map((line) => [line.id, line]))
        for (const shipmentLine of shipment.lines) {
          const orderLine = orderLineById.get(shipmentLine.purchaseOrderLineId)
          if (!orderLine)
            throw Object.assign(new Error('发货明细与采购单不一致'), {
              statusCode: 409,
            })
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
        const fullyShipped = order.lines.every((line) => line.shippedQty.greaterThanOrEqualTo(line.confirmedQty || line.orderedQty))
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
        return tx.upstreamShipment.findUnique({
          where: { id: shipment.id },
          include: { lines: true },
        })
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
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
        purchaseOrder: {
          select: {
            id: true,
            no: true,
            status: true,
            currency: true,
            totalAmount: true,
            amountWithoutTax: true,
          },
        },
        shipment: { select: { id: true, no: true, status: true } },
        _count: { select: { lines: true, claims: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  })

  app.get('/receipts/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const scopedSupplierId = INTERNAL_ROLES.has(role) ? undefined : supplierScope(req, 'upstream.order.read')
    const receiptId = idSchema.safeParse(req.params.id)
    if (!receiptId.success) return reply.status(400).send({ error: '收货单标识格式不正确' })
    const receipt = await prisma.upstreamReceipt.findFirst({
      where: {
        id: receiptId.data,
        tenantId,
        ...(scopedSupplierId ? { supplierId: scopedSupplierId } : {}),
      },
      select: {
        id: true,
        no: true,
        supplierId: true,
        status: true,
        arrivedAt: true,
        evidenceCompletenessSnapshot: true,
        payableAmount: true,
        reviewReasons: true,
        priceExceptionReason: true,
        priceExceptionApprovedByNameSnapshot: true,
        priceExceptionApprovedByRoleSnapshot: true,
        priceExceptionApprovedAt: true,
        postedAt: true,
        createdAt: true,
        supplier: {
          select: {
            id: true,
            no: true,
            name: true,
            postReceiptClaimHours: true,
          },
        },
        purchaseOrder: {
          select: {
            id: true,
            no: true,
            status: true,
            totalAmount: true,
            amountWithoutTax: true,
            lines: {
              select: {
                id: true,
                productId: true,
                productCodeSnapshot: true,
                productNameSnapshot: true,
                productSpecSnapshot: true,
                purchaseUnit: true,
                orderedQty: true,
                confirmedQty: true,
                shippedQty: true,
                receivedQty: true,
                unitPrice: true,
                standardUnitPriceSnapshot: true,
                priceStandardCurrencySnapshot: true,
                priceStandardTaxInclusiveSnapshot: true,
                priceStandardId: true,
                priceStandardVersionSnapshot: true,
                qualityStandardId: true,
                qualityStandardVersionSnapshot: true,
                qualityCriteriaSnapshot: true,
              },
              orderBy: { lineNo: 'asc' },
            },
          },
        },
        shipment: { select: { id: true, no: true, status: true } },
        lines: {
          select: {
            id: true,
            productId: true,
            purchaseOrderLineId: true,
            arrivedQty: true,
            acceptedQty: true,
            shortageQty: true,
            damagedQty: true,
            rejectedQty: true,
            purchaseUnit: true,
            unitPrice: true,
            standardUnitPriceSnapshot: true,
            priceStandardCurrencySnapshot: true,
            priceStandardTaxInclusiveSnapshot: true,
            priceStandardId: true,
            priceStandardVersionSnapshot: true,
            qualityStandardId: true,
            qualityStandardVersionSnapshot: true,
            qualityCriteriaSnapshot: true,
            qualityResult: true,
            qualityEvidence: true,
            qualityDisposition: true,
            payableAmount: true,
            purchaseOrderLine: {
              select: {
                id: true,
                productCodeSnapshot: true,
                productNameSnapshot: true,
                productSpecSnapshot: true,
              },
            },
            product: { select: { evidenceRequirement: true, requiredEvidenceTypes: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!receipt) return reply.status(404).send({ error: '收货单不存在' })
    const evidenceCompleteness = await evaluateReceiptEvidenceCompleteness(prisma, {
      tenantId,
      supplierId: receipt.supplierId,
      businessAt: receipt.arrivedAt || new Date(),
      lines: receipt.lines,
    })
    return {
      ...receipt,
      canApprovePriceException: ['ADMIN', 'SUPER_ADMIN'].includes(role),
      evidenceCompleteness,
      lines: receipt.lines.map((line) => ({
        ...line,
        qualityEvidence: Array.isArray(line.qualityEvidence)
          ? (line.qualityEvidence as Array<Record<string, unknown>>).map((item) => ({
              name: String(item.name || '质量证据'),
              mime: String(item.mime || ''),
              size: Number(item.size || 0),
              url: signOssKey(typeof item.key === 'string' ? item.key : null),
            }))
          : [],
      })),
    }
  })

  app.post('/shipments/:id/receipts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链内部人员可创建收货单' })
    const shipmentId = idSchema.safeParse(req.params.id)
    if (!shipmentId.success) return reply.status(400).send({ error: '发货单标识格式不正确' })
    const parsed = receiptCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const requestFingerprint = upstreamReceiptRequestFingerprint(shipmentId.data, d)

    const replay = await prisma.upstreamReceipt.findFirst({
      where: { tenantId, idempotencyKey: d.idempotencyKey },
      include: { lines: true },
    })
    if (replay) {
      if (replay.shipmentId !== shipmentId.data || replay.requestFingerprint !== requestFingerprint) {
        return reply.status(409).send({ error: '同一幂等键不能用于不同收货内容' })
      }
      return reply.status(200).send(replay)
    }

    try {
      await assertWarehouseDocumentObjects(tenantId, d.lines.flatMap((line) => line.qualityEvidence || []))
    } catch (error: any) {
      return reply.status(error?.statusCode || 503).send({ error: error?.message || '质量证据暂时无法核验' })
    }

    try {
      const result = await prisma.$transaction(
        async (tx) => {
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
              if (existing.shipmentId !== shipmentId.data || existing.requestFingerprint !== requestFingerprint) {
                throw Object.assign(new Error('同一幂等键不能用于不同收货内容'), {
                  statusCode: 409,
                })
              }
              return { receipt: existing, replayed: true }
            }
          }
          const shipment = await tx.upstreamShipment.findFirst({
            where: {
              id: shipmentId.data,
              tenantId,
              status: { in: ['SHIPPED', 'PARTIALLY_RECEIVED'] },
            },
            include: {
              supplier: { select: { id: true } },
              purchaseOrder: { include: { lines: true } },
              lines: true,
            },
          })
          if (!shipment) return null
          const shipmentLineById = new Map(shipment.lines.map((line) => [line.id, line]))
          const orderLineById = new Map(shipment.purchaseOrder.lines.map((line) => [line.id, line]))
          if (d.lines.some((line) => !shipmentLineById.has(line.shipmentLineId))) {
            throw Object.assign(new Error('验收明细不属于该发货单'), {
              statusCode: 400,
            })
          }
          const priorReceiptLines = await tx.upstreamReceiptLine.findMany({
            where: {
              shipmentLineId: {
                in: d.lines.map((line) => line.shipmentLineId),
              },
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
              priorAcceptedByOrderLine.set(shipmentLine.purchaseOrderLineId, (priorAcceptedByOrderLine.get(shipmentLine.purchaseOrderLineId) || decimal(0)).plus(line.acceptedQty))
            }
          }

          let payableAmount = decimal(0)
          const receiptLines = d.lines.map((input) => {
            const shipmentLine = shipmentLineById.get(input.shipmentLineId)!
            const orderLine = orderLineById.get(shipmentLine.purchaseOrderLineId)!
            if (orderLine.qualityStandardId && !input.qualityResult) {
              throw Object.assign(new Error(`${orderLine.productNameSnapshot} 已配置质量标准，必须填写验收结果`), { statusCode: 400 })
            }
            if (!orderLine.qualityStandardId && (input.qualityResult || input.qualityEvidence?.length || input.qualityDisposition?.trim())) {
              throw Object.assign(new Error(`${orderLine.productNameSnapshot} 未配置质量标准，不能提交质量验收结果`), { statusCode: 400 })
            }
            const arrived = decimal(input.arrivedQty)
            const accepted = decimal(input.acceptedQty)
            const previousArrived = priorArrived.get(shipmentLine.id) || decimal(0)
            const shortage = d.finalForShipment ? Prisma.Decimal.max(decimal(0), shipmentLine.shippedQty.minus(previousArrived).minus(arrived)) : decimal(0)
            const overage = Prisma.Decimal.max(decimal(0), previousArrived.plus(arrived).minus(shipmentLine.shippedQty))
            const orderAccepted = orderLine.receivedQty.plus(priorAcceptedByOrderLine.get(orderLine.id) || decimal(0)).plus(accepted)
            const target = orderLine.confirmedQty || orderLine.orderedQty
            const maximum = target.times(decimal(1).plus(orderLine.overTolerancePct))
            if (orderAccepted.greaterThan(maximum)) {
              throw Object.assign(new Error(`${orderLine.productNameSnapshot} 合格验收数量超过合同允许上限 ${maximum.toString()} ${orderLine.purchaseUnit}`), { statusCode: 400 })
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
              standardUnitPriceSnapshot: orderLine.standardUnitPriceSnapshot,
              priceStandardCurrencySnapshot: orderLine.priceStandardCurrencySnapshot,
              priceStandardTaxInclusiveSnapshot: orderLine.priceStandardTaxInclusiveSnapshot,
              priceStandardId: orderLine.priceStandardId,
              priceStandardVersionSnapshot: orderLine.priceStandardVersionSnapshot,
              qualityStandardId: orderLine.qualityStandardId,
              qualityStandardVersionSnapshot: orderLine.qualityStandardVersionSnapshot,
              qualityCriteriaSnapshot: orderLine.qualityCriteriaSnapshot || undefined,
              qualityResult: input.qualityResult || null,
              qualityEvidence: input.qualityEvidence as Prisma.InputJsonValue | undefined,
              qualityDisposition: input.qualityDisposition || null,
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
              requestFingerprint,
              evidence: d.evidence as Prisma.InputJsonValue | undefined,
              note: d.note || null,
              finalForShipment: d.finalForShipment,
              createdById: userId,
              lines: { create: receiptLines },
            },
            include: { lines: true },
          })
          await tx.opLog.create({
            data: {
              tenantId,
              userId,
              role,
              action: '创建上游收货单',
              entityType: 'UpstreamReceipt',
              target: no,
              targetId: created.id,
            },
          })
          return { receipt: created, replayed: false }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      )
      if (!result) return reply.status(409).send({ error: '发货单不存在或当前不可验收' })
      return reply.status(result.replayed ? 200 : 201).send(result.receipt)
    } catch (error: any) {
      if (error?.code === 'P2002' && d.idempotencyKey) {
        const existing = await prisma.upstreamReceipt.findFirst({
          where: { tenantId, idempotencyKey: d.idempotencyKey },
          include: { lines: true },
        })
        if (existing) {
          if (existing.shipmentId !== shipmentId.data || existing.requestFingerprint !== requestFingerprint) {
            return reply.status(409).send({ error: '同一幂等键不能用于不同收货内容' })
          }
          return reply.status(200).send(existing)
        }
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
      data: {
        status: 'INSPECTING',
        inspectionStartedAt: new Date(),
        inspectorId: userId,
        rowVersion: { increment: 1 },
      },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '收货单不存在或已开始验收' })
    return prisma.upstreamReceipt.findUnique({
      where: { id: receiptId.data },
      include: { lines: true },
    })
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
      const result = await prisma.$transaction(
        async (tx) => {
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
                  settlementLines: {
                    select: {
                      statement: { select: { status: true, no: true } },
                    },
                  },
                  purchaseReturnLines: {
                    where: {
                      purchaseReturn: {
                        status: {
                          in: ['PENDING_APPROVAL', 'APPROVED', 'RECEIVED'],
                        },
                      },
                    },
                    select: {
                      purchaseReturn: { select: { no: true, status: true } },
                    },
                  },
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
          const activeClaim = receipt.claims.find((claim) => claim.status !== 'CANCELLED')
          if (activeClaim) {
            throw Object.assign(new Error(`收货单已关联差异单 ${activeClaim.no}，请先办结业务再按实盘调整处理`), { statusCode: 409 })
          }
          const activeSettlement = receipt.lines.flatMap((line) => line.settlementLines).find((line) => line.statement.status !== 'CANCELLED')
          if (activeSettlement) {
            throw Object.assign(new Error(`收货单已进入对账单 ${activeSettlement.statement.no}，不能直接冲销`), { statusCode: 409 })
          }
          const linkedReturn = receipt.lines.flatMap((line) => line.purchaseReturnLines).find((line) => ['PENDING_APPROVAL', 'APPROVED', 'RECEIVED'].includes(line.purchaseReturn.status))
          if (linkedReturn) {
            throw Object.assign(new Error(`收货单已关联采购退货单 ${linkedReturn.purchaseReturn.no}，不能直接冲销`), { statusCode: 409 })
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
            const nextReceived = Prisma.Decimal.max(decimal(0), (receivedAfter.get(line.purchaseOrderLineId) || decimal(0)).minus(line.acceptedQty))
            receivedAfter.set(line.purchaseOrderLineId, nextReceived)
            await tx.upstreamPurchaseOrderLine.update({
              where: { id: line.purchaseOrderLineId },
              data: { receivedQty: nextReceived },
            })
          }

          if (receipt.shipment) {
            const otherReceiptLines = await tx.upstreamReceiptLine.findMany({
              where: {
                shipmentLineId: {
                  in: receipt.shipment.lines.map((line) => line.id),
                },
                receiptId: { not: receipt.id },
                receipt: { status: 'POSTED' },
              },
              select: { shipmentLineId: true, arrivedQty: true },
            })
            const arrivedByShipmentLine = new Map<string, Prisma.Decimal>()
            for (const line of otherReceiptLines) {
              if (!line.shipmentLineId) continue
              arrivedByShipmentLine.set(line.shipmentLineId, (arrivedByShipmentLine.get(line.shipmentLineId) || decimal(0)).plus(line.arrivedQty))
            }
            const fullyReceived = receipt.shipment.lines.every((line) => (arrivedByShipmentLine.get(line.id) || decimal(0)).greaterThanOrEqualTo(line.shippedQty))
            const partiallyReceived = [...arrivedByShipmentLine.values()].some((value) => value.gt(0))
            await tx.upstreamShipment.update({
              where: { id: receipt.shipment.id },
              data: {
                status: fullyReceived ? 'RECEIVED' : partiallyReceived ? 'PARTIALLY_RECEIVED' : 'SHIPPED',
              },
            })
          }

          const fullyReceived = receipt.purchaseOrder.lines.every((line) => (receivedAfter.get(line.id) || decimal(0)).greaterThanOrEqualTo(line.confirmedQty || line.orderedQty))
          const partiallyReceived = [...receivedAfter.values()].some((value) => value.gt(0))
          const fullyShipped = receipt.purchaseOrder.lines.every((line) => line.shippedQty.greaterThanOrEqualTo(line.confirmedQty || line.orderedQty))
          const partiallyShipped = receipt.purchaseOrder.lines.some((line) => line.shippedQty.gt(0))
          const nextOrderStatus = fullyReceived ? 'RECEIVED' : partiallyReceived ? 'PARTIALLY_RECEIVED' : fullyShipped ? 'SHIPPED' : partiallyShipped ? 'PARTIALLY_SHIPPED' : 'SUPPLIER_ACCEPTED'
          const reversedAt = new Date()
          await tx.upstreamPurchaseOrder.update({
            where: { id: receipt.purchaseOrderId },
            data: { status: nextOrderStatus, rowVersion: { increment: 1 } },
          })
          const reversed = await tx.upstreamReceipt.update({
            where: { id: receipt.id },
            data: {
              status: 'REVERSED',
              reversedAt,
              rowVersion: { increment: 1 },
            },
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
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 20_000,
        }
      )
      if (!result) return reply.status(404).send({ error: '收货单不存在' })
      return result
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.get('/purchase-returns/returnable-lines', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureInternal(role, reply)) return
    return listReturnableUpstreamReceiptLines({
      tenantId,
      supplierId: typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined,
      warehouseId: typeof req.query?.warehouseId === 'string' ? req.query.warehouseId : undefined,
      take: Number(req.query?.take) || undefined,
    })
  })

  app.get('/purchase-returns', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureInternal(role, reply)) return
    const status = typeof req.query?.status === 'string' ? z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RECEIVED', 'REJECTED', 'CANCELLED']).safeParse(req.query.status) : null
    if (status && !status.success) return reply.status(400).send({ error: '采购退货状态无效' })
    return listUpstreamPurchaseReturns({
      tenantId,
      supplierId: typeof req.query?.supplierId === 'string' ? req.query.supplierId : undefined,
      warehouseId: typeof req.query?.warehouseId === 'string' ? req.query.warehouseId : undefined,
      status: status?.success ? status.data : undefined,
      take: Number(req.query?.take) || undefined,
    })
  })

  app.get('/purchase-returns/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureInternal(role, reply)) return
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) return reply.status(400).send({ error: '采购退货单标识格式不正确' })
    return getUpstreamPurchaseReturn(tenantId, id.data)
  })

  app.post('/purchase-returns', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const parsed = purchaseReturnCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return createUpstreamPurchaseReturn({ tenantId, userId, ...parsed.data })
  })

  app.post('/purchase-returns/:id/submit', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) return reply.status(400).send({ error: '采购退货单标识格式不正确' })
    return submitUpstreamPurchaseReturn(tenantId, id.data, userId)
  })

  app.post('/purchase-returns/:id/approve', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!APPROVER_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链审核人员可审批采购退货' })
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) return reply.status(400).send({ error: '采购退货单标识格式不正确' })
    return approveUpstreamPurchaseReturn(tenantId, id.data, userId)
  })

  app.post('/purchase-returns/:id/reject', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!APPROVER_ROLES.has(role)) return reply.status(403).send({ error: '仅供应链审核人员可驳回采购退货' })
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) return reply.status(400).send({ error: '采购退货单标识格式不正确' })
    const parsed = purchaseReturnReasonSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return rejectUpstreamPurchaseReturn(tenantId, id.data, userId, parsed.data.reason)
  })

  app.post('/purchase-returns/:id/cancel', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) return reply.status(400).send({ error: '采购退货单标识格式不正确' })
    const parsed = purchaseReturnReasonSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return cancelUpstreamPurchaseReturn(tenantId, id.data, userId, parsed.data.reason)
  })

  app.post('/purchase-returns/:id/receive', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ensureInternal(role, reply)) return
    const id = idSchema.safeParse(req.params.id)
    if (!id.success) return reply.status(400).send({ error: '采购退货单标识格式不正确' })
    const parsed = purchaseReturnReceiveSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    return receiveUpstreamPurchaseReturn(tenantId, id.data, userId, parsed.data.note)
  })

  app.get('/arrival-claims', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    const supplierId = INTERNAL_ROLES.has(role)
      ? typeof req.query?.supplierId === 'string'
        ? req.query.supplierId
        : undefined
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
      const result = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-receipt:${receiptId.data}`}))::text AS locked`
          const receipt = await tx.upstreamReceipt.findFirst({
            where: { id: receiptId.data, tenantId, status: 'POSTED' },
            include: {
              supplier: true,
              purchaseOrder: { include: { lines: true } },
              lines: { include: { purchaseOrderLine: true } },
            },
          })
          if (!receipt || !receipt.postedAt) return null
          const normalizedLines = normalizePostReceiptClaimLines(d, receipt)
          const requestFingerprint = postReceiptClaimRequestFingerprint({
            receiptId: receipt.id,
            claim: d,
            normalizedLines,
          })
          const existingClaim = await tx.upstreamArrivalClaim.findFirst({
            where: { tenantId, idempotencyKey: d.idempotencyKey },
            include: { lines: true },
          })
          if (existingClaim) {
            if (existingClaim.receiptId !== receipt.id || existingClaim.type !== d.type || existingClaim.requestFingerprint !== requestFingerprint) {
              throw Object.assign(new Error('同一幂等键不能用于不同的补报请求'), { statusCode: 409 })
            }
            return { replayed: true, claim: existingClaim }
          }
          // 少发补报必须以整张采购单的最终应收数为口径。分批发货/收货尚未完成时，
          // “确认数量 - 累计已收”中还包含后续未发数量，不能提前当作少发。
          if (d.type === 'SHORTAGE' && !POST_RECEIPT_SHORTAGE_ORDER_STATUSES.has(receipt.purchaseOrder.status)) {
            throw Object.assign(new Error('采购单尚未完成全部发货与收货，不能补报少发；请在最终收货完成后重试'), { statusCode: 409 })
          }
          const deadline = new Date(receipt.postedAt.getTime() + receipt.supplier.postReceiptClaimHours * 3_600_000)
          if (deadline < new Date()) {
            throw Object.assign(new Error(`已超过收货后 ${receipt.supplier.postReceiptClaimHours} 小时补报时限`), { statusCode: 409 })
          }
          const priorClaimLines = await tx.upstreamArrivalClaimLine.findMany({
            where: {
              purchaseOrderLineId: {
                in: normalizedLines.map((line) => line.purchaseOrderLine.id),
              },
              claim: {
                purchaseOrderId: receipt.purchaseOrderId,
                status: { not: 'CANCELLED' },
                type: d.type,
                ...(d.type === 'POST_RECEIPT_DAMAGE' ? { receiptId: receipt.id } : {}),
              },
            },
            select: { purchaseOrderLineId: true, affectedQty: true },
          })
          const alreadyClaimed = new Map<string, Prisma.Decimal>()
          for (const line of priorClaimLines) {
            alreadyClaimed.set(line.purchaseOrderLineId, (alreadyClaimed.get(line.purchaseOrderLineId) || decimal(0)).plus(line.affectedQty))
          }
          let claimedAmount = decimal(0)
          const claimedInRequest = new Map<string, Prisma.Decimal>()
          for (const line of normalizedLines) {
            const { input, receiptLine, purchaseOrderLine } = line
            const currentRequestAmount = claimedInRequest.get(purchaseOrderLine.id) || decimal(0)
            const cumulative = (alreadyClaimed.get(purchaseOrderLine.id) || decimal(0)).plus(currentRequestAmount).plus(input.affectedQty)
            const maximum =
              d.type === 'SHORTAGE' ? Prisma.Decimal.max(decimal(0), (purchaseOrderLine.confirmedQty || purchaseOrderLine.orderedQty).minus(purchaseOrderLine.receivedQty)) : receiptLine!.acceptedQty
            if (cumulative.greaterThan(maximum)) {
              const label = d.type === 'SHORTAGE' ? '当前未收数量' : '原合格收货数量'
              throw Object.assign(new Error(`${purchaseOrderLine.productNameSnapshot} 累计补报数量不能超过${label} ${maximum.toString()} ${purchaseOrderLine.purchaseUnit}`), { statusCode: 400 })
            }
            claimedInRequest.set(purchaseOrderLine.id, currentRequestAmount.plus(input.affectedQty))
            claimedAmount = claimedAmount.plus(decimal(input.affectedQty).times(purchaseOrderLine.unitPrice))
          }
          const no = await nextUpstreamDocumentNo(tx, tenantId, 'claim')
          const claim = await tx.upstreamArrivalClaim.create({
            data: {
              tenantId,
              no,
              purchaseOrderId: receipt.purchaseOrderId,
              receiptId: receipt.id,
              supplierId: receipt.supplierId,
              type: d.type,
              claimedAmount: money(claimedAmount),
              description: d.description,
              evidence: d.evidence as Prisma.InputJsonValue,
              responseDueAt: deadline,
              idempotencyKey: d.idempotencyKey,
              requestFingerprint,
              createdById: userId,
            },
          })
          for (const { input, receiptLine, purchaseOrderLine } of normalizedLines) {
            await tx.upstreamArrivalClaimLine.create({
              data: {
                tenantId,
                claimId: claim.id,
                receiptLineId: receiptLine?.id || null,
                purchaseOrderLineId: purchaseOrderLine.id,
                productId: purchaseOrderLine.productId,
                affectedQty: input.affectedQty,
                purchaseUnit: purchaseOrderLine.purchaseUnit,
                unitPrice: purchaseOrderLine.unitPrice,
                claimedAmount: money(decimal(input.affectedQty).times(purchaseOrderLine.unitPrice)),
              },
            })
          }
          await tx.opLog.create({
            data: {
              tenantId,
              userId,
              role,
              action: '收货后补报到货异常',
              entityType: 'UpstreamArrivalClaim',
              target: no,
              targetId: claim.id,
            },
          })
          const saved = await tx.upstreamArrivalClaim.findUnique({
            where: { id: claim.id },
            include: { lines: true },
          })
          return { replayed: false, claim: saved }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      )
      if (!result) return reply.status(404).send({ error: '已入账收货单不存在' })
      return reply.status(result.replayed ? 200 : 201).send(result.claim)
    } catch (error: any) {
      if (error?.code === 'P2002' || error?.code === 'P2034') {
        const existing = await prisma.upstreamArrivalClaim.findFirst({
          where: { tenantId, idempotencyKey: d.idempotencyKey },
          include: { lines: true },
        })
        if (existing) {
          if (existing.receiptId !== receiptId.data || existing.type !== d.type) {
            return reply.status(409).send({ error: '同一幂等键不能用于不同的补报请求' })
          }
          const receipt = await prisma.upstreamReceipt.findFirst({
            where: { id: receiptId.data, tenantId },
            include: {
              purchaseOrder: { include: { lines: true } },
              lines: { include: { purchaseOrderLine: true } },
            },
          })
          if (receipt) {
            const normalizedLines = normalizePostReceiptClaimLines(d, receipt)
            const requestFingerprint = postReceiptClaimRequestFingerprint({
              receiptId: receipt.id,
              claim: d,
              normalizedLines,
            })
            if (existing.requestFingerprint === requestFingerprint) {
              return reply.status(200).send(existing)
            }
          }
          return reply.status(409).send({ error: '同一幂等键不能用于不同的补报请求' })
        }
        if (error?.code === 'P2034') {
          return reply.status(409).send({ error: '补报请求刚被其他操作处理，请刷新后重试' })
        }
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
    const updated = await prisma.$transaction(async (tx) => {
      const claim = await tx.upstreamArrivalClaim.findFirst({
        where: {
          id: claimId.data,
          tenantId,
          supplierId,
          status: 'PENDING_SUPPLIER',
        },
        select: { id: true, evidence: true },
      })
      if (!claim) return null
      // 供应商举证并入差异单证据包, 打上来源标记便于仲裁时区分
      const priorEvidence = Array.isArray(claim.evidence) ? claim.evidence : []
      const supplierEvidence = (d.evidence || []).map((item) => ({
        ...item,
        source: 'SUPPLIER_RESPONSE',
      }))
      await tx.upstreamArrivalClaim.update({
        where: { id: claim.id },
        data: {
          status: d.decision === 'ACCEPT' ? 'SUPPLIER_ACCEPTED' : 'SUPPLIER_REJECTED',
          supplierResponse: d.response,
          supplierRespondedAt: new Date(),
          ...(supplierEvidence.length ? { evidence: [...priorEvidence, ...supplierEvidence] } : {}),
        },
      })
      return claim
    })
    if (!updated) return reply.status(409).send({ error: '差异单不存在、无权访问或已处理' })
    await prisma.opLog.create({
      data: {
        tenantId,
        userId,
        role,
        action: `供应商${d.decision === 'ACCEPT' ? '接受' : '拒绝'}到货差异`,
        entityType: 'UpstreamArrivalClaim',
        targetId: claimId.data,
      },
    })
    return prisma.upstreamArrivalClaim.findUnique({
      where: { id: claimId.data },
      include: { lines: true },
    })
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
    return prisma.upstreamArrivalClaim.findUnique({
      where: { id: claimId.data },
      include: { lines: true },
    })
  })

  app.post('/arrival-claims/:id/resolve', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const claimId = idSchema.safeParse(req.params.id)
    if (!claimId.success) return reply.status(400).send({ error: '差异单标识格式不正确' })
    const parsed = claimResolutionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-claim:${claimId.data}`}))::text AS locked`
        const claim = await tx.upstreamArrivalClaim.findFirst({
          where: {
            id: claimId.data,
            tenantId,
            status: {
              in: ['SUPPLIER_ACCEPTED', 'ARBITRATION', 'AUTO_ACCEPTED'],
            },
          },
          include: {
            receipt: true,
            lines: {
              include: {
                receiptLine: { include: { purchaseOrderLine: true } },
                product: true,
              },
            },
          },
        })
        if (!claim) return null
        if (decimal(d.resolvedAmount).greaterThan(claim.claimedAmount)) {
          throw Object.assign(new Error('确认金额不能超过差异申请金额'), {
            statusCode: 400,
          })
        }
        if (claim.type === 'POST_RECEIPT_DAMAGE') {
          if (claim.lines.some((line) => !line.receiptLine)) {
            throw Object.assign(new Error('收货后破损差异缺少原收货明细，禁止入账'), { statusCode: 409 })
          }
          await postUpstreamClaimLossInTransaction(tx, {
            tenantId,
            warehouseId: claim.receipt.warehouseId,
            supplierId: claim.supplierId,
            claimId: claim.id,
            claimNo: claim.no,
            userId,
            effectiveAt: new Date(),
            lines: claim.lines.map((line) => ({
              claimLineId: line.id,
              productId: line.productId,
              productName: line.product.name,
              purchaseQuantity: line.affectedQty,
              purchaseUnit: line.purchaseUnit,
              conversionFactor: line.receiptLine!.inventoryUnitsPerPurchaseUnit,
              inventoryQuantity: line.affectedQty.times(line.receiptLine!.inventoryUnitsPerPurchaseUnit),
              inventoryUnit: line.receiptLine!.inventoryUnit,
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
          const share = claim.claimedAmount.isZero() ? decimal(0) : money(resolvedTotal.times(line.claimedAmount).dividedBy(claim.claimedAmount))
          await tx.upstreamArrivalClaimLine.update({
            where: { id: line.id },
            data: { resolvedAmount: share },
          })
        }
        await tx.opLog.create({
          data: {
            tenantId,
            userId,
            role,
            action: '办结上游到货差异',
            entityType: 'UpstreamArrivalClaim',
            target: claim.no,
            targetId: claim.id,
            metadata: d,
          },
        })
        return saved
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    if (!result) return reply.status(409).send({ error: '差异单不存在或当前不可办结' })
    return result
  })

  app.get('/settlement-statements', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    const supplierId = SETTLEMENT_READ_ROLES.has(role)
      ? typeof req.query?.supplierId === 'string'
        ? req.query.supplierId
        : undefined
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
    const supplierId = SETTLEMENT_READ_ROLES.has(role) ? undefined : requireSupplierCapability(role, req.user.supplierId, 'settlement.read')
    const statement = await prisma.upstreamSettlementStatement.findFirst({
      where: {
        id: statementId.data,
        tenantId,
        ...(supplierId ? { supplierId } : {}),
      },
      include: {
        supplier: { select: { id: true, no: true, name: true } },
        lines: {
          include: {
            receiptLine: {
              select: {
                id: true,
                receipt: {
                  select: {
                    id: true,
                    no: true,
                    purchaseOrder: { select: { id: true, no: true } },
                  },
                },
              },
            },
            claim: {
              select: {
                id: true,
                no: true,
                purchaseOrder: { select: { id: true, no: true } },
                receipt: { select: { id: true, no: true } },
              },
            },
          },
          orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
        },
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
      where: {
        id: d.supplierId,
        tenantId,
        status: 'ENABLED',
        businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
      },
      select: { id: true },
    })
    if (!supplier) return reply.status(400).send({ error: '上游供应商不存在或已停用' })

    let result: { empty: true } | { empty: false; statementId: string }
    try {
      result = await prisma.$transaction(
        async (tx) => {
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
                settlementLines: {
                  none: { statement: { status: { not: 'CANCELLED' } } },
                },
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
                settlementLines: {
                  none: { statement: { status: { not: 'CANCELLED' } } },
                },
              },
              include: {
                lines: {
                  select: {
                    receiptLine: {
                      select: {
                        acceptedQty: true,
                        arrivedQty: true,
                        overageQty: true,
                        unitPrice: true,
                      },
                    },
                  },
                },
              },
              orderBy: { resolvedAt: 'asc' },
            }),
            tx.upstreamSettlementStatement.findFirst({
              where: {
                tenantId,
                supplierId: d.supplierId,
                periodStart: start,
                periodEnd: endDate,
              },
              orderBy: { version: 'desc' },
              select: { version: true },
            }),
          ])
          if (receiptLines.length === 0 && claims.length === 0) {
            return { empty: true } as const
          }
          const receiptAmount = receiptLines.reduce((sum, line) => sum.plus(line.payableAmount), decimal(0))
          const claimDeductions = new Map(claims.map((claim) => [claim.id, upstreamSettlementClaimDeduction(claim)]))
          const deductionAmount = [...claimDeductions.values()].reduce((sum, amount) => sum.plus(amount), decimal(0))
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
            const deduction = claimDeductions.get(claim.id) || decimal(0)
            const deductsPayable = deduction.greaterThan(0)
            await tx.upstreamSettlementLine.create({
              data: {
                tenantId,
                statementId: statement.id,
                sourceType: 'CLAIM',
                sourceId: claim.id,
                sourceNo: claim.no,
                businessDate: claim.resolvedAt || claim.createdAt,
                claimId: claim.id,
                description: deductsPayable ? `到货差异扣款：${claim.description}` : `到货差异（已在收货净额中体现，不重复扣款）：${claim.description}`,
                originalAmount: amount,
                adjustmentAmount: deduction.negated(),
                payableAmount: deduction.negated(),
              },
            })
          }
          const orderIds = [...new Set(receiptLines.map((line) => line.receipt.purchaseOrderId))]
          if (orderIds.length) {
            await tx.upstreamPurchaseOrder.updateMany({
              where: { id: { in: orderIds }, tenantId, status: 'RECEIVED' },
              data: {
                status: 'SETTLEMENT_PENDING',
                rowVersion: { increment: 1 },
              },
            })
          }
          await tx.opLog.create({
            data: {
              tenantId,
              userId,
              role,
              action: '生成上游月度对账单',
              entityType: 'UpstreamSettlementStatement',
              target: no,
              targetId: statement.id,
            },
          })
          return { empty: false, statementId: statement.id } as const
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 20_000,
        }
      )
    } catch (error: any) {
      if (error?.code === 'P2034' || error?.code === 'P2002' || (error?.code === 'P2010' && String(error?.meta?.code || '') === '40001')) {
        return reply.status(409).send({ error: '该对账单刚被他人处理，请刷新后重试' })
      }
      throw error
    }
    if (result.empty) return reply.status(409).send({ error: '该结算周期没有新的已入账收货或已办结扣款' })
    const statement = await prisma.upstreamSettlementStatement.findUnique({
      where: { id: result.statementId },
      include: {
        lines: { orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }] },
      },
    })
    return reply.status(201).send(statement)
  })

  app.post('/settlement-statements/:id/send', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INTERNAL_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const changed = await prisma.upstreamSettlementStatement.updateMany({
      where: {
        id: statementId.data,
        tenantId,
        status: { in: ['DRAFT', 'DISPUTED'] },
      },
      data: {
        status: 'SENT_TO_SUPPLIER',
        buyerConfirmedById: userId,
        buyerConfirmedAt: new Date(),
      },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '对账单不存在或当前不可发送' })
    return prisma.upstreamSettlementStatement.findUnique({
      where: { id: statementId.data },
      include: { lines: true },
    })
  })

  app.post('/settlement-statements/:id/confirm', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.settlement.confirm')
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const statement = await prisma.$transaction(async (tx) => {
      const changed = await tx.upstreamSettlementStatement.updateMany({
        where: {
          id: statementId.data,
          tenantId,
          supplierId,
          status: 'SENT_TO_SUPPLIER',
        },
        data: {
          status: 'CONFIRMED',
          supplierConfirmedById: userId,
          supplierConfirmedAt: new Date(),
        },
      })
      if (changed.count !== 1) return null
      const confirmed = await tx.upstreamSettlementStatement.findUnique({
        where: { id: statementId.data },
        include: { lines: true },
      })
      if (!confirmed) throw new Error('确认后的上游对账单不存在')
      // 确认状态和系统通知在同一事务内落库：不会出现“已确认但财务没收到”或
      // “尚未确认却提前通知财务”。幂等键同时防止重复通知。
      await tx.notification.create({
        data: {
          tenantId,
          recipientRole: 'FINANCE',
          type: 'UPSTREAM_SETTLEMENT_CONFIRMED',
          title: '上游对账单待锁定',
          body: `供应商已确认对账单 ${confirmed.no}，应付金额 ¥${confirmed.payableAmount.toString()}，请进入上游结算锁定。`,
          refType: 'UpstreamSettlementStatement',
          refId: confirmed.id,
          dedupeKey: `UPSTREAM_SETTLEMENT:${confirmed.id}:CONFIRMED`,
        },
      })
      return confirmed
    })
    if (!statement) return reply.status(409).send({ error: '对账单不存在、无权访问或当前不可确认' })
    return statement
  })

  app.post('/settlement-statements/:id/dispute', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const supplierId = requireSupplierCapability(role, req.user.supplierId, 'upstream.settlement.confirm')
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const parsed = settlementDisputeSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const changed = await prisma.upstreamSettlementStatement.updateMany({
      where: {
        id: statementId.data,
        tenantId,
        supplierId,
        status: 'SENT_TO_SUPPLIER',
      },
      data: {
        status: 'DISPUTED',
        note: parsed.data.reason,
        supplierConfirmedById: userId,
        supplierConfirmedAt: new Date(),
      },
    })
    if (changed.count !== 1) return reply.status(409).send({ error: '对账单不存在、无权访问或当前不可提出异议' })
    return prisma.upstreamSettlementStatement.findUnique({
      where: { id: statementId.data },
      include: { lines: true },
    })
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
    return prisma.upstreamSettlementStatement.findUnique({
      where: { id: statementId.data },
      include: { lines: true },
    })
  })

  app.post('/settlement-statements/:id/invoices', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可关联发票' })
    const statementId = idSchema.safeParse(req.params.id)
    if (!statementId.success) return reply.status(400).send({ error: '对账单标识格式不正确' })
    const parsed = settlementInvoiceAllocationSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`upstream-statement:${statementId.data}`}))::text AS locked`
        const statement = await tx.upstreamSettlementStatement.findFirst({
          where: {
            id: statementId.data,
            tenantId,
            status: { in: ['LOCKED', 'INVOICED'] },
          },
          include: { invoiceAllocations: true },
        })
        if (!statement) return null
        const invoice = await tx.invoice.findFirst({
          where: {
            id: d.invoiceId,
            tenantId,
            supplierId: statement.supplierId,
            status: 'VERIFIED',
          },
          include: { upstreamSettlementAllocations: true },
        })
        if (!invoice)
          throw Object.assign(new Error('已审核发票不存在或不属于该供应商'), {
            statusCode: 400,
          })
        const allocatedToStatement = statement.invoiceAllocations.reduce((sum, item) => sum.plus(item.amount), decimal(0))
        const allocatedToInvoice = invoice.upstreamSettlementAllocations.reduce((sum, item) => sum.plus(item.amount), decimal(0))
        const amount = decimal(d.amount)
        if (allocatedToStatement.plus(amount).greaterThan(statement.payableAmount)) {
          throw Object.assign(new Error('发票分配金额超过对账单应付余额'), {
            statusCode: 400,
          })
        }
        if (allocatedToInvoice.plus(amount).greaterThan(invoice.amount)) {
          throw Object.assign(new Error('分配金额超过发票可用余额'), {
            statusCode: 400,
          })
        }
        await tx.upstreamSettlementInvoiceAllocation.create({
          data: {
            tenantId,
            statementId: statement.id,
            invoiceId: invoice.id,
            amount,
            createdById: userId,
          },
        })
        const fullyInvoiced = allocatedToStatement.plus(amount).greaterThanOrEqualTo(statement.payableAmount)
        if (fullyInvoiced && statement.status === 'LOCKED') {
          await tx.upstreamSettlementStatement.update({
            where: { id: statement.id },
            data: { status: 'INVOICED' },
          })
        }
        return { statementId: statement.id }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    if (!result) return reply.status(409).send({ error: '对账单不存在或尚未锁定' })
    return prisma.upstreamSettlementStatement.findUnique({
      where: { id: result.statementId },
      include: {
        lines: true,
        invoiceAllocations: { include: { invoice: true } },
      },
    })
  })
}
