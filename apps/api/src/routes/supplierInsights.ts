/**
 * 供应商洞察只使用已经发生的履约事实：
 * - 客户与趋势按已确认入库单（实收/应付口径）
 * - SKU 排行按入库明细（实收数量与金额）
 * 不再用订货单金额冒充供应商销售额。
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { z } from 'zod'
import { isSupplierRole } from '../lib/auth-scope'
import { requireSupplierCapability } from '../lib/supplier-access'
import { withDocumentProductSnapshot } from '../lib/supply-document-snapshot'
import { auditSupplierSupplyChain } from '../services/supplyChainAudit'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const RECEIVED_STATUSES = ['CONFIRMED', 'ACCOUNTED'] as const
const supplierSelectionSchema = {
  supplierId: z.string().trim().min(1).max(100).optional(),
}
const insightDaysQuerySchema = z.object({
  ...supplierSelectionSchema,
  days: z.coerce.number().int().min(7).max(365).default(90),
}).strict()
const skuRankQuerySchema = z.object({
  ...supplierSelectionSchema,
  days: z.coerce.number().int().min(7).max(365).default(30),
  limit: z.coerce.number().int().min(3).max(50).default(10),
}).strict()
const salesTrendQuerySchema = z.object({
  ...supplierSelectionSchema,
  months: z.coerce.number().int().min(3).max(12).default(6),
}).strict()

function insightSupplierId(req: any, requestedSupplierId?: string) {
  const { role, supplierId } = req.user
  if (isSupplierRole(role)) return requireSupplierCapability(role, supplierId, 'analytics.read')
  if (['ADMIN', 'SUPER_ADMIN'].includes(role)) {
    if (!requestedSupplierId) throw Object.assign(new Error('管理员查看供应商洞察时必须指定 supplierId'), { statusCode: 400 })
    return requestedSupplierId
  }
  throw Object.assign(new Error('无权查看供应商洞察'), { statusCode: 403 })
}

export const supplierInsightRoutes: FastifyPluginAsync = async (app) => {
  app.get('/audit', auth(app), async (req: any, reply: any) => {
    const query = insightDaysQuerySchema.safeParse(req.query || {})
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })
    const supplierId = insightSupplierId(req, query.data.supplierId)
    const { days } = query.data
    return auditSupplierSupplyChain({ tenantId: req.user.tenantId, supplierId, days })
  })

  app.get('/customers', auth(app), async (req: any, reply: any) => {
    const query = insightDaysQuerySchema.safeParse(req.query || {})
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })
    const { tenantId } = req.user
    const supplierId = insightSupplierId(req, query.data.supplierId)
    const { days } = query.data
    const since = dayjs().subtract(days, 'day').startOf('day').toDate()
    const monthStart = dayjs().startOf('month').toDate()
    const receipts = await prisma.receipt.findMany({
      where: {
        tenantId, supplierId,
        status: { in: [...RECEIVED_STATUSES] },
        deliveryDate: { gte: since },
      },
      select: {
        id: true, purchaseOrderId: true, storeId: true, totalAmount: true,
        deliveryDate: true, createdAt: true,
        store: { select: { id: true, name: true, no: true } },
      },
    })

    const byStore = new Map<string, {
      storeId: string; name: string; no: string
      orderKeys: Set<string>; monthOrderKeys: Set<string>
      totalAmount: number; monthAmount: number; lastOrderAt: Date
    }>()
    for (const receipt of receipts) {
      const at = receipt.deliveryDate || receipt.createdAt
      const current = byStore.get(receipt.storeId) || {
        storeId: receipt.storeId,
        name: receipt.store?.name || '?',
        no: receipt.store?.no || '',
        orderKeys: new Set<string>(),
        monthOrderKeys: new Set<string>(),
        totalAmount: 0,
        monthAmount: 0,
        lastOrderAt: at,
      }
      const orderKey = receipt.purchaseOrderId || `receipt:${receipt.id}`
      current.orderKeys.add(orderKey)
      current.totalAmount += Number(receipt.totalAmount)
      if (at >= monthStart) {
        current.monthOrderKeys.add(orderKey)
        current.monthAmount += Number(receipt.totalAmount)
      }
      if (at > current.lastOrderAt) current.lastOrderAt = at
      byStore.set(receipt.storeId, current)
    }

    return [...byStore.values()].map(current => {
      const daysSinceLastOrder = Math.floor((Date.now() - current.lastOrderAt.getTime()) / 86_400_000)
      return {
        storeId: current.storeId,
        name: current.name,
        no: current.no,
        totalOrders: current.orderKeys.size,
        totalAmount: current.totalAmount,
        monthOrders: current.monthOrderKeys.size,
        monthAmount: current.monthAmount,
        lastOrderAt: current.lastOrderAt,
        daysSinceLastOrder,
        isVip: current.monthAmount >= 5000,
        isSleeping: daysSinceLastOrder > 30,
        amountBasis: 'RECEIPT_PAYABLE',
      }
    }).sort((a, b) => b.totalAmount - a.totalAmount)
  })

  app.get('/sku-rank', auth(app), async (req: any, reply: any) => {
    const query = skuRankQuerySchema.safeParse(req.query || {})
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })
    const { tenantId } = req.user
    const supplierId = insightSupplierId(req, query.data.supplierId)
    const { days, limit } = query.data
    const since = dayjs().subtract(days, 'day').startOf('day').toDate()
    const items = await prisma.receiptItem.findMany({
      where: {
        receipt: {
          tenantId, supplierId,
          status: { in: [...RECEIVED_STATUSES] },
          deliveryDate: { gte: since },
        },
      },
      include: { product: { select: { name: true, unit: true, spec: true } } },
    })

    const byProduct = new Map<string, { name: string; unit: string; qty: number; amount: number; orders: number }>()
    for (const raw of items) {
      const item = withDocumentProductSnapshot(raw)
      const current = byProduct.get(item.productId) || {
        name: String(item.product.name || '?'),
        unit: String(item.product.unit || ''),
        qty: 0,
        amount: 0,
        orders: 0,
      }
      current.qty += Number(item.quantity)
      current.amount += Number(item.amount)
      current.orders += 1
      byProduct.set(item.productId, current)
    }
    const list = [...byProduct.entries()].map(([productId, value]) => ({ productId, ...value }))
    const top = [...list]
      .sort((a, b) => b.amount - a.amount || a.productId.localeCompare(b.productId))
      .slice(0, limit)
    const activeProducts = await prisma.product.findMany({
      where: { tenantId, supplierId, status: 'ENABLED' },
      select: { id: true, name: true, unit: true, price: true },
      orderBy: { id: 'asc' },
    })
    const soldIds = new Set(list.map(item => item.productId))
    const bottom = activeProducts.filter(product => !soldIds.has(product.id)).slice(0, limit).map(product => ({
      productId: product.id,
      name: product.name,
      unit: product.unit,
      qty: 0,
      amount: 0,
      orders: 0,
      price: Number(product.price),
    }))
    return { top, bottom, periodDays: days, amountBasis: 'RECEIPT_PAYABLE' }
  })

  app.get('/sales-trend', auth(app), async (req: any, reply: any) => {
    const query = salesTrendQuerySchema.safeParse(req.query || {})
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })
    const { tenantId } = req.user
    const supplierId = insightSupplierId(req, query.data.supplierId)
    const { months } = query.data
    const start = dayjs().subtract(months - 1, 'month').startOf('month').toDate()
    const receipts = await prisma.receipt.findMany({
      where: {
        tenantId, supplierId,
        status: { in: [...RECEIVED_STATUSES] },
        deliveryDate: { gte: start },
      },
      select: { id: true, purchaseOrderId: true, totalAmount: true, deliveryDate: true },
    })
    const byMonth = new Map<string, { revenue: number; orderKeys: Set<string> }>()
    for (let index = 0; index < months; index++) {
      byMonth.set(dayjs().subtract(months - 1 - index, 'month').format('YYYY-MM'), {
        revenue: 0,
        orderKeys: new Set<string>(),
      })
    }
    for (const receipt of receipts) {
      const month = dayjs(receipt.deliveryDate).format('YYYY-MM')
      const current = byMonth.get(month)
      if (!current) continue
      current.revenue += Number(receipt.totalAmount)
      current.orderKeys.add(receipt.purchaseOrderId || `receipt:${receipt.id}`)
    }
    return [...byMonth.entries()].map(([month, value]) => ({
      month,
      revenue: value.revenue,
      receivedAmount: value.revenue,
      orders: value.orderKeys.size,
      amountBasis: 'RECEIPT_PAYABLE',
    }))
  })
}
