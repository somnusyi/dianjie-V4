/**
 * 门店食材消耗视图 (只读聚合)
 *
 *   GET /api/stores/:storeId/consumption/daily?date=YYYY-MM-DD
 *   GET /api/stores/:storeId/consumption/daily/:productId?date=YYYY-MM-DD
 *   GET /api/stores/:storeId/consumption/summary?month=YYYY-MM
 *
 * 权限: 同库存查看角色; 门店级角色 (MANAGER/CHEF/KITCHEN_LEAD) 仅限本店。
 * 口径: 消耗仅含已发布 BOM 的菜品扣减与门店报损; 日报未确认的日期无数据。
 */
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { isStoreScoped } from '../lib/auth-scope'
import { hasInternalSupplyChainCapability } from '../lib/internal-supply-chain-access'
import { monthRangeForDateCol } from '../lib/dateRange'
import {
  aggregateByProduct, dailyQtyByProduct, groupDetailRows, summarizeMonth, trailingAvgQty,
} from '../services/storeConsumption'
import { VoidConsumptionError, voidConsumptionWithCorrection } from '../services/consumptionCorrection'

const CONSUMPTION_VIEW_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])
// 冲销/补记是修正性写操作, 仅集团厨房/管理员角色可用
const CONSUMPTION_VOID_ROLES = new Set(['CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])

function canViewConsumption(role: string | undefined | null) {
  return Boolean(role && (
    CONSUMPTION_VIEW_ROLES.has(role)
    || hasInternalSupplyChainCapability(role, 'consumption.read')
  ))
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

function strictDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error('日期无效'), { statusCode: 400 })
  }
  return parsed
}

const num = (d: Prisma.Decimal, dp = 6) => Number(d.toFixed(dp))
const money = (d: Prisma.Decimal) => Number(d.toFixed(2))

