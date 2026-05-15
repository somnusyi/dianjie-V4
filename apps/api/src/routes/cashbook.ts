import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { cmbTransfer, reportCmbError } from '../services/cmbPayment'
import crypto from 'crypto'
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
    const { name, type, bankName, accountNo, note, cmbBindAccount } = req.body as any
    if (!name) return reply.status(400).send({ error: '账户名称不能为空' })
    // 招行实时账户校验: cmbBindAccount 必须是合理的银行账号格式
    if (cmbBindAccount && !/^[0-9]{10,25}$/.test(String(cmbBindAccount).trim())) {
      return reply.status(400).send({ error: '招行账号格式不对, 应为 10-25 位数字' })
    }
    const account = await prisma.cashAccount.create({
      data: {
        tenantId, name, type: type || 'BANK', bankName, accountNo, note,
        cmbBindAccount: cmbBindAccount ? String(cmbBindAccount).trim() : null,
      },
    })
    return reply.status(201).send(account)
  })

  // ── 更新账户 ──────────────────────────────────────────
  app.patch('/accounts/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })
    const { name, bankName, accountNo, note, status, cmbBindAccount } = req.body as any
    if (cmbBindAccount !== undefined && cmbBindAccount !== null && cmbBindAccount !== ''
        && !/^[0-9]{10,25}$/.test(String(cmbBindAccount).trim())) {
      return reply.status(400).send({ error: '招行账号格式不对, 应为 10-25 位数字' })
    }
    const account = await prisma.cashAccount.updateMany({
      where: { id: req.params.id, tenantId },
      data: {
        name, bankName, accountNo, note, status,
        ...(cmbBindAccount !== undefined && {
          cmbBindAccount: cmbBindAccount ? String(cmbBindAccount).trim() : null,
        }),
      },
    })
    return account
  })

  // ── 内部账户间转账 (招行实时账户之间) ────────────────
  //    POST /api/cashbook/internal-transfer
  //    入参: { fromAccountId, toAccountId, amount, remark }
  //    校验:
  //      - 角色 ADMIN/FINANCE/SUPER_ADMIN
  //      - test tenant 拒绝 (跟 paymentSchedule 防护一致, 不打真银行)
  //      - fromAccountId / toAccountId 必须属于当前 tenant, status=ACTIVE, cmbBindAccount 非空
  //      - amount > 0
  //    成功后:
  //      - 双向记 CashTransaction (付款方 -amount, 收款方 +amount, category='internal-transfer')
  //      - 同步更新两个 CashAccount.balance (虽然 cmbBindAccount 非空时 balance 不是单一来源,
  //        但记账让现金流水页能看到这笔操作)
  app.post('/internal-transfer', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!WRITE_ROLES.includes(role)) {
      return reply.status(403).send({ error: '无权发起转账' })
    }

    const { fromAccountId, toAccountId, amount, remark } = (req.body || {}) as {
      fromAccountId: string; toAccountId: string; amount: number; remark?: string
    }
    if (!fromAccountId || !toAccountId) {
      return reply.status(400).send({ error: '缺少 fromAccountId / toAccountId' })
    }
    if (fromAccountId === toAccountId) {
      return reply.status(400).send({ error: '付款账户与收款账户不能相同' })
    }
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      return reply.status(400).send({ error: '金额必须 > 0' })
    }

    // test tenant 防护 (跟 paymentSchedule.executeBankPayment 一致)
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }, select: { slug: true },
    })
    if (tenant?.slug === 'test') {
      return reply.status(403).send({
        error: 'test tenant 演示环境 · 已阻止真实银行转账 (不会扣钱)',
      })
    }

    // 拉两端账户校验
    const [fromAcc, toAcc] = await Promise.all([
      prisma.cashAccount.findFirst({
        where: { id: fromAccountId, tenantId, status: 'ACTIVE' },
      }),
      prisma.cashAccount.findFirst({
        where: { id: toAccountId, tenantId, status: 'ACTIVE' },
      }),
    ])
    if (!fromAcc) return reply.status(404).send({ error: '付款账户不存在或已停用' })
    if (!toAcc)   return reply.status(404).send({ error: '收款账户不存在或已停用' })
    if (!fromAcc.cmbBindAccount) {
      return reply.status(400).send({ error: '付款账户未绑定招行实时账号, 无法发起转账' })
    }
    if (!toAcc.cmbBindAccount) {
      return reply.status(400).send({ error: '收款账户未绑定招行实时账号, 无法接收转账' })
    }

    // 生成 bizNo: int-<14位时间戳>-<6 字符随机> (≤ 30 字符, 符合招行 yurRef 规则)
    const ts = dayjs().format('YYYYMMDDHHmmss')
    const rand = crypto.randomBytes(3).toString('hex')
    const bizNo = `int-${ts}-${rand}`

    // 调银行
    let bankResult
    try {
      bankResult = await cmbTransfer({
        fromAccount: fromAcc.cmbBindAccount,
        toAccount:   toAcc.cmbBindAccount,
        toName:      toAcc.name,       // 收款户名 (我们的设计里 CashAccount.name = 户名)
        amount:      amt,
        bizNo,
        remark:      remark?.trim() || '内部转账',
        // 同行 (都是招行) 不传 bankCode
      })
    } catch (e: any) {
      return reply.status(502).send({
        error: '招行服务调用失败',
        detail: e?.message || String(e),
      })
    }

    if (!bankResult.success) {
      reportCmbError(bankResult.resultMsg || '内部转账失败', {
        funcode: 'BB1PAYOP', resultCode: bankResult.resultCode, bizNo, raw: bankResult.raw,
      })
      return reply.status(400).send({
        success:    false,
        resultCode: bankResult.resultCode,
        resultMsg:  bankResult.resultMsg,
        bizNo,
      })
    }

    // 成功: 双向记 CashTransaction (审计 + 让现金流水页能看到)
    const now = new Date()
    await prisma.$transaction([
      prisma.cashTransaction.create({
        data: {
          tenantId, accountId: fromAcc.id, direction: -1,
          category: 'internal-transfer', amount: amt,
          balanceAfter: Number(fromAcc.balance) - amt,
          note: `内部转出 → ${toAcc.name}${remark ? ` (${remark})` : ''}`,
          txDate: now,
          refType: 'CMB_INTERNAL', refId: bizNo,
          createdById: userId,
        },
      }),
      prisma.cashTransaction.create({
        data: {
          tenantId, accountId: toAcc.id, direction: 1,
          category: 'internal-transfer', amount: amt,
          balanceAfter: Number(toAcc.balance) + amt,
          note: `内部转入 ← ${fromAcc.name}${remark ? ` (${remark})` : ''}`,
          txDate: now,
          refType: 'CMB_INTERNAL', refId: bizNo,
          createdById: userId,
        },
      }),
      prisma.cashAccount.update({
        where: { id: fromAcc.id },
        data: { balance: { decrement: amt } },
      }),
      prisma.cashAccount.update({
        where: { id: toAcc.id },
        data: { balance: { increment: amt } },
      }),
    ])

    return {
      success:    true,
      resultCode: bankResult.resultCode,
      txNo:       bankResult.txNo,
      bizNo,
      fromAccount: { id: fromAcc.id, name: fromAcc.name },
      toAccount:   { id: toAcc.id, name: toAcc.name },
      amount:     amt,
    }
  })

  // ── 软删账户 (status=DISABLED, 不真 DELETE 防误删历史流水关联) ────
  app.delete('/accounts/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })
    const result = await prisma.cashAccount.updateMany({
      where: { id: req.params.id, tenantId, status: 'ACTIVE' },
      data: { status: 'DISABLED' },
    })
    if (result.count === 0) {
      return reply.status(404).send({ error: '账户不存在或已停用' })
    }
    return { success: true }
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
