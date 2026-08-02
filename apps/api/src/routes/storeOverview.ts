import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { isSupplierRole } from '../lib/auth-scope'
import { isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { getStoreConsumptionRanking, getStoreOrderRunboard, getStoreOverview } from '../services/storeOverview'
import { signOssKey } from './upload'
import { getSupplierReservedStock, stockAvailability } from '../services/supplierStockReservation'
import { tryCostUnitPriceToOrderUnitPrice } from '../services/costUnitPricing'
import { loadOrderDraftProducts, validateOrderDraftLines } from '../services/orderDraftValidation'

const OVERVIEW_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPLY_CHAIN'])

function canViewStoreOverview(role: string | undefined | null): boolean {
  if (!role) return false
  return OVERVIEW_ROLES.has(role) || isInternalSupplyChainRole(role)
}

const consumptionRankingQuerySchema = z.object({
  days: z.coerce.number().int().refine(
    value => value === 7 || value === 30 || value === 90,
    '时间范围仅支持 7、30 或 90 天',
  ).default(30),
  dimension: z.enum(['PRODUCT', 'CATEGORY']).default('PRODUCT'),
}).strict()

const orderSimulationSchema = z.object({
  supplierId: z.string().trim().min(1, '请选择供应商'),
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    quantity: z.number().positive().max(99_999_999.99),
  }).strict()).min(1, '请至少选择一个商品').max(500),
}).strict()

