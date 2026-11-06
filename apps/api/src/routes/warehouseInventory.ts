import {createReviewInbound,createReviewOutbound} from '../services/warehouseReviewPosting'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { upstreamFeatureEnabled } from '../lib/upstream-feature-flags'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { resolveTenantWarehouseId } from '../services/defaultWarehouse'
import {
  serializableWithRetry,
  recordBatchManualWarehouseInbound,
  recordBatchManualWarehouseOutbound,
  recordManualWarehouseInbound,
  recordWarehousePhysicalCount,
  reverseManualWarehouseInbound,
} from '../services/warehouseLedger'
import { auditWarehouseLedger } from '../services/warehouseLedgerAudit'
import { reconcileWarehouseShadowLedger } from '../services/warehouseLedgerReconciliation'
import { resolveProductFourUnits } from '../services/inventoryUnits'
import {
  ensureWarehouseDoc,
  ensureWarehouseDocInTransaction,
  normalizeWarehouseDocAttachments,
  type WarehouseDocAttachmentInput,
  type WarehouseDocLineInput,
} from '../services/warehouseDocs'
import { findLatestPurchaseInboundPrices } from '../services/purchaseInboundPriceHistory'
import { submitInboundDraft, draftPayloadSchema } from '../services/warehouseInboundDrafts'
import { registerWarehouseInboundDraftRoutes } from './warehouseInboundDrafts'
import { currentInboundValues } from '../services/warehouseMovementDisplay'
import { assertWarehouseDocumentObjects } from './upload'

/** 过账后登记单据（find-or-create，幂等键与台账批次对齐）。登记失败抛错，前端可用同一幂等键安全重试。 */
async function registerWarehouseDoc(input: {
  tenantId: string
  userId: string
  type: 'MANUAL_INBOUND' | 'MANUAL_OUTBOUND'
  warehouseId: string
  effectiveAt: Date
  idempotencyKey: string
  supplierId?: string | null
  supplierName?: string | null
  attachments?: WarehouseDocAttachmentInput[]
  reason?: string | null
  note?: string | null
  lines: WarehouseDocLineInput[]
}) {
  const { doc, created } = await ensureWarehouseDoc(input)
  return { id: doc.id, docNo: doc.docNo, status: doc.status as string, created }
}

const READ_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'PURCHASER'])
const WRITE_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'PURCHASER'])
const ORDER_ENTRY_POLICY_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'SUPPLY_CHAIN'])
export type WarehouseInventoryScope = 'stock' | 'bom-mapping' | 'unit-review'

export function buildWarehouseInventoryScopeWhere(input: {
  tenantId: string
  warehouseId: string
  scope: WarehouseInventoryScope
}): Prisma.ProductWhereInput {
  const common = { tenantId: input.tenantId, status: 'ENABLED' as const }
  if (input.scope === 'bom-mapping') return { ...common, category: 'BOM待采购映射' }
  if (input.scope === 'unit-review') {
    return {
      ...common,
      unitConversionStatus: { not: 'VERIFIED' },
      NOT: { category: 'BOM待采购映射' },
    }
  }
  return {
    ...common,
    warehouseLedgerBalances: { some: { tenantId: input.tenantId, warehouseId: input.warehouseId } },
  }
}

function hasCapability(role: string, capability: 'inventory.read' | 'inventory.write') {
  if (isInternalSupplyChainRole(role)) return hasInternalSupplyChainCapability(role, capability)
  return (capability === 'inventory.read' ? READ_ROLES : WRITE_ROLES).has(role)
}

function requireCapability(capability: 'inventory.read' | 'inventory.write') {
  return async (req: any, reply: any) => {
    if (!hasCapability(req.user?.role, capability)) {
      return reply.status(403).send({ error: capability === 'inventory.read' ? '无权查看总仓库存' : '无权操作总仓库存' })
    }
  }
}

function canEditOrderEntryPolicy(role: string | undefined | null) {
  return Boolean(role && ORDER_ENTRY_POLICY_ROLES.has(role))
}

function requireOrderEntryPolicyWrite() {
  return async (req: any, reply: any) => {
    if (!canEditOrderEntryPolicy(req.user?.role)) {
      return reply.status(403).send({ error: '无权设置门店订货零库存策略' })
    }
  }
}

function number(value: Prisma.Decimal | null | undefined) {
  return Number(value || 0)
}

/** 实时库存按当前配送价的发货价值；价格是每成本单位，库存是最小库存单位。 */
export function currentInventoryShipmentAmount(input: {
  physicalQty: Prisma.Decimal | number | string
  price: Prisma.Decimal | number | string
  inventoryUnitsPerCostUnit: Prisma.Decimal | number | string | null | undefined
}) {
  if (input.inventoryUnitsPerCostUnit == null) return null
  const factor = new Prisma.Decimal(input.inventoryUnitsPerCostUnit)
  if (!factor.isFinite() || factor.lte(0)) return null
  return Number(new Prisma.Decimal(input.physicalQty).mul(input.price).div(factor).toDecimalPlaces(2))
}

const manualInboundSchema = z.object({
  productId: z.string().trim().min(1),
  purchaseQuantity: z.number().positive().max(99_999_999),
  totalAmount: z.number().positive().max(999_999_999.99),
  draftId: z.string().min(8).max(80).optional(),
  draftVersion: z.number().int().positive().optional(),
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
  supplierId: z.string({ required_error: '请选择供货供应商' }).trim().min(1, '请选择供货供应商'),
  sourceName: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(240).optional().nullable(),
  batchNo: z.string().trim().max(80).optional().nullable(),
  manufactureDate: z.string().date().optional().nullable(),
  expiryDate: z.string().date().optional().nullable(),
  attachments: z.array(z.object({
    key: z.string().trim().min(1).max(1024),
    name: z.string().trim().min(1).max(160),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']),
    size: z.number().int().positive().max(10 * 1024 * 1024),
  }).strict()).max(9).optional().default([]),
})

