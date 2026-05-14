/**
 * 财务月度对账 API
 *
 * GET /api/finance/reconcile?month=2026-05&view=store|supplier
 *
 * - view=store: 每店本月: 营收 / 食材成本(receipt total) / 报损 / 净利
 * - view=supplier: 每家供应商本月: 交付额 / 已付 / 未付 / 报损
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const ALLOW = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])

export const financeReconcileRoutes: FastifyPluginAsync = async (app) => {
  app.get('/reconcile', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ALLOW.has(role)) return reply.status(403).send({ error: '仅财务/老板可对账' })

    const monthStr = String((req.query as any).month || dayjs().format('YYYY-MM'))
    const view = String((req.query as any).view || 'store')
    const start = dayjs(monthStr + '-01').startOf('month').toDate()
    const end = dayjs(monthStr + '-01').endOf('month').toDate()

    if (view === 'store') {
      const stores = await prisma.store.findMany({
        where: { tenantId, status: 'ENABLED' },
        select: { id: true, no: true, name: true },
      })
      const result = await Promise.all(stores.map(async s => {
        const [revAgg, costAgg, lossAgg] = await Promise.all([
          prisma.revenueRecord.aggregate({
            _sum: { amount: true },
            where: { storeId: s.id, date: { gte: start, lte: end } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          prisma.receipt.aggregate({
            _sum: { totalAmount: true },
            where: { storeId: s.id, createdAt: { gte: start, lte: end } },
          }).catch(() => ({ _sum: { totalAmount: 0 } as any })),
          prisma.lossClaim.aggregate({
            _sum: { totalLossAmount: true },
            where: { storeId: s.id, createdAt: { gte: start, lte: end },
                     status: { in: ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'] } },
          }).catch(() => ({ _sum: { totalLossAmount: 0 } as any })),
        ])
        const revenue = Number(revAgg._sum.amount || 0)
        const foodCost = Number(costAgg._sum.totalAmount || 0)
        const loss = Number(lossAgg._sum.totalLossAmount || 0)
        return {
          storeId: s.id, no: s.no, name: s.name,
          revenue, foodCost, loss,
          net: revenue - foodCost - loss,
        }
      }))
      return reply.send(result.sort((a, b) => b.revenue - a.revenue))
    }

    if (view === 'supplier') {
      const suppliers = await prisma.supplier.findMany({
        where: { tenantId },
        select: { id: true, name: true },
      })
      const result = await Promise.all(suppliers.map(async s => {
        const [delAgg, paidAgg, unpaidAgg, lossAgg] = await Promise.all([
          // 本月交付 = receipt 总额 by supplier
          prisma.receipt.aggregate({
            _sum: { totalAmount: true },
            where: { supplierId: s.id, createdAt: { gte: start, lte: end } },
          }).catch(() => ({ _sum: { totalAmount: 0 } as any })),
          prisma.paymentSchedule.aggregate({
            _sum: { amount: true },
            where: { supplierId: s.id, status: 'PAID' as any, paidAt: { gte: start, lte: end } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          prisma.paymentSchedule.aggregate({
            _sum: { amount: true },
            where: { supplierId: s.id, status: { in: ['PENDING', 'NOTIFIED', 'APPROVED', 'OVERDUE', 'ON_HOLD'] as any },
                     dueAt: { gte: start, lte: end } },
          }).catch(() => ({ _sum: { amount: 0 } as any })),
          prisma.lossClaim.aggregate({
            _sum: { totalLossAmount: true },
            where: { supplierId: s.id, createdAt: { gte: start, lte: end },
                     status: { in: ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'] } },
          }).catch(() => ({ _sum: { totalLossAmount: 0 } as any })),
        ])
        return {
          supplierId: s.id, name: s.name,
          delivered: Number(delAgg._sum.totalAmount || 0),
          paid:      Number(paidAgg._sum.amount || 0),
          unpaid:    Number(unpaidAgg._sum.amount || 0),
          loss:      Number(lossAgg._sum.totalLossAmount || 0),
        }
      }))
      // 仅返回有交付或有应付的, 过滤静默供应商
      return reply.send(result.filter(r => r.delivered > 0 || r.unpaid > 0 || r.paid > 0).sort((a, b) => b.delivered - a.delivered))
    }

    return reply.status(400).send({ error: 'view 必须是 store 或 supplier' })
  })
}
