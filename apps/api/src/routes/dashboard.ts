import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { cached } from '../lib/cache'
import { isStoreScoped } from '../lib/auth-scope'

export const dashboardRoutes: FastifyPluginAsync = async (app) => {

  // ── 总部看板数据 ──────────────────────────────────
  app.get('/stats', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, role, storeId } = req.user
    const cacheKey = `dashboard:stats:${tenantId}:${role}:${storeId || 'all'}`
    return cached(cacheKey, 300, async () => {
    const now = dayjs()
    const monthStart = now.startOf('month').toDate()
    const lastMonthStart = now.subtract(1, 'month').startOf('month').toDate()
    const lastMonthEnd = now.subtract(1, 'month').endOf('month').toDate()

    // 门店级角色（店长/总厨/采购）只看自己门店
    const storeFilter = isStoreScoped(role) && storeId ? { storeId } : {}
    const scheduleStoreFilter = isStoreScoped(role) && storeId
      ? { receipt: { storeId } } : {}

    const [
      monthPurchase, lastMonthPurchase,
      pendingPayment, overdueCount, pendingApprovalCount,
      pendingReceiptCount, pendingLossCount,
      allProducts, upcomingSchedules, recentReceipts,
      storeStats,
    ] = await Promise.all([
      // 本月采购
      prisma.receipt.aggregate({
        where: { tenantId, status: { notIn: ['VOID','REJECTED'] }, createdAt: { gte: monthStart }, ...storeFilter },
        _sum: { totalAmount: true },
      }),
      // 上月采购
      prisma.receipt.aggregate({
        where: { tenantId, status: { notIn: ['VOID','REJECTED'] }, createdAt: { gte: lastMonthStart, lte: lastMonthEnd }, ...storeFilter },
        _sum: { totalAmount: true },
      }),
      // 待付款总额
      prisma.paymentSchedule.aggregate({
        where: { tenantId, status: { in: ['PENDING','APPROVED','NOTIFIED'] }, ...scheduleStoreFilter },
        _sum: { amount: true },
      }),
      // 逾期账期数
      prisma.paymentSchedule.count({
        where: { tenantId, status: 'OVERDUE', ...scheduleStoreFilter },
      }),
      // 待审批数（总部用）
      role !== 'MANAGER' ? prisma.paymentSchedule.count({
        where: { tenantId, status: 'PENDING_APPROVAL' },
      }) : Promise.resolve(0),
      // 待收货入库单
      prisma.receipt.count({
        where: { tenantId, status: 'PENDING_CONFIRM', ...storeFilter },
      }),
      // 待处理报损
      prisma.lossClaim.count({
        where: { tenantId, status: 'PENDING' },
      }),
      // 全部商品（算低库存）
      prisma.product.findMany({
        where: { tenantId, status: 'ENABLED' },
        select: { id: true, name: true, stock: true, minStock: true, unit: true },
      }),
      // 7天内到期账期
      prisma.paymentSchedule.findMany({
        where: {
          tenantId,
          status: { in: ['PENDING','APPROVED','NOTIFIED'] },
          dueAt: { gte: now.toDate(), lte: now.add(7, 'day').toDate() },
          ...scheduleStoreFilter,
        },
        include: {
          supplier: { select: { name: true } },
          receipt: { select: { no: true, store: { select: { name: true } } } },
        },
        orderBy: { dueAt: 'asc' },
        take: 5,
      }),
      // 最近入库记录
      prisma.receipt.findMany({
        where: { tenantId, status: { notIn: ['VOID'] }, ...storeFilter },
        include: {
          store: { select: { name: true } },
          supplier: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
      // 各门店本月采购汇总（总部用）
      role !== 'MANAGER' ? prisma.receipt.groupBy({
        by: ['storeId'],
        where: { tenantId, status: { notIn: ['VOID','REJECTED'] }, createdAt: { gte: monthStart } },
        _sum: { totalAmount: true },
        _count: { id: true },
      }) : Promise.resolve([]),
    ])

    const lowStockProducts = allProducts.filter(p => Number(p.stock) < Number(p.minStock))
    const thisMonth = Number(monthPurchase._sum.totalAmount || 0)
    const lastMonth = Number(lastMonthPurchase._sum.totalAmount || 0)
    const growth = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth * 100).toFixed(1) : null

    // 补全门店名称
    let storeBreakdown: any[] = []
    if (Array.isArray(storeStats) && storeStats.length > 0) {
      const stores = await prisma.store.findMany({ where: { tenantId }, select: { id: true, name: true, no: true } })
      storeBreakdown = storeStats.map((s: any) => {
        const store = stores.find(st => st.id === s.storeId)
        return {
          storeId: s.storeId,
          storeName: store?.name?.replace('滇界·', '') || '未知门店',
          storeNo: store?.no,
          totalAmount: Number(s._sum.totalAmount || 0),
          orderCount: s._count.id,
        }
      }).sort((a: any, b: any) => b.totalAmount - a.totalAmount)
    }

    return {
      purchase: { thisMonth, lastMonth, growth },
      pendingPayment: Number(pendingPayment._sum.amount || 0),
      overdueCount,
      pendingApprovalCount,
      pendingReceiptCount,
      pendingLossCount,
      lowStockProducts,
      upcomingSchedules,
      recentReceipts,
      storeBreakdown,
    }
  }) // end cached
  })

  // ── 采购趋势（近30天）────────────────────────────
  app.get('/purchase-trend', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, role, storeId } = req.user
    const { days = 30 } = req.query as any
    const since = dayjs().subtract(Number(days), 'day').startOf('day').toDate()
    const storeFilter = isStoreScoped(role) && storeId ? { storeId } : {}

    const receipts = await prisma.receipt.findMany({
      where: { tenantId, status: { notIn: ['VOID','REJECTED'] }, createdAt: { gte: since }, ...storeFilter },
      select: { createdAt: true, totalAmount: true },
      orderBy: { createdAt: 'asc' },
    })

    // 按周聚合
    const byWeek: Record<string, number> = {}
    receipts.forEach(r => {
      const w = dayjs(r.createdAt).startOf('week').format('MM/DD')
      byWeek[w] = (byWeek[w] || 0) + Number(r.totalAmount)
    })

    return Object.entries(byWeek).map(([week, amount]) => ({ week, amount }))
  })
}
