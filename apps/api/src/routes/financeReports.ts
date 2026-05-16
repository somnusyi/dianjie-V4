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

const FINANCE_ROLES = ['FINANCE', 'ADMIN', 'SUPER_ADMIN']
const auth = (app: any) => ({ preHandler: [app.authenticate] })

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
    const monthStart = dayjs(ym + '-01').startOf('month').toDate()
    const monthEnd   = dayjs(ym + '-01').endOf('month').toDate()
    // 同比 (上年同月)
    const lyStart = dayjs(monthStart).subtract(1, 'year').toDate()
    const lyEnd   = dayjs(monthEnd).subtract(1, 'year').toDate()
    // 环比 (上月)
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
        createdAt: { gte: monthStart, lte: monthEnd },
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
}
