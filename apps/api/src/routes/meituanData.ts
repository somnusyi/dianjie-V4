import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@dianjie/db'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { businessDateKey } from '../lib/businessTime'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

// 美团数据按租户门店隔离：门店角色（MANAGER）只看本店；
// 集团角色看租户内全部已映射门店；storeId 为 null 的未映射历史订单仅超管可见。
// MtOrder 模型没有 tenantId 列，租户边界经由 storeId → Store.tenantId 收敛。
const STORE_SCOPED_ROLES = ['MANAGER']
const TENANT_ROLES = ['SUPER_ADMIN', 'ADMIN', 'BOSS', 'FINANCE']
const UNMAPPED_ROLES = ['SUPER_ADMIN', 'ADMIN']
const allowedRoles = [...STORE_SCOPED_ROLES, ...TENANT_ROLES]

type MeituanScope = {
  storeIds: string[]
  includeUnmapped: boolean
}

async function resolveMeituanScope(req: any, reply: any): Promise<MeituanScope | null> {
  const role = req.user?.role
  if (!allowedRoles.includes(role)) {
    reply.status(403).send({ error: '无权查看美团数据' })
    return null
  }
  const tenantStores = await prisma.store.findMany({
    where: { tenantId: req.user.tenantId },
    select: { id: true },
  })
  const tenantStoreIds = tenantStores.map(s => s.id)
  if (STORE_SCOPED_ROLES.includes(role)) {
    const storeId = req.user.storeId
    // fail-closed：门店角色未绑定门店、或绑定门店不在本租户时，看不到任何订单
    return {
      storeIds: storeId && tenantStoreIds.includes(storeId) ? [storeId] : [],
      includeUnmapped: false,
    }
  }
  return { storeIds: tenantStoreIds, includeUnmapped: UNMAPPED_ROLES.includes(role) }
}

/** Prisma where 片段：限定门店集合；空数组匹配不到任何行（fail-closed）。 */
function storeWhere(scope: MeituanScope) {
  if (scope.includeUnmapped) {
    return { OR: [{ storeId: { in: scope.storeIds } }, { storeId: null }] }
  }
  return { storeId: { in: scope.storeIds } }
}

/** raw SQL 片段：限定门店集合（表别名 o）。 */
function storeSql(scope: MeituanScope): Prisma.Sql {
  return scope.includeUnmapped
    ? Prisma.sql`AND (o."storeId" = ANY(${scope.storeIds}::text[]) OR o."storeId" IS NULL)`
    : Prisma.sql`AND o."storeId" = ANY(${scope.storeIds}::text[])`
}

function orderInScope(order: { storeId: string | null }, scope: MeituanScope): boolean {
  if (order.storeId == null) return scope.includeUnmapped
  return scope.storeIds.includes(order.storeId)
}

