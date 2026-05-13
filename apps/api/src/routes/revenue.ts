import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { isStoreScoped } from '../lib/auth-scope'

export const revenueRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: [(app as any).authenticate] }

  // 获取营业额列表
  app.get('/', auth, async (req: any) => {
    const { month } = req.query as any
    const { tenantId, storeId, role } = req.user
    const where: any = { store: { tenantId } }
    if (isStoreScoped(role)) {
      if (!storeId) return []
      where.storeId = storeId
    }
    if (month) {
      const start = dayjs(month + '-01').startOf('month').toDate()
      const end = dayjs(month + '-01').endOf('month').toDate()
      where.date = { gte: start, lte: end }
    }
    try {
      return await prisma.revenueRecord.findMany({
        where,
        include: { store: { select: { id: true, name: true } } },
        orderBy: { date: 'desc' },
      })
    } catch { return [] }
  })

  // 录入营业额（支持渠道明细）
  // Round 7 QA：原本只要登录即可 POST revenue，chef/supplier 也能提交其他店
  // 的营业额。加角色白名单（MANAGER 对本店；ADMIN/FINANCE 可代录）
  const REVENUE_WRITE_ROLES = new Set(['MANAGER', 'ADMIN', 'FINANCE', 'SUPER_ADMIN'])

  app.post('/', auth, async (req: any, reply: any) => {
    const { tenantId, storeId: userStoreId, role } = req.user
    if (!REVENUE_WRITE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权录入营业额' })
    }
    const { storeId, date, amount, source, channels } = req.body as any

    const finalStoreId = isStoreScoped(role) ? userStoreId : storeId
    if (!finalStoreId) return reply.status(400).send({ error: '请指定门店' })
    if (!date) return reply.status(400).send({ error: '请填写日期' })

    // 如果传了渠道明细，从渠道合计算总额；否则用 amount
    let finalAmount = amount
    let rawData: any = {}
    if (channels && typeof channels === 'object') {
      const total = Object.values(channels).reduce((s: number, v: any) => s + (Number(v) || 0), 0)
      if (total <= 0) return reply.status(400).send({ error: '请至少填写一个渠道金额' })
      finalAmount = total
      rawData = { channels }
    } else {
      if (!amount || Number(amount) <= 0) return reply.status(400).send({ error: '请填写营业额' })
    }

    const store = await prisma.store.findFirst({ where: { id: finalStoreId, tenantId } })
    if (!store) return reply.status(403).send({ error: '无权操作该门店' })

    try {
      const record = await prisma.revenueRecord.upsert({
        where: { storeId_date: { storeId: finalStoreId, date: new Date(date) } },
        update: { amount: finalAmount, source: source || 'manual', rawData },
        create: { storeId: finalStoreId, date: new Date(date), amount: finalAmount, source: source || 'manual', rawData },
      })
      return reply.status(201).send(record)
    } catch (e: any) {
      return reply.status(500).send({ error: '录入失败: ' + e.message })
    }
  })

  // 获取月度汇总
  app.get('/summary', auth, async (req: any) => {
    const { month } = req.query as any
    const { tenantId, storeId, role } = req.user
    const start = dayjs((month || dayjs().format('YYYY-MM')) + '-01').startOf('month').toDate()
    const end = dayjs((month || dayjs().format('YYYY-MM')) + '-01').endOf('month').toDate()
    const where: any = { store: { tenantId }, date: { gte: start, lte: end } }
    if (role === 'MANAGER') {
      if (!storeId) return { month: month || dayjs().format('YYYY-MM'), total: 0, stores: [] }
      where.storeId = storeId
    }
    try {
      const records = await prisma.revenueRecord.findMany({
        where,
        include: { store: { select: { id: true, name: true } } },
      })
      const byStore: Record<string, any> = {}
      records.forEach(r => {
        if (!byStore[r.storeId]) byStore[r.storeId] = { storeId: r.storeId, storeName: r.store.name, total: 0, days: 0 }
        byStore[r.storeId].total += Number(r.amount)
        byStore[r.storeId].days += 1
      })
      return {
        month: month || dayjs().format('YYYY-MM'),
        total: records.reduce((s, r) => s + Number(r.amount), 0),
        stores: Object.values(byStore).sort((a, b) => b.total - a.total),
      }
    } catch { return { month, total: 0, stores: [] } }
  })
}