const batchManualInboundSchema = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    purchaseQuantity: z.number().positive().max(99_999_999),
    unitPrice: z.number().positive().max(999_999_999.99),
    // 行金额（凑整）：提供时作为权威金额入账，单价由后端按 金额/数量 反算
    totalAmount: z.number().positive().max(999_999_999.99).optional().nullable(),
    batchNo: z.string().trim().max(80).optional().nullable(),
    manufactureDate: z.string().date().optional().nullable(),
    expiryDate: z.string().date().optional().nullable(),
  })).min(1).max(200),
  draftId: z.string().min(8).max(80).optional(),
  draftVersion: z.number().int().positive().optional(),
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
  supplierId: z.string({ required_error: '请选择供货供应商' }).trim().min(1, '请选择供货供应商'),
  sourceName: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(240).optional().nullable(),
  attachments: z.array(z.object({
    key: z.string().trim().min(1).max(1024),
    name: z.string().trim().min(1).max(160),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']),
    size: z.number().int().positive().max(10 * 1024 * 1024),
  }).strict()).max(9).optional().default([]),
}).superRefine((value, context) => {
  const productIds = value.items.map(item => item.productId)
  if (new Set(productIds).size !== productIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一商品不能重复添加' })
  }
  value.items.forEach((item, index) => {
    if (item.expiryDate && item.manufactureDate && item.expiryDate < item.manufactureDate) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'expiryDate'], message: '到期日期不能早于生产日期' })
    }
  })
})

// 批量手工出库（2026-08-23）：只处理非自损的结构化业务用途。
// 自损必须走 /batch-self-loss，不允许通过自由文本理由规避责任、证据和成本口径。
const batchManualOutboundSchema = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    inventoryQuantity: z.number().positive().max(99_999_999),
    totalAmount: z.number().positive().max(999_999_999.99).optional().nullable(),
    note: z.string().trim().max(240).optional().nullable(),
  })).min(1).max(200),
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
  purpose: z.enum(['STORE_REALLOCATION', 'SAMPLE_ISSUE', 'HISTORICAL_CORRECTION']),
  reason: z.string().trim().min(2, '请填写出库原因/去向').max(120),
  responsibility: z.string().trim().max(120).optional().nullable(),
  sourceName: z.string().trim().max(120).optional().nullable(),
  attachments: z.array(z.object({
    key: z.string().trim().min(1).max(1024),
    name: z.string().trim().min(1).max(160),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']),
    size: z.number().int().positive().max(10 * 1024 * 1024),
  }).strict()).max(9).optional().default([]),
}).superRefine((value, context) => {
  const productIds = value.items.map(item => item.productId)
  if (new Set(productIds).size !== productIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一商品不能重复添加' })
  }
})

// 总仓自损使用独立端点和结构化输入，不能通过自由文本原因绕过责任、证据和成本口径。
const batchSelfLossSchema = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    inventoryQuantity: z.number().positive().max(99_999_999),
    note: z.string().trim().max(240).optional().nullable(),
  })).min(1).max(200),
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
  reason: z.enum(['盘亏损毁', '过期变质', '搬运损坏', '保管不当', '其他自损']),
  responsibility: z.string({ required_error: '请填写责任归属' }).trim().min(2, '请填写责任归属').max(120),
  attachments: z.array(z.object({
    key: z.string().trim().min(1).max(1024),
    name: z.string().trim().min(1).max(160),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']),
    size: z.number().int().positive().max(10 * 1024 * 1024),
  }).strict(), { required_error: '总仓自损必须上传现场证据' }).min(1, '总仓自损必须上传现场证据').max(9),
}).superRefine((value, context) => {
  const productIds = value.items.map(item => item.productId)
  if (new Set(productIds).size !== productIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一商品不能重复添加' })
  }
})

// 入库供应商闸口（P2）：供应商必须是本租户启用中的上游供应商
async function requireUpstreamSupplier(tenantId: string, supplierId: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, tenantId },
    select: { id: true, name: true, status: true, businessScopes: true },
  })
  if (!supplier) throw Object.assign(new Error('供货供应商不存在'), { statusCode: 400 })
  if (supplier.status !== 'ENABLED') throw Object.assign(new Error(`供应商「${supplier.name}」已停用，不能入库`), { statusCode: 409 })
  if (!supplier.businessScopes.includes('WAREHOUSE_UPSTREAM')) {
    throw Object.assign(new Error(`供应商「${supplier.name}」不是总仓上游供应商，不能作为入库来源`), { statusCode: 409 })
  }
  return supplier
}

// 软闸口：商品未绑定该供应商的供货关系 → 警告放行（数据补齐后可升硬阻断）
async function inboundGateWarnings(tenantId: string, supplierId: string, productIds: string[]) {
  const uniqueIds = [...new Set(productIds)]
  const relations = await prisma.productUpstreamSource.findMany({
    where: { tenantId, supplierId, productId: { in: uniqueIds }, isActive: true },
    select: { productId: true },
  })
  const bound = new Set(relations.map(relation => relation.productId))
  const missingIds = uniqueIds.filter(id => !bound.has(id))
  if (missingIds.length === 0) return [] as string[]
  const products = await prisma.product.findMany({
    where: { tenantId, id: { in: missingIds } },
    select: { code: true, name: true },
    orderBy: { code: 'asc' },
  })
  return products.map(product => `${product.name}（${product.code}）未绑定该供应商的供货关系`)
}