export const storeOverviewRoutes: FastifyPluginAsync = async (app) => {
  const auth = (app as any).authenticate

  async function requireReadableStore(req: any, reply: any) {
    const { tenantId, role } = req.user
    if (isSupplierRole(role) || !canViewStoreOverview(role)) {
      reply.status(403).send({ error: '无权访问门店运营' })
      return null
    }
    const store = await prisma.store.findFirst({
      where: { id: req.params.storeId, tenantId },
      select: { id: true, no: true, name: true, status: true },
    })
    if (!store) {
      reply.status(404).send({ error: '门店不存在' })
      return null
    }
    return store
  }

  /**
   * Read-only mirror of the store order catalog. It deliberately returns only
   * enabled suppliers and enabled SKUs, matching what a store can select.
   */
  app.get('/:storeId/order-simulation/catalog', { preHandler: [auth] }, async (req: any, reply: any) => {
    const store = await requireReadableStore(req, reply)
    if (!store) return
    const { tenantId } = req.user
    const [suppliers, products] = await Promise.all([
      prisma.supplier.findMany({
        where: { tenantId, status: 'ENABLED' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, category: true, inventoryMode: true },
      }),
      prisma.product.findMany({
        where: { tenantId, status: 'ENABLED', supplier: { status: 'ENABLED' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, supplierId: true, code: true, name: true, category: true, spec: true,
          unit: true, imageKey: true, price: true, stock: true, minOrderQty: true, stepQty: true,
          purchaseUnit: true, inventoryUnit: true, orderUnit: true, costUnit: true,
          inventoryUnitsPerPurchaseUnit: true, inventoryUnitsPerOrderUnit: true,
          inventoryUnitsPerCostUnit: true, unitConversionStatus: true,
        },
      }),
    ])
    const reserved = await getSupplierReservedStock({ tenantId, productIds: products.map(product => product.id) })
    return {
      mode: 'SIMULATION',
      store,
      suppliers,
      products: products.map(product => {
        const reservedStock = reserved.get(product.id) || 0
        const availability = stockAvailability(Number(product.stock || 0), reservedStock)
        return {
          ...product,
          imageUrl: signOssKey(product.imageKey),
          imageKey: undefined,
          orderUnitPrice: tryCostUnitPriceToOrderUnitPrice(product),
          ...availability,
        }
      }),
    }
  })

  /** Dry-run only: no PurchaseOrder, reservation, stock, finance or audit write. */
  app.post('/:storeId/order-simulation/preflight', { preHandler: [auth] }, async (req: any, reply: any) => {
    const store = await requireReadableStore(req, reply)
    if (!store) return
    const parsed = orderSimulationSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const { tenantId } = req.user
    const { supplierId, items } = parsed.data
    const supplier = await prisma.supplier.findFirst({
      where: { id: supplierId, tenantId, status: 'ENABLED' },
      select: { id: true, name: true, inventoryMode: true },
    })
    if (!supplier) return reply.status(400).send({ error: '供应商不存在或已停用' })

    const products = await loadOrderDraftProducts({
      tenantId,
      supplierId,
      productIds: items.map(item => item.productId),
    })
    const validation = validateOrderDraftLines(products, items)
    const issues: Array<(typeof validation.issues)[number] & { stage: 'ORDER_ENTRY' | 'SUPPLIER_ACCEPT' }> =
      validation.issues.map(issue => ({ ...issue, stage: 'ORDER_ENTRY' }))

    // STRICT 模式会在真实流程的供应商接单阶段原子预占库存；模拟需提前暴露该阻塞。
    if (validation.ok && supplier.inventoryMode === 'STRICT') {
      const reserved = await getSupplierReservedStock({
        tenantId,
        supplierId,
        productIds: products.map(product => product.id),
      })
      const stockRows = await prisma.product.findMany({
        where: { tenantId, supplierId, id: { in: products.map(product => product.id) } },
        select: { id: true, name: true, stock: true },
      })
      const requested = new Map<string, number>()
      for (const item of items) requested.set(item.productId, (requested.get(item.productId) || 0) + item.quantity)
      for (const product of stockRows) {
        const available = Number(product.stock || 0) - (reserved.get(product.id) || 0)
        const needed = requested.get(product.id) || 0
        if (available + 0.0001 < needed) {
          issues.push({
            code: 'PRODUCT_UNAVAILABLE',
            productId: product.id,
            productName: product.name,
            message: `${product.name} 可用库存不足：可用 ${available.toFixed(2)}，模拟订单需要 ${needed.toFixed(2)}`,
            stage: 'SUPPLIER_ACCEPT',
          })
        }
      }
    }

    return {
      mode: 'SIMULATION',
      persisted: false,
      store,
      supplier,
      canSubmit: validation.ok,
      canCompleteFlow: validation.ok && issues.length === 0,
      totalAmount: validation.totalAmount?.toFixed(2) || null,
      itemCount: items.length,
      issues,
      message: validation.ok && issues.length === 0
        ? '模拟校验通过：按当前配置可提交，并可进入供应链接单流程'
        : '模拟校验未通过：请按阻塞原因修复配置后重试',
    }
  })

  app.get('/:storeId/overview', { preHandler: [auth] }, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const { storeId } = req.params

    if (isSupplierRole(role)) {
      return reply.status(403).send({ error: '无权访问门店概览' })
    }

    if (!canViewStoreOverview(role)) {
      return reply.status(403).send({ error: '无权访问门店概览' })
    }

    const store = await prisma.store.findFirst({
      where: { id: storeId, tenantId },
      select: { id: true },
    })
    if (!store) {
      return reply.status(404).send({ error: '门店不存在' })
    }

    return getStoreOverview(tenantId, storeId)
  })

  app.get('/:storeId/order-runboard', { preHandler: [auth] }, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const { storeId } = req.params

    if (isSupplierRole(role) || !canViewStoreOverview(role)) {
      return reply.status(403).send({ error: '无权访问门店订货运行' })
    }

    const store = await prisma.store.findFirst({
      where: { id: storeId, tenantId },
      select: { id: true },
    })
    if (!store) {
      return reply.status(404).send({ error: '门店不存在' })
    }

    return getStoreOrderRunboard(tenantId, storeId)
  })

  app.get('/:storeId/consumption-ranking', { preHandler: [auth] }, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const { storeId } = req.params

    if (isSupplierRole(role) || !canViewStoreOverview(role)) {
      return reply.status(403).send({ error: '无权访问门店消耗排行' })
    }

    const parsed = consumptionRankingQuerySchema.safeParse(req.query || {})
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message })
    }

    const store = await prisma.store.findFirst({
      where: { id: storeId, tenantId },
      select: { id: true },
    })
    if (!store) {
      return reply.status(404).send({ error: '门店不存在' })
    }

    return getStoreConsumptionRanking(
      tenantId,
      storeId,
      parsed.data.days as 7 | 30 | 90,
      parsed.data.dimension,
    )
  })
}
