import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const inventoryRoutes: FastifyPluginAsync = async (app) => {

  // 库存列表（含保质期预警）
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, storeId } = req.user
    const today = new Date()
    const warningDate = dayjs().add(7, 'day').toDate()
    const monthStart = dayjs().startOf('month').toDate()

    const products = await prisma.product.findMany({
      where: { tenantId, status: 'ENABLED' },
      orderBy: { name: 'asc' },
    })

    // 本月入库量（按商品）
    const monthReceipts = await prisma.receiptItem.findMany({
      where: {
        receipt: { tenantId, createdAt: { gte: monthStart }, ...(storeId ? { storeId } : {}) },
      },
      select: { productId: true, quantity: true },
    })

    // 本月消耗量（按商品）
    const monthConsumptions = await prisma.stockConsumption.findMany({
      where: { tenantId, date: { gte: monthStart }, ...(storeId ? { storeId } : {}) },
      select: { productId: true, quantity: true },
    })

    return products.map(p => {
      const receipts = monthReceipts.filter(r => r.productId === p.id)
      const consumptions = monthConsumptions.filter(c => c.productId === p.id)
      const monthIn = receipts.reduce((s, r) => s + Number(r.quantity), 0)
      const monthOut = consumptions.reduce((s, c) => s + Number(c.quantity), 0)

      // 最近到期日
      const expiryDates = receipts
        .filter((r: any) => (r as any).expiryDate)
        .map((r: any) => (r as any).expiryDate as Date)
        .sort((a, b) => a.getTime() - b.getTime())
      const nearestExpiry = expiryDates[0] || null

      const isLowStock = Number(p.stock) < Number(p.minStock)
      const isExpiringSoon = nearestExpiry && nearestExpiry <= warningDate
      const isExpired = nearestExpiry && nearestExpiry < today

      return {
        ...p,
        monthIn,
        monthOut,
        nearestExpiry,
        isLowStock,
        isExpiringSoon,
        isExpired,
        daysToExpiry: nearestExpiry ? dayjs(nearestExpiry).diff(dayjs(), 'day') : null,
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