export const consumptionRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  // 权限 + 门店归属校验; 失败时已写响应并返回 null
  async function resolveStore(req: any, reply: any): Promise<string | null> {
    const { tenantId, role, storeId: userStoreId } = req.user
    if (!canViewConsumption(role)) {
      await reply.status(403).send({ error: '无权查看门店消耗' })
      return null
    }
    const { storeId } = req.params
    if (isStoreScoped(role) && userStoreId !== storeId) {
      await reply.status(403).send({ error: '无权查看该门店' })
      return null
    }
    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId }, select: { id: true } })
    if (!store) {
      await reply.status(404).send({ error: '门店不存在或不属于当前租户' })
      return null
    }
    return storeId
  }

  const rowSelect = {
    productId: true, dishId: true, sourceType: true, date: true,
    quantity: true, inventoryQuantity: true, costAmountSnapshot: true,
  } as const

  // 当日按食材聚合 + 前 7 个有数据自然日均值环比
  app.get('/:storeId/consumption/daily', auth, async (req: any, reply: any) => {
    const storeId = await resolveStore(req, reply)
    if (!storeId) return
    const { tenantId } = req.user
    const dateText = String(req.query?.date || '')
    if (!DATE_RE.test(dateText)) return reply.status(400).send({ error: '日期格式应为 YYYY-MM-DD' })
    let date: Date
    try {
      date = strictDate(dateText)
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message })
    }

    const [dayRows, historyRows] = await Promise.all([
      prisma.stockConsumption.findMany({
        where: { tenantId, storeId, date, voidedAt: null },
        select: rowSelect,
      }),
      // 回看 30 天窗口足够覆盖"前 7 个有数据自然日"的常见断档 (日报未确认期间)
      prisma.stockConsumption.findMany({
        where: { tenantId, storeId, date: { gte: dayjs(date).subtract(30, 'day').toDate(), lt: date }, voidedAt: null },
        select: rowSelect,
      }),
    ])

    const aggregates = aggregateByProduct(dayRows)
    const historyByProduct = dailyQtyByProduct(historyRows)
    const productIds = [...aggregates.keys()]
    const products = productIds.length > 0
      ? await prisma.product.findMany({
          where: { tenantId, id: { in: productIds } },
          select: { id: true, code: true, name: true, spec: true, unit: true, inventoryUnit: true },
        })
      : []
    const productById = new Map(products.map(p => [p.id, p]))

    let totalCost = new Prisma.Decimal(0)
    const items = [...aggregates.values()].map(agg => {
      totalCost = totalCost.plus(agg.cost)
      const product = productById.get(agg.productId)
      const avg = trailingAvgQty(historyByProduct.get(agg.productId), dateText)
      const changePct = avg && avg.gt(0) ? Number(agg.qty.minus(avg).div(avg).mul(100).toFixed(1)) : null
      return {
        productId: agg.productId,
        code: product?.code ?? '',
        name: product?.name ?? '未知食材',
        spec: product?.spec ?? null,
        unit: product?.inventoryUnit || product?.unit || '',
        qty: num(agg.qty),
        cost: money(agg.cost),
        dishCount: agg.dishCount,
        prev7AvgQty: avg ? num(avg) : null,
        changePct,
      }
    }).sort((a, b) => b.cost - a.cost)

    return { date: dateText, totalCost: money(totalCost), items }
  })

  // 单食材当日明细: 按菜品聚合, 人工报损单独标注
  app.get('/:storeId/consumption/daily/:productId', auth, async (req: any, reply: any) => {
    const storeId = await resolveStore(req, reply)
    if (!storeId) return
    const { tenantId } = req.user
    const { productId } = req.params
    const dateText = String(req.query?.date || '')
    if (!DATE_RE.test(dateText)) return reply.status(400).send({ error: '日期格式应为 YYYY-MM-DD' })
    let date: Date
    try {
      date = strictDate(dateText)
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message })
    }

    const product = await prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true, code: true, name: true, spec: true, unit: true, inventoryUnit: true },
    })
    if (!product) return reply.status(404).send({ error: '食材不存在或不属于当前租户' })

    const rows = await prisma.stockConsumption.findMany({
      where: { tenantId, storeId, productId, date, voidedAt: null },
      select: rowSelect,
    })
    const groups = groupDetailRows(rows)
    const dishIds = groups.map(g => g.dishId).filter((id): id is string => Boolean(id))
    const dishes = dishIds.length > 0
      ? await prisma.dish.findMany({ where: { tenantId, id: { in: dishIds } }, select: { id: true, name: true } })
      : []
    const dishNameById = new Map(dishes.map(d => [d.id, d.name]))

    const detail = groups.map(group => ({
      key: group.key,
      dishId: group.dishId,
      dishName: group.dishId ? dishNameById.get(group.dishId) ?? '已删除菜品' : null,
      manual: group.manual,
      qty: num(group.qty),
      cost: money(group.cost),
    })).sort((a, b) => b.cost - a.cost)

    return {
      date: dateText,
      product: {
        id: product.id, code: product.code, name: product.name, spec: product.spec,
        unit: product.inventoryUnit || product.unit,
      },
      rows: detail,
    }
  })

  // 月度合计: 总金额 / 有数据天数 / Top5 食材
  app.get('/:storeId/consumption/summary', auth, async (req: any, reply: any) => {
    const storeId = await resolveStore(req, reply)
    if (!storeId) return
    const { tenantId } = req.user
    const month = String(req.query?.month || '')
    if (!MONTH_RE.test(month)) return reply.status(400).send({ error: '月份格式应为 YYYY-MM' })
    const { start, end } = monthRangeForDateCol(month)

    const rows = await prisma.stockConsumption.findMany({
      where: { tenantId, storeId, date: { gte: start, lte: end }, voidedAt: null },
      select: rowSelect,
    })
    const summary = summarizeMonth(rows)

    const topEntries = [...summary.byProduct.entries()]
      .sort((a, b) => b[1].cost.comparedTo(a[1].cost))
      .slice(0, 5)
    const products = topEntries.length > 0
      ? await prisma.product.findMany({
          where: { tenantId, id: { in: topEntries.map(([id]) => id) } },
          select: { id: true, code: true, name: true, unit: true, inventoryUnit: true },
        })
      : []
    const productById = new Map(products.map(p => [p.id, p]))

    return {
      month,
      totalCost: money(summary.totalCost),
      daysWithData: summary.daysWithData,
      top: topEntries.map(([productId, agg]) => {
        const product = productById.get(productId)
        return {
          productId,
          code: product?.code ?? '',
          name: product?.name ?? '未知食材',
          unit: product?.inventoryUnit || product?.unit || '',
          qty: num(agg.qty),
          cost: money(agg.cost),
        }
      }),
    }
  })
}

/**
 * 消耗修正与日线序列 (挂在 /api/consumption 前缀下)
 *
 *   POST /api/consumption/:id/void           冲销 (+可选补记), CHEF_DIRECTOR/ADMIN/SUPER_ADMIN
 *   GET  /api/consumption/daily-series       食材消耗 × 营业额 日线, 权限同消耗查看
 */
