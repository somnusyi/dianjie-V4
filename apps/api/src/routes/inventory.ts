import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { estimatedStoreInventory, latestStoreInventorySnapshot } from '../services/storeInventory'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const inventoryRoutes: FastifyPluginAsync = async (app) => {

  // 最新实物盘点快照：店长工作台与移动端库存明细共用
  app.get('/snapshot/latest', auth(app), async (req: any, reply) => {
    const { tenantId, storeId, role } = req.user
    if (!storeId) return reply.status(400).send({ error: '当前账号未绑定门店' })
    if (!['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权查看门店库存' })
    }
    return latestStoreInventorySnapshot(tenantId, storeId, true)
  })

  // 门店预计库存：最近实物盘点 + 后续实收入库 - BOM/人工消耗 - 店内报损。
  // Product.stock 属于供应商库存，绝不能在这里作为门店库存使用。
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, storeId } = req.user
    if (!storeId) return []
    const estimate = await estimatedStoreInventory(tenantId, storeId)
    return estimate.items
  })

  // 录入消耗
  app.post('/consume', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    if (!['CHEF', 'MANAGER'].includes(role)) return reply.status(403).send({ error: '无权限' })

    const { items, date, note } = req.body as any
    if (!items?.length) return reply.status(400).send({ error: '请填写消耗明细' })

    const consumeDate = date ? new Date(date) : new Date()
    const targetStoreId = storeId

    if (!targetStoreId) return reply.status(400).send({ error: '当前账号未绑定门店' })
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
        product: { select: { name: true, unit: true, spec: true, code: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: { date: 'desc' },
      take: 100,
    })
  })
}