const physicalCountSchema = z.object({
  productId: z.string().trim().min(1),
  countedInventoryQuantity: z.number().nonnegative().max(99_999_999),
  countedInventoryValue: z.number().nonnegative().max(999_999_999.99),
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
  note: z.string().trim().min(2).max(240),
})

const orderEntryPolicySchema = z.object({
  blockZeroStockAtOrderEntry: z.boolean(),
  rowVersion: z.number().int().nonnegative(),
}).strict()

function isWarehousePolicyTransactionConflict(error: any) {
  if (error?.code === 'P2034') return true
  return error?.code === 'P2010'
    && (String(error?.meta?.code || '') === '40001'
      || /could not serialize|serialization failure|SQLSTATE\s*40001/i.test(String(error?.meta?.message || error?.message || '')))
}

type BatchOutboundRouteData = {
  items: Array<{ productId: string; inventoryQuantity: number; totalAmount?: number | null; note?: string | null }>
  effectiveAt: string
  idempotencyKey: string
  purpose?: 'STORE_REALLOCATION' | 'SAMPLE_ISSUE' | 'HISTORICAL_CORRECTION'
  reason: string
  responsibility?: string | null
  sourceName?: string | null
  attachments: WarehouseDocAttachmentInput[]
}

async function executeBatchManualOutbound(
  req: any,
  data: BatchOutboundRouteData,
  businessType: 'GENERIC' | 'SELF_LOSS',
) {
  const attachments = normalizeWarehouseDocAttachments(req.user.tenantId, data.attachments)
  await assertWarehouseDocumentObjects(req.user.tenantId, attachments)
  const purposeLabels = { STORE_REALLOCATION: '门店拨补', SAMPLE_ISSUE: '样品领用', HISTORICAL_CORRECTION: '历史补录' } as const
  const reason = businessType === 'SELF_LOSS'
    ? `总仓自损：${data.reason}`
    : `【${purposeLabels[data.purpose!]}】${data.reason}`
  const sourceName = data.responsibility ? `责任归属：${data.responsibility}` : data.sourceName
  const result=await serializableWithRetry(tx=>createReviewOutbound(tx,{
    tenantId:req.user.tenantId,userId:req.user.userId,
    items:data.items.map(item=>({...item,totalAmount:businessType==='SELF_LOSS'?null:item.totalAmount})),
    effectiveAt:new Date(data.effectiveAt),idempotencyKey:data.idempotencyKey,
    documentKey:`${businessType==='SELF_LOSS'?'self-loss':'manual-outbound'}:${data.idempotencyKey}`,
    reason,sourceName,businessType,attachments,note:data.responsibility?`责任归属：${data.responsibility}`:null,
  }))
  return {ok:true,replayed:!result.created,warehouseId:result.doc.warehouseId,count:result.doc.lineCount,totalAmount:Number(result.doc.totalAmount),doc:{id:result.doc.id,docNo:result.doc.docNo,status:result.doc.status},movements:[]}

}

