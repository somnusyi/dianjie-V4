import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { isSupplierRole, resolveActiveStore } from '../lib/auth-scope'
import { monthRangeForDateCol, monthRangeForTimestampCol } from '../lib/dateRange'

// 费用项配置
export const EXPENSE_ITEMS = {
  LABOR: [
    '工资成本', '提成奖金', '社保成本', '外包服务费', '员工宿舍费', '员工福利费',
  ],
  SALES: [
    '门店租金', '门店物业费', '抽成租金', '仓库租金', '商场其他费用',
    '洗碗机租金', '炒菜机租金', '水费', '电费', '燃气费',
    '运费', '维修费', '推广费', '设备', '前厅餐具', '厨房厨具',
    '消杀费', '清洗费', '垃圾清运费', '清洁用品', '平台服务费', '前期开办费摊销', '其他销售费用',
  ],
  MGMT: [
    '交通费', '差旅费', '代账代办费', '招聘费', '办公费', '通讯费',
    '门店保险费', '业务招待费', '软件服务费', '总部管理费2%', '运营服务费5%', '其他费用',
  ],
  FINANCE: ['利息支出及结息', '银行手续费'],
}

export const profitRoutes: FastifyPluginAsync = async (app) => {

  // 集团经营数据(营业额、利润、采购总额、应付排期)对外部供应商一律不可见。
  // 历史 bug: 这三条老路由只用 isStoreScoped 兜，而供应商不是门店范围角色，
  // 过滤器为空 → 供应商 token 能读到全租户的营收、利润表和付给别家的应付明细。
  const denySupplier = async (req: any, reply: any) => {
    if (isSupplierRole(req.user?.role)) {
      return reply.status(403).send({ error: '无权访问集团经营数据' })
    }
  }
  const auth = { preHandler: [(app as any).authenticate, denySupplier] }

  // 获取单店利润表数据
  app.get('/store/:storeId', auth, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const { storeId } = req.params
    const { month } = req.query as any

    // 权限校验：门店级角色只能看可访问集合内的门店（多店集合校验）
    try { resolveActiveStore(req.user, storeId) } catch {
      return reply.status(403).send({ error: '无权查看该门店' })
    }

    const targetMonth = month || dayjs().format('YYYY-MM')
    const targetMonthDay = dayjs(`${targetMonth}-01`)
    const comparisonMonth = targetMonthDay.subtract(1, 'month').format('YYYY-MM')
    // DATE 列 (RevenueRecord.date) → UTC 边界; timestamp 列 (createdAt) → ts 边界
    const { start, end } = monthRangeForDateCol(targetMonth)
    const { start: startTs, end: endTs } = monthRangeForTimestampCol(targetMonth)
    const { start: comparisonStart, end: comparisonEnd } = monthRangeForDateCol(comparisonMonth)

    // 验证门店属于当前租户
    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })

    const [revenues, comparisonRevenueRows, receipts, lossClaims, expenses, accountingClose] = await Promise.all([
      // 营业额（含渠道, date 是 DATE）
      prisma.revenueRecord.findMany({
        where: { storeId, date: { gte: start, lte: end } },
        orderBy: { date: 'asc' },
      }),
      // 对比期营业数据；本月会在查询后截到相同营业日，避免拿半个月对比完整上月
      prisma.revenueRecord.findMany({
        where: { storeId, date: { gte: comparisonStart, lte: comparisonEnd } },
        orderBy: { date: 'asc' },
      }),
      // 食材采购成本 (createdAt 是 timestamp)
      prisma.receipt.findMany({
        where: { storeId, tenantId, status: { notIn: ['VOID', 'REJECTED'] }, createdAt: { gte: startTs, lte: endTs } },
        select: { totalAmount: true },
      }),
      // 报损金额 (createdAt 是 timestamp)
      prisma.lossClaim.findMany({
        where: { storeId, tenantId, status: { in: ['APPROVED', 'AUTO_APPROVED'] }, createdAt: { gte: startTs, lte: endTs } },
        select: { totalLossAmount: true },
      }),
      // 手动录入费用
      prisma.storeExpense.findMany({
        where: { storeId, month: targetMonth },
        orderBy: { category: 'asc' },
      }),
      prisma.storeMonthlyClose.findFirst({
        where: { tenantId, storeId, month: targetMonth, status: 'CONFIRMED' },
      }),
    ])

    // 营业核心指标。历史 POS 导入在 rawData 中保留折前/优惠/折后/订单量；
    // 老的手工记录没有这些字段时，以 amount 作为营业额和营业收入兜底。
    function operatingMetrics(rows: typeof revenues) {
      return rows.reduce((result, record) => {
        const raw = (record.rawData as any) || {}
        const netRevenue = Number(raw.netRevenue ?? record.amount ?? 0)
        const grossAmount = Number(raw.grossAmount ?? record.amount ?? 0)
        result.grossAmount += grossAmount
        result.netRevenue += netRevenue
        result.discountAmount += Number(raw.discountAmount ?? Math.max(0, grossAmount - netRevenue))
        result.orders += Number(raw.orders ?? 0)
        result.recordCount += 1
        return result
      }, { grossAmount: 0, netRevenue: 0, discountAmount: 0, orders: 0, recordCount: 0 })
    }

    const metrics = operatingMetrics(revenues)
    const isCurrentMonth = targetMonth === dayjs().format('YYYY-MM')
    const latestRecordedDay = revenues.length > 0
      ? Math.max(...revenues.map(record => record.date.getUTCDate()))
      : 0
    const comparableRevenueRows = isCurrentMonth && latestRecordedDay > 0
      ? comparisonRevenueRows.filter(record => record.date.getUTCDate() <= latestRecordedDay)
      : comparisonRevenueRows
    const comparisonMetrics = operatingMetrics(comparableRevenueRows)
    const changePct = (current: number, previous: number) => previous > 0
      ? ((current - previous) / previous) * 100
      : null
    const currentMonthLabel = `${targetMonthDay.month() + 1}月`
    const comparisonMonthDay = targetMonthDay.subtract(1, 'month')
    const comparisonMonthLabel = `${comparisonMonthDay.month() + 1}月`
    const comparisonLabel = isCurrentMonth && latestRecordedDay > 0 ? '较上月同期' : '较上月'
    const dataRangeLabel = (monthLabel: string, monthDay: dayjs.Dayjs, rows: typeof revenues) => {
      if (rows.length === 0) return `${monthLabel}暂无数据`
      const firstDay = Math.min(...rows.map(record => record.date.getUTCDate()))
      const lastDay = Math.max(...rows.map(record => record.date.getUTCDate()))
      return firstDay === 1 && lastDay === monthDay.daysInMonth()
        ? monthLabel
        : `${monthLabel}${firstDay}–${lastDay}日`
    }
    const rangeLabel = `${dataRangeLabel(currentMonthLabel, targetMonthDay, revenues)} · 对比${dataRangeLabel(comparisonMonthLabel, comparisonMonthDay, comparableRevenueRows)}`

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
    const operationalPurchaseCost = receipts.reduce((s, r) => s + Number(r.totalAmount), 0)
    const closedCostOfGoods = accountingClose
      ? Number(accountingClose.foodCost) + Number(accountingClose.beverageCost) + Number(accountingClose.consumablesCost)
      : null
    const foodCost = closedCostOfGoods ?? operationalPurchaseCost
    const lossAmount = lossClaims.reduce((s, l) => s + Number(l.totalLossAmount), 0)

    // 各类费用汇总
    const expenseByItem: Record<string, number> = {}
    expenses.forEach(e => { expenseByItem[e.item] = Number(e.amount) })

    const laborTotal = accountingClose ? Number(accountingClose.laborCost) : EXPENSE_ITEMS.LABOR.reduce((s, item) => s + (expenseByItem[item] || 0), 0)
    const salesTotal = accountingClose ? Number(accountingClose.salesExpense) : EXPENSE_ITEMS.SALES.reduce((s, item) => s + (expenseByItem[item] || 0), 0)
    const mgmtTotal = accountingClose ? Number(accountingClose.managementExpense) : EXPENSE_ITEMS.MGMT.reduce((s, item) => s + (expenseByItem[item] || 0), 0)
    const financeTotal = accountingClose ? Number(accountingClose.financeExpense) : EXPENSE_ITEMS.FINANCE.reduce((s, item) => s + (expenseByItem[item] || 0), 0)
    // 平台抽成单独算入"销售费用"
    const salesTotalWithPlatform = accountingClose ? salesTotal : salesTotal + platformFeeTotal
    const closeAdjustments = accountingClose
      ? Number(accountingClose.vat) + Number(accountingClose.surcharge) + Number(accountingClose.nonOperatingExpense)
        - Number(accountingClose.nonOperatingIncome) + Number(accountingClose.incomeTax)
      : 0
    const totalExpense = laborTotal + salesTotalWithPlatform + mgmtTotal + financeTotal + closeAdjustments
    const totalCost = foodCost + totalExpense
    const financialRevenue = accountingClose ? Number(accountingClose.operatingRevenue) : totalRevenue
    const netProfit = accountingClose ? Number(accountingClose.netProfit) : totalRevenue - totalCost
    const netRevenue = accountingClose ? financialRevenue : totalRevenue - platformFeeTotal   // 实际到账 (现金流口径)

    return {
      store: { id: store.id, name: store.name, no: store.no },
      month: targetMonth,
      accountingClose: accountingClose ? {
        status: accountingClose.status,
        operatingRevenue: Number(accountingClose.operatingRevenue),
        operationalRevenue: totalRevenue,
        reconciliationDifference: Number(accountingClose.operatingRevenue) - totalRevenue,
        sourceFilename: accountingClose.sourceFilename,
        confirmedAt: accountingClose.confirmedAt,
        tax: Number(accountingClose.vat) + Number(accountingClose.surcharge),
        incomeTax: Number(accountingClose.incomeTax),
        nonOperatingNet: Number(accountingClose.nonOperatingIncome) - Number(accountingClose.nonOperatingExpense),
      } : null,
      revenue: {
        total: financialRevenue,                          // 已月结时为财务确认收入，否则为运营日报收入
        operationalTotal: totalRevenue,
        net: netRevenue,                                  // 净到账
        platformFee: accountingClose ? 0 : platformFeeTotal,
        operationalPlatformFee: platformFeeTotal,
        platformFeeBreakdown: {
          meituan: platformFeeMeituan,
          douyin:  platformFeeDouyin,
        },
        channels: channelSummary,
        recordCount: revenues.length,
        metrics,
        comparison: {
          label: comparisonLabel,
          month: comparisonMonth,
          rangeLabel,
          metrics: comparisonMetrics,
          changes: {
            grossAmount: changePct(metrics.grossAmount, comparisonMetrics.grossAmount),
            netRevenue: changePct(metrics.netRevenue, comparisonMetrics.netRevenue),
            orders: changePct(metrics.orders, comparisonMetrics.orders),
            discountAmount: changePct(metrics.discountAmount, comparisonMetrics.discountAmount),
          },
        },
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
      grossProfit: financialRevenue - foodCost,
      grossMargin: financialRevenue > 0 ? ((financialRevenue - foodCost) / financialRevenue * 100) : 0,
      netProfit,
      netMargin: financialRevenue > 0 ? (netProfit / financialRevenue * 100) : 0,
    }
  })

  // ── 已确认财务月结月份列表: 店长营业页「上月」历史月份选择器数据源 ──
  // 只读, 返回该门店全部 CONFIRMED 月结月份 (倒序), 不暴露金额明细
  app.get('/store/:storeId/closed-months', auth, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const { storeId } = req.params

    // 权限校验：门店级角色只能看可访问集合内的门店 (与 /store/:storeId 同一规则)
    try { resolveActiveStore(req.user, storeId) } catch {
      return reply.status(403).send({ error: '无权查看该门店' })
    }
    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })

    const closes = await prisma.storeMonthlyClose.findMany({
      where: { tenantId, storeId, status: 'CONFIRMED' },
      select: { month: true, confirmedAt: true, sourceFilename: true },
      orderBy: { month: 'desc' },
    })
    return {
      months: closes.map(close => ({
        month: close.month,
        confirmedAt: close.confirmedAt,
        sourceFilename: close.sourceFilename,
      })),
    }
  })

  // ── 净利快照: 4 口径一次返回 (月/季/年/累计含建店成本) ──
  app.get('/store/:storeId/snapshot', auth, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    const { storeId } = req.params
    try { resolveActiveStore(req.user, storeId) } catch {
      return reply.status(403).send({ error: '无权查看该门店' })
    }
    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })

    const now = dayjs()
    // 这些边界同时给 DATE 列 (RevenueRecord.date) 和 timestamp 列 (createdAt) 用,
    // 用 UTC 边界优先保证 DATE 列正确 (PG 隐式 cast 丢时间会跨日);
    // 对 timestamp 列在月度边界上 0-8h 偏移可忽略 (季/年范围内尤其无感)
    const monthStart = monthRangeForDateCol(now.format('YYYY-MM')).start
    const monthEnd = monthRangeForDateCol(now.format('YYYY-MM')).end
    const quarterIdx = Math.floor(now.month() / 3)  // 0..3
    const quarterStart = monthRangeForDateCol(now.month(quarterIdx * 3).format('YYYY-MM')).start
    const quarterEnd = monthRangeForDateCol(now.month(quarterIdx * 3 + 2).format('YYYY-MM')).end
    const yearStart = monthRangeForDateCol(now.startOf('year').format('YYYY-MM')).start
    const yearEnd = monthRangeForDateCol(now.month(11).format('YYYY-MM')).end
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
    // DATE 列优先: UTC 边界. timestamp 列 (createdAt) 0-8h 偏移可忽略.
    const monthStart = monthRangeForDateCol(now.format('YYYY-MM')).start
    const monthEnd = monthRangeForDateCol(now.format('YYYY-MM')).end
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
    const { tenantId, role } = req.user
    const { storeId } = req.params
    const { month, expenses } = req.body as any

    try { resolveActiveStore(req.user, storeId) } catch {
      return reply.status(403).send({ error: '无权操作该门店' })
    }
    if (!['MANAGER', 'ADMIN', 'FINANCE'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })
    const confirmedClose = await prisma.storeMonthlyClose.findFirst({
      where: { tenantId, storeId, month, status: 'CONFIRMED' }, select: { id: true },
    })
    if (confirmedClose) return reply.status(409).send({ error: '该月已完成财务月结，费用明细不可直接修改' })

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
