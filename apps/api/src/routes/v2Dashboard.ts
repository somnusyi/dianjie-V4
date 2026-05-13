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
      // 财务核心: 应付/今日付款/失败重试 — 不是营业额
      const today = new Date(); today.setHours(0,0,0,0)
      const tomorrow = new Date(today.getTime() + 86400_000)
      const [
        payableTotal, payableToday, payableOverdue,
        failedSch, pendingInvoice, pendingDocs,
        cashAccountsAgg
      ] = await Promise.all([
        prisma.paymentSchedule.aggregate({
          _sum: { amount: true },
          where: { tenantId, status: { in: ['PENDING', 'NOTIFIED', 'APPROVED'] as any } },
        }).catch(() => ({ _sum: { amount: 0 } as any })),
        prisma.paymentSchedule.aggregate({
          _sum: { amount: true },
          where: { tenantId, status: { in: ['PENDING', 'NOTIFIED', 'APPROVED'] as any },
                   dueAt: { gte: today, lt: tomorrow } },
        }).catch(() => ({ _sum: { amount: 0 } as any })),
        prisma.paymentSchedule.aggregate({
          _sum: { amount: true },
          where: { tenantId, status: { in: ['PENDING', 'NOTIFIED', 'APPROVED', 'OVERDUE'] as any },
                   dueAt: { lt: today } },
        }).catch(() => ({ _sum: { amount: 0 } as any })),
        prisma.paymentSchedule.count({
          where: { tenantId, status: { in: ['FAILED', 'OVERDUE'] as any } },
        }).catch(() => 0),
        (prisma as any).invoice?.count({ where: { tenantId, status: 'PENDING' } }).catch(() => 0) ?? 0,
        prisma.documentStep.count({
          where: { document: { tenantId, status: 'PENDING' }, status: 'PENDING',
                   approverRole: 'FINANCE' },
        }).catch(() => 0),
        prisma.cashAccount.aggregate({
          _sum: { balance: true } as any,
          where: { tenantId, status: 'ACTIVE' },
        }).catch(() => ({ _sum: { balance: 0 } as any })),
      ])
      const payable    = Number((payableTotal as any)._sum.amount || 0)
      const todayPay   = Number((payableToday as any)._sum.amount || 0)
      const overdue    = Number((payableOverdue as any)._sum.amount || 0)
      const cashTotal  = Number((cashAccountsAgg as any)._sum.balance || 0)
      pendingReviewCount = pendingInvoice
      pendingApprovalCount = pendingDocs

      hero = {
        label: '应付总额',
        value: fmtMoney(payable),
        meta: overdue > 0
          ? `⚠ 逾期 ${fmtMoney(overdue)} · 今日要付 ${fmtMoney(todayPay)}`
          : todayPay > 0 ? `今日要付 ${fmtMoney(todayPay)}` : '✓ 今日无应付',
        stats: [
          { label: '今日待付', value: fmtMoney(todayPay), tone: todayPay > 0 ? 'orange' as const : 'default' as const },
          { label: '账户余额', value: fmtMoney(cashTotal), tone: cashTotal < payable ? 'red' as const : 'default' as const, delta: cashTotal < payable ? '⚠ 不足以付' : undefined },
          { label: '失败/逾期', value: String(failedSch), tone: failedSch > 0 ? 'red' as const : 'default' as const },
        ],
        // finance 专属扩展
        financeExt: {
          payable, todayPay, overdue, cashTotal, failedSch,
          pendingInvoice, pendingDocs,
        },
      }
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
      // 厨师长 = 单店厨房视角: 看食材消耗 / 待验收 / 库存预警, 不看营收
      const [pendingReceive, monthReceiptAgg, monthLossAgg, lowStockCount] = await Promise.all([
        prisma.purchaseOrder.count({
          where: { storeId: storeId!, status: 'PENDING_CONFIRM' },
        }).catch(() => 0),
        prisma.receipt.aggregate({
          _sum: { totalAmount: true },
          where: { storeId: storeId!, createdAt: { gte: monthStart, lte: monthEnd } },
        }).catch(() => ({ _sum: { totalAmount: 0 } as any })),
        prisma.lossClaim.aggregate({
          _sum: { totalLossAmount: true },
          where: { storeId: storeId!, createdAt: { gte: monthStart, lte: monthEnd },
                   status: { in: ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'] } },
        }).catch(() => ({ _sum: { totalLossAmount: 0 } as any })),
        // 低库存粗算: 本店有过收货的 SKU 中, 累计入-出 < minStock 的数量
        // 精算放 inventory api, 此处 0 占位由前端补
        Promise.resolve(0),
      ])
      const monthFood = Number(monthReceiptAgg._sum.totalAmount || 0)
      const monthLoss = Number(monthLossAgg._sum.totalLossAmount || 0)
      const lossRate = monthFood > 0 ? (monthLoss / monthFood) * 100 : 0
      hero = {
        label: '本月食材消耗',
        value: fmtMoney(monthFood),
        meta: pendingReceive > 0 ? `⚠ 有 ${pendingReceive} 单待验收` : '今日无待验收',
        stats: [
          { label: '待验收', value: String(pendingReceive), tone: pendingReceive > 0 ? 'orange' as const : 'default' as const },
          { label: '本月报损', value: fmtMoney(monthLoss), tone: lossRate > 3 ? 'red' as const : 'default' as const },
          { label: '损耗率', value: `${lossRate.toFixed(1)}%`, tone: lossRate > 3 ? 'red' as const : lossRate > 2 ? 'orange' as const : 'green' as const },
        ],
      }
    }

    if (role === 'CHEF_DIRECTOR') {
      // 总厨 = 集团厨房标准化: 看待审批 + 集团损耗 + 食材成本, 不看营收
      const [
        pendingLossDispute, pendingManualLoss, pendingDocs,
        groupReceiptAgg, groupLossAgg
      ] = await Promise.all([
        prisma.lossClaim.count({
          where: { tenantId, status: 'REJECTED', isManual: false },   // 供应商拒, 待总厨仲裁
        }).catch(() => 0),
        prisma.lossClaim.count({
          where: { tenantId, status: 'PENDING', isManual: true },    // 店内报损 ≥¥500 待审
        }).catch(() => 0),
        prisma.documentStep.count({
          where: { document: { tenantId, status: 'PENDING' }, status: 'PENDING',
                   approverRole: 'CHEF_DIRECTOR' },
        }).catch(() => 0),
        prisma.receipt.aggregate({
          _sum: { totalAmount: true },
          where: { tenantId, createdAt: { gte: monthStart, lte: monthEnd } },
        }).catch(() => ({ _sum: { totalAmount: 0 } as any })),
        prisma.lossClaim.aggregate({
          _sum: { totalLossAmount: true },
          where: { tenantId, createdAt: { gte: monthStart, lte: monthEnd },
                   status: { in: ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'] } },
        }).catch(() => ({ _sum: { totalLossAmount: 0 } as any })),
      ])
      const totalPending = pendingLossDispute + pendingManualLoss + pendingDocs
      pendingApprovalCount = totalPending
      const groupFood = Number(groupReceiptAgg._sum.totalAmount || 0)
      const groupLoss = Number(groupLossAgg._sum.totalLossAmount || 0)
      const lossRate = groupFood > 0 ? (groupLoss / groupFood) * 100 : 0
      hero = {
        label: '待你审批',
        value: String(totalPending),
        meta: totalPending > 0
          ? `${pendingDocs ? pendingDocs + ' 调价/新菜 · ' : ''}${pendingLossDispute ? pendingLossDispute + ' 争议 · ' : ''}${pendingManualLoss ? pendingManualLoss + ' 店内报损' : ''}`.replace(/ · $/, '')
          : '✓ 暂无待审批',
        stats: [
          { label: '集团本月食材', value: fmtMoney(groupFood), tone: 'default' as const },
          { label: '集团本月报损', value: fmtMoney(groupLoss), tone: lossRate > 3 ? 'red' as const : 'default' as const },
          { label: '集团损耗率', value: `${lossRate.toFixed(1)}%`, tone: lossRate > 3 ? 'red' as const : lossRate > 2 ? 'orange' as const : 'green' as const },
        ],
      }
    }

    if (role === 'SUPPLIER_OWNER' || role === 'SUPPLIER_STAFF' || role === 'SUPPLIER_SUB') {
      // 供应商核心指标: 应收 / 在途 / 临期 / 低库存
      if (!supplierId) {
        hero = { label: '账号未绑供应商', value: '—', meta: '请联系运营', stats: [] }
      } else {
        const now = new Date()
        const in7d = new Date(Date.now() + 7 * 86400_000)
        const [
          submittedCnt, confirmedCnt, shippedCnt,
          monthDelivered,
          arAll, arOverdue, ar7d, ar30d,
          monthPaid, monthDue,
          lowStockCnt, expiringCnt
        ] = await Promise.all([
          prisma.purchaseOrder.count({ where: { supplierId, status: 'SUBMITTED' } }).catch(() => 0),
          prisma.purchaseOrder.count({ where: { supplierId, status: 'CONFIRMED' } }).catch(() => 0),
          prisma.purchaseOrder.count({ where: { supplierId, status: 'PENDING_CONFIRM' } }).catch(() => 0),
          prisma.purchaseOrder.aggregate({
            _sum: { totalAmount: true },
            where: { supplierId, status: { in: ['RECEIVED', 'COMPLETED'] }, updatedAt: { gte: monthStart, lte: monthEnd } },
          }).catch(() => ({ _sum: { totalAmount: 0 } as any })),
          // 应收 (PaymentSchedule)
          prisma.paymentSchedule.aggregate({
            _sum: { amount: true },
            where: { supplierId, status: { in: ['PENDING', 'APPROVED', 'NOTIFIED', 'OVERDUE', 'ON_HOLD'] as any } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          prisma.paymentSchedule.aggregate({
            _sum: { amount: true },
            where: { supplierId, status: { in: ['PENDING', 'APPROVED', 'NOTIFIED'] as any }, dueAt: { lt: now } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          prisma.paymentSchedule.aggregate({
            _sum: { amount: true },
            where: { supplierId, status: { in: ['PENDING', 'APPROVED', 'NOTIFIED'] as any }, dueAt: { gte: now, lte: in7d } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          prisma.paymentSchedule.aggregate({
            _sum: { amount: true },
            where: { supplierId, status: { in: ['PENDING', 'APPROVED', 'NOTIFIED'] as any }, dueAt: { gt: in7d, lte: new Date(Date.now() + 30 * 86400_000) } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          // 本月回款率
          prisma.paymentSchedule.aggregate({
            _sum: { amount: true },
            where: { supplierId, status: 'PAID' as any, paidAt: { gte: monthStart, lte: monthEnd } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          prisma.paymentSchedule.aggregate({
            _sum: { amount: true },
            where: { supplierId, dueAt: { gte: monthStart, lte: monthEnd } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          // 库存预警
          (async () => {
            // 用原生 SQL 算 stock < minStock (Prisma 不支持字段比字段)
            try {
              const r = await prisma.$queryRawUnsafe<Array<{ c: number }>>(
                `SELECT COUNT(*)::int AS c FROM products WHERE "supplierId"=$1 AND status='ENABLED' AND stock < "minStock"`,
                supplierId
              )
              return Array.isArray(r) && r[0] ? Number(r[0].c) : 0
            } catch { return 0 }
          })(),
          // 临期预警 — 用 supplier_stock_movements.expiryDate (如果有)
          prisma.supplierStockMovement.count({
            where: { supplierId, expiryDate: { gte: now, lte: in7d } },
          }).catch(() => 0),
        ])
        const arTotal = Number(arAll._sum.amount || 0)
        const arOver  = Number(arOverdue._sum.amount || 0)
        const ar7     = Number(ar7d._sum.amount || 0)
        const ar30    = Number(ar30d._sum.amount || 0)
        const paidM   = Number(monthPaid._sum.amount || 0)
        const dueM    = Number(monthDue._sum.amount || 0)
        const recoveryRate = dueM > 0 ? (paidM / dueM) * 100 : 0

        const totalActive = submittedCnt + confirmedCnt + shippedCnt
        hero = {
          label: '应收总额',
          value: fmtMoney(arTotal),
          meta: arOver > 0
            ? `⚠ 逾期 ¥${arOver.toLocaleString()} · 7天内到 ¥${ar7.toLocaleString()}`
            : ar7 > 0 ? `7天内到账 ¥${ar7.toLocaleString()}` : '✓ 暂无应收',
          stats: [
            { label: '在途订单', value: String(totalActive), tone: submittedCnt > 0 ? 'orange' as const : 'default' as const, delta: submittedCnt > 0 ? `${submittedCnt} 待接` : undefined },
            { label: '本月已交付', value: fmtMoney(Number(monthDelivered._sum.totalAmount || 0)), tone: 'default' as const },
            { label: '回款率', value: `${recoveryRate.toFixed(0)}%`, tone: recoveryRate > 80 ? 'green' as const : recoveryRate > 50 ? 'default' as const : 'red' as const, delta: '本月' },
          ],
          // 供应商专属扩展 (前端读): 账期分桶 + 库存预警
          supplierExt: {
            arOverdue: arOver,
            ar7d: ar7,
            ar30d: ar30,
            arTotal,
            submittedCnt, confirmedCnt, shippedCnt,
            lowStockCnt, expiringCnt,
            recoveryRate,
          },
        }
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