export const consumptionAdminRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  // 冲销一行消耗; 传修正值时同事务插入补记行。重复冲销返回 409 (幂等报错)。
  app.post('/:id/void', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!CONSUMPTION_VOID_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权冲销消耗记录' })
    }
    const body = (req.body || {}) as Record<string, unknown>
    const reason = String(body.reason || '').trim()
    if (!reason) return reply.status(400).send({ error: '请填写作废原因' })
    const numericField = (key: string): number | null | undefined => {
      const value = body[key]
      if (value === undefined || value === null) return null
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed < 0) return undefined
      return parsed
    }
    const correctedQuantity = numericField('correctedQuantity')
    const correctedInventoryQuantity = numericField('correctedInventoryQuantity')
    const correctedCostAmount = numericField('correctedCostAmount')
    if (correctedQuantity === undefined || correctedInventoryQuantity === undefined || correctedCostAmount === undefined) {
      return reply.status(400).send({ error: '修正值必须是不小于 0 的数字' })
    }

    try {
      const result = await prisma.$transaction(async tx => {
        const voided = await voidConsumptionWithCorrection(tx, {
          consumptionId: String(req.params.id),
          tenantId,
          reason,
          voidedById: userId,
          correctedQuantity,
          correctedInventoryQuantity,
          correctedCostAmount,
        })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: `冲销消耗记录${voided.correctionId ? '并补记修正行' : ''}`,
            entityType: 'StockConsumption',
            targetId: voided.voidedId,
            metadata: { reason, correctionId: voided.correctionId },
          },
        })
        return voided
      })
      return { success: true, ...result }
    } catch (error) {
      if (error instanceof VoidConsumptionError) {
        return reply.status(error.statusCode).send({ error: error.message })
      }
      throw error
    }
  })

  // 食材消耗 × 营业额 日线 (店长营业页共振折线图)
  // consumptionCost: 当日 stock_consumptions (排除作废) costAmountSnapshot 合计
  // revenue: 当日 RevenueRecord.amount; costRate = consumptionCost/revenue×100 (revenue=0 时 null)
  app.get('/daily-series', auth, async (req: any, reply: any) => {
    const { tenantId, role, storeId: userStoreId } = req.user
    if (!canViewConsumption(role)) {
      return reply.status(403).send({ error: '无权查看门店消耗' })
    }
    const storeId = String(req.query?.storeId || '')
    if (!storeId) return reply.status(400).send({ error: '请指定门店' })
    if (isStoreScoped(role) && userStoreId !== storeId) {
      return reply.status(403).send({ error: '无权查看该门店' })
    }
    const month = String(req.query?.month || '')
    if (!MONTH_RE.test(month)) return reply.status(400).send({ error: '月份格式应为 YYYY-MM' })
    const store = await prisma.store.findFirst({ where: { id: storeId, tenantId }, select: { id: true } })
    if (!store) return reply.status(404).send({ error: '门店不存在或不属于当前租户' })

    const { start, end } = monthRangeForDateCol(month)
    const [consumptionRows, revenueRows] = await Promise.all([
      prisma.stockConsumption.findMany({
        where: { tenantId, storeId, date: { gte: start, lte: end }, voidedAt: null },
        select: { date: true, costAmountSnapshot: true },
      }),
      prisma.revenueRecord.findMany({
        where: { storeId, date: { gte: start, lte: end } },
        select: { date: true, amount: true },
      }),
    ])

    const costByDate = new Map<string, Prisma.Decimal>()
    for (const row of consumptionRows) {
      const key = row.date.toISOString().slice(0, 10)
      costByDate.set(key, (costByDate.get(key) ?? new Prisma.Decimal(0)).plus(row.costAmountSnapshot ?? 0))
    }
    const revenueByDate = new Map<string, Prisma.Decimal>()
    for (const row of revenueRows) {
      const key = row.date.toISOString().slice(0, 10)
      revenueByDate.set(key, (revenueByDate.get(key) ?? new Prisma.Decimal(0)).plus(row.amount))
    }

    const daysInMonth = end.getUTCDate()
    const series = []
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${month}-${String(day).padStart(2, '0')}`
      const consumptionCost = Number((costByDate.get(key) ?? new Prisma.Decimal(0)).toFixed(2))
      const revenue = Number((revenueByDate.get(key) ?? new Prisma.Decimal(0)).toFixed(2))
      series.push({
        date: key,
        consumptionCost,
        revenue,
        costRate: revenue > 0 ? Number((consumptionCost / revenue * 100).toFixed(2)) : null,
      })
    }
    return { storeId, month, series }
  })
}
