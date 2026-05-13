import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const inventoryRoutes: FastifyPluginAsync = async (app) => {

  // 门店库存列表 (P0 修复: 之前错误显示供应商 catalog stock, 改为门店实际入库 - 已消耗)
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, storeId } = req.user
    const today = new Date()
    const warningDate = dayjs().add(7, 'day').toDate()
    const monthStart = dayjs().startOf('month').toDate()

    if (!storeId) {
      // 集团角色 (BOSS / FINANCE / CHEF_DIRECTOR) 没有 storeId, 返回空 - 让他们用各店分页查
      return []
    }

    // 取本店历史所有 receipt items (累计入库)
    const allReceipts = await prisma.receiptItem.findMany({
      where: { receipt: { tenantId, storeId } },
      select: { productId: true, quantity: true, receipt: { select: { createdAt: true } } },
    })
    // 取本店历史所有 consumption (累计消耗)
    const allConsumptions = await prisma.stockConsumption.findMany({
      where: { tenantId, storeId },
      select: { productId: true, quantity: true, date: true },
    })
    // 本店历史所有报损 (StockConsumption 之外的损耗 - LossClaim isManual=true 也算消耗)
    const lossItems = await prisma.lossClaimItem.findMany({
      where: { lossClaim: { tenantId, storeId, status: { in: ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'] } } },
      select: { productId: true, lossQty: true },
    })

    // 累计 per productId
    const stockBy = new Map<string, { recv: number; consume: number; loss: number }>()
    for (const r of allReceipts) {
      const cur = stockBy.get(r.productId) || { recv: 0, consume: 0, loss: 0 }
      cur.recv += Number(r.quantity)
      stockBy.set(r.productId, cur)
    }
    for (const c of allConsumptions) {
      const cur = stockBy.get(c.productId) || { recv: 0, consume: 0, loss: 0 }
      cur.consume += Number(c.quantity)
      stockBy.set(c.productId, cur)
    }
    for (const l of lossItems) {
      const cur = stockBy.get(l.productId) || { recv: 0, consume: 0, loss: 0 }
      cur.loss += Number(l.lossQty)
      stockBy.set(l.productId, cur)
    }

    const productIds = Array.from(stockBy.keys())
    if (productIds.length === 0) return []

    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId },
      orderBy: { name: 'asc' },
    })

    // 本月入库 / 消耗 (UI 显示 month chip)
    const monthRecv = new Map<string, number>()
    const monthCons = new Map<string, number>()
    for (const r of allReceipts) {
      if (r.receipt.createdAt >= monthStart) {
        monthRecv.set(r.productId, (monthRecv.get(r.productId) || 0) + Number(r.quantity))
      }
    }
    for (const c of allConsumptions) {
      if (c.date >= monthStart) {
        monthCons.set(c.productId, (monthCons.get(c.productId) || 0) + Number(c.quantity))
      }
    }

    return products.map(p => {
      const s = stockBy.get(p.id)!
      const storeStock = Math.max(0, s.recv - s.consume - s.loss)   // 门店库存 = 累计入 - 累计消耗 - 报损
      const isLowStock = storeStock < Number(p.minStock)

      return {
        ...p,
        stock: storeStock,                                           // 覆盖 catalog stock, 改成门店真实库存
        monthIn: monthRecv.get(p.id) || 0,
        monthOut: monthCons.get(p.id) || 0,
        nearestExpiry: null,
        isLowStock,
        isExpiringSoon: false,
        isExpired: false,
        daysToExpiry: null,
      }
    })
  })

  // 录入消耗
  app.post('/consume', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    if (!['CHEF', 'MANAGER'].includes(role)) return reply.status(403).send({ error: '无权限' })

    const { items, date, note } = req.body as any
    if (!items?.length) return reply.status(400).send({ error: '请填写消耗明细' })

    const consumeDate = date ? new Date(date) : new Date()
    const targetStoreId = storeId

    const records = await Promise.all(
      items.map(async (item: any) => {
        const record = await prisma.stockConsumption.create({
          data: {
            tenantId,
            storeId: targetStoreId,
            productId: item.productId,
            quantity: item.quantity,
            date: consumeDate,
            note,
            createdById: userId,
          },
        })
        // 扣减库存
        await prisma.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        })
        return record
      })
    )

    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `录入消耗 ${items.length} 种食材`,
        entityType: 'StockConsumption',
        targetId: records[0].id,
      },
    })

    return { success: true, count: records.length }
  })

  // 消耗记录列表
  app.get('/consumptions', auth(app), async (req: any) => {
    const { tenantId, storeId } = req.user
    const { days = 30 } = req.query as any
    const since = dayjs().subtract(Number(days), 'day').toDate()

    return prisma.stockConsumption.findMany({
      where: {
        tenantId,
        date: { gte: since },
        ...(storeId ? { storeId } : {}),
      },
      include: {
        product: { select: { name: true, unit: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: { date: 'desc' },
      take: 100,
    })
  })
}
