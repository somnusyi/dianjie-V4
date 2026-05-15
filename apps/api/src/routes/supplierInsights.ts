/**
 * 供应商洞察 — 客户/门店关系 + SKU 销售排行 + 月度趋势
 *
 * 仅供 SUPPLIER_OWNER / STAFF / SUB / ADMIN 访问. 数据按 token.supplierId 隔离.
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { isSupplierRole } from '../lib/auth-scope'
import dayjs from 'dayjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const supplierInsightRoutes: FastifyPluginAsync = async (app) => {

  // ── 客户/门店关系列表 ─────────────────────────────
  // GET /api/supplier/insights/customers?days=90
  app.get('/customers', auth(app), async (req: any, reply: any) => {
    const { role, supplierId } = req.user
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅供应商角色' })
    }
    const sid = supplierId
    if (!sid) return reply.send([])
    const days = Math.min(365, Math.max(7, parseInt((req.query as any).days) || 90))
    const since = dayjs().subtract(days, 'day').toDate()
    const monthStart = dayjs().startOf('month').toDate()

    // 该供应商所有合作过的订单
    const orders = await prisma.purchaseOrder.findMany({
      where: { supplierId: sid, createdAt: { gte: since } },
      select: {
        id: true,
        storeId: true, totalAmount: true, status: true, createdAt: true,
        store: { select: { id: true, name: true, no: true } },
      },
    })
    // 同期已生效的报损 (APPROVED / RESOLVED) — 用于扣除净销售
    const approvedLoss = await prisma.lossClaim.groupBy({
      by: ['purchaseOrderId'],
      where: {
        supplierId: sid,
        status: { in: ['APPROVED', 'RESOLVED'] },
        purchaseOrderId: { in: orders.map(o => o.id) },
      },
      _sum: { totalLossAmount: true },
    })
    const lossByOrder = new Map<string, number>()
    approvedLoss.forEach(l => l.purchaseOrderId && lossByOrder.set(l.purchaseOrderId, Number(l._sum.totalLossAmount || 0)))
    // groupby storeId
    const byStore = new Map<string, {
      storeId: string; name: string; no: string
      totalOrders: number; totalAmount: number
      monthOrders: number; monthAmount: number
      lastOrderAt: Date
    }>()
    for (const o of orders) {
      const k = o.storeId
      let cur = byStore.get(k)
      if (!cur) {
        cur = {
          storeId: k, name: o.store?.name || '?', no: o.store?.no || '',
          totalOrders: 0, totalAmount: 0, monthOrders: 0, monthAmount: 0,
          lastOrderAt: o.createdAt,
        }
        byStore.set(k, cur)
      }
      // 排除取消的不算
      if (o.status === 'CANCELLED') continue
      const net = Number(o.totalAmount) - (lossByOrder.get(o.id) || 0)
      cur.totalOrders++
      cur.totalAmount += net
      if (o.createdAt >= monthStart) {
        cur.monthOrders++
        cur.monthAmount += net
      }
      if (o.createdAt > cur.lastOrderAt) cur.lastOrderAt = o.createdAt
    }
    const list = Array.from(byStore.values())
      .map(c => {
        const daysSince = Math.floor((Date.now() - c.lastOrderAt.getTime()) / 86400_000)
        return {
          ...c,
          daysSinceLastOrder: daysSince,
          isVip: c.monthAmount >= 5000,        // 本月 ≥¥5000 = VIP
          isSleeping: daysSince > 30,           // 30天没下单 = 沉睡
        }
      })
      .sort((a, b) => b.totalAmount - a.totalAmount)
    return reply.send(list)
  })

  // ── SKU 销售排行 ─────────────────────────────────
  // GET /api/supplier/insights/sku-rank?days=30&limit=10
  app.get('/sku-rank', auth(app), async (req: any, reply: any) => {
    const { role, supplierId } = req.user
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅供应商角色' })
    }
    if (!supplierId) return reply.send({ top: [], bottom: [] })
    const days  = Math.min(365, Math.max(7, parseInt((req.query as any).days) || 30))
    const limit = Math.min(50, Math.max(3, parseInt((req.query as any).limit) || 10))
    const since = dayjs().subtract(days, 'day').toDate()

    const items = await prisma.purchaseOrderItem.findMany({
      where: {
        purchaseOrder: {
          supplierId, createdAt: { gte: since },
          status: { in: ['CONFIRMED', 'PENDING_CONFIRM', 'RECEIVED', 'COMPLETED'] },
        },
      },
      select: { productId: true, quantity: true, shippedQty: true, amount: true,
                product: { select: { name: true, unit: true } } },
    })
    // 已生效报损按 SKU 维度扣减 (净销售 = 订单 amount - 报损 amount)
    const lossItems = await prisma.lossClaimItem.findMany({
      where: {
        lossClaim: {
          supplierId, createdAt: { gte: since },
          status: { in: ['APPROVED', 'RESOLVED'] },
        },
      },
      select: { productId: true, lossQty: true, lossAmount: true },
    })
    const lossByProd = new Map<string, { qty: number; amount: number }>()
    for (const lc of lossItems) {
      const cur = lossByProd.get(lc.productId) || { qty: 0, amount: 0 }
      cur.qty += Number(lc.lossQty || 0)
      cur.amount += Number(lc.lossAmount || 0)
      lossByProd.set(lc.productId, cur)
    }
    const byProd = new Map<string, { name: string; unit: string; qty: number; amount: number; orders: number }>()
    for (const it of items) {
      const k = it.productId
      let cur = byProd.get(k)
      if (!cur) {
        cur = { name: it.product?.name || '?', unit: it.product?.unit || '', qty: 0, amount: 0, orders: 0 }
        byProd.set(k, cur)
      }
      cur.qty += Number(it.shippedQty ?? it.quantity)
      cur.amount += Number(it.amount)
      cur.orders += 1
    }
    // 扣减报损
    for (const [pid, loss] of lossByProd) {
      const cur = byProd.get(pid)
      if (cur) {
        cur.qty = Math.max(0, cur.qty - loss.qty)
        cur.amount = Math.max(0, cur.amount - loss.amount)
      }
    }
    const list = Array.from(byProd.entries()).map(([id, v]) => ({ productId: id, ...v }))
    const top = [...list].sort((a, b) => b.amount - a.amount).slice(0, limit)
    // 滞销 = 本期销量为 0 但是上架的 SKU
    const allActive = await prisma.product.findMany({
      where: { supplierId, status: 'ENABLED' },
      select: { id: true, name: true, unit: true, price: true },
    })
    const soldIds = new Set(list.map(l => l.productId))
    const bottom = allActive.filter(p => !soldIds.has(p.id)).map(p => ({
      productId: p.id, name: p.name, unit: p.unit, qty: 0, amount: 0, orders: 0,
      price: Number(p.price),
    })).slice(0, limit)
    return reply.send({ top, bottom, periodDays: days })
  })

  // ── 月度销售趋势 (近 6 个月) ──────────────────────
  // GET /api/supplier/insights/sales-trend?months=6
  app.get('/sales-trend', auth(app), async (req: any, reply: any) => {
    const { role, supplierId } = req.user
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅供应商角色' })
    }
    if (!supplierId) return reply.send([])
    const months = Math.min(12, Math.max(3, parseInt((req.query as any).months) || 6))
    const start = dayjs().subtract(months - 1, 'month').startOf('month').toDate()
    const orders = await prisma.purchaseOrder.findMany({
      where: { supplierId, createdAt: { gte: start },
               status: { in: ['CONFIRMED', 'PENDING_CONFIRM', 'RECEIVED', 'COMPLETED'] } },
      select: { id: true, totalAmount: true, createdAt: true },
    })
    // 同期已生效报损
    const losses = await prisma.lossClaim.findMany({
      where: {
        supplierId,
        status: { in: ['APPROVED', 'RESOLVED'] },
        purchaseOrderId: { in: orders.map(o => o.id) },
      },
      select: { purchaseOrderId: true, totalLossAmount: true },
    })
    const lossByOrder = new Map<string, number>()
    losses.forEach(l => l.purchaseOrderId && lossByOrder.set(l.purchaseOrderId, (lossByOrder.get(l.purchaseOrderId) || 0) + Number(l.totalLossAmount)))
    // 按 YYYY-MM groupby
    const byMonth = new Map<string, { revenue: number; orders: number }>()
    for (let i = 0; i < months; i++) {
      const k = dayjs().subtract(months - 1 - i, 'month').format('YYYY-MM')
      byMonth.set(k, { revenue: 0, orders: 0 })
    }
    for (const o of orders) {
      const k = dayjs(o.createdAt).format('YYYY-MM')
      const cur = byMonth.get(k)
      if (cur) {
        cur.revenue += Number(o.totalAmount) - (lossByOrder.get(o.id) || 0)
        cur.orders += 1
      }
    }
    return reply.send(Array.from(byMonth.entries()).map(([month, v]) => ({ month, ...v })))
  })
}
