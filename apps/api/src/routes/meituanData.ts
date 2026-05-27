import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import dayjs from 'dayjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const allowedRoles = ['SUPER_ADMIN', 'ADMIN', 'BOSS', 'MANAGER', 'FINANCE']
const requireView = (req: any, reply: any) => {
  if (!allowedRoles.includes(req.user?.role)) {
    return reply.status(403).send({ error: '无权查看美团数据' })
  }
}

export const meituanDataRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/meituan/stats/today ──
  app.get('/stats/today', auth(app), async (req: any, reply) => {
    const denied = requireView(req, reply); if (denied) return denied
    const today = dayjs().startOf('day').toDate()

    const agg = await prisma.mtOrder.aggregate({
      where: { businessTime: today, status: { in: [300, 600] } },
      _count: { _all: true },
      _sum: { payed: true, discount: true },
    })
    const refundAgg = await prisma.mtOrder.aggregate({
      where: { businessTime: today, isPartRefund: true },
      _sum: { receivable: true, payed: true },
    })
    const orderCount = agg._count._all
    const gmvCents = agg._sum.payed ?? 0
    return {
      date: dayjs(today).format('YYYY-MM-DD'),
      orderCount,
      gmv: gmvCents / 100,
      avgPrice: orderCount ? Number((gmvCents / orderCount / 100).toFixed(2)) : 0,
      refundAmount: ((refundAgg._sum.receivable ?? 0) - (refundAgg._sum.payed ?? 0)) / 100,
    }
  })

  // ── GET /api/meituan/stats/payment-breakdown ──
  app.get('/stats/payment-breakdown', auth(app), async (req: any, reply) => {
    const denied = requireView(req, reply); if (denied) return denied
    const q = z.object({ date: z.string().optional() }).parse(req.query)
    const day = dayjs(q.date || undefined).startOf('day').toDate()

    const rows: { payTypeName: string; totalAmount: bigint; orderCount: bigint }[] = await prisma.$queryRaw`
      SELECT p.pay_type_name as "payTypeName",
             SUM(p.payed)::bigint as "totalAmount",
             COUNT(DISTINCT p.mt_order_id)::bigint as "orderCount"
      FROM mt_order_payments p
      JOIN mt_orders o ON o.mt_order_id = p.mt_order_id
      WHERE o.business_time = ${day}
      GROUP BY p.pay_type_name
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
    const denied = requireView(req, reply); if (denied) return denied
    const q = z.object({ date: z.string().optional() }).parse(req.query)
    const day = dayjs(q.date || undefined).startOf('day').toDate()

    const rows = await prisma.mtOrder.groupBy({
      by: ['channel'],
      where: { businessTime: day },
      _count: { _all: true },
      _sum: { payed: true },
    })
    const total = rows.reduce((s, r) => s + (r._sum.payed ?? 0), 0)
    return rows.map(r => ({
      channel: r.channel,
      orderCount: r._count._all,
      gmv: (r._sum.payed ?? 0) / 100,
      percentage: total ? Number(((r._sum.payed ?? 0) / total).toFixed(4)) : 0,
    }))
  })

  // ── GET /api/meituan/stats/trend?days=7 ──
  app.get('/stats/trend', auth(app), async (req: any, reply) => {
    const denied = requireView(req, reply); if (denied) return denied
    const q = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) }).parse(req.query)
    const since = dayjs().subtract(q.days - 1, 'day').startOf('day').toDate()

    const rows: { date: Date; gmv: bigint; orderCount: bigint }[] = await prisma.$queryRaw`
      SELECT business_time as "date",
             SUM(payed)::bigint as "gmv",
             COUNT(*)::bigint as "orderCount"
      FROM mt_orders
      WHERE business_time >= ${since}
      GROUP BY business_time
      ORDER BY business_time ASC
    `
    return rows.map(r => ({
      date: dayjs(r.date).format('YYYY-MM-DD'),
      gmv: Number(r.gmv) / 100,
      orderCount: Number(r.orderCount),
    }))
  })

  // ── GET /api/meituan/orders ──
  app.get('/orders', auth(app), async (req: any, reply) => {
    const denied = requireView(req, reply); if (denied) return denied
    const q = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      status: z.coerce.number().int().optional(),
      channel: z.string().optional(),
      pageNo: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query)

    const where: any = {}
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
    const denied = requireView(req, reply); if (denied) return denied
    const order = await prisma.mtOrder.findUnique({
      where: { mtOrderId: req.params.mtOrderId },
      include: {
        items: { orderBy: { serialNo: 'asc' } },
        payments: true,
        refundOrders: { orderBy: { refundTime: 'desc' } },
      },
    })
    if (!order) return reply.status(404).send({ error: 'order not found' })
    return order
  })

}
