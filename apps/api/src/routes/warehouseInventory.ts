import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { resolveTenantWarehouseId } from '../services/defaultWarehouse'
import {
  recordBatchManualWarehouseInbound,
  recordBatchManualWarehouseOutbound,
  recordManualWarehouseInbound,
  recordWarehousePhysicalCount,
  reverseManualWarehouseInbound,
} from '../services/warehouseLedger'
import { auditWarehouseLedger } from '../services/warehouseLedgerAudit'
import { reconcileWarehouseShadowLedger } from '../services/warehouseLedgerReconciliation'
import { resolveProductFourUnits } from '../services/inventoryUnits'
import { ensureWarehouseDoc, type WarehouseDocLineInput } from '../services/warehouseDocs'

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
  reason?: string | null
  note?: string | null
  lines: WarehouseDocLineInput[]
}) {
  const { doc, created } = await ensureWarehouseDoc(input)
  return { id: doc.id, docNo: doc.docNo, status: doc.status as string, created }
}

const READ_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'PURCHASER'])
const WRITE_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'PURCHASER'])
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

function number(value: Prisma.Decimal | null | undefined) {
  return Number(value || 0)
}

const manualInboundSchema = z.object({
  productId: z.string().trim().min(1),
  purchaseQuantity: z.number().positive().max(99_999_999),
  totalAmount: z.number().positive().max(999_999_999.99),
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
  supplierId: z.string({ required_error: '请选择供货供应商' }).trim().min(1, '请选择供货供应商'),
  sourceName: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(240).optional().nullable(),
  batchNo: z.string().trim().max(80).optional().nullable(),
  manufactureDate: z.string().date().optional().nullable(),
  expiryDate: z.string().date().optional().nullable(),
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
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
  supplierId: z.string({ required_error: '请选择供货供应商' }).trim().min(1, '请选择供货供应商'),
  sourceName: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(240).optional().nullable(),
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

// 批量手工出库（2026-08-23）：订单体系之外的总仓出库——门店拨补/样品/报损/历史补录。
// 数量按库存单位；成本缺省按移动均价带出，可指定权威成本（如美团口径）。
const batchManualOutboundSchema = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    inventoryQuantity: z.number().positive().max(99_999_999),
    totalAmount: z.number().positive().max(999_999_999.99).optional().nullable(),
    note: z.string().trim().max(240).optional().nullable(),
  })).min(1).max(200),
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
  reason: z.string().trim().min(2, '请填写出库原因/去向').max(120),
  sourceName: z.string().trim().max(120).optional().nullable(),
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

