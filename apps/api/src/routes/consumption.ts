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
import { monthRangeForDateCol } from '../lib/dateRange'
import {
  aggregateByProduct, dailyQtyByProduct, groupDetailRows, summarizeMonth, trailingAvgQty,
} from '../services/storeConsumption'

const CONSUMPTION_VIEW_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])

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
    if (!CONSUMPTION_VIEW_ROLES.has(role)) {
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
        where: { tenantId, storeId, date },
        select: rowSelect,
      }),
      // 回看 30 天窗口足够覆盖"前 7 个有数据自然日"的常见断档 (日报未确认期间)
      prisma.stockConsumption.findMany({
        where: { tenantId, storeId, date: { gte: dayjs(date).subtract(30, 'day').toDate(), lt: date } },
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
      where: { tenantId, storeId, productId, date },
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
      where: { tenantId, storeId, date: { gte: start, lte: end } },
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