export const warehouseInventoryRoutes: FastifyPluginAsync = async app => {
  const authRead = { preHandler: [(app as any).authenticate, requireCapability('inventory.read')] }
  const authWrite = { preHandler: [(app as any).authenticate, requireCapability('inventory.write')] }
  const authOrderEntryPolicyWrite = { preHandler: [(app as any).authenticate, requireOrderEntryPolicyWrite()] }
  registerWarehouseInboundDraftRoutes(app, authWrite)

  app.get('/', authRead, async (req: any, reply: any) => {
    const parsed = z.object({
      q: z.string().trim().max(100).optional(),
      productStatus: z.enum(['ALL', 'PENDING_APPROVAL', 'PENDING_DISABLE', 'ENABLED', 'DISABLED']).default('ALL'),
      scope: z.enum(['stock', 'bom-mapping', 'unit-review']).default('stock'),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId } = req.user
    const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
    const terms = parsed.data.q?.toLowerCase().split(/\s+/).filter(Boolean) || []
    const stockWhere = buildWarehouseInventoryScopeWhere({ tenantId, warehouseId, scope: 'stock' })
    const bomMappingWhere = buildWarehouseInventoryScopeWhere({ tenantId, warehouseId, scope: 'bom-mapping' })
    const unitReviewWhere = buildWarehouseInventoryScopeWhere({ tenantId, warehouseId, scope: 'unit-review' })
    const scopeWhere = buildWarehouseInventoryScopeWhere({ tenantId, warehouseId, scope: parsed.data.scope })
    const where: Prisma.ProductWhereInput = {
      ...scopeWhere,
      status: parsed.data.productStatus === 'ALL'
        ? { in: ['PENDING_APPROVAL', 'PENDING_DISABLE', 'ENABLED', 'DISABLED'] }
        : parsed.data.productStatus,
      ...(terms.length ? {
        AND: terms.map(term => ({
          OR: [
            { code: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
            { category: { contains: term, mode: 'insensitive' } },
            { spec: { contains: term, mode: 'insensitive' } },
          ],
        })),
      } : {}),
    }
    const [warehouse, products, total, stockSku, bomMappingSku, unitReviewSku, allBalances, activeReservations, movementCount] = await Promise.all([
      prisma.warehouse.findFirstOrThrow({
        where: { id: warehouseId, tenantId },
        select: {
          id: true,
          code: true,
          name: true,
          rowVersion: true,
          inventoryMode: true,
          blockZeroStockAtOrderEntry: true,
          inventoryActivatedAt: true,
        },
      }),
      prisma.product.findMany({
        where,
        orderBy: [{ category: 'asc' }, { code: 'asc' }],
        skip: (parsed.data.page - 1) * parsed.data.pageSize,
        take: parsed.data.pageSize,
        select: {
          id: true, code: true, name: true, spec: true, category: true, unit: true, status: true,
          price: true,
          purchaseUnit: true, inventoryUnit: true, orderUnit: true, costUnit: true,
          inventoryUnitsPerPurchaseUnit: true, inventoryUnitsPerOrderUnit: true,
          inventoryUnitsPerCostUnit: true, unitConversionStatus: true, minStock: true,
        },
      }),
      prisma.product.count({ where }),
      prisma.product.count({ where: stockWhere }),
      prisma.product.count({ where: bomMappingWhere }),
      prisma.product.count({ where: unitReviewWhere }),
      prisma.warehouseLedgerBalance.findMany({ where: { tenantId, warehouseId } }),
      Promise.all([prisma.warehouseLedgerReservation.count({ where: { tenantId, warehouseId, status: 'ACTIVE' } }), prisma.replenishmentStockHold.count({ where: { tenantId, warehouseId, status: 'ACTIVE' } })]).then(([orders, replenishments]) => orders + replenishments),
      prisma.warehouseLedgerMovement.count({ where: { tenantId, warehouseId } }),
    ])
    const balanceByProduct = new Map(allBalances.map(item => [item.productId, item]))
    const items = products.map(product => {
      const contract = resolveProductFourUnits(product)
      const balance = balanceByProduct.get(product.id)
      const physicalQty = number(balance?.physicalQty)
      const reservedQty = number(balance?.reservedQty)
      const availableQty = physicalQty - reservedQty
      const minInventoryQty = Number(product.minStock || 0) * contract.inventoryUnitsPerOrderUnit
      return {
        id: product.id,
        code: product.code,
        name: product.name,
        spec: product.spec,
        category: product.category,
        productStatus: product.status,
        purchaseUnit: contract.purchaseUnit,
        inventoryUnit: contract.inventoryUnit,
        purchaseToInventoryFactor: contract.inventoryUnitsPerPurchaseUnit,
        unitConversionStatus: contract.status,
        physicalQty,
        reservedQty,
        availableQty,
        inventoryValue: number(balance?.inventoryValue),
        averageUnitCost: number(balance?.averageUnitCost),
        shipmentAmount: currentInventoryShipmentAmount({
          physicalQty,
          price: product.price,
          inventoryUnitsPerCostUnit: product.inventoryUnitsPerCostUnit,
        }),
        rowVersion: balance?.rowVersion || 0,
        statusFlag: physicalQty < 0 ? 'SHADOW_GAP' : availableQty <= 0 ? 'OUT' : availableQty <= minInventoryQty ? 'LOW' : 'OK',
      }
    })
    const totalValue = allBalances.reduce((sum, item) => sum.plus(item.inventoryValue), new Prisma.Decimal(0))
    const physicalSku = allBalances.filter(item => item.physicalQty.gt(0)).length
    const negativeSku = allBalances.filter(item => item.physicalQty.lt(0)).length
    return {
      warehouse,
      canEditOrderEntryPolicy: canEditOrderEntryPolicy(req.user.role),
      summary: {
        inventoryMode: warehouse.inventoryMode,
        totalSku: stockSku,
        physicalSku,
        negativeSku,
        totalValue: Number(totalValue),
        activeReservations,
        movementCount,
        strictActivated: warehouse.inventoryMode === 'STRICT' && Boolean(warehouse.inventoryActivatedAt),
      },
      scope: parsed.data.scope,
      scopeCounts: { stockSku, bomMappingSku, unitReviewSku },
      items,
      total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
    }
  })

  app.get('/movements', authRead, async (req: any, reply: any) => {
    const parsed = z.object({
      productId: z.string().trim().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId } = req.user
    const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
    const rows = await prisma.warehouseLedgerMovement.findMany({
      where: {
        tenantId,
        warehouseId,
        ...(parsed.data.productId ? { productId: parsed.data.productId } : {}),
      },
      orderBy: [{ effectiveAt: 'desc' }, { recordedAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit,
      include: {
        product: { select: { id: true, code: true, name: true } },
        reversal: { select: { id: true } },
        docLines: { select: { doc: { select: { status: true, reviewStatus: true } } } },
      },
    })
    const inboundValues = await currentInboundValues(prisma, tenantId, warehouseId, rows)
    return rows.map(row => ({
      ...row,
      physicalDelta: number(row.physicalDelta),
      reservedDelta: number(row.reservedDelta),
      valueDelta: number(row.valueDelta),
      currentInboundValue: inboundValues.has(row.id) ? number(inboundValues.get(row.id)) : undefined,
      physicalAfter: number(row.physicalAfter),
      reservedAfter: number(row.reservedAfter),
      valueAfter: number(row.valueAfter),
      averageUnitCostAfter: number(row.averageUnitCostAfter),
      originalQuantity: number(row.originalQuantity),
      conversionFactor: number(row.conversionFactor),
      inventoryQuantity: number(row.inventoryQuantity),
      inventoryUnitCost: number(row.inventoryUnitCost),
      reversed: Boolean(row.reversal),
      canReverse: !row.docLines.some(line => line.doc.status === 'CONFIRMED' || line.doc.reviewStatus === 'REVIEWED'),
    }))
  })

  // 入库记录中心（P2）：总仓全部入库流水的统一查询视图
  app.get('/inbound-records', authRead, async (req: any, reply: any) => {
    const parsed = z.object({
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      supplierId: z.string().trim().min(1).optional(),
      q: z.string().trim().max(100).optional(),
      source: z.enum(['all', 'manual', 'batch', 'package', 'opening', 'purchase']).default('all'),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId } = req.user
    const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
    const sourceTypeMap: Record<string, string> = {
      manual: 'WarehouseManualInbound',
      batch: 'WarehouseBatchManualInbound',
      package: 'MeituanDailyPackage',
    }
    const terms = parsed.data.q?.toLowerCase().split(/\s+/).filter(Boolean) || []
    const where: Prisma.WarehouseLedgerMovementWhereInput = {
      tenantId,
      warehouseId,
      ...(parsed.data.source === 'opening'
        ? { type: 'OPENING_BALANCE' }
        : parsed.data.source === 'all'
          ? { type: { in: ['MANUAL_INBOUND', 'OPENING_BALANCE', 'UPSTREAM_RECEIPT'] } }
          : parsed.data.source === 'purchase' ? {type:'UPSTREAM_RECEIPT'} : { type: 'MANUAL_INBOUND', sourceType: sourceTypeMap[parsed.data.source] }),
      ...(parsed.data.supplierId ? { supplierId: parsed.data.supplierId } : {}),
      ...((parsed.data.from||parsed.data.to)?{effectiveAt:{...(parsed.data.from?{gte:new Date(`${parsed.data.from}T00:00:00+08:00`)}:{}),...(parsed.data.to?{lte:new Date(`${parsed.data.to}T23:59:59.999+08:00`)}:{})}}:{}),
      ...(terms.length ? {
        AND: terms.map(term => ({ OR: [
          { product: { code: { contains: term, mode: 'insensitive' as const } } },
          { product: { name: { contains: term, mode: 'insensitive' as const } } },
        ] })),
      } : {}),
    }
    const [total, sumAgg, rows] = await Promise.all([
      prisma.warehouseLedgerMovement.count({ where }),
      prisma.warehouseLedgerMovement.aggregate({ where, _sum: { valueDelta: true } }),
      prisma.warehouseLedgerMovement.findMany({
        where,
        orderBy: [{ effectiveAt: 'desc' }, { recordedAt: 'desc' }, { id: 'desc' }],
        skip: (parsed.data.page - 1) * parsed.data.pageSize,
        take: parsed.data.pageSize,
        include: {
          product: { select: { id: true, code: true, name: true, category: true } },
          supplier: { select: { id: true, no: true, name: true } },
          createdLot: { select: { batchNo: true, expiryDate: true } },
          reversal: { select: { id: true } },
        },
      }),
    ])
    // 关联仓库单据（审核流）：按流水ID找到所属单据，给前端"改单"入口用
    const docLines = rows.length
      ? await prisma.warehouseDocLine.findMany({
          where: { tenantId, movementId: { in: rows.map(row => row.id) } },
          select: { movementId: true, doc: { select: { id: true, docNo: true, status: true } } },
        })
      : []
    const docByMovement = new Map(docLines.map(line => [line.movementId, line.doc]))
    const purchaseReceipts=await prisma.upstreamReceipt.findMany({where:{tenantId,id:{in:rows.filter(row=>row.type==='UPSTREAM_RECEIPT'&&row.sourceType==='UpstreamReceipt').map(row=>row.sourceId)}},select:{id:true,no:true}})
    const receiptById=new Map(purchaseReceipts.map(row=>[row.id,row]))
    return {
      total,
      totalAmount: Math.round((sumAgg._sum.valueDelta ? number(sumAgg._sum.valueDelta) : 0) * 100) / 100,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      items: rows.map(row => ({
        id: row.id,
        type: row.type,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        effectiveAt: row.effectiveAt,
        recordedAt: row.recordedAt,
        product: row.product,
        supplier: row.supplier,
        sourceName: row.sourceName,
        note: row.note,
        originalQuantity: number(row.originalQuantity),
        originalUnit: row.originalUnit,
        inventoryQuantity: number(row.inventoryQuantity),
        inventoryUnit: row.inventoryUnit,
        inventoryUnitCost: number(row.inventoryUnitCost),
        amount: number(row.valueDelta),
        batchNo: row.createdLot?.batchNo || null,
        expiryDate: row.createdLot?.expiryDate || null,
        reversed: Boolean(row.reversal),
        doc: docByMovement.get(row.id) || null,
        purchaseReceipt:row.type==='UPSTREAM_RECEIPT'?receiptById.get(row.sourceId)||null:null,
      })),
    }
  })

  app.get('/lots', authRead, async (req: any, reply: any) => {
    const parsed = z.object({
      productId: z.string().trim().min(1).optional(),
      includeDepleted: z.union([z.literal('true'), z.literal('false'), z.boolean()])
        .default(false)
        .transform(value => value === true || value === 'true'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId } = req.user
    const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
    const rows = await prisma.warehouseLedgerLot.findMany({
      where: {
        tenantId,
        warehouseId,
        ...(parsed.data.productId ? { productId: parsed.data.productId } : {}),
        ...(parsed.data.includeDepleted ? {} : { remainingQty: { gt: 0 } }),
      },
      orderBy: [
        { expiryDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: parsed.data.limit,
      include: { product: { select: { id: true, code: true, name: true } } },
    })
    return rows.map(row => ({
      ...row,
      initialQty: number(row.initialQty),
      remainingQty: number(row.remainingQty),
      inventoryUnitCost: number(row.inventoryUnitCost),
    }))
  })

  app.get('/audit', authRead, async (req: any) => {
    return auditWarehouseLedger(req.user.tenantId)
  })

  /** 仅配置门店提交内部总仓订单时的零库存阻断，不改变台账、预占或出库模式。 */
  app.patch('/order-entry-policy', authOrderEntryPolicyWrite, async (req: any, reply: any) => {
    const parsed = orderEntryPolicySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const { tenantId, userId, role } = req.user
    const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
    try {
      return await prisma.$transaction(async tx => {
        const lockedWarehouses = await tx.$queryRaw<Array<{
          id: string
          name: string
          inventoryMode: 'OFF' | 'SHADOW' | 'STRICT'
          blockZeroStockAtOrderEntry: boolean
          rowVersion: number
        }>>`
          SELECT "id", "name", "inventoryMode"::text AS "inventoryMode",
                 "blockZeroStockAtOrderEntry", "rowVersion"
          FROM "warehouses"
          WHERE "id" = ${warehouseId} AND "tenantId" = ${tenantId} AND "isActive" = true
          FOR UPDATE
        `
        const warehouse = lockedWarehouses[0]
        if (!warehouse) throw Object.assign(new Error('总仓不存在或不属于当前租户'), { statusCode: 404 })
        if (warehouse.rowVersion !== parsed.data.rowVersion) {
          throw Object.assign(new Error('库存策略已被其他人更新，请刷新后重试'), { statusCode: 409 })
        }
        if (warehouse.blockZeroStockAtOrderEntry === parsed.data.blockZeroStockAtOrderEntry) {
          return {
            warehouseId: warehouse.id,
            blockZeroStockAtOrderEntry: warehouse.blockZeroStockAtOrderEntry,
            rowVersion: warehouse.rowVersion,
            unchanged: true,
          }
        }
        if (parsed.data.blockZeroStockAtOrderEntry && warehouse.inventoryMode === 'OFF') {
          throw Object.assign(new Error('总仓库存投影尚未启用，不能在门店提交阶段按零库存阻断'), { statusCode: 409 })
        }
        if (parsed.data.blockZeroStockAtOrderEntry && warehouse.inventoryMode === 'SHADOW') {
          const audit = await auditWarehouseLedger(tenantId, tx, warehouse.id)
          if (!audit.readyForStrict) {
            throw Object.assign(
              new Error(`库存四账审计未通过，仍有 ${audit.blockerCount} 项阻断问题，不能在门店提交阶段按零库存阻断`),
              { statusCode: 409, blockerCount: audit.blockerCount, firstIssue: audit.issues[0] || null },
            )
          }
        }

        const updated = await tx.warehouse.updateMany({
          where: {
            id: warehouse.id,
            tenantId,
            isActive: true,
            rowVersion: parsed.data.rowVersion,
          },
          data: {
            blockZeroStockAtOrderEntry: parsed.data.blockZeroStockAtOrderEntry,
            rowVersion: { increment: 1 },
          },
        })
        if (updated.count !== 1) {
          throw Object.assign(new Error('库存策略已被其他人更新，请刷新后重试'), { statusCode: 409 })
        }
        await tx.opLog.create({
          data: {
            tenantId,
            userId,
            role,
            action: parsed.data.blockZeroStockAtOrderEntry
              ? '门店提交订单切换为零库存禁止提交'
              : '门店提交订单切换为库存仅提醒、仍可提交',
            target: warehouse.name,
            targetId: warehouse.id,
            entityType: 'Warehouse',
            ip: req.ip,
            metadata: {
              inventoryMode: warehouse.inventoryMode,
              before: warehouse.blockZeroStockAtOrderEntry,
              after: parsed.data.blockZeroStockAtOrderEntry,
              role,
              requestId: req.id,
              ip: req.ip,
              scope: 'ORDER_ENTRY_ONLY',
            },
          },
        })
        return {
          warehouseId: warehouse.id,
          blockZeroStockAtOrderEntry: parsed.data.blockZeroStockAtOrderEntry,
          rowVersion: warehouse.rowVersion + 1,
          unchanged: false,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    } catch (error: any) {
      if (error?.statusCode) {
        return reply.status(error.statusCode).send({
          error: error.message,
          ...(typeof error.blockerCount === 'number' ? { blockerCount: error.blockerCount } : {}),
          ...(error.firstIssue ? { firstIssue: error.firstIssue } : {}),
        })
      }
      if (isWarehousePolicyTransactionConflict(error)) {
        return reply.status(409).send({ error: '库存策略正在被其他人更新，请刷新后重试' })
      }
      throw error
    }
  })

  app.get('/inbound-candidates', authRead, async (req: any, reply: any) => {
    const parsed = z.object({
      q: z.string().trim().max(100).optional(),
      paged:z.enum(['1']).optional(),cursor:z.string().min(1).max(100).optional(),
      productIds:z.string().max(20000).transform(value=>[...new Set(value.split(',').map(id=>id.trim()).filter(Boolean))]).pipe(z.array(z.string().min(1).max(100)).min(1).max(200)).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(500),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const terms = parsed.data.q?.toLowerCase().split(/\s+/).filter(Boolean) || []
    const products = await prisma.product.findMany({
      where: {
        tenantId: req.user.tenantId,
        ...(parsed.data.productIds?{id:{in:parsed.data.productIds}}:{status:'ENABLED',unitConversionStatus:'VERIFIED',NOT:{category:'BOM待采购映射'}}),
        ...(terms.length ? {
          AND: terms.map(term => ({ OR: [
            { code: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
            { spec: { contains: term, mode: 'insensitive' } },
          ] })),
        } : {}),
      },
      orderBy: parsed.data.paged||parsed.data.productIds?{id:'asc'}:[{category:'asc'},{code:'asc'}],
      ...(parsed.data.cursor?{cursor:{id:parsed.data.cursor},skip:1}:{}),
      take: parsed.data.productIds?200:parsed.data.limit,
      select: {
        id: true, code: true, name: true, spec: true, category: true, unit: true,status:true,
        purchaseUnit: true, inventoryUnit: true, orderUnit: true, costUnit: true,
        inventoryUnitsPerPurchaseUnit: true, inventoryUnitsPerOrderUnit: true,
        inventoryUnitsPerCostUnit: true, unitConversionStatus: true,
      },
    })
    return {
      nextCursor:parsed.data.paged&&products.length===parsed.data.limit?products[products.length-1].id:null,
      items: products.flatMap(product => {
        const contract = resolveProductFourUnits(product)
        const eligible=product.status==='ENABLED'&&product.category!=='BOM待采购映射'&&contract.structured.purchase&&contract.status==='VERIFIED'
        if(!eligible&&!parsed.data.productIds)return []
        return [{
          id: product.id,
          code: product.code,
          name: product.name,
          spec: product.spec,
          category: product.category,
          purchaseUnit: contract.purchaseUnit,
          inventoryUnit: contract.inventoryUnit,
          purchaseToInventoryFactor: eligible?contract.inventoryUnitsPerPurchaseUnit:0,eligible,unitConversionStatus:contract.status,
        }]
      }),
    }
  })

  app.get('/purchase-inbound-price-history', authRead, async (req: any, reply: any) => {
    const parsed = z.object({ supplierId: z.string().trim().min(1), productIds: z.string().trim().min(1).max(10_000).transform(value => Array.from(new Set(value.split(',').map(id => id.trim()).filter(Boolean)))).pipe(z.array(z.string()).min(1).max(200)) }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const products = await prisma.product.findMany({ where: { tenantId: req.user.tenantId, id: { in: parsed.data.productIds } }, select: { id: true, purchaseUnit: true, unit: true } })
    const purchaseUnits = Object.fromEntries(products.map(product => [product.id, product.purchaseUnit || product.unit]))
    const items = await findLatestPurchaseInboundPrices({ tenantId: req.user.tenantId, supplierId: parsed.data.supplierId, productIds: products.map(product => product.id), purchaseUnits })
    return { items: items.map(item => ({ ...item, effectiveAt: item.effectiveAt.toISOString() })) }
  })

  app.post('/manual-inbound', authWrite, async (req: any, reply: any) => {
    if (upstreamFeatureEnabled('UPSTREAM_MANUAL_INBOUND_RESTRICTED')) {
      return reply.status(409).send({ error: '手工入库已收口，请从上游采购的发货单发起验收入库' })
    }
    const parsed = manualInboundSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const manufactureDate = parsed.data.manufactureDate ? new Date(`${parsed.data.manufactureDate}T00:00:00.000Z`) : null
    const expiryDate = parsed.data.expiryDate ? new Date(`${parsed.data.expiryDate}T00:00:00.000Z`) : null
    try {
      if (parsed.data.draftId) {
        if (!parsed.data.draftVersion) return reply.code(400).send({error:'缺少草稿版本'})
        const draft = await prisma.warehouseInboundDraft.findFirst({where:{id:parsed.data.draftId,tenantId:req.user.tenantId,createdById:req.user.userId}})
        if (!draft) return reply.code(404).send({error:'草稿不存在'})
        if (draft.mode!=='SINGLE') return reply.code(400).send({error:'草稿类型与入库入口不一致'})
        if (draft.status==='EDITING') await assertWarehouseDocumentObjects(req.user.tenantId,normalizeWarehouseDocAttachments(req.user.tenantId,draftPayloadSchema.parse(draft.payload).attachments))
        const result=await submitInboundDraft({tenantId:req.user.tenantId,userId:req.user.userId,id:draft.id,version:parsed.data.draftVersion,auditOnSubmit:false})
        return {ok:true,replayed:result.replayed,gateWarnings:result.gateWarnings,count:result.doc.lineCount,totalAmount:Number(result.doc.totalAmount),doc:{id:result.doc.id,docNo:result.doc.docNo,status:result.doc.status,reviewStatus:result.doc.reviewStatus}}
      }

      const attachments = normalizeWarehouseDocAttachments(req.user.tenantId, parsed.data.attachments)
      await assertWarehouseDocumentObjects(req.user.tenantId, attachments)
      const supplier = await requireUpstreamSupplier(req.user.tenantId, parsed.data.supplierId)
      const gateWarnings = await inboundGateWarnings(req.user.tenantId, supplier.id, [parsed.data.productId])
      const result=await serializableWithRetry(tx=>createReviewInbound(tx,{
        tenantId:req.user.tenantId,userId:req.user.userId,
        items:[{productId:parsed.data.productId,purchaseQuantity:parsed.data.purchaseQuantity,totalAmount:parsed.data.totalAmount,batchNo:parsed.data.batchNo,manufactureDate,expiryDate}],
        effectiveAt:new Date(parsed.data.effectiveAt),idempotencyKey:parsed.data.idempotencyKey,documentKey:`manual-inbound:${parsed.data.idempotencyKey}`,
        supplierId:supplier.id,sourceName:supplier.name,note:parsed.data.note,attachments,
      }))
      return {ok:true,replayed:!result.created,warehouseId:result.doc.warehouseId,count:result.doc.lineCount,totalAmount:Number(result.doc.totalAmount),gateWarnings,doc:{id:result.doc.id,docNo:result.doc.docNo,status:result.doc.status},movements:[]}
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/batch-manual-inbound', authWrite, async (req: any, reply: any) => {
    if (upstreamFeatureEnabled('UPSTREAM_MANUAL_INBOUND_RESTRICTED')) {
      return reply.status(409).send({ error: '批量手工入库已收口，请从上游采购的发货单发起验收入库' })
    }
    const parsed = batchManualInboundSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      if (parsed.data.draftId) {
        if (!parsed.data.draftVersion) return reply.code(400).send({error:'缺少草稿版本'})
        const draft = await prisma.warehouseInboundDraft.findFirst({where:{id:parsed.data.draftId,tenantId:req.user.tenantId,createdById:req.user.userId}})
        if (!draft) return reply.code(404).send({error:'草稿不存在'})
        if (draft.mode!=='BATCH') return reply.code(400).send({error:'草稿类型与入库入口不一致'})
        if (draft.status==='EDITING') await assertWarehouseDocumentObjects(req.user.tenantId,normalizeWarehouseDocAttachments(req.user.tenantId,draftPayloadSchema.parse(draft.payload).attachments))
        const result=await submitInboundDraft({tenantId:req.user.tenantId,userId:req.user.userId,id:draft.id,version:parsed.data.draftVersion,auditOnSubmit:false})
        return {ok:true,replayed:result.replayed,gateWarnings:result.gateWarnings,count:result.doc.lineCount,totalAmount:Number(result.doc.totalAmount),doc:{id:result.doc.id,docNo:result.doc.docNo,status:result.doc.status,reviewStatus:result.doc.reviewStatus}}
      }

      const attachments = normalizeWarehouseDocAttachments(req.user.tenantId, parsed.data.attachments)
      await assertWarehouseDocumentObjects(req.user.tenantId, attachments)
      const supplier = await requireUpstreamSupplier(req.user.tenantId, parsed.data.supplierId)
      const gateWarnings = await inboundGateWarnings(req.user.tenantId, supplier.id, parsed.data.items.map(item => item.productId))
      const result=await serializableWithRetry(tx=>createReviewInbound(tx,{
        tenantId:req.user.tenantId,userId:req.user.userId,
        items:parsed.data.items.map(item=>({...item,manufactureDate:item.manufactureDate?new Date(`${item.manufactureDate}T00:00:00.000Z`):null,expiryDate:item.expiryDate?new Date(`${item.expiryDate}T00:00:00.000Z`):null})),
        effectiveAt:new Date(parsed.data.effectiveAt),idempotencyKey:parsed.data.idempotencyKey,documentKey:`manual-inbound-batch:${parsed.data.idempotencyKey}`,
        supplierId:supplier.id,sourceName:supplier.name,note:parsed.data.note,attachments,
      }))
      return {ok:true,replayed:!result.created,warehouseId:result.doc.warehouseId,count:result.doc.lineCount,totalAmount:Number(result.doc.totalAmount),gateWarnings,doc:{id:result.doc.id,docNo:result.doc.docNo,status:result.doc.status},movements:[]}
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/batch-manual-outbound', authWrite, async (req: any, reply: any) => {
    const parsed = batchManualOutboundSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      return await executeBatchManualOutbound(req, parsed.data, 'GENERIC')
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/batch-self-loss', authWrite, async (req: any, reply: any) => {
    const parsed = batchSelfLossSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      return await executeBatchManualOutbound(req, parsed.data, 'SELF_LOSS')
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/movements/:id/reverse', authWrite, async (req: any, reply: any) => {
    const parsed = z.object({
      reason: z.string().trim().min(2).max(240),
      idempotencyKey: z.string().trim().min(8).max(80),
    }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const result = await reverseManualWarehouseInbound({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        movementId: String(req.params.id),
        reason: parsed.data.reason,
        idempotencyKey: parsed.data.idempotencyKey,
      })
      return { ok: true, replayed: result.replayed, movementId: result.movement.id }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/physical-count', authWrite, async (req: any, reply: any) => {
    const parsed = physicalCountSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const result = await recordWarehousePhysicalCount({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        productId: parsed.data.productId,
        countedInventoryQuantity: parsed.data.countedInventoryQuantity,
        countedInventoryValue: parsed.data.countedInventoryValue,
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: parsed.data.idempotencyKey,
        note: parsed.data.note,
      })
      return {
        ok: true,
        replayed: result.replayed,
        movement: {
          id: result.movement.id,
          type: result.movement.type,
          physicalDelta: number(result.movement.physicalDelta),
          physicalAfter: number(result.movement.physicalAfter),
          valueAfter: number(result.movement.valueAfter),
          inventoryUnit: result.movement.inventoryUnit,
        },
      }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/reconcile-shadow', authWrite, async (req: any, reply: any) => {
    const parsed = z.object({
      limit: z.number().int().min(1).max(500).default(200),
      cursor: z.string().trim().min(1).optional().nullable(),
    }).safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      return await reconcileWarehouseShadowLedger({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })
}
