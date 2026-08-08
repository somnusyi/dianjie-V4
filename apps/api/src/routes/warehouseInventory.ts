import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { resolveTenantWarehouseId } from '../services/defaultWarehouse'
import {
  recordBatchManualWarehouseInbound,
  recordManualWarehouseInbound,
  recordWarehousePhysicalCount,
  reverseManualWarehouseInbound,
} from '../services/warehouseLedger'
import { auditWarehouseLedger } from '../services/warehouseLedgerAudit'
import { reconcileWarehouseShadowLedger } from '../services/warehouseLedgerReconciliation'
import { resolveProductFourUnits } from '../services/inventoryUnits'

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
    batchNo: z.string().trim().max(80).optional().nullable(),
    manufactureDate: z.string().date().optional().nullable(),
    expiryDate: z.string().date().optional().nullable(),
  })).min(1).max(200),
  effectiveAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(80),
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
          id: true, code: true, name: true, spec: true, category: true, unit: true,
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
      const result = await recordManualWarehouseInbound({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        productId: parsed.data.productId,
        purchaseQuantity: parsed.data.purchaseQuantity,
        totalAmount: parsed.data.totalAmount,
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: parsed.data.idempotencyKey,
        sourceName: parsed.data.sourceName,
        note: parsed.data.note,
        batchNo: parsed.data.batchNo,
        manufactureDate,
        expiryDate,
      })
      return {
        ok: true,
        replayed: result.replayed,
        warehouseId: result.warehouseId,
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
      const result = await recordBatchManualWarehouseInbound({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        items: parsed.data.items.map(item => ({
          productId: item.productId,
          purchaseQuantity: item.purchaseQuantity,
          unitPrice: item.unitPrice,
          batchNo: item.batchNo,
          manufactureDate: item.manufactureDate ? new Date(`${item.manufactureDate}T00:00:00+08:00`) : null,
          expiryDate: item.expiryDate ? new Date(`${item.expiryDate}T00:00:00+08:00`) : null,
        })),
        effectiveAt: new Date(parsed.data.effectiveAt),
        idempotencyKey: parsed.data.idempotencyKey,
        sourceName: parsed.data.sourceName,
        note: parsed.data.note,
      })
      const totalAmount = result.movements.reduce((sum, movement) => sum + number(movement.valueDelta), 0)
      return {
        ok: true,
        replayed: result.replayed,
        warehouseId: result.warehouseId,
        count: result.movements.length,
        totalAmount,
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