export const warehouseInventoryRoutes: FastifyPluginAsync = async app => {
  const authRead = { preHandler: [(app as any).authenticate, requireCapability('inventory.read')] }
  const authWrite = { preHandler: [(app as any).authenticate, requireCapability('inventory.write')] }

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
        select: { id: true, code: true, name: true, inventoryMode: true, inventoryActivatedAt: true },
      }),
      prisma.product.findMany({
        where,
        orderBy: [{ category: 'asc' }, { code: 'asc' }],
        skip: (parsed.data.page - 1) * parsed.data.pageSize,
        take: parsed.data.pageSize,
        select: {
          id: true, code: true, name: true, spec: true, category: true, unit: true, status: true,
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
      prisma.warehouseLedgerReservation.count({ where: { tenantId, warehouseId, status: 'ACTIVE' } }),
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
        rowVersion: balance?.rowVersion || 0,
        statusFlag: physicalQty < 0 ? 'SHADOW_GAP' : availableQty <= 0 ? 'OUT' : availableQty <= minInventoryQty ? 'LOW' : 'OK',
      }
    })
    const totalValue = allBalances.reduce((sum, item) => sum.plus(item.inventoryValue), new Prisma.Decimal(0))
    const physicalSku = allBalances.filter(item => item.physicalQty.gt(0)).length
    const negativeSku = allBalances.filter(item => item.physicalQty.lt(0)).length
    return {
      warehouse,
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
      },
    })
    return rows.map(row => ({
      ...row,
      physicalDelta: number(row.physicalDelta),
      reservedDelta: number(row.reservedDelta),
      valueDelta: number(row.valueDelta),
      physicalAfter: number(row.physicalAfter),
      reservedAfter: number(row.reservedAfter),
      valueAfter: number(row.valueAfter),
      averageUnitCostAfter: number(row.averageUnitCostAfter),
      originalQuantity: number(row.originalQuantity),
      conversionFactor: number(row.conversionFactor),
      inventoryQuantity: number(row.inventoryQuantity),
      inventoryUnitCost: number(row.inventoryUnitCost),
      reversed: Boolean(row.reversal),
    }))
  })

  // 入库记录中心（P2）：总仓全部入库流水的统一查询视图
  app.get('/inbound-records', authRead, async (req: any, reply: any) => {
    const parsed = z.object({
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      supplierId: z.string().trim().min(1).optional(),
      q: z.string().trim().max(100).optional(),
      source: z.enum(['all', 'manual', 'batch', 'package', 'opening']).default('all'),
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
          ? { type: { in: ['MANUAL_INBOUND', 'OPENING_BALANCE'] } }
          : { type: 'MANUAL_INBOUND', sourceType: sourceTypeMap[parsed.data.source] }),
      ...(parsed.data.supplierId ? { supplierId: parsed.data.supplierId } : {}),
      ...(parsed.data.from ? { effectiveAt: { gte: new Date(`${parsed.data.from}T00:00:00+08:00`) } } : {}),
      ...(parsed.data.to ? { effectiveAt: { lte: new Date(`${parsed.data.to}T23:59:59.999+08:00`) } } : {}),
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

  app.get('/inbound-candidates', authRead, async (req: any, reply: any) => {
    const parsed = z.object({
      q: z.string().trim().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(500),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const terms = parsed.data.q?.toLowerCase().split(/\s+/).filter(Boolean) || []
    const products = await prisma.product.findMany({
      where: {
        tenantId: req.user.tenantId,
        status: 'ENABLED',
        unitConversionStatus: 'VERIFIED',
        NOT: { category: 'BOM待采购映射' },
        ...(terms.length ? {
          AND: terms.map(term => ({ OR: [
            { code: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
            { spec: { contains: term, mode: 'insensitive' } },
          ] })),
        } : {}),
      },
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
      take: parsed.data.limit,
      select: {
        id: true, code: true, name: true, spec: true, category: true, unit: true,
        purchaseUnit: true, inventoryUnit: true, orderUnit: true, costUnit: true,
        inventoryUnitsPerPurchaseUnit: true, inventoryUnitsPerOrderUnit: true,
        inventoryUnitsPerCostUnit: true, unitConversionStatus: true,
      },
    })
    return {
      items: products.flatMap(product => {
        const contract = resolveProductFourUnits(product)
        if (!contract.structured.purchase || contract.status !== 'VERIFIED') return []
        return [{
          id: product.id,
          code: product.code,
          name: product.name,
          spec: product.spec,
          category: product.category,
          purchaseUnit: contract.purchaseUnit,
          inventoryUnit: contract.inventoryUnit,
          purchaseToInventoryFactor: contract.inventoryUnitsPerPurchaseUnit,
        }]
      }),
    }
  })

  app.post('/manual-inbound', authWrite, async (req: any, reply: any) => {
    const parsed = manualInboundSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const manufactureDate = parsed.data.manufactureDate ? new Date(`${parsed.data.manufactureDate}T00:00:00+08:00`) : null
    const expiryDate = parsed.data.expiryDate ? new Date(`${parsed.data.expiryDate}T00:00:00+08:00`) : null
    try {
      const supplier = await requireUpstreamSupplier(req.user.tenantId, parsed.data.supplierId)
      const gateWarnings = await inboundGateWarnings(req.user.tenantId, supplier.id, [parsed.data.productId])
      const result = await recordManualWarehouseInbound({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        productId: parsed.data.productId,
        purchaseQuantity: parsed.data.purchaseQuantity,
        totalAmount: parsed.data.totalAmount,
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: parsed.data.idempotencyKey,
        supplierId: supplier.id,
        sourceName: supplier.name,
        note: parsed.data.note,
        batchNo: parsed.data.batchNo,
        manufactureDate,
        expiryDate,
      })
      if (gateWarnings.length > 0 && !result.replayed) {
        await prisma.opLog.create({
          data: {
            tenantId: req.user.tenantId,
            userId: req.user.userId,
            action: `入库闸口警告：${gateWarnings.length} 个商品未绑定供应商「${supplier.name}」的供货关系`,
            target: parsed.data.idempotencyKey,
            entityType: 'WarehouseLedgerMovement',
            targetId: result.movement.id,
            metadata: { supplierId: supplier.id, supplierName: supplier.name, warnings: gateWarnings },
          },
        })
      }
      const inboundProduct = await prisma.product.findFirst({
        where: { tenantId: req.user.tenantId, id: parsed.data.productId },
        select: { id: true, name: true, purchaseUnit: true, inventoryUnit: true },
      })
      const doc = await registerWarehouseDoc({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        type: 'MANUAL_INBOUND',
        warehouseId: result.warehouseId,
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: `manual-inbound:${parsed.data.idempotencyKey}`,
        supplierId: supplier.id,
        supplierName: supplier.name,
        note: parsed.data.note,
        lines: [{
          productId: parsed.data.productId,
          productName: inboundProduct?.name || parsed.data.productId,
          quantity: parsed.data.purchaseQuantity,
          unit: inboundProduct?.purchaseUnit || String(result.movement.inventoryUnit || ''),
          unitPrice: Math.round((parsed.data.totalAmount / parsed.data.purchaseQuantity) * 1_000_000) / 1_000_000,
          amount: parsed.data.totalAmount,
          inventoryQuantity: Math.abs(number(result.movement.physicalDelta)),
          inventoryUnit: String(result.movement.inventoryUnit || inboundProduct?.inventoryUnit || ''),
          batchNo: parsed.data.batchNo,
          manufactureDate,
          expiryDate,
          movementId: result.movement.id,
        }],
      })
      return {
        ok: true,
        replayed: result.replayed,
        warehouseId: result.warehouseId,
        gateWarnings,
        doc,
        movement: {
          id: result.movement.id,
          productId: result.movement.productId,
          physicalDelta: number(result.movement.physicalDelta),
          physicalAfter: number(result.movement.physicalAfter),
          inventoryUnit: result.movement.inventoryUnit,
          valueDelta: number(result.movement.valueDelta),
          valueAfter: number(result.movement.valueAfter),
          averageUnitCostAfter: number(result.movement.averageUnitCostAfter),
          effectiveAt: result.movement.effectiveAt,
        },
      }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/batch-manual-inbound', authWrite, async (req: any, reply: any) => {
    const parsed = batchManualInboundSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const supplier = await requireUpstreamSupplier(req.user.tenantId, parsed.data.supplierId)
      const gateWarnings = await inboundGateWarnings(req.user.tenantId, supplier.id, parsed.data.items.map(item => item.productId))
      const result = await recordBatchManualWarehouseInbound({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        items: parsed.data.items.map(item => ({
          productId: item.productId,
          purchaseQuantity: item.purchaseQuantity,
          unitPrice: item.unitPrice,
          totalAmount: item.totalAmount ?? null,
          batchNo: item.batchNo,
          manufactureDate: item.manufactureDate ? new Date(`${item.manufactureDate}T00:00:00+08:00`) : null,
          expiryDate: item.expiryDate ? new Date(`${item.expiryDate}T00:00:00+08:00`) : null,
        })),
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: parsed.data.idempotencyKey,
        supplierId: supplier.id,
        sourceName: supplier.name,
        note: parsed.data.note,
      })
      if (gateWarnings.length > 0 && !result.replayed) {
        await prisma.opLog.create({
          data: {
            tenantId: req.user.tenantId,
            userId: req.user.userId,
            action: `入库闸口警告：${gateWarnings.length} 个商品未绑定供应商「${supplier.name}」的供货关系`,
            target: parsed.data.idempotencyKey,
            entityType: 'WarehouseLedgerMovement',
            targetId: result.movements[0]?.id || '',
            metadata: { supplierId: supplier.id, supplierName: supplier.name, warnings: gateWarnings },
          },
        })
      }
      const totalAmount = result.movements.reduce((sum, movement) => sum + number(movement.valueDelta), 0)
      const movementByProduct = new Map(result.movements.map(movement => [movement.productId, movement]))
      const productRows = await prisma.product.findMany({
        where: { tenantId: req.user.tenantId, id: { in: parsed.data.items.map(item => item.productId) } },
        select: { id: true, name: true, purchaseUnit: true, inventoryUnit: true },
      })
      const productById = new Map(productRows.map(product => [product.id, product]))
      const doc = await registerWarehouseDoc({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        type: 'MANUAL_INBOUND',
        warehouseId: result.warehouseId,
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: `manual-inbound-batch:${parsed.data.idempotencyKey}`,
        supplierId: supplier.id,
        supplierName: supplier.name,
        note: parsed.data.note,
        lines: parsed.data.items.map(item => {
          const movement = movementByProduct.get(item.productId)
          const product = productById.get(item.productId)
          // 金额以台账流水为准（凑整口径 totalAmount 可能 ≠ 数量×单价）
          const movementAmount = movement ? Math.abs(number(movement.valueDelta)) : null
          const lineAmount = movementAmount ?? Math.round(item.purchaseQuantity * item.unitPrice * 100) / 100
          return {
            productId: item.productId,
            productName: product?.name || item.productId,
            quantity: item.purchaseQuantity,
            unit: product?.purchaseUnit || String(movement?.inventoryUnit || ''),
            unitPrice: Math.round((lineAmount / item.purchaseQuantity) * 1_000_000) / 1_000_000,
            amount: lineAmount,
            inventoryQuantity: movement ? Math.abs(number(movement.physicalDelta)) : 0,
            inventoryUnit: String(movement?.inventoryUnit || product?.inventoryUnit || ''),
            batchNo: item.batchNo,
            manufactureDate: item.manufactureDate ? new Date(`${item.manufactureDate}T00:00:00+08:00`) : null,
            expiryDate: item.expiryDate ? new Date(`${item.expiryDate}T00:00:00+08:00`) : null,
            movementId: movement?.id || null,
          }
        }),
      })
      return {
        ok: true,
        replayed: result.replayed,
        warehouseId: result.warehouseId,
        count: result.movements.length,
        totalAmount,
        gateWarnings,
        doc,
        movements: result.movements.map(movement => ({
          id: movement.id,
          productId: movement.productId,
          physicalDelta: number(movement.physicalDelta),
          inventoryUnit: movement.inventoryUnit,
          valueDelta: number(movement.valueDelta),
        })),
      }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/batch-manual-outbound', authWrite, async (req: any, reply: any) => {
    const parsed = batchManualOutboundSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const result = await recordBatchManualWarehouseOutbound({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        items: parsed.data.items.map(item => ({
          productId: item.productId,
          inventoryQuantity: item.inventoryQuantity,
          totalAmount: item.totalAmount ?? null,
          note: item.note,
        })),
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: parsed.data.idempotencyKey,
        reason: parsed.data.reason,
        sourceName: parsed.data.sourceName,
      })
      const totalAmount = result.movements.reduce((sum, movement) => sum + Math.abs(number(movement.valueDelta)), 0)
      const outProductRows = await prisma.product.findMany({
        where: { tenantId: req.user.tenantId, id: { in: parsed.data.items.map(item => item.productId) } },
        select: { id: true, name: true, inventoryUnit: true },
      })
      const outProductById = new Map(outProductRows.map(product => [product.id, product]))
      const outDoc = await registerWarehouseDoc({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        type: 'MANUAL_OUTBOUND',
        warehouseId: result.warehouseId,
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: `manual-outbound:${parsed.data.idempotencyKey}`,
        reason: parsed.data.reason,
        note: null,
        lines: parsed.data.items.map(item => {
          const movement = result.movements.find(row => row.productId === item.productId)
          const product = outProductById.get(item.productId)
          const quantity = movement ? Math.abs(number(movement.physicalDelta)) : item.inventoryQuantity
          const amount = movement ? Math.abs(number(movement.valueDelta)) : (item.totalAmount ?? 0)
          return {
            productId: item.productId,
            productName: product?.name || item.productId,
            quantity,
            unit: String(movement?.inventoryUnit || product?.inventoryUnit || ''),
            unitPrice: quantity > 0 ? Math.round((amount / quantity) * 1_000_000) / 1_000_000 : null,
            amount: Math.round(amount * 100) / 100,
            inventoryQuantity: quantity,
            inventoryUnit: String(movement?.inventoryUnit || product?.inventoryUnit || ''),
            note: item.note,
            movementId: movement?.id || null,
          }
        }),
      })
      return {
        ok: true,
        replayed: result.replayed,
        warehouseId: result.warehouseId,
        count: result.movements.length,
        totalAmount,
        doc: outDoc,
        movements: result.movements.map(movement => ({
          id: movement.id,
          productId: movement.productId,
          physicalDelta: number(movement.physicalDelta),
          inventoryUnit: movement.inventoryUnit,
          valueDelta: number(movement.valueDelta),
        })),
      }
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
