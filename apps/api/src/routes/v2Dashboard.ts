/**
 * v2 Dashboard 聚合端点
 * GET /api/v2/dashboard/me  → 按当前 user.role 聚合首页所需的全部数据
 *
 * 设计目标：
 * - 单一接口替代前端 6 个角色页各自拉数据，让首屏 < 200ms
 * - 字段贴合 apps/web/src/components/v2/use-dashboard.tsx 的 DashboardData 类型
 * - 失败要么返回 null/空数组（首页能渲染骨架），要么 500（前端有 ErrorScreen 兜底）
 * - revenue7d 字段为 Hero sparkline 提供 7 日营业额数列
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'

const fmtMoney = (n: number) => '¥' + Math.round(n).toLocaleString()

/** 取过去 N 天每日合计，返回长度 N 的数组（最早 → 最新）*/
/** RevenueRecord.date 是 @db.Date，存的是 UTC 午夜的"日"。
 *  按本地日期组件构造比较边界，避免 +8 时区误差把当日回退。*/
function utcDateForLocal(d: dayjs.Dayjs): Date {
  return new Date(Date.UTC(d.year(), d.month(), d.date()))
}

async function dailyRevenue(opts: {
  tenantId: string
  storeId?: string | null
  days: number
}): Promise<number[]> {
  const { tenantId, storeId, days } = opts
  const startLocal = dayjs().subtract(days - 1, 'day')
  const start = utcDateForLocal(startLocal)
  const end = utcDateForLocal(dayjs())
  const records = await prisma.revenueRecord.findMany({
    where: {
      store: { tenantId },
      ...(storeId ? { storeId } : {}),
      date: { gte: start, lte: end },
    },
    select: { date: true, amount: true },
  })
  const buckets: number[] = Array(days).fill(0)
  const startMs = start.getTime()
  records.forEach(r => {
    const idx = Math.round((new Date(r.date).getTime() - startMs) / 86400000)
    if (idx >= 0 && idx < days) buckets[idx] += Number(r.amount)
  })
  return buckets
}