export const meituanDataRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/meituan/stats/today ──
  app.get('/stats/today', auth(app), async (req: any, reply) => {
    const scope = await resolveMeituanScope(req, reply); if (!scope) return reply
    // businessTime 是 @db.Date；用业务时区当天（上海）构造 UTC 0 点 Date，避免 DATE 列跨日
    const today = new Date(`${businessDateKey()}T00:00:00.000Z`)

    const agg = await prisma.mtOrder.aggregate({
      where: { businessTime: today, status: 300, ...storeWhere(scope) },
      _count: { _all: true },
      _sum: { payed: true, discount: true },
    })
    const refundAgg = await prisma.mtOrder.aggregate({
      where: { businessTime: today, isPartRefund: true, ...storeWhere(scope) },
      _sum: { receivable: true, payed: true },
    })
    const orderCount = agg._count._all
    const gmvCents = agg._sum.payed ?? 0
    return {
      date: businessDateKey(),
      orderCount,
      gmv: gmvCents / 100,
      avgPrice: orderCount ? Number((gmvCents / orderCount / 100).toFixed(2)) : 0,
      refundAmount: ((refundAgg._sum.receivable ?? 0) - (refundAgg._sum.payed ?? 0)) / 100,
    }
  })

  // ── GET /api/meituan/stats/payment-breakdown ──
  app.get('/stats/payment-breakdown', auth(app), async (req: any, reply) => {
    const scope = await resolveMeituanScope(req, reply); if (!scope) return reply
    const q = z.object({ date: z.string().optional() }).parse(req.query)
    // businessTime 是 @db.Date (date-only); 用日期字符串 (YYYY-MM-DD) 让 PG 直接按 DATE 比较, 避开 JS Date → TIMESTAMP 的隐式转换坑
    const dayStr = q.date || businessDateKey()

    const rows: { payTypeName: string; totalAmount: bigint; orderCount: bigint }[] = await prisma.$queryRaw`
      SELECT p."payTypeName" as "payTypeName",
             SUM(p.payed)::bigint as "totalAmount",
             COUNT(DISTINCT p."mtOrderId")::bigint as "orderCount"
      FROM mt_order_payments p
      JOIN mt_orders o ON o."mtOrderId" = p."mtOrderId"
      WHERE o."businessTime" = ${dayStr}::date
      ${storeSql(scope)}
      GROUP BY p."payTypeName"
      ORDER BY "totalAmount" DESC
    `
    const total = rows.reduce((s, r) => s + Number(r.totalAmount), 0)
    return rows.map(r => ({
      payTypeName: r.payTypeName,
      totalAmount: Number(r.totalAmount) / 100,
      orderCount: Number(r.orderCount),
      percentage: total ? Number((Number(r.totalAmount) / total).toFixed(4)) : 0,
    }))
  })

  // ── GET /api/meituan/stats/business-type-breakdown ──
  app.get('/stats/business-type-breakdown', auth(app), async (req: any, reply) => {
    const scope = await resolveMeituanScope(req, reply); if (!scope) return reply
    const q = z.object({ date: z.string().optional() }).parse(req.query)
    const dayStr = q.date || businessDateKey()
    const day = new Date(`${dayStr}T00:00:00.000Z`)

    const rows = await prisma.mtOrder.groupBy({
      by: ['channel'],
      where: { businessTime: day, ...storeWhere(scope) },
      _count: { _all: true },
      _sum: { payed: true },
    })
    const total = rows.reduce((s, r) => s + Number(r._sum.payed ?? 0), 0)
    return rows.map(r => ({
      channel: r.channel,
      orderCount: r._count._all,
      gmv: Number(r._sum.payed ?? 0) / 100,
      percentage: total ? Number((Number(r._sum.payed ?? 0) / total).toFixed(4)) : 0,
    }))
  })

  // ── GET /api/meituan/stats/trend?days=7 ──
  app.get('/stats/trend', auth(app), async (req: any, reply) => {
    const scope = await resolveMeituanScope(req, reply); if (!scope) return reply
    const q = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) }).parse(req.query)
    // 按业务时区取"今天"，再回退 N-1 天，保证窗口覆盖上海自然日
    const sinceStr = new Date(`${businessDateKey()}T00:00:00.000Z`)
    sinceStr.setUTCDate(sinceStr.getUTCDate() - (q.days - 1))

    const rows: { date: Date; gmv: bigint; orderCount: bigint }[] = await prisma.$queryRaw`
      SELECT "businessTime" as "date",
             SUM(payed)::bigint as "gmv",
             COUNT(*)::bigint as "orderCount"
      FROM mt_orders o
      WHERE o."businessTime" >= ${sinceStr}
      ${storeSql(scope)}
      GROUP BY "businessTime"
      ORDER BY "businessTime" ASC
    `
    return rows.map(r => ({
      date: businessDateKey(r.date),
      gmv: Number(r.gmv) / 100,
      orderCount: Number(r.orderCount),
    }))
  })

  // ── GET /api/meituan/orders ──
  app.get('/orders', auth(app), async (req: any, reply) => {
    const scope = await resolveMeituanScope(req, reply); if (!scope) return reply
    const q = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      status: z.coerce.number().int().optional(),
      channel: z.string().optional(),
      pageNo: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query)

    const where: any = storeWhere(scope)
    if (q.from) where.businessTime = { ...(where.businessTime || {}), gte: new Date(q.from) }
    if (q.to) where.businessTime = { ...(where.businessTime || {}), lte: new Date(q.to) }
    if (q.status) where.status = q.status
    if (q.channel) where.channel = q.channel

    const [items, total] = await Promise.all([
      prisma.mtOrder.findMany({
        where,
        orderBy: { checkoutTime: 'desc' },
        skip: (q.pageNo - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          mtOrderId: true, orderNo: true, channel: true,
          businessTime: true, checkoutTime: true,
          status: true, statusName: true,
          payed: true, receivable: true, discount: true,
          customerCount: true, tableComment: true, cashierName: true,
          isPartRefund: true,
        },
      }),
      prisma.mtOrder.count({ where }),
    ])

    return {
      items: items.map(o => ({
        ...o,
        payed: o.payed / 100,
        receivable: o.receivable / 100,
        discount: o.discount / 100,
      })),
      total, pageNo: q.pageNo, pageSize: q.pageSize,
    }
  })

  // ── GET /api/meituan/orders/:mtOrderId ──
  app.get('/orders/:mtOrderId', auth(app), async (req: any, reply) => {
    const scope = await resolveMeituanScope(req, reply); if (!scope) return reply
    const order = await prisma.mtOrder.findUnique({
      where: { mtOrderId: req.params.mtOrderId },
      include: {
        items: { orderBy: { serialNo: 'asc' } },
        payments: true,
        refundOrders: { orderBy: { refundTime: 'desc' } },
      },
    })
    // 详情按归属校验（防 IDOR）：不在 scope 内一律 404，不泄露存在性
    if (!order || !orderInScope(order, scope)) return reply.status(404).send({ error: 'order not found' })
    return order
  })

}
