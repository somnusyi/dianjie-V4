import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { isStoreScoped } from '../lib/auth-scope'

// 费用项配置
export const EXPENSE_ITEMS = {
  LABOR: [
    '工资成本', '提成奖金', '社保成本', '外包服务费', '员工宿舍费', '员工福利费',
  ],
  SALES: [
    '门店租金', '门店物业费', '抽成租金', '仓库租金', '商场其他费用',
    '洗碗机租金', '炒菜机租金', '水费', '电费', '燃气费',
    '运费', '维修费', '推广费', '设备', '前厅餐具', '厨房厨具',
    '消杀费', '清洗费', '垃圾清运费', '清洁用品', '平台服务费', '前期开办费摊销',
  ],
  MGMT: [
    '交通费', '差旅费', '代账代办费', '招聘费', '办公费', '通讯费',
    '门店保险费', '业务招待费', '软件服务费', '总部管理费2%', '运营服务费5%', '其他费用',
  ],
  FINANCE: ['利息支出及结息', '银行手续费'],
}

export const profitRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: [(app as any).authenticate] }

  // 获取单店利润表数据
  app.get('/store/:storeId', auth, async (req: any, reply: any) => {
    const { tenantId, role, storeId: userStoreId } = req.user
    const { storeId } = req.params
    const { month } = req.query as any

    // 权限校验：店长只能看自己门店
    if (isStoreScoped(role) && userStoreId !== storeId) {
      return reply.status(403).send({ error: '无权查看该门店' })
    }

    const targetMonth = month || dayjs().format('YYYY-MM')
    const start = dayjs(targetMonth + '-01').startOf('month').toDate()
    const end = dayjs(targetMonth + '-01').endOf('month').toDate()

    // 验证门店属于当前租户
    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })

    const [revenues, receipts, lossClaims, expenses] = await Promise.all([
      // 营业额（含渠道）
      prisma.revenueRecord.findMany({
        where: { storeId, date: { gte: start, lte: end } },
        orderBy: { date: 'asc' },
      }),
      // 食材采购成本
      prisma.receipt.findMany({
        where: { storeId, tenantId, status: { notIn: ['VOID', 'REJECTED'] }, createdAt: { gte: start, lte: end } },
        select: { totalAmount: true },
      }),
      // 报损金额
      prisma.lossClaim.findMany({
        where: { storeId, tenantId, status: { in: ['APPROVED', 'AUTO_APPROVED'] }, createdAt: { gte: start, lte: end } },
        select: { totalLossAmount: true },
      }),
      // 手动录入费用
      prisma.storeExpense.findMany({
        where: { storeId, month: targetMonth },
        orderBy: { category: 'asc' },
      }),
    ])

    // 营业额合计 + 渠道分解
    // amount 字段是 GMV (顾客实际花费), 包含平台券面值
    const totalRevenue = revenues.reduce((s, r) => s + Number(r.amount), 0)
    const channelSummary: Record<string, number> = {}
    // 平台抽成自动算: meituanGmv - meituanNet, douyinGmv - douyinNet
    let platformFeeMeituan = 0
    let platformFeeDouyin = 0
    revenues.forEach(r => {
      const ch = (r.rawData as any)?.channels
      if (ch) {
        Object.entries(ch).forEach(([k, v]) => {
          channelSummary[k] = (channelSummary[k] || 0) + (Number(v) || 0)
        })
        const mGmv = Number(ch.meituanGmv || ch.meituan || 0)
        const mNet = Number(ch.meituanNet || mGmv)
        const dGmv = Number(ch.douyinGmv || ch.douyin || 0)
        const dNet = Number(ch.douyinNet || dGmv)
        platformFeeMeituan += Math.max(0, mGmv - mNet)
        platformFeeDouyin  += Math.max(0, dGmv - dNet)
      }
    })
    const platformFeeTotal = platformFeeMeituan + platformFeeDouyin

    // 食材成本
    const foodCost = receipts.reduce((s, r) => s + Number(r.totalAmount), 0)
    const lossAmount = lossClaims.reduce((s, l) => s + Number(l.totalLossAmount), 0)

    // 毛利
    const grossProfit = totalRevenue - foodCost

    // 各类费用汇总
    const expenseByItem: Record<string, number> = {}
    expenses.forEach(e => { expenseByItem[e.item] = Number(e.amount) })

    const laborTotal = EXPENSE_ITEMS.LABOR.reduce((s, item) => s + (expenseByItem[item] || 0), 0)
    const salesTotal = EXPENSE_ITEMS.SALES.reduce((s, item) => s + (expenseByItem[item] || 0), 0)
    const mgmtTotal = EXPENSE_ITEMS.MGMT.reduce((s, item) => s + (expenseByItem[item] || 0), 0)
    const financeTotal = EXPENSE_ITEMS.FINANCE.reduce((s, item) => s + (expenseByItem[item] || 0), 0)
    // 平台抽成单独算入"销售费用"
    const salesTotalWithPlatform = salesTotal + platformFeeTotal
    const totalExpense = laborTotal + salesTotalWithPlatform + mgmtTotal + financeTotal
    const totalCost = foodCost + totalExpense
    const netProfit = totalRevenue - totalCost
    const netRevenue = totalRevenue - platformFeeTotal   // 实际到账 (现金流口径)

    return {
      store: { id: store.id, name: store.name, no: store.no },
      month: targetMonth,
      revenue: {
        total: totalRevenue,                              // GMV
        net: netRevenue,                                  // 净到账
        platformFee: platformFeeTotal,
        platformFeeBreakdown: {
          meituan: platformFeeMeituan,
          douyin:  platformFeeDouyin,
        },
        channels: channelSummary,
        recordCount: revenues.length,
      },
      cost: {
        food: foodCost,
        loss: lossAmount,
        labor: { total: laborTotal, items: expenseByItem },
        sales: { total: salesTotalWithPlatform, items: expenseByItem, platformFee: platformFeeTotal },
        mgmt: { total: mgmtTotal, items: expenseByItem },
        finance: { total: financeTotal, items: expenseByItem },
        totalExpense,
        totalCost,
      },
      grossProfit,
      grossMargin: totalRevenue > 0 ? (grossProfit / totalRevenue * 100) : 0,
      netProfit,
      netMargin: totalRevenue > 0 ? (netProfit / totalRevenue * 100) : 0,
    }
  })

  // ── 净利快照: 4 口径一次返回 (月/季/年/累计含建店成本) ──
  app.get('/store/:storeId/snapshot', auth, async (req: any, reply: any) => {
    const { tenantId, role, storeId: userStoreId } = req.user
    const { storeId } = req.params
    if (isStoreScoped(role) && userStoreId !== storeId) {
      return reply.status(403).send({ error: '无权查看该门店' })
    }
    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })

    const now = dayjs()
    const monthStart = now.startOf('month').toDate()
    const monthEnd = now.endOf('month').toDate()
    // 季度: 不依赖 quarterOfYear 插件, 手工算
    const quarterIdx = Math.floor(now.month() / 3)  // 0..3
    const quarterStart = now.month(quarterIdx * 3).startOf('month').toDate()
    const quarterEnd = now.month(quarterIdx * 3 + 2).endOf('month').toDate()
    const yearStart = now.startOf('year').toDate()
    const yearEnd = now.endOf('year').toDate()
    const sinceStart = (store as any).createdAt
    const sinceEnd = now.endOf('day').toDate()

    async function metricsFor(start: Date, end: Date, includeOpening: boolean) {
      const [revenues, receipts, lossClaims, expenses, openingTotal] = await Promise.all([
        prisma.revenueRecord.findMany({
          where: { storeId, date: { gte: start, lte: end } },
          select: { amount: true, rawData: true },
        }),
        prisma.receipt.findMany({
          where: { storeId, tenantId, status: { notIn: ['VOID', 'REJECTED'] }, createdAt: { gte: start, lte: end } },
          select: { totalAmount: true },
        }),
        prisma.lossClaim.findMany({
          where: { storeId, tenantId, status: { in: ['APPROVED', 'AUTO_APPROVED'] }, createdAt: { gte: start, lte: end } },
          select: { totalLossAmount: true },
        }),
        prisma.storeExpense.findMany({
          where: {
            storeId,
            month: { gte: dayjs(start).format('YYYY-MM'), lte: dayjs(end).format('YYYY-MM') },
          },
          select: { item: true, amount: true },
        }),
        includeOpening
          ? (prisma as any).storeOpeningBudget.aggregate({
              where: { tenantId, storeId },
              _sum: { contractAmount: true, paidAmount: true, budget: true },
            }).catch(() => ({ _sum: { contractAmount: 0, paidAmount: 0, budget: 0 } }))
          : Promise.resolve({ _sum: { contractAmount: 0, paidAmount: 0, budget: 0 } }),
      ])
      const totalRevenue = revenues.reduce((s, r) => s + Number(r.amount), 0)
      // 平台抽成
      let platformFee = 0
      revenues.forEach(r => {
        const ch = (r.rawData as any)?.channels
        if (!ch) return
        const mGmv = Number(ch.meituanGmv || ch.meituan || 0)
        const mNet = Number(ch.meituanNet || mGmv)
        const dGmv = Number(ch.douyinGmv || ch.douyin || 0)
        const dNet = Number(ch.douyinNet || dGmv)
        platformFee += Math.max(0, mGmv - mNet) + Math.max(0, dGmv - dNet)
      })
      const foodCost = receipts.reduce((s, r) => s + Number(r.totalAmount), 0)
      const lossAmount = lossClaims.reduce((s, l) => s + Number(l.totalLossAmount), 0)
      // 经营杂费
      const expensesTotal = expenses.reduce((s, e) => s + Number(e.amount), 0) + platformFee
      const openingCost = includeOpening ? Number(openingTotal._sum?.contractAmount || 0) : 0
      const openingPaid = includeOpening ? Number(openingTotal._sum?.paidAmount || 0) : 0
      const netProfit = totalRevenue - foodCost - expensesTotal - openingCost
      return {
        revenue: totalRevenue,
        platformFee,
        foodCost,
        lossOffset: lossAmount,
        expensesTotal,
        openingCost,
        openingPaid,
        netProfit,
        netMargin: totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0,
      }
    }

    const [m, q, y, s] = await Promise.all([
      metricsFor(monthStart, monthEnd, false),
      metricsFor(quarterStart, quarterEnd, false),
      metricsFor(yearStart, yearEnd, false),
      metricsFor(sinceStart, sinceEnd, true),  // 累计含建店成本
    ])

    return {
      store: { id: store.id, name: store.name, no: store.no, createdAt: (store as any).createdAt },
      month: { label: now.format('YYYY-MM'), ...m },
      quarter: { label: `${now.year()} Q${quarterIdx + 1}`, ...q },
      year: { label: `${now.year()}`, ...y },
      sinceOpen: {
        label: '开店以来',
        startedAt: sinceStart,
        ...s,
      },
    }
  })

  // 集团多店快照 (老板/财务总览)
  app.get('/group/snapshot', auth, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const now = dayjs()
    const monthStart = now.startOf('month').toDate()
    const monthEnd = now.endOf('month').toDate()
    const stores = await prisma.store.findMany({
      where: { tenantId, status: 'ENABLED' },
      orderBy: { no: 'asc' },
    })
    const list = await Promise.all(stores.map(async store => {
      const [revenues, receipts, expenses, openingTotal] = await Promise.all([
        prisma.revenueRecord.aggregate({
          where: { storeId: store.id, date: { gte: monthStart, lte: monthEnd } },
          _sum: { amount: true },
        }),
        prisma.receipt.aggregate({
          where: { storeId: store.id, tenantId, status: { notIn: ['VOID', 'REJECTED'] }, createdAt: { gte: monthStart, lte: monthEnd } },
          _sum: { totalAmount: true },
        }),
        prisma.storeExpense.aggregate({
          where: { storeId: store.id, month: now.format('YYYY-MM') },
          _sum: { amount: true },
        }),
        (prisma as any).storeOpeningBudget.aggregate({
          where: { tenantId, storeId: store.id },
          _sum: { contractAmount: true, paidAmount: true },
        }).catch(() => ({ _sum: { contractAmount: 0, paidAmount: 0 } })),
      ])
      const rev = Number(revenues._sum.amount || 0)
      const fc = Number(receipts._sum.totalAmount || 0)
      const ex = Number(expenses._sum.amount || 0)
      const monthNet = rev - fc - ex
      const opening = Number(openingTotal._sum?.contractAmount || 0)
      return {
        id: store.id, no: store.no, name: store.name,
        lifecyclePhase: (store as any).lifecyclePhase,
        monthRevenue: rev,
        monthNet,
        openingCost: opening,
      }
    }))
    return list
  })

  // 保存/更新费用项
  app.post('/store/:storeId/expenses', auth, async (req: any, reply: any) => {
    const { tenantId, role, storeId: userStoreId } = req.user
    const { storeId } = req.params
    const { month, expenses } = req.body as any

    if (isStoreScoped(role) && userStoreId !== storeId) {
      return reply.status(403).send({ error: '无权操作该门店' })
    }
    if (!['MANAGER', 'ADMIN', 'FINANCE'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })

    // upsert 每个费用项
    const results = await Promise.all(
      Object.entries(expenses as Record<string, number>).map(([item, amount]) => {
        // 找 category
        let category = 'SALES'
        for (const [cat, items] of Object.entries(EXPENSE_ITEMS)) {
          if (items.includes(item)) { category = cat; break }
        }
        return prisma.storeExpense.upsert({
          where: { storeId_month_item: { storeId, month, item } },
          update: { amount, updatedAt: new Date() },
          create: { id: `${storeId}-${month}-${item}`.replace(/[^a-zA-Z0-9-]/g, '_'), tenantId, storeId, month, category, item, amount },
        })
      })
    )
    return { success: true, count: results.length }
  })
}
