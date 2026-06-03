/**
 * 财务管理报表 (非法定, 给老板 + 财务看)
 *
 * GET /api/finance/reports/profit?month=YYYY-MM&storeId=optional
 *   返回: 营收/成本/净利 + 渠道分布 + 损益结构占比
 *
 * GET /api/finance/reports/aging
 *   返回: 应付账龄 (0-30/30-60/60-90/90+/未到期) + 按供应商分组
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { PNL_PREFIXES, BS_PREFIXES } from '../services/voucher/coa-config'
import { monthRangeForDateCol, monthRangeForTimestampCol, endOfDayUtcForDateCol } from '../lib/dateRange'

const FINANCE_ROLES = ['FINANCE', 'ADMIN', 'SUPER_ADMIN']
const auth = (app: any) => ({ preHandler: [app.authenticate] })

// 帮助函数: 按科目编码前缀求和 (借 - 贷)
async function sumVoucherByCode(tenantId: string, prefixes: string[], start: Date, end: Date) {
  const rows = await prisma.voucherEntry.findMany({
    where: {
      voucher: { tenantId, date: { gte: start, lte: end }, status: { in: ['DRAFT', 'POSTED'] } },
      OR: prefixes.map(pp => ({ accountCode: { startsWith: pp } })),
    },
    select: { debit: true, credit: true },
  })
  return rows.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0)
}

export const financeReportRoutes: FastifyPluginAsync = async (app) => {

  // ──────────────────────────────────────────────────────
  // 利润中心: 营收 + 成本 + 净利 + 渠道 + 损益结构占比
  // ──────────────────────────────────────────────────────
  app.get('/profit', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role) && role !== 'ADMIN') {
      return reply.status(403).send({ error: '无权查看' })
    }
    const { month, storeId } = req.query as any
    const ym = month || dayjs().format('YYYY-MM')
    // DATE 列 (RevenueRecord.date / Receipt.deliveryDate / Voucher.date): 用 UTC 边界防 timezone 跨日
    const { start: monthStart, end: monthEnd } = monthRangeForDateCol(ym)
    // timestamp 列 (LossClaim.createdAt 等): 用 Asia/Shanghai 边界保留本地语义
    const { start: monthStartTs, end: monthEndTs } = monthRangeForTimestampCol(ym)
    // 同比/环比 衍生 (用 DATE 边界 + 偏移, 因主要给 DATE 列查询用)
    const lyStart = dayjs(monthStart).subtract(1, 'year').toDate()
    const lyEnd   = dayjs(monthEnd).subtract(1, 'year').toDate()
    const lmStart = dayjs(monthStart).subtract(1, 'month').toDate()
    const lmEnd   = dayjs(monthStart).subtract(1, 'day').endOf('day').toDate()

    const storeWhere: any = { tenant: { id: tenantId } }
    if (storeId) storeWhere.id = storeId
    const stores = await prisma.store.findMany({ where: { tenantId, ...(storeId && { id: storeId }) }, select: { id: true, name: true } })
    const storeIds = stores.map((s) => s.id)
    if (storeIds.length === 0) return reply.send({ stores: [], summary: null })

    // 营业额 (本月 / 同比 / 环比)
    async function sumRevenue(start: Date, end: Date) {
      const r = await prisma.revenueRecord.aggregate({
        where: { storeId: { in: storeIds }, date: { gte: start, lte: end } },
        _sum: { amount: true },
      })
      return Number(r._sum.amount || 0)
    }
    const [revThis, revLy, revLm] = await Promise.all([
      sumRevenue(monthStart, monthEnd),
      sumRevenue(lyStart, lyEnd),
      sumRevenue(lmStart, lmEnd),
    ])

    // 渠道分布 (从 rawData.channels 聚合)
    const revRecords = await prisma.revenueRecord.findMany({
      where: { storeId: { in: storeIds }, date: { gte: monthStart, lte: monthEnd } },
      select: { rawData: true, amount: true },
    })
    const byChannel: Record<string, number> = { cash: 0, wechat: 0, alipay: 0, meituan: 0, douyin: 0, bank: 0, unknown: 0 }
    for (const r of revRecords) {
      const ch = (r.rawData as any)?.channels
      if (ch && typeof ch === 'object') {
        for (const [k, v] of Object.entries(ch)) {
          byChannel[k] = (byChannel[k] || 0) + Number(v || 0)
        }
      } else {
        byChannel.unknown += Number(r.amount)
      }
    }

    // 成本 (从 Receipt + LossClaim 反推, 后期可加凭证维度)
    async function sumReceipts(start: Date, end: Date) {
      const r = await prisma.receipt.aggregate({
        where: { tenantId, storeId: { in: storeIds }, deliveryDate: { gte: start, lte: end } },
        _sum: { totalAmount: true },
      })
      return Number(r._sum.totalAmount || 0)
    }
    const [foodThis, foodLy, foodLm] = await Promise.all([
      sumReceipts(monthStart, monthEnd),
      sumReceipts(lyStart, lyEnd),
      sumReceipts(lmStart, lmEnd),
    ])

    const loss = await prisma.lossClaim.aggregate({
      where: {
        tenantId, storeId: { in: storeIds },
        status: { in: ['APPROVED', 'RESOLVED'] },
        // createdAt 是 timestamp 列, 用 ts 边界
        createdAt: { gte: monthStartTs, lte: monthEndTs },
      },
      _sum: { totalLossAmount: true },
    })
    const lossAmount = Number(loss._sum.totalLossAmount || 0)

    // 其他成本: 从凭证按科目前缀聚合 (5601/5602/5603 → 销售/管理/财务)
    async function sumByCode(prefixes: string[], start: Date, end: Date) {
      const rows = await prisma.voucherEntry.findMany({
        where: {
          voucher: { tenantId, date: { gte: start, lte: end }, status: { in: ['DRAFT', 'POSTED'] } },
          OR: prefixes.map(p => ({ accountCode: { startsWith: p } })),
        },
        select: { debit: true, credit: true },
      })
      return rows.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0)
    }
    const [sellExp, mgmtExp, finExp, payroll, rent, utility, marketing] = await Promise.all([
      sumByCode(['5601'], monthStart, monthEnd),
      sumByCode(['5602'], monthStart, monthEnd),
      sumByCode(['5603'], monthStart, monthEnd),
      sumByCode(['560101', '560201'], monthStart, monthEnd),  // 销售人员/管理人员职工薪酬
      sumByCode(['560117', '560118'], monthStart, monthEnd),  // 门店租金 + 物业费
      sumByCode(['560119', '560120'], monthStart, monthEnd),  // 水费 + 电费
      sumByCode(['560104', '560105', '560116'], monthStart, monthEnd),  // 广告费 + 业务宣传 + 推广费
    ])

    // 各店明细
    const storesDetail = await Promise.all(stores.map(async (s) => {
      const rev = await prisma.revenueRecord.aggregate({
        where: { storeId: s.id, date: { gte: monthStart, lte: monthEnd } },
        _sum: { amount: true },
      })
      const food = await prisma.receipt.aggregate({
        where: { tenantId, storeId: s.id, deliveryDate: { gte: monthStart, lte: monthEnd } },
        _sum: { totalAmount: true },
      })
      const revVal = Number(rev._sum.amount || 0)
      const foodVal = Number(food._sum.totalAmount || 0)
      return {
        storeId: s.id, storeName: s.name,
        revenue: revVal,
        foodCost: foodVal,
        grossProfit: revVal - foodVal,
        grossMargin: revVal > 0 ? (revVal - foodVal) / revVal : 0,
      }
    }))

    const totalCost = foodThis + lossAmount + sellExp + mgmtExp + finExp
    const netProfit = revThis - totalCost
    return reply.send({
      month: ym,
      summary: {
        revenue: revThis,
        revenueYoy: revLy > 0 ? (revThis - revLy) / revLy : null,
        revenueMom: revLm > 0 ? (revThis - revLm) / revLm : null,
        cost: {
          food: foodThis,
          loss: lossAmount,
          sellingExp: sellExp,
          mgmtExp: mgmtExp,
          financeExp: finExp,
          // 细分销售费用
          payroll, rent, utility, marketing,
          other: sellExp + mgmtExp - payroll - rent - utility - marketing,
        },
        netProfit,
        netMargin: revThis > 0 ? netProfit / revThis : 0,
        foodCostRatio: revThis > 0 ? foodThis / revThis : 0,
      },
      byChannel,
      stores: storesDetail,
    })
  })

  // ──────────────────────────────────────────────────────
  // 食材成本专项
  // 月度 + 趋势(近6月) + 各店 + 周转(库存余额 / 月消耗)
  // ──────────────────────────────────────────────────────
  app.get('/food-cost', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role) && role !== 'ADMIN') {
      return reply.status(403).send({ error: '无权查看' })
    }
    const { month } = req.query as any
    const ym = month || dayjs().format('YYYY-MM')
    // DATE 列 (deliveryDate, date): UTC 边界. timestamp 列 (createdAt): Asia/Shanghai 边界.
    const { start: monthStart, end: monthEnd } = monthRangeForDateCol(ym)
    const { start: monthStartTs, end: monthEndTs } = monthRangeForTimestampCol(ym)

    const stores = await prisma.store.findMany({ where: { tenantId }, select: { id: true, name: true } })
    const storeIds = stores.map(s => s.id)

    // 本月: 收货金额 / 报损金额 / 营业额 / 食材占比
    async function sumByStore(storeId: string | null) {
      const where: any = { tenantId, deliveryDate: { gte: monthStart, lte: monthEnd } }
      if (storeId) where.storeId = storeId
      const receipt = await prisma.receipt.aggregate({ where, _sum: { totalAmount: true } })
      const lossWhere: any = {
        tenantId, status: { in: ['APPROVED', 'RESOLVED'] },
        createdAt: { gte: monthStartTs, lte: monthEndTs },
      }
      if (storeId) lossWhere.storeId = storeId
      const loss = await prisma.lossClaim.aggregate({ where: lossWhere, _sum: { totalLossAmount: true } })
      const revWhere: any = { date: { gte: monthStart, lte: monthEnd } }
      if (storeId) revWhere.storeId = storeId
      else revWhere.storeId = { in: storeIds }
      const rev = await prisma.revenueRecord.aggregate({ where: revWhere, _sum: { amount: true } })
      return {
        revenue: Number(rev._sum.amount || 0),
        foodCost: Number(receipt._sum.totalAmount || 0),
        loss: Number(loss._sum.totalLossAmount || 0),
      }
    }

    const total = await sumByStore(null)
    const totalRatio = total.revenue > 0 ? total.foodCost / total.revenue : 0
    const totalLossRatio = total.foodCost > 0 ? total.loss / total.foodCost : 0

    const storesDetail = await Promise.all(stores.map(async (s) => {
      const d = await sumByStore(s.id)
      return {
        storeId: s.id, storeName: s.name,
        ...d,
        foodCostRatio: d.revenue > 0 ? d.foodCost / d.revenue : 0,
        lossRatio: d.foodCost > 0 ? d.loss / d.foodCost : 0,
      }
    }))

    // 近 6 个月趋势
    const trend = [] as Array<{ month: string; revenue: number; foodCost: number; ratio: number; loss: number }>
    for (let i = 5; i >= 0; i--) {
      const m = dayjs(ym + '-01').subtract(i, 'month').format('YYYY-MM')
      // DATE 列用 UTC 边界, timestamp 列用 ts 边界
      const { start: ms, end: me } = monthRangeForDateCol(m)
      const { start: msTs, end: meTs } = monthRangeForTimestampCol(m)
      const [rec, los, rev] = await Promise.all([
        prisma.receipt.aggregate({ where: { tenantId, deliveryDate: { gte: ms, lte: me } }, _sum: { totalAmount: true } }),
        prisma.lossClaim.aggregate({ where: { tenantId, status: { in: ['APPROVED', 'RESOLVED'] }, createdAt: { gte: msTs, lte: meTs } }, _sum: { totalLossAmount: true } }),
        prisma.revenueRecord.aggregate({ where: { storeId: { in: storeIds }, date: { gte: ms, lte: me } }, _sum: { amount: true } }),
      ])
      const revV = Number(rev._sum.amount || 0)
      const food = Number(rec._sum.totalAmount || 0)
      trend.push({
        month: m,
        revenue: revV, foodCost: food,
        loss: Number(los._sum.totalLossAmount || 0),
        ratio: revV > 0 ? food / revV : 0,
      })
    }

    // 库存周转: 库存余额估值 / 月消耗
    // 库存余额 = Σ(product.stock * product.price) per supplier - 但供应商商品归供应商不归店,这里用 receipt 现存(简化)
    // 简化: 库存价值 = sum(本月入库未消耗) — 真实计算需要 ConsumptionRecord, 暂略
    // 周转天数 ≈ 食材库存价值 / 日均消耗 (无法精确; 给参考值)
    const turnoverDays = total.foodCost > 0 ? Math.round((total.foodCost / 30)) : 0

    return reply.send({
      month: ym,
      total: {
        ...total,
        foodCostRatio: totalRatio,
        lossRatio: totalLossRatio,
      },
      stores: storesDetail.sort((a, b) => b.foodCost - a.foodCost),
      trend,
      turnoverDays,
    })
  })

  // ──────────────────────────────────────────────────────
  // 现金流瀑布: 经营 / 投资 / 筹资 三大活动
  // ──────────────────────────────────────────────────────
  app.get('/cash-flow', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role) && role !== 'ADMIN') {
      return reply.status(403).send({ error: '无权查看' })
    }
    const { month } = req.query as any
    const ym = month || dayjs().format('YYYY-MM')
    // DATE 列 (RevenueRecord.date, Voucher.date) 用 UTC; timestamp 列 (paidAt, createdAt) 用 ts
    const { start, end } = monthRangeForDateCol(ym)
    const { start: tsStart, end: tsEnd } = monthRangeForTimestampCol(ym)

    const stores = await prisma.store.findMany({ where: { tenantId }, select: { id: true } })
    const storeIds = stores.map(s => s.id)

    // 经营活动 (流入)
    // - 营业额 (revenueRecord)
    const revIn = await prisma.revenueRecord.aggregate({
      where: { storeId: { in: storeIds }, date: { gte: start, lte: end } },
      _sum: { amount: true },
    })
    const operatingIn = Number(revIn._sum.amount || 0)

    // 经营活动 (流出)
    // - 已付款给供应商 (paidAt 是 timestamp)
    const paymentOut = await prisma.payment.aggregate({
      where: { tenantId, status: 'PAID', paidAt: { gte: tsStart, lte: tsEnd } },
      _sum: { amount: true },
    })
    const supplierPaid = Number(paymentOut._sum.amount || 0)
    // - 销售费用 + 管理费用 (从凭证里聚合, 借方; voucher.date 是 DATE)
    const sellingPaid = await sumVoucherByCode(tenantId, ['5601'], start, end)
    const mgmtPaid    = await sumVoucherByCode(tenantId, ['5602'], start, end)
    const operatingOut = supplierPaid + sellingPaid + mgmtPaid

    // 投资活动 (流出): 建店资金 (createdAt 是 timestamp)
    const capitalExpense: any = await prisma.capitalExpense.aggregate({
      where: { project: { store: { tenantId } }, createdAt: { gte: tsStart, lte: tsEnd } },
      _sum: { amount: true },
    } as any).catch(() => ({ _sum: { amount: 0 } }))
    const investmentOut = Number(capitalExpense?._sum?.amount || 0)

    // 筹资活动 (借款 / 还款) — 暂无业务事件, 留 0
    const financingIn = 0
    const financingOut = 0

    // 净现金流
    const operatingNet = operatingIn - operatingOut
    const investmentNet = -investmentOut
    const financingNet = financingIn - financingOut
    const totalNet = operatingNet + investmentNet + financingNet

    return reply.send({
      month: ym,
      operating: {
        inflow: operatingIn,
        outflow: operatingOut,
        net: operatingNet,
        detail: {
          revenue: operatingIn,
          supplierPayment: supplierPaid,
          sellingExp: sellingPaid,
          mgmtExp: mgmtPaid,
        },
      },
      investment: {
        inflow: 0,
        outflow: investmentOut,
        net: investmentNet,
        detail: { capitalExpense: investmentOut },
      },
      financing: {
        inflow: financingIn,
        outflow: financingOut,
        net: financingNet,
        detail: {},
      },
      totalNet,
    })
  })

  // ──────────────────────────────────────────────────────
  // 对账自检: 凭证(银行存款分录) vs CashTransaction
  // 帮财务发现"漏建凭证"或"重复入账"
  // ──────────────────────────────────────────────────────
  app.get('/recon-check', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role) && role !== 'ADMIN') {
      return reply.status(403).send({ error: '无权查看' })
    }
    const { month } = req.query as any
    const ym = month || dayjs().format('YYYY-MM')
    // voucher.date 是 DATE 列 → UTC 边界
    const { start, end } = monthRangeForDateCol(ym)

    // 拉本月所有"银行存款"类凭证分录 (1001 库存现金 / 1002* 银行存款 / 1012* 其他货币资金)
    const entries = await prisma.voucherEntry.findMany({
      where: {
        voucher: { tenantId, date: { gte: start, lte: end }, status: { not: 'VOIDED' } },
        OR: [
          { accountCode: { startsWith: '1001' } },
          { accountCode: { startsWith: '1002' } },
          { accountCode: { startsWith: '1012' } },
        ],
      },
      include: { voucher: { select: { id: true, no: true, date: true, summary: true } } },
    })

    // 拉本月所有 CashTransaction
    const cashTxs = await prisma.cashTransaction.findMany({
      where: { tenantId, txDate: { gte: start, lte: end } },
      include: { account: { select: { name: true, type: true } } },
    })

    // 按金额+日期粗匹配 — 凭证分录 net (借-贷) 应等于 CashTransaction.amount * direction
    const matched: any[] = []
    const unmatchedEntries: any[] = []
    const unmatchedTxs: any[] = []
    const txUsed = new Set<string>()
    for (const e of entries) {
      const net = Number(e.debit) - Number(e.credit)
      const eDate = dayjs(e.voucher.date).format('YYYY-MM-DD')
      // 找一笔金额相同 + 日期同 ± 3 天 + 没用过的 cash tx
      const cand = cashTxs.find(t => {
        if (txUsed.has(t.id)) return false
        const tDate = dayjs(t.txDate).format('YYYY-MM-DD')
        const diff = Math.abs(dayjs(eDate).diff(tDate, 'day'))
        if (diff > 3) return false
        const tNet = Number(t.amount) * t.direction
        return Math.abs(tNet - net) < 0.01
      })
      if (cand) {
        txUsed.add(cand.id)
        matched.push({ entryId: e.id, txId: cand.id, amount: net, voucherNo: e.voucher.no, voucherDate: eDate, txDate: dayjs(cand.txDate).format('YYYY-MM-DD') })
      } else {
        unmatchedEntries.push({
          entryId: e.id, voucherId: e.voucher.id, voucherNo: e.voucher.no,
          date: eDate, accountCode: e.accountCode, accountName: e.accountName,
          debit: Number(e.debit), credit: Number(e.credit),
          summary: e.summary, voucherSummary: e.voucher.summary,
        })
      }
    }
    for (const t of cashTxs) {
      if (txUsed.has(t.id)) continue
      unmatchedTxs.push({
        txId: t.id, txDate: dayjs(t.txDate).format('YYYY-MM-DD'),
        direction: t.direction, amount: Number(t.amount),
        category: t.category, note: t.note,
        accountName: t.account?.name,
      })
    }

    return reply.send({
      month: ym,
      summary: {
        voucherEntries: entries.length,
        cashTxs: cashTxs.length,
        matched: matched.length,
        unmatchedEntries: unmatchedEntries.length,
        unmatchedTxs: unmatchedTxs.length,
      },
      unmatchedEntries,
      unmatchedTxs,
    })
  })

  // ──────────────────────────────────────────────────────
  // 账龄分析: 应付账龄分桶
  // ──────────────────────────────────────────────────────
  app.get('/aging', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role) && role !== 'ADMIN') {
      return reply.status(403).send({ error: '无权查看' })
    }
    const { storeId } = req.query as any
    const where: any = {
      tenantId,
      status: { in: ['PENDING', 'PENDING_APPROVAL', 'APPROVED', 'ON_HOLD'] },
    }
    if (storeId) where.storeId = storeId
    const schedules = await prisma.paymentSchedule.findMany({
      where, orderBy: { dueAt: 'asc' },
    })
    // PaymentSchedule 没有 supplier/store 反向 relation, 手工 join
    const supplierIds = Array.from(new Set(schedules.map(s => s.supplierId)))
    const storeIdList = Array.from(new Set(schedules.map(s => s.storeId).filter(Boolean) as string[]))
    const [suppliers, storesArr] = await Promise.all([
      prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }),
      prisma.store.findMany({ where: { id: { in: storeIdList } }, select: { id: true, name: true } }),
    ])
    const supplierMap = new Map(suppliers.map(s => [s.id, s]))
    const storeMap = new Map(storesArr.map(s => [s.id, s]))

    const now = new Date()
    const buckets = {
      notDue:   { count: 0, total: 0, label: '未到期' },
      d0_30:    { count: 0, total: 0, label: '逾期 0-30 天' },
      d30_60:   { count: 0, total: 0, label: '逾期 30-60 天' },
      d60_90:   { count: 0, total: 0, label: '逾期 60-90 天' },
      d90plus:  { count: 0, total: 0, label: '逾期 90+ 天' },
    } as Record<string, { count: number; total: number; label: string }>

    const bySupplier = new Map<string, { name: string; total: number; count: number; oldest: number }>()

    const items = schedules.map((s) => {
      const overdueDays = Math.floor((now.getTime() - s.dueAt.getTime()) / 86400_000)
      let bucket: string
      if (overdueDays < 0) bucket = 'notDue'
      else if (overdueDays < 30) bucket = 'd0_30'
      else if (overdueDays < 60) bucket = 'd30_60'
      else if (overdueDays < 90) bucket = 'd60_90'
      else bucket = 'd90plus'
      const amt = Number(s.amount)
      buckets[bucket].count++
      buckets[bucket].total += amt

      const supId = s.supplierId
      const supName = supplierMap.get(supId)?.name || '?'
      const cur = bySupplier.get(supId) || { name: supName, total: 0, count: 0, oldest: -1 }
      cur.total += amt
      cur.count += 1
      if (overdueDays > cur.oldest) cur.oldest = overdueDays
      bySupplier.set(supId, cur)

      return {
        scheduleId: s.id,
        supplierId: supId, supplierName: supName,
        storeId: s.storeId, storeName: s.storeId ? (storeMap.get(s.storeId)?.name || '') : '',
        amount: amt,
        dueAt: s.dueAt,
        overdueDays,
        bucket,
        status: s.status,
      }
    })

    const supplierRank = Array.from(bySupplier.entries())
      .map(([id, v]) => ({ supplierId: id, ...v }))
      .sort((a, b) => b.total - a.total)

    return reply.send({
      asOf: now,
      buckets,
      totalOverdue: buckets.d0_30.total + buckets.d30_60.total + buckets.d60_90.total + buckets.d90plus.total,
      totalNotDue: buckets.notDue.total,
      grandTotal: items.reduce((s, i) => s + i.amount, 0),
      items,
      supplierRank,
    })
  })

  // ════════════════════════════════════════════════════════
  // Phase 4: 报税口径报表
  // ════════════════════════════════════════════════════════

  // 帮助函数: 按科目前缀拉出借/贷合计 (考虑日期区间, 默认 POSTED + DRAFT)
  async function aggregateByPrefix(opts: {
    tenantId: string
    prefixes: string[]
    start?: Date
    end?: Date
    statuses?: ('DRAFT'|'POSTED'|'VOIDED')[]
  }) {
    const { tenantId, prefixes, start, end, statuses = ['DRAFT', 'POSTED'] } = opts
    const voucherWhere: any = { tenantId, status: { in: statuses } }
    if (start || end) {
      voucherWhere.date = {}
      if (start) voucherWhere.date.gte = start
      if (end) voucherWhere.date.lte = end
    }
    const rows = await prisma.voucherEntry.findMany({
      where: {
        voucher: voucherWhere,
        OR: prefixes.map(p => ({ accountCode: { startsWith: p } })),
      },
      select: { accountCode: true, debit: true, credit: true },
    })
    let totalDebit = 0, totalCredit = 0
    for (const r of rows) {
      totalDebit += Number(r.debit)
      totalCredit += Number(r.credit)
    }
    return { totalDebit, totalCredit, net: totalDebit - totalCredit, count: rows.length }
  }

  // ──────────────────────────────────────────────────────
  // 利润表 (报税口径) GET /api/finance/reports/tax/income-statement?month=YYYY-MM
  // 输出: 与好会计/电子税局利润表一致的行列
  // ──────────────────────────────────────────────────────
  app.get('/tax/income-statement', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const { month } = req.query as any
    const ym = month || dayjs().format('YYYY-MM')
    // 用 UTC 边界 (避免 PG DATE 列时区跨日问题)
    const { start, end } = monthRangeForDateCol(ym)

    // 收入类: 贷-借为正 (期间发生额) — 多前缀兼容 (企业会计准则 5xxx + 好会计旧准则 6xxx)
    const revenueMain = await aggregateByPrefix({ tenantId, prefixes: PNL_PREFIXES.revenueMain, start, end })
    const revenueOther = await aggregateByPrefix({ tenantId, prefixes: PNL_PREFIXES.revenueOther, start, end })
    const revenueNonOp = await aggregateByPrefix({ tenantId, prefixes: PNL_PREFIXES.revenueNonOp, start, end })
    // 成本费用: 借-贷为正
    const costMain = await aggregateByPrefix({ tenantId, prefixes: PNL_PREFIXES.costMain, start, end })
    const sellingExp = await aggregateByPrefix({ tenantId, prefixes: PNL_PREFIXES.sellingExp, start, end })
    const mgmtExp = await aggregateByPrefix({ tenantId, prefixes: PNL_PREFIXES.mgmtExp, start, end })
    const financeExp = await aggregateByPrefix({ tenantId, prefixes: PNL_PREFIXES.financeExp, start, end })
    const tax = await aggregateByPrefix({ tenantId, prefixes: PNL_PREFIXES.tax, start, end })  // 税金及附加

    const operatingRevenue = revenueMain.totalCredit - revenueMain.totalDebit  // 营业收入
    const operatingCost    = costMain.totalDebit - costMain.totalCredit          // 营业成本
    const sellingExpAmt    = sellingExp.totalDebit - sellingExp.totalCredit
    const mgmtExpAmt       = mgmtExp.totalDebit - mgmtExp.totalCredit
    const financeExpAmt    = financeExp.totalDebit - financeExp.totalCredit
    const taxAmt           = tax.totalDebit - tax.totalCredit
    const otherIncome      = revenueOther.totalCredit - revenueOther.totalDebit
    const nonOpIncome      = revenueNonOp.totalCredit - revenueNonOp.totalDebit

    const operatingProfit = operatingRevenue - operatingCost - taxAmt - sellingExpAmt - mgmtExpAmt - financeExpAmt
    const totalProfit     = operatingProfit + otherIncome + nonOpIncome
    // 小微企业暂不计所得税 (财务可在导出 Excel 后手工填)
    const netProfit       = totalProfit

    return {
      month: ym,
      currency: 'CNY',
      rows: [
        // 行号 / 项目 / 本月 / 累计 (累计字段暂未计算, 后续可扩)
        { lineNo: 1,  label: '一、营业收入',     amount: operatingRevenue, type: 'subtotal' },
        { lineNo: 2,  label: '   主营业务收入',  amount: operatingRevenue, indent: 1 },
        { lineNo: 3,  label: '二、营业成本',     amount: operatingCost, type: 'subtotal' },
        { lineNo: 4,  label: '   主营业务成本',  amount: operatingCost, indent: 1 },
        { lineNo: 5,  label: '三、税金及附加',   amount: taxAmt },
        { lineNo: 6,  label: '四、销售费用',     amount: sellingExpAmt },
        { lineNo: 7,  label: '五、管理费用',     amount: mgmtExpAmt },
        { lineNo: 8,  label: '六、财务费用',     amount: financeExpAmt },
        { lineNo: 9,  label: '七、营业利润',     amount: operatingProfit, type: 'total' },
        { lineNo: 10, label: '   +其他业务收入', amount: otherIncome, indent: 1 },
        { lineNo: 11, label: '   +营业外收入',   amount: nonOpIncome, indent: 1 },
        { lineNo: 12, label: '八、利润总额',     amount: totalProfit, type: 'total' },
        { lineNo: 13, label: '九、所得税费用',   amount: 0, note: '小微企业核定征收, 此处不计' },
        { lineNo: 14, label: '十、净利润',       amount: netProfit, type: 'grand' },
      ],
      summary: {
        operatingRevenue, operatingCost,
        sellingExp: sellingExpAmt, mgmtExp: mgmtExpAmt, financeExp: financeExpAmt,
        tax: taxAmt, otherIncome, nonOpIncome,
        operatingProfit, totalProfit, netProfit,
      },
    }
  })

  // ──────────────────────────────────────────────────────
  // 资产负债表 (报税口径) GET /api/finance/reports/tax/balance-sheet?asOf=YYYY-MM-DD
  // 余额 = 累计借方 - 累计贷方 (按科目类别决定正负)
  // ──────────────────────────────────────────────────────
  app.get('/tax/balance-sheet', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const { asOf } = req.query as any
    const end = endOfDayUtcForDateCol(asOf || dayjs().format('YYYY-MM-DD'))

    // 资产类: 借方余额 (1xxx)
    // 负债类: 贷方余额 (2xxx)
    // 所有者权益: 贷方余额 (3xxx / 4xxx — 兼容两套准则)
    // 累计自开账以来的所有 POSTED 凭证
    const asAssetMulti = async (prefixes: string[]) => {
      const r = await aggregateByPrefix({ tenantId, prefixes, end, statuses: ['POSTED'] })
      return r.totalDebit - r.totalCredit
    }
    const asLiabEquityMulti = async (prefixes: string[]) => {
      const r = await aggregateByPrefix({ tenantId, prefixes, end, statuses: ['POSTED'] })
      return r.totalCredit - r.totalDebit
    }

    // ── 资产 ──
    const cash       = await asAssetMulti(BS_PREFIXES.cash)
    const bank       = await asAssetMulti(BS_PREFIXES.bank)
    const otherCash  = await asAssetMulti(BS_PREFIXES.otherCash)   // 美团/抖音/支付宝/微信余额
    const ar         = await asAssetMulti(BS_PREFIXES.ar)
    const otherAr    = await asAssetMulti(BS_PREFIXES.otherAr)
    const inventory  = await asAssetMulti(BS_PREFIXES.inventory)
    const prepaid    = await asAssetMulti(BS_PREFIXES.prepaid)
    const fixedAsset = await asAssetMulti(BS_PREFIXES.fixedAsset)
    const accumDep   = await asAssetMulti(BS_PREFIXES.accumDep)    // 累计折旧, 借方贷余, 此值 <=0
    const longExp    = await asAssetMulti(BS_PREFIXES.longExp)
    const currentAsset = cash + bank + otherCash + ar + otherAr + inventory + prepaid
    const longTermAsset = fixedAsset + accumDep + longExp
    const totalAsset = currentAsset + longTermAsset

    // ── 负债 ──
    const shortLoan  = await asLiabEquityMulti(BS_PREFIXES.shortLoan)
    const ap         = await asLiabEquityMulti(BS_PREFIXES.ap)
    const otherAp    = await asLiabEquityMulti(BS_PREFIXES.otherAp)
    const payroll    = await asLiabEquityMulti(BS_PREFIXES.payroll)
    const taxPayable = await asLiabEquityMulti(BS_PREFIXES.taxPayable)
    const advance    = await asLiabEquityMulti(BS_PREFIXES.advance)
    const currentLiab = shortLoan + ap + otherAp + payroll + taxPayable + advance
    const totalLiab = currentLiab

    // ── 所有者权益 (3xxx 优先, 4xxx 兜底) ──
    const paidInCapital    = await asLiabEquityMulti(BS_PREFIXES.paidInCapital)
    const capitalReserve   = await asLiabEquityMulti(BS_PREFIXES.capitalReserve)
    const surplusReserve   = await asLiabEquityMulti(BS_PREFIXES.surplusReserve)
    const profitThisYear   = await asLiabEquityMulti(BS_PREFIXES.profitYTD)
    const retainedEarnings = await asLiabEquityMulti(BS_PREFIXES.retainedEarnings)
    const totalEquity = paidInCapital + capitalReserve + surplusReserve + profitThisYear + retainedEarnings

    const balanced = Math.abs(totalAsset - (totalLiab + totalEquity)) < 0.01

    return {
      asOf: end.toISOString(),
      currency: 'CNY',
      asset: {
        cash, bank, otherCash, ar, otherAr, inventory, prepaid,
        currentAsset,
        fixedAsset, accumDep, longExp,
        longTermAsset,
        total: totalAsset,
      },
      liability: {
        shortLoan, ap, otherAp, payroll, taxPayable, advance,
        currentLiab,
        total: totalLiab,
      },
      equity: {
        paidInCapital, capitalReserve, surplusReserve, profitThisYear, retainedEarnings,
        total: totalEquity,
      },
      balanced,
      diff: totalAsset - (totalLiab + totalEquity),
    }
  })
}
