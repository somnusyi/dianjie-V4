import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const WRITE_ROLES = ['ADMIN', 'FINANCE', 'SUPER_ADMIN']
const READ_ROLES = new Set(['ADMIN', 'FINANCE', 'SUPER_ADMIN', 'BOSS'])  // 仅集团财务/老板可看现金账

export const cashbookRoutes: FastifyPluginAsync = async (app) => {

  // ── 账户列表 ──────────────────────────────────────────
  app.get('/accounts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!READ_ROLES.has(role)) return reply.status(403).send({ error: '无权访问现金账' })
    return prisma.cashAccount.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    })
  })

  // ── 创建账户 ──────────────────────────────────────────
  app.post('/accounts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })
    const { name, type, bankName, accountNo, note } = req.body as any
    if (!name) return reply.status(400).send({ error: '账户名称不能为空' })
    const account = await prisma.cashAccount.create({
      data: { tenantId, name, type: type || 'BANK', bankName, accountNo, note },
    })
    return reply.status(201).send(account)
  })

  // ── 更新账户 ──────────────────────────────────────────
  app.patch('/accounts/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })
    const { name, bankName, accountNo, note, status } = req.body as any
    const account = await prisma.cashAccount.updateMany({
      where: { id: req.params.id, tenantId },
      data: { name, bankName, accountNo, note, status },
    })
    return account
  })

  // ── 流水列表（分页 + 过滤）────────────────────────────
  app.get('/transactions', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!READ_ROLES.has(role)) return reply.status(403).send({ error: '无权访问现金流水' })
    const { accountId, direction, category, month, page = '1', pageSize = '20' } = req.query as any

    const where: any = { tenantId }
    if (accountId) where.accountId = accountId
    if (direction) where.direction = Number(direction)
    if (category) where.category = category
    if (month) {
      const start = dayjs(month).startOf('month').toDate()
      const end = dayjs(month).endOf('month').toDate()
      where.txDate = { gte: start, lte: end }
    }

    const p = Math.max(1, parseInt(page))
    const ps = Math.min(100, Math.max(1, parseInt(pageSize)))

    const [items, total] = await Promise.all([
      prisma.cashTransaction.findMany({
        where,
        include: {
          account: { select: { id: true, name: true, type: true } },
          createdBy: { select: { name: true } },
        },
        orderBy: { txDate: 'desc' },
        skip: (p - 1) * ps,
        take: ps,
      }),
      prisma.cashTransaction.count({ where }),
    ])

    return { items, total, page: p, pageSize: ps }
  })

  // ── 录入流水（原子更新账户余额）──────────────────────
  app.post('/transactions', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })

    const { accountId, direction, category, amount, note, txDate, refType, refId } = req.body as any
    if (!accountId || !direction || !category || !amount || !txDate)
      return reply.status(400).send({ error: '请填写完整信息' })
    if (![1, -1].includes(Number(direction)))
      return reply.status(400).send({ error: 'direction 只能是 1（收入）或 -1（支出）' })
    if (Number(amount) <= 0)
      return reply.status(400).send({ error: '金额必须大于 0' })

    const tx = await prisma.$transaction(async (client) => {
      const account = await client.cashAccount.findFirst({
        where: { id: accountId, tenantId, status: 'ACTIVE' },
      })
      if (!account) throw { statusCode: 404, message: '账户不存在' }

      const newBalance = Number(account.balance) + Number(direction) * Number(amount)

      await client.cashAccount.update({
        where: { id: accountId },
        data: { balance: newBalance },
      })

      return client.cashTransaction.create({
        data: {
          tenantId,
          accountId,
          direction: Number(direction),
          category,
          amount: Number(amount),
          balanceAfter: newBalance,
          note,
          txDate: new Date(txDate),
          refType,
          refId,
          createdById: userId,
        },
        include: {
          account: { select: { id: true, name: true, type: true } },
        },
      })
    })

    return reply.status(201).send(tx)
  })

  // ── 汇总（本月收支 + 各账户余额）────────────────────
  app.get('/summary', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!READ_ROLES.has(role)) return reply.status(403).send({ error: '无权访问现金汇总' })
    const monthStart = dayjs().startOf('month').toDate()
    const monthEnd = dayjs().endOf('month').toDate()

    const [accounts, monthTx] = await Promise.all([
      prisma.cashAccount.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: { id: true, name: true, type: true, balance: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.cashTransaction.findMany({
        where: { tenantId, txDate: { gte: monthStart, lte: monthEnd } },
        select: { direction: true, amount: true },
      }),
    ])

    const totalBalance = accounts.reduce((s, a) => s + Number(a.balance), 0)
    const monthIncome = monthTx.filter(t => t.direction === 1).reduce((s, t) => s + Number(t.amount), 0)
    const monthExpense = monthTx.filter(t => t.direction === -1).reduce((s, t) => s + Number(t.amount), 0)

    return {
      totalBalance,
      monthIncome,
      monthExpense,
      monthNet: monthIncome - monthExpense,
      accounts,
    }
  })
}