export const v2DashboardRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: [(app as any).authenticate] }

  app.get('/me', auth, async (req: any, reply) => {
    const { userId, tenantId, role, storeId, supplierId } = req.user

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        store: { select: { id: true, name: true, no: true } },
        supplier: { select: { id: true, name: true } },
      },
    })
    if (!user) return reply.status(404).send({ error: '用户不存在' })

    const todayLocal = dayjs()
    const today = utcDateForLocal(todayLocal)
    const monthStart = utcDateForLocal(todayLocal.startOf('month'))
    const monthEnd = utcDateForLocal(todayLocal.endOf('month'))

    // ── 共享数据：根据角色范围算今日 / 本月 / 7 日营收 ──
    const isStore = role === 'MANAGER' || role === 'KITCHEN_LEAD'
    const scopeStoreId = isStore ? storeId : undefined

    const [todayAgg, monthAgg, revenue7d] = await Promise.all([
      prisma.revenueRecord.aggregate({
        _sum: { amount: true },
        where: {
          store: { tenantId },
          ...(scopeStoreId ? { storeId: scopeStoreId } : {}),
          date: { gte: today },
        },
      }),
      prisma.revenueRecord.aggregate({
        _sum: { amount: true },
        where: {
          store: { tenantId },
          ...(scopeStoreId ? { storeId: scopeStoreId } : {}),
          date: { gte: monthStart, lte: monthEnd },
        },
      }),
      dailyRevenue({ tenantId, storeId: scopeStoreId, days: 7 }),
    ])
    const todayRevenue = Number(todayAgg._sum.amount || 0)
    const monthRevenue = Number(monthAgg._sum.amount || 0)

    // ── 角色定制 ──
    let hero: any = {
      label: '今日营业额', value: fmtMoney(todayRevenue),
      stats: [{ label: '月营收', value: fmtMoney(monthRevenue), tone: 'default' as const }],
      revenue7d,
    }
    let approvals: any = undefined
    let storesOverview: any = undefined
    let monthlyMetrics: any = undefined
    let pendingReviewCount: number | undefined
    let pendingApprovalCount: number | undefined

    if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
      // BOSS 视角
      hero.label = '今日集团营业额'
      // 待审批粗算：报损待处理 + 总厨二审 + 代付审批
      const [pendingLoss, pendingCapital, pendingAccountApply, pendingDocSteps, allStores, monthLossSum] = await Promise.all([
        prisma.lossClaim.count({ where: { store: { tenantId }, status: 'PENDING' } }).catch(() => 0),
        (prisma as any).capitalExpense?.count({
          where: { project: { store: { tenantId } }, status: 'PENDING_APPROVAL' },
        }).catch(() => 0) ?? 0,
        // 账号申请
        (prisma as any).userApplication?.count({
          where: { tenantId, status: 'PENDING' },
        }).catch(() => 0) ?? 0,
        // 单据审批 step inbox: 当前用户能审且未决
        (prisma as any).documentStep?.count({
          where: { document: { tenantId }, decidedAt: null, isActive: true },
        }).catch(() => 0) ?? 0,
        prisma.store.findMany({
          where: { tenantId, status: 'ENABLED' },
          select: { id: true, name: true },
          orderBy: { no: 'asc' },
        }),
        // 本月集团报损金额
        prisma.lossClaim.aggregate({
          _sum: { totalLossAmount: true },
          where: {
            store: { tenantId },
            createdAt: { gte: monthStart, lte: monthEnd },
            status: { in: ['PENDING', 'APPROVED', 'AUTO_APPROVED', 'RESOLVED'] },
          },
        }).catch(() => ({ _sum: { totalLossAmount: 0 } as any })),
      ])
      const totalApprovals = pendingLoss + pendingCapital + pendingAccountApply + pendingDocSteps
      approvals = {
        total: totalApprovals,
        totalAmount: '—',
        byType: [
          ...(pendingDocSteps > 0 ? [{ type: '单据', n: pendingDocSteps, tone: 'red' }] : []),
          ...(pendingLoss > 0 ? [{ type: '报损', n: pendingLoss, tone: 'red' }] : []),
          ...(pendingCapital > 0 ? [{ type: '代付', n: pendingCapital, tone: 'orange' }] : []),
          ...(pendingAccountApply > 0 ? [{ type: '账号', n: pendingAccountApply, tone: 'orange' }] : []),
        ],
      }
      // 集团关键指标 (附加在 hero 下方, 前端用 groupKpi 字段)
      const totalLoss = Number(monthLossSum._sum.totalLossAmount || 0)
      const lossRate = monthRevenue > 0 ? (totalLoss / monthRevenue) * 100 : 0
      ;(hero as any).groupKpi = [
        { label: '本月报损率', value: `${lossRate.toFixed(2)}%`, delta: `共 ¥${Math.round(totalLoss).toLocaleString()}`, tone: lossRate < 2 ? 'green' : lossRate < 4 ? 'default' : 'red' },
        { label: '门店数', value: `${allStores.length} 家`, delta: '运营中', tone: 'default' },
        { label: '待审批', value: `${totalApprovals}`, delta: pendingLoss > 0 ? `${pendingLoss} 报损` : '无', tone: totalApprovals > 0 ? 'orange' : 'default' },
      ]
      hero.stats = [
        { label: '本月累计', value: fmtMoney(monthRevenue), tone: 'default' as const },
        { label: '门店数', value: String(allStores.length), tone: 'default' as const },
        { label: '待审批', value: String(totalApprovals), tone: totalApprovals > 0 ? 'orange' as const : 'default' as const },
      ]

      // storesOverview：按本月营收降序排
      const monthByStore = await prisma.revenueRecord.groupBy({
        by: ['storeId'],
        where: { store: { tenantId }, date: { gte: monthStart, lte: monthEnd } },
        _sum: { amount: true },
      })
      const map = new Map(monthByStore.map(r => [r.storeId, Number(r._sum.amount || 0)]))
      storesOverview = allStores
        .map((s, i) => {
          const rev = map.get(s.id) ?? 0
          return {
            id: s.id, rank: 0, name: s.name,
            revenue: rev > 0 ? fmtMoney(rev) : '¥0',
            revenueRaw: rev,
            growth: rev > 0 ? '本月累计' : '本月暂未录入',
            anomaly: false,
          }
        })
        .sort((a, b) => b.revenueRaw - a.revenueRaw)
        .map((s, i) => ({ ...s, rank: i + 1 }))
    }

    if (role === 'FINANCE') {
      hero.label = '今日集团营业额'
      const [pendingPay, pendingInvoice] = await Promise.all([
        (prisma as any).invoice?.count({ where: { tenantId, status: 'PENDING_REVIEW' } }).catch(() => 0) ?? 0,
        prisma.payment.count({ where: { schedule: { receipt: { store: { tenantId } } }, status: 'PENDING' } }).catch(() => 0),
      ])
      pendingReviewCount = pendingInvoice
      pendingApprovalCount = pendingPay
      hero.stats = [
        { label: '本月累计', value: fmtMoney(monthRevenue), tone: 'default' as const },
        { label: '待审发票', value: String(pendingInvoice), tone: pendingInvoice > 0 ? 'orange' as const : 'default' as const },
        { label: '待付款', value: String(pendingPay), tone: pendingPay > 0 ? 'orange' as const : 'default' as const },
      ]
    }

    if (role === 'MANAGER') {
      hero.label = '今日本店营业额'
      const recvDays = await prisma.revenueRecord.count({
        where: { storeId: storeId!, date: { gte: monthStart, lte: monthEnd } },
      })
      monthlyMetrics = [
        { label: '本月累计', value: fmtMoney(monthRevenue), tone: 'default' as const, delta: `${recvDays} 天有录入` },
        { label: '日均', value: fmtMoney(recvDays > 0 ? monthRevenue / recvDays : 0), tone: 'default' as const, delta: '本月平均' },
      ]
    }

    if (role === 'KITCHEN_LEAD') {
      // 厨师长 = 单店食材采购视角：hero 显示本店待操作订单数
      const pendingOrders = await prisma.purchaseOrder.count({
        where: { storeId: storeId!, status: { in: ['CONFIRMED', 'SHIPPED'] } },
      }).catch(() => 0)
      hero = {
        label: '本店采购单',
        value: String(pendingOrders),
        meta: pendingOrders > 0 ? '有订单待你处理' : '今日无待办',
        stats: [{ label: '今日营收', value: fmtMoney(todayRevenue), tone: 'default' as const }],
        revenue7d,
      }
    }

    if (role === 'CHEF_DIRECTOR') {
      const pending = await prisma.lossClaim.count({
        where: { store: { tenantId }, status: 'PENDING' },
      }).catch(() => 0)
      pendingApprovalCount = pending
      hero = {
        label: '待审批',
        value: String(pending),
        meta: pending > 0 ? '报损 / 采购 等你审' : '暂无待审批',
        stats: [{ label: '今日集团营收', value: fmtMoney(todayRevenue), tone: 'default' as const }],
        revenue7d,
      }
    }

    if (role === 'SUPPLIER_OWNER' || role === 'SUPPLIER_STAFF' || role === 'SUPPLIER_SUB') {
      // 供应商不暴露集团/门店数据, hero 用 supplier 自己的指标
      const activeOrders = supplierId ? await prisma.purchaseOrder.count({
        where: { supplierId, status: { in: ['SUBMITTED', 'CONFIRMED', 'SHIPPED', 'PENDING_CONFIRM'] } },
      }).catch(() => 0) : 0
      const monthDelivered = supplierId ? await prisma.purchaseOrder.aggregate({
        _sum: { totalAmount: true },
        where: {
          supplierId,
          status: { in: ['RECEIVED', 'COMPLETED'] },
          updatedAt: { gte: monthStart, lte: monthEnd },
        },
      }).catch(() => ({ _sum: { totalAmount: 0 } as any })) : { _sum: { totalAmount: 0 } as any }
      hero = {
        label: '在途订单',
        value: String(activeOrders),
        meta: activeOrders > 0 ? '请按时发货' : '暂无在途',
        stats: [{
          label: '本月已交付',
          value: fmtMoney(Number(monthDelivered._sum.totalAmount || 0)),
          tone: 'default' as const,
        }],
      }
    }

    return reply.send({
      role,
      user: { id: user.id, name: user.name, role: user.role, store: user.store, supplier: user.supplier },
      store: user.store ?? null,
      supplier: user.supplier ?? null,
      hero,
      approvals,
      storesOverview,
      monthlyMetrics,
      pendingReviewCount,
      pendingApprovalCount,
    })
  })
}
