import { FastifyPluginAsync } from 'fastify'
import { businessCompactTimestampKey } from '../lib/businessTime'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { cmbTransfer, reportCmbError } from '../services/cmbPayment'
import { voucherForInternalTransfer } from '../services/voucher'
import { syncCmbAccount } from '../services/cmbAutoSync'
import { writeCashTransaction } from '../services/cashbook'
import crypto from 'crypto'
import dayjs from 'dayjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const WRITE_ROLES = ['ADMIN', 'FINANCE', 'SUPER_ADMIN']
const READ_ROLES = new Set(['ADMIN', 'FINANCE', 'SUPER_ADMIN', 'BOSS'])  // 仅集团财务/老板可看现金账
const accountTypeSchema = z.enum(['BANK', 'ALIPAY', 'WECHAT', 'CASH'])
const nullableText = (max: number) => z.string().trim().max(max).optional().nullable()
const moneySchema = z.number().positive().max(9_999_999_999.99, '金额超出系统上限')
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, '金额最多保留两位小数')

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

function parseBusinessDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T12:00:00+08:00`)
  const [year, month, day] = value.split('-').map(Number)
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== year ||
      date.getMonth() + 1 !== month || date.getDate() !== day) return null
  return date
}

function businessDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

async function lockAccountIdentifiers(tx: any, values: Array<string | null | undefined>) {
  const keys = [...new Set(values.filter(Boolean).map(value => `cash-account-id:${value!.toLowerCase()}`))].sort()
  for (const key of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
}

async function assertUniqueAccountIdentifiers(
  tx: any,
  tenantId: string,
  values: { name?: string | null; accountNo?: string | null; cmbBindAccount?: string | null },
  excludeId?: string,
) {
  const clauses: any[] = []
  if (values.name) clauses.push({ name: { equals: values.name, mode: 'insensitive' } })
  if (values.accountNo) clauses.push({ accountNo: values.accountNo })
  if (values.cmbBindAccount) clauses.push({ cmbBindAccount: values.cmbBindAccount })
  if (clauses.length === 0) return
  const duplicate = await tx.cashAccount.findFirst({
    where: { tenantId, status: 'ACTIVE', ...(excludeId ? { id: { not: excludeId } } : {}), OR: clauses },
    select: { id: true, name: true, accountNo: true, cmbBindAccount: true },
  })
  if (!duplicate) return
  if (values.cmbBindAccount && duplicate.cmbBindAccount === values.cmbBindAccount) {
    throw httpError('该招行实时账号已绑定其他活动账户', 409)
  }
  if (values.accountNo && duplicate.accountNo === values.accountNo) {
    throw httpError('该银行账号已存在于其他活动账户', 409)
  }
  throw httpError('已存在同名活动资金账户', 409)
}

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
  const accountCreateSchema = z.object({
    name: z.string().trim().min(1, '账户名称不能为空').max(100),
    type: accountTypeSchema.optional().default('BANK'),
    bankName: nullableText(100),
    accountNo: nullableText(64),
    note: nullableText(500),
    cmbBindAccount: nullableText(25),
  }).strict()
  app.post('/accounts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = accountCreateSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { name, type, bankName, accountNo, note, cmbBindAccount } = parsed.data
    if (cmbBindAccount && !/^[0-9]{10,25}$/.test(cmbBindAccount)) {
      return reply.status(400).send({ error: '招行账号格式不对, 应为 10-25 位数字' })
    }
    if (cmbBindAccount && type !== 'BANK') {
      return reply.status(400).send({ error: '只有银行账户可以绑定招行实时账号' })
    }
    try {
      const account = await prisma.$transaction(async tx => {
        await lockAccountIdentifiers(tx, [name, accountNo, cmbBindAccount])
        await assertUniqueAccountIdentifiers(tx, tenantId, { name, accountNo, cmbBindAccount })
        const created = await tx.cashAccount.create({
          data: {
            tenantId, name, type,
            bankName: bankName || null, accountNo: accountNo || null, note: note || null,
            cmbBindAccount: cmbBindAccount || null,
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, action: `创建资金账户 ${created.name}`,
            entityType: 'CashAccount', targetId: created.id,
            metadata: { type: created.type, bankName: created.bankName } as any,
          },
        })
        return created
      })
      return reply.status(201).send(account)
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'cash account create failed')
      return reply.status(500).send({ error: '资金账户创建失败，未保存任何变更' })
    }
  })

  // ── 更新账户 ──────────────────────────────────────────
  const accountUpdateSchema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    bankName: nullableText(100),
    accountNo: nullableText(64),
    note: nullableText(500),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    cmbBindAccount: nullableText(25),
  }).strict().refine(body => Object.keys(body).length > 0, '没有可更新字段')
  app.patch('/accounts/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = accountUpdateSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { name, bankName, accountNo, note, status, cmbBindAccount } = parsed.data
    if (cmbBindAccount && !/^[0-9]{10,25}$/.test(cmbBindAccount)) {
      return reply.status(400).send({ error: '招行账号格式不对, 应为 10-25 位数字' })
    }
    try {
      const account = await prisma.$transaction(async tx => {
        await lockAccountIdentifiers(tx, [name, accountNo, cmbBindAccount])
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash-account:${id}`}))`
        const current = await tx.cashAccount.findFirst({ where: { id, tenantId } })
        if (!current) throw httpError('账户不存在', 404)
        const nextName = name ?? current.name
        const nextAccountNo = accountNo === undefined ? current.accountNo : (accountNo || null)
        const nextCmb = cmbBindAccount === undefined ? current.cmbBindAccount : (cmbBindAccount || null)
        await lockAccountIdentifiers(tx, [nextName, nextAccountNo, nextCmb])
        if (nextCmb && current.type !== 'BANK') throw httpError('只有银行账户可以绑定招行实时账号', 400)
        if (status === 'DISABLED' && !current.balance.equals(0)) {
          throw httpError(`账户余额为 ¥${current.balance.toFixed(2)}，清零后才能停用`, 409)
        }
        await assertUniqueAccountIdentifiers(
          tx, tenantId, { name: nextName, accountNo: nextAccountNo, cmbBindAccount: nextCmb }, current.id,
        )
        const updated = await tx.cashAccount.update({
          where: { id: current.id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(bankName !== undefined ? { bankName: bankName || null } : {}),
            ...(accountNo !== undefined ? { accountNo: accountNo || null } : {}),
            ...(note !== undefined ? { note: note || null } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(cmbBindAccount !== undefined ? { cmbBindAccount: cmbBindAccount || null } : {}),
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, action: `更新资金账户 ${current.name}`,
            entityType: 'CashAccount', targetId: current.id,
            metadata: { before: { name: current.name, status: current.status }, after: { name: updated.name, status: updated.status } } as any,
          },
        })
        return updated
      })
      return account
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'cash account update failed')
      return reply.status(500).send({ error: '资金账户更新失败，未保存任何变更' })
    }
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

    // 真实扣款入口默认关闭；修复持久幂等前只能由生产环境显式开启。
    // PREVIEW/开发环境即使误配开关也绝不调用银行。
    if (process.env.NODE_ENV !== 'production' || process.env.PREVIEW_MODE === 'true' ||
        process.env.CMB_INTERNAL_TRANSFER_ENABLED !== 'true') {
      return reply.status(503).send({
        error: '内部账户转账已临时停用，未调用银行',
        code: 'CMB_INTERNAL_TRANSFER_DISABLED',
      })
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
    const ts = businessCompactTimestampKey()
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
      req.log.error({ err: e, bizNo }, 'CMB internal transfer call failed')
      return reply.status(502).send({
        error: '招行服务调用失败',
        code: 'CMB_SERVICE_ERROR',
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

    // 2026-06-01 Phase 1 修底盘: 生凭证 (借 1002 收款户 / 贷 1002 付款户, 同科目不同明细)
    // 用 cmbBindAccount 末四位映射到好会计明细科目 (跟 voucherForPayment 同一套约定)
    const last4 = (s?: string | null) => s ? s.slice(-4) : undefined
    let voucherId: string | null = null
    try {
      voucherId = await voucherForInternalTransfer({
        tenantId,
        transferBizNo: bizNo,
        fromAccountName: fromAcc.name,
        fromBankLast4: last4(fromAcc.cmbBindAccount),
        toAccountName: toAcc.name,
        toBankLast4: last4(toAcc.cmbBindAccount),
        amount: amt,
        remark: remark?.trim() || undefined,
        date: now,
      })
    } catch (error: any) {
      req.log.warn({ err: error, bizNo }, 'internal transfer voucher failed after bank success')
    }

    return {
      success:    true,
      resultCode: bankResult.resultCode,
      txNo:       bankResult.txNo,
      bizNo,
      fromAccount: { id: fromAcc.id, name: fromAcc.name },
      toAccount:   { id: toAcc.id, name: toAcc.name },
      amount:     amt,
      voucherId,
      voucherWarning: voucherId ? null : '银行转账和资金流水已完成，但凭证生成失败，请按业务号补建',
    }
  })

  // ── 软删账户 (status=DISABLED, 不真 DELETE 防误删历史流水关联) ────
  app.delete('/accounts/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })
    try {
      const result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash-account:${id}`}))`
        const account = await tx.cashAccount.findFirst({ where: { id, tenantId } })
        if (!account) throw httpError('账户不存在', 404)
        if (account.status === 'DISABLED') return { duplicated: true }
        if (!account.balance.equals(0)) {
          throw httpError(`账户余额为 ¥${account.balance.toFixed(2)}，清零后才能停用`, 409)
        }
        await tx.cashAccount.update({ where: { id: account.id }, data: { status: 'DISABLED' } })
        await tx.opLog.create({
          data: {
            tenantId, userId, action: `停用资金账户 ${account.name}`,
            entityType: 'CashAccount', targetId: account.id,
          },
        })
        return { duplicated: false }
      })
      return { success: true, ...result }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'cash account disable failed')
      return reply.status(500).send({ error: '资金账户停用失败，未保存任何变更' })
    }
  })

  // ── 流水列表（分页 + 过滤）────────────────────────────
  const transactionQuerySchema = z.object({
    accountId: z.string().min(1).optional(),
    direction: z.enum(['1', '-1']).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    month: z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/, '月份格式应为 YYYY-MM').optional(),
    page: z.string().regex(/^\d+$/).optional().default('1'),
    pageSize: z.string().regex(/^\d+$/).optional().default('20'),
  }).strict()
  app.get('/transactions', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!READ_ROLES.has(role)) return reply.status(403).send({ error: '无权访问现金流水' })
    const parsed = transactionQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { accountId, direction, category, month, page, pageSize } = parsed.data

    const where: any = { tenantId }
    if (accountId) where.accountId = accountId
    if (direction) where.direction = Number(direction)
    if (category) where.category = category
    if (month) {
      const monthNumber = Number(month.slice(5, 7))
      if (monthNumber < 1 || monthNumber > 12) return reply.status(400).send({ error: '月份无效' })
      const start = dayjs(`${month.slice(0, 7)}-01`).startOf('month').toDate()
      const end = dayjs(`${month.slice(0, 7)}-01`).endOf('month').toDate()
      where.txDate = { gte: start, lte: end }
    }

    const p = Math.max(1, Number(page))
    const ps = Math.min(100, Math.max(1, Number(pageSize)))

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
  const manualTransactionSchema = z.object({
    operationId: z.string().uuid('operationId 必须是 UUID'),
    accountId: z.string().min(1, '请选择资金账户'),
    direction: z.union([z.literal(1), z.literal(-1)]),
    category: z.string().trim().min(1, '请选择流水分类').max(80),
    amount: moneySchema,
    note: z.string().trim().max(1000).optional().nullable(),
    txDate: z.string(),
  }).strict()
  app.post('/transactions', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = manualTransactionSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { operationId, accountId, direction, category, amount, note, txDate } = parsed.data
    const txDateValue = parseBusinessDate(txDate)
    if (!txDateValue) return reply.status(400).send({ error: '流水日期无效' })
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
    if (txDateValue > endOfToday) return reply.status(400).send({ error: '流水日期不能晚于今天' })
    try {
      const result = await prisma.$transaction(async client => {
        await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash-manual:${tenantId}:${operationId}`}))`
        const existing = await client.cashTransaction.findFirst({
          where: { tenantId, refType: 'MANUAL_CASHBOOK', refId: operationId },
          include: { account: { select: { id: true, name: true, type: true } } },
        })
        if (existing) {
          const same = existing.accountId === accountId && existing.createdById === userId &&
            existing.direction === direction && existing.category === category &&
            existing.amount.equals(amount) && (existing.note || '') === (note || '') &&
            businessDateKey(existing.txDate) === txDate
          if (!same) throw httpError('该 operationId 已用于其他流水参数，不可覆盖', 409)
          return { transaction: existing, duplicated: true }
        }
        const written = await writeCashTransaction(client, {
          tenantId, accountId, direction, category, amount,
          note: note || undefined, txDate: txDateValue,
          refType: 'MANUAL_CASHBOOK', refId: operationId, createdById: userId,
        })
        if (!written) throw httpError('账户不存在或已停用', 404)
        await client.opLog.create({
          data: {
            tenantId, userId,
            action: `手工录入资金${direction === 1 ? '收入' : '支出'} ${category} ¥${new Prisma.Decimal(amount).toFixed(2)}`,
            entityType: 'CashTransaction', targetId: written.id,
            metadata: { operationId, accountId, balanceAfter: written.balanceAfter } as any,
          },
        })
        const transaction = await client.cashTransaction.findUniqueOrThrow({
          where: { id: written.id },
          include: { account: { select: { id: true, name: true, type: true } } },
        })
        return { transaction, duplicated: false }
      })
      return reply.status(result.duplicated ? 200 : 201).send({ ...result.transaction, duplicated: result.duplicated })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'manual cash transaction failed')
      return reply.status(500).send({ error: '手工流水录入失败，未保存任何变更' })
    }
  })

  // ── CMB 流水手动同步 (财务点 funds 页 "立即同步" 按钮触发) ──
  // POST /api/cashbook/sync-from-cmb
  //   body: { accountId?: string; daysBack?: number }
  //   不传 accountId 同步该 tenant 所有 cmbBindAccount; 传则只同步指定
  //   daysBack 默认 1 (昨天+今天); 历史首次接入可传 30 拉一个月
  const cmbSyncSchema = z.object({
    accountId: z.string().min(1).optional(),
    daysBack: z.number().int().min(1).max(60).optional().default(1),
  }).strict()
  app.post('/sync-from-cmb', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!WRITE_ROLES.includes(role)) return reply.status(403).send({ error: '无权操作' })
    if (process.env.NODE_ENV !== 'production' || process.env.PREVIEW_MODE === 'true') {
      return reply.status(503).send({ error: '预览/开发环境不允许连接银行流水', code: 'CMB_SYNC_DISABLED' })
    }
    const parsed = cmbSyncSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { accountId, daysBack: days } = parsed.data
    try {
      if (accountId) {
        const acc = await prisma.cashAccount.findFirst({
          where: { id: accountId, tenantId, status: 'ACTIVE' },
          select: { id: true, name: true, cmbBindAccount: true },
        })
        if (!acc?.cmbBindAccount) return reply.status(400).send({ error: '账户未绑定 CMB' })
        const r = await syncCmbAccount({
          tenantId, cashAccountId: acc.id, cmbAccount: acc.cmbBindAccount,
          accountName: acc.name,
          fromDate: dayjs().subtract(days, 'day').toDate(),
          toDate: dayjs().toDate(),
        })
        return { results: [r] }
      }
      // 全量 (tenant 内所有 cmbBindAccount)
      const accounts = await prisma.cashAccount.findMany({
        where: { tenantId, cmbBindAccount: { not: null }, status: 'ACTIVE' },
        select: { id: true, name: true, cmbBindAccount: true },
      })
      const results = await Promise.all(
        accounts.map(a => syncCmbAccount({
          tenantId, cashAccountId: a.id, cmbAccount: a.cmbBindAccount!,
          accountName: a.name,
          fromDate: dayjs().subtract(days, 'day').toDate(),
          toDate: dayjs().toDate(),
        }).catch(e => ({
          account: a.cmbBindAccount!, accountName: a.name,
          pulled: 0, matched: 0, alreadySynced: 0, newlyWritten: 0,
          errors: 1, errorMsg: e?.message || String(e),
        }))),
      )
      return { results }
    } catch (e: any) {
      req.log.error({ err: e }, 'CMB transaction sync failed')
      return reply.status(500).send({ error: '银行流水同步失败，请稍后重试' })
    }
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
        // 补 cmbBindAccount + bankName + accountNo: 前端 finance-pc/funds 需要这些字段来拉 CMB 实时余额 + 显示银行名/尾号
        select: { id: true, name: true, type: true, balance: true, cmbBindAccount: true, bankName: true, accountNo: true },
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
