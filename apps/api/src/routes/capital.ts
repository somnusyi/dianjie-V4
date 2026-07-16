/**
 * 总部代付项目 (店长发起 → 老板/财务审批 → 财务付款)
 *
 * 角色权限:
 *   MANAGER  店长: 创建项目 / 录合同 / 申请支出 (PENDING_APPROVAL); 仅自己门店
 *   BOSS/FINANCE: 全部门店; 审批支出; 付款; 录还款
 *
 * 状态机:
 *   CapitalExpense:
 *     PENDING_APPROVAL → APPROVED  (老板/财务批)
 *                     → REJECTED   (驳回)
 *                     → CANCELED   (店长撤回, 仅 PENDING_APPROVAL 可)
 *     APPROVED → PAID    (财务确认到账)
 *              → FAILED  (银行返回失败)
 *
 * project.spent 只在 PAID 时累加(防止申请阶段就计入)
 * contract.paidAmount 同上
 */
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { cashLedgerAccount, writeCashTransaction } from '../services/cashbook'
import { createVoucher } from '../services/voucher'

const FINANCE_OR_BOSS = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE'])
const STORE_LEVEL = new Set(['MANAGER', 'KITCHEN_LEAD'])
// 与 capital 完全无关的角色（应直接 403）
const NON_CAPITAL_ROLES = new Set(['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB', 'CHEF_DIRECTOR', 'CHEF'])
const money = z.number().positive().max(9_999_999_999.99, '金额超出系统上限')
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, '金额最多保留两位小数')
const paymentMethodSchema = z.enum(['cmb', 'bank', 'cash'])

function parseBusinessDate(value: string | undefined): Date | null {
  if (!value) return new Date()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T12:00:00+08:00`)
  if (Number.isNaN(date.getTime())) return null
  const [year, month, day] = value.split('-').map(Number)
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return null
  return date
}

function businessDateKey(date: Date | null | undefined): string {
  if (!date) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

export const capitalRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: [(app as any).authenticate] }

  // ─── 项目列表 (店长只看本店, 老板/财务全部) ────
  app.get('/projects', auth, async (req: any, reply: any) => {
    const { tenantId, role, storeId } = req.user
    if (NON_CAPITAL_ROLES.has(role)) return reply.status(403).send({ error: '无权访问代付' })
    const { status, storeId: qStore } = req.query as any
    const where: any = { tenantId }
    if (status) where.status = status
    // 店长只看自己店, 集团角色可查全部 / 按 store 过滤
    if (STORE_LEVEL.has(role)) {
      if (!storeId) return []
      where.storeId = storeId
    } else if (qStore) {
      where.storeId = qStore
    }
    const list = await prisma.capitalProject.findMany({
      where,
      include: {
        store: { select: { id: true, name: true, no: true } },
        _count: { select: { contracts: true, expenses: true, repayments: true } },
      },
      orderBy: { startedAt: 'desc' },
    })
    return list.map(p => ({
      ...p,
      remainingDebt: Number(p.spent) - Number(p.repaidAmount),
      progressPct: Number(p.budget) > 0 ? Math.round(Number(p.spent) / Number(p.budget) * 100) : null,
    }))
  })

  // ─── 项目详情 ─────────────────────────────────
  app.get('/projects/:id', auth, async (req: any, reply: any) => {
    const { tenantId, role, storeId } = req.user
    if (NON_CAPITAL_ROLES.has(role)) return reply.status(403).send({ error: '无权访问代付' })
    const p = await prisma.capitalProject.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        store: { select: { id: true, name: true, no: true } },
        contracts: {
          include: { _count: { select: { expenses: true } } },
          orderBy: { createdAt: 'asc' },
        },
        expenses: {
          include: {
            contract: { select: { id: true, vendor: true, category: true } },
          },
          orderBy: { requestedAt: 'desc' },
        },
        repayments: { orderBy: { paidAt: 'desc' } },
      },
    })
    if (!p) return reply.status(404).send({ error: '项目不存在' })
    // 店长只能看自己店
    if (STORE_LEVEL.has(role) && p.storeId !== storeId) {
      return reply.status(403).send({ error: '无权查看其他门店项目' })
    }
    return {
      ...p,
      remainingDebt: Number(p.spent) - Number(p.repaidAmount),
      progressPct: Number(p.budget) > 0 ? Math.round(Number(p.spent) / Number(p.budget) * 100) : null,
    }
  })

  // ─── 立项 (店长 / 老板都可) ────────────────────
  // 注: 全局 registerIdempotency 中间件已支持 Idempotency-Key header (10min Redis 缓存)
  // 这里再加一层业务级 dedup, 防止前端漏传 header 时双击仍创建重复
  app.post('/projects', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId: userStoreId } = req.user
    if (!FINANCE_OR_BOSS.has(role) && !STORE_LEVEL.has(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const { name, type = 'NEW_STORE', storeId, budget, repaymentTerms, note } = req.body as any
    if (!name?.trim()) return reply.status(400).send({ error: '请填项目名称' })
    // 店长立项必须绑自己门店
    const finalStoreId = STORE_LEVEL.has(role) ? userStoreId : (storeId || null)
    if (STORE_LEVEL.has(role) && !finalStoreId) {
      return reply.status(400).send({ error: '当前账号未绑定门店, 不能立项' })
    }
    // 业务级 dedup: 同 tenant + storeId + name 在 60s 内已有, 直接返回旧的, 不创建新
    const dupWindowMs = 60_000
    const dup = await prisma.capitalProject.findFirst({
      where: {
        tenantId,
        name: name.trim(),
        storeId: finalStoreId,
        createdAt: { gte: new Date(Date.now() - dupWindowMs) },
      },
    })
    if (dup) return reply.status(200).send(dup)
    const p = await prisma.capitalProject.create({
      data: {
        tenantId, name: name.trim(), type,
        storeId: finalStoreId,
        budget: budget ? Number(budget) : null,
        repaymentTerms: repaymentTerms || null,
        note: note || null,
        status: 'PREPARING',
      },
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: `立项代付项目 ${name}` + (budget ? ` 预算 ¥${Number(budget).toLocaleString()}` : ''),
        entityType: 'CapitalProject', targetId: p.id },
    })
    return reply.status(201).send(p)
  })

  app.patch('/projects/:id', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId } = req.user
    const target = await prisma.capitalProject.findFirst({ where: { id: req.params.id, tenantId } })
    if (!target) return reply.status(404).send({ error: '项目不存在' })
    if (STORE_LEVEL.has(role) && target.storeId !== storeId) {
      return reply.status(403).send({ error: '只能修改本店项目' })
    }
    const { name, status: nextStatus, budget, repaymentTerms, openedAt, closedAt, note } = req.body as any
    const data: any = {}
    if (name !== undefined) data.name = name
    if (nextStatus !== undefined) data.status = nextStatus
    if (budget !== undefined) data.budget = budget ? Number(budget) : null
    if (repaymentTerms !== undefined) data.repaymentTerms = repaymentTerms || null
    if (openedAt !== undefined) data.openedAt = openedAt ? new Date(openedAt) : null
    if (closedAt !== undefined) data.closedAt = closedAt ? new Date(closedAt) : null
    if (note !== undefined) data.note = note || null
    await prisma.capitalProject.update({ where: { id: target.id }, data })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `更新代付项目 ${target.name}`, entityType: 'CapitalProject', targetId: target.id },
    })
    return { success: true }
  })

  // ─── 合同录入 (店长 / 老板都可) ────────────────
  app.post('/contracts', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId } = req.user
    if (!FINANCE_OR_BOSS.has(role) && !STORE_LEVEL.has(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const { projectId, category, vendor, contractNo, totalAmount, startDate, endDate, fileUrl, note } = req.body as any
    if (!projectId || !category || !vendor) return reply.status(400).send({ error: '缺必填项' })
    if (!totalAmount || Number(totalAmount) <= 0) return reply.status(400).send({ error: '合同金额必填' })
    const p = await prisma.capitalProject.findFirst({ where: { id: projectId, tenantId } })
    if (!p) return reply.status(404).send({ error: '项目不存在' })
    if (STORE_LEVEL.has(role) && p.storeId !== storeId) {
      return reply.status(403).send({ error: '只能为本店项目录合同' })
    }
    const c = await prisma.capitalContract.create({
      data: {
        tenantId, projectId, category, vendor,
        contractNo: contractNo || null,
        totalAmount: Number(totalAmount),
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        fileUrl: fileUrl || null,
        note: note || null,
      },
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: `录合同 ${vendor} ${category} ¥${Number(totalAmount).toLocaleString()}`,
        entityType: 'CapitalContract', targetId: c.id },
    })
    return reply.status(201).send(c)
  })

  app.patch('/contracts/:id', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId } = req.user
    const target = await prisma.capitalContract.findFirst({
      where: { id: req.params.id, tenantId },
      include: { project: true },
    })
    if (!target) return reply.status(404).send({ error: '合同不存在' })
    if (STORE_LEVEL.has(role) && target.project.storeId !== storeId) {
      return reply.status(403).send({ error: '只能修改本店合同' })
    }
    const { vendor, contractNo, totalAmount, status: ns, startDate, endDate, fileUrl, note } = req.body as any
    const data: any = {}
    if (vendor !== undefined) data.vendor = vendor
    if (contractNo !== undefined) data.contractNo = contractNo || null
    if (totalAmount !== undefined) data.totalAmount = Number(totalAmount)
    if (ns !== undefined) data.status = ns
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null
    if (fileUrl !== undefined) data.fileUrl = fileUrl || null
    if (note !== undefined) data.note = note || null
    await prisma.capitalContract.update({ where: { id: target.id }, data })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `更新合同 ${target.vendor}`, entityType: 'CapitalContract', targetId: target.id },
    })
    return { success: true }
  })

  // ─── 申请支出 (店长发起, 创建即 PENDING_APPROVAL) ──
  const expenseCreateSchema = z.object({
    projectId: z.string().min(1, '请选择代付项目'),
    contractId: z.string().min(1).optional().nullable(),
    category: z.enum(['RENT', 'DECORATION', 'EQUIPMENT', 'PAYROLL', 'LEGAL', 'MARKETING', 'OTHER']),
    vendor: z.string().trim().min(1, '请填写收款方').max(200),
    amount: money,
    fileUrl: z.string().trim().max(2000).optional().nullable(),
    note: z.string().trim().max(1000).optional().nullable(),
  }).strict()
  app.post('/expenses', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId, storeId } = req.user
    if (!FINANCE_OR_BOSS.has(role) && !STORE_LEVEL.has(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const parsed = expenseCreateSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { projectId, contractId, category, vendor, amount, fileUrl, note } = parsed.data
    try {
      const exp = await prisma.$transaction(async tx => {
        const lockKey = contractId ? `capital-contract:${contractId}` : `capital-project:${projectId}`
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`
        const projectRows = await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "capital_projects"
          WHERE "id" = ${projectId} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `) as Array<{ id: string }>
        if (projectRows.length !== 1) throw httpError('项目不存在', 404)
        const project = await tx.capitalProject.findUniqueOrThrow({ where: { id: projectId } })
        if (STORE_LEVEL.has(role) && project.storeId !== storeId) {
          throw httpError('只能为本店项目申请支出', 403)
        }
        if (['CANCELED', 'REPAID'].includes(project.status)) {
          throw httpError(`项目当前状态 ${project.status} 不可新增支出`, 409)
        }
        if (contractId) {
          const contractRows = await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "capital_contracts"
            WHERE "id" = ${contractId} AND "tenantId" = ${tenantId} AND "projectId" = ${projectId}
            FOR UPDATE
          `) as Array<{ id: string }>
          if (contractRows.length !== 1) throw httpError('合同不属于该项目', 409)
          const contract = await tx.capitalContract.findUniqueOrThrow({ where: { id: contractId } })
          if (contract.status !== 'ACTIVE') throw httpError(`合同当前状态 ${contract.status} 不可新增支出`, 409)
          const reserved = await tx.capitalExpense.aggregate({
            where: { contractId, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PAID'] } },
            _sum: { amount: true },
          })
          const reservedAmount = reserved._sum.amount || new Prisma.Decimal(0)
          const requestedAmount = new Prisma.Decimal(amount)
          if (reservedAmount.plus(requestedAmount).gt(contract.totalAmount)) {
            throw httpError(
              `本笔 ¥${requestedAmount.toFixed(2)} 超合同剩余可申请 ¥${contract.totalAmount.minus(reservedAmount).toFixed(2)}`,
              409,
            )
          }
        }
        const created = await tx.capitalExpense.create({
          data: {
            tenantId, projectId, contractId: contractId || null,
            category, vendor, amount,
            fileUrl: fileUrl || null, note: note || null,
            status: 'PENDING_APPROVAL', requestedById: userId,
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: `申请支出 ${vendor} ${category} ¥${new Prisma.Decimal(amount).toFixed(2)} (待审批)`,
            entityType: 'CapitalExpense', targetId: created.id,
          },
        })
        return created
      })
      return reply.status(201).send(exp)
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'capital expense create failed')
      return reply.status(500).send({ error: '代付支出申请失败，未保存任何变更' })
    }
  })

  // ─── 审批支出 (老板/财务) ──────────────────────
  app.patch('/expenses/:id/approve', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_OR_BOSS.has(role)) return reply.status(403).send({ error: '仅老板/财务可审批' })
    const parsed = z.object({
      decision: z.enum(['APPROVE', 'REJECT']),
      note: z.string().trim().max(1000).optional(),
    }).strict().safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { decision, note } = parsed.data
    if (decision === 'REJECT' && !note) {
      return reply.status(400).send({ error: '驳回必须填原因' })
    }
    try {
      const result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capital-expense:${id}`}))`
        const exp = await tx.capitalExpense.findFirst({ where: { id, tenantId } })
        if (!exp) throw httpError('支出不存在', 404)
        const targetStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'
        if (exp.status !== 'PENDING_APPROVAL') {
          if (exp.status === targetStatus && exp.approvedById === userId &&
              (decision === 'APPROVE' || exp.rejectReason === note)) {
            return { status: targetStatus, duplicated: true }
          }
          throw httpError(`支出当前状态 ${exp.status}，不可重复审批`, 409)
        }
        await tx.capitalExpense.update({
          where: { id: exp.id },
          data: {
            status: targetStatus,
            approvedById: userId, approvedAt: new Date(),
            approvalNote: decision === 'APPROVE' ? (note || null) : null,
            rejectReason: decision === 'REJECT' ? note : null,
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: decision === 'APPROVE'
              ? `批准支出 ${exp.vendor} ¥${exp.amount.toFixed(2)}`
              : `驳回支出 ${exp.vendor} ¥${exp.amount.toFixed(2)}: ${note}`,
            entityType: 'CapitalExpense', targetId: exp.id,
          },
        })
        return { status: targetStatus, duplicated: false }
      })
      return { success: true, ...result }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'capital expense approval failed')
      return reply.status(500).send({ error: '支出审批失败，未保存任何变更' })
    }
  })

  // ─── 撤回 (店长 only, 仅 PENDING_APPROVAL) ──────
  app.patch('/expenses/:id/cancel', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!STORE_LEVEL.has(role) && !FINANCE_OR_BOSS.has(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    try {
      const result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capital-expense:${id}`}))`
        const exp = await tx.capitalExpense.findFirst({ where: { id, tenantId } })
        if (!exp) throw httpError('支出不存在', 404)
        if (STORE_LEVEL.has(role) && exp.requestedById !== userId) {
          throw httpError('只能撤回自己发起的申请', 403)
        }
        if (exp.status === 'CANCELED') return { duplicated: true }
        if (exp.status !== 'PENDING_APPROVAL') {
          throw httpError(`支出当前状态 ${exp.status}，不可撤回`, 409)
        }
        await tx.capitalExpense.update({ where: { id: exp.id }, data: { status: 'CANCELED' } })
        await tx.opLog.create({
          data: {
            tenantId, userId, action: `撤回支出 ${exp.vendor} ¥${exp.amount.toFixed(2)}`,
            entityType: 'CapitalExpense', targetId: exp.id,
          },
        })
        return { duplicated: false }
      })
      return { success: true, ...result }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'capital expense cancel failed')
      return reply.status(500).send({ error: '支出撤回失败，未保存任何变更' })
    }
  })

  // ─── 财务付款 (APPROVED → PAID, 累加 spent) ─────
  // 2026-06-01 Phase 1 修底盘: 财务点付款时同步写 CashTransaction + 生成凭证
  const paySchema = z.object({
    paymentMethod: paymentMethodSchema,
    accountId: z.string().min(1, '请选择资金账户'),
    bankTxNo: z.string().trim().max(100).optional(),
    paidAt: z.string().optional(),
  }).strict()
  app.patch('/expenses/:id/pay', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_OR_BOSS.has(role)) return reply.status(403).send({ error: '仅财务可付款' })
    const parsed = paySchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const paidAtDate = parseBusinessDate(parsed.data.paidAt)
    if (!paidAtDate) return reply.status(400).send({ error: '付款日期无效' })
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
    if (paidAtDate > endOfToday) return reply.status(400).send({ error: '付款日期不能晚于今天' })

    let result: {
      exp: any
      account: { id: string; name: string; type: string; accountNo: string | null; cmbBindAccount: string | null }
      amount: number
      paidAt: Date
      duplicated: boolean
    }
    try {
      result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capital-expense:${id}`}))`
        const exp = await tx.capitalExpense.findFirst({
          where: { id, tenantId }, include: { project: { select: { id: true, name: true } } },
        })
        if (!exp) throw httpError('支出不存在', 404)
        const amount = Number(exp.amount)

        if (exp.status === 'PAID') {
          const existingTx = await tx.cashTransaction.findFirst({
            where: { tenantId, refType: 'CapitalExpense', refId: exp.id, direction: -1 },
            include: { account: { select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true } } },
          })
          if (!existingTx) throw httpError('资本支出已标记付款但缺少资金流水，请先由财务修复', 409)
          const same = exp.paymentMethod === parsed.data.paymentMethod &&
            (exp.bankTxNo || '') === (parsed.data.bankTxNo || '') &&
            existingTx.accountId === parsed.data.accountId &&
            (!parsed.data.paidAt || businessDateKey(exp.paidAt) === parsed.data.paidAt)
          if (!same) throw httpError('资本支出已按其他付款参数执行，不可覆盖', 409)
          return { exp, account: existingTx.account, amount, paidAt: exp.paidAt!, duplicated: true }
        }
        if (exp.status !== 'APPROVED') throw httpError(`当前状态 ${exp.status} 不可付款`, 409)

        const account = await tx.cashAccount.findFirst({
          where: { id: parsed.data.accountId, tenantId, status: 'ACTIVE' },
          select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true },
        })
        if (!account) throw httpError('资金账户不存在或已停用', 404)
        if (parsed.data.paymentMethod === 'cash' && account.type !== 'CASH') {
          throw httpError('现金付款必须选择库存现金账户', 409)
        }
        if (parsed.data.paymentMethod !== 'cash' && account.type !== 'BANK') {
          throw httpError('转账付款必须选择银行账户', 409)
        }
        if (parsed.data.paymentMethod === 'cmb' && !account.cmbBindAccount) {
          throw httpError('招行付款必须选择已绑定招行账号的资金账户', 409)
        }

        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "capital_projects"
          WHERE "id" = ${exp.projectId} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `)
        const project = await tx.capitalProject.findUniqueOrThrow({ where: { id: exp.projectId } })
        if (exp.contractId) {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "capital_contracts"
            WHERE "id" = ${exp.contractId} AND "tenantId" = ${tenantId}
            FOR UPDATE
          `)
          const contract = await tx.capitalContract.findUniqueOrThrow({ where: { id: exp.contractId } })
          const newPaid = contract.paidAmount.plus(exp.amount)
          if (newPaid.gt(contract.totalAmount)) {
            throw httpError(
              `付款后合同累计 ${newPaid.toFixed(2)} 将超过合同额 ${contract.totalAmount.toFixed(2)}`, 409,
            )
          }
          await tx.capitalContract.update({
            where: { id: contract.id },
            data: { paidAmount: newPaid, status: newPaid.equals(contract.totalAmount) ? 'COMPLETED' : contract.status },
          })
        }
        const cashTx = await writeCashTransaction(tx, {
          tenantId, accountId: account.id, direction: -1, category: '资本支出', amount,
          note: `${exp.vendor} ${exp.category}` + (parsed.data.bankTxNo ? ` · 流水 ${parsed.data.bankTxNo}` : ''),
          txDate: paidAtDate, refType: 'CapitalExpense', refId: exp.id, createdById: userId,
        })
        if (!cashTx) throw new Error('资金账户写入失败')
        const updated = await tx.capitalExpense.update({
          where: { id: exp.id },
          data: {
            status: 'PAID', paidAt: paidAtDate, paidById: userId,
            paymentMethod: parsed.data.paymentMethod, bankTxNo: parsed.data.bankTxNo || null,
          },
          include: { project: { select: { id: true, name: true } } },
        })
        await tx.capitalProject.update({
          where: { id: project.id }, data: { spent: project.spent.plus(exp.amount) },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: `付款 ${exp.vendor} ¥${exp.amount.toFixed(2)}` +
              (parsed.data.bankTxNo ? ` 流水 ${parsed.data.bankTxNo}` : ''),
            entityType: 'CapitalExpense', targetId: exp.id,
            metadata: { accountId: account.id, cashTransactionId: cashTx.id } as any,
          },
        })
        return { exp: updated, account, amount, paidAt: paidAtDate, duplicated: false }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'capital expense pay failed')
      return reply.status(500).send({ error: '资本支出付款失败，未保存任何变更' })
    }

    const ledger = cashLedgerAccount(result.account)
    let voucherId: string | null = null
    try {
      voucherId = await createVoucher({
        tenantId, date: result.paidAt,
        summary: `总部代付 ${result.exp.vendor} (${result.exp.project.name})`,
        sourceType: 'CapitalExpense', sourceId: result.exp.id,
        entries: [
          { accountCode: '1221', accountName: '其他应收款', debit: result.amount,
            summary: `${result.exp.project.name} · ${result.exp.vendor}` },
          { accountCode: ledger.code, accountName: ledger.name, credit: result.amount },
        ],
        createdById: userId, lockMode: 'auto', autoPost: true,
      })
    } catch (error: any) {
      req.log.warn({ err: error }, 'capital expense voucher failed after payment')
    }
    return {
      success: true, duplicated: result.duplicated, voucherId,
      voucherWarning: voucherId ? null : '资本支出已付款但凭证生成失败，可用相同参数重试补建',
    }
  })

  // ─── 录还款 (财务) ────────────────────────────
  const repaymentSchema = z.object({
    projectId: z.string().min(1),
    storeId: z.string().min(1),
    amount: money,
    paidAt: z.string().optional(),
    source: z.enum(['MANUAL', 'AUTO_FROM_PROFIT', 'TRANSFER']).optional().default('MANUAL'),
    bankTxNo: z.string().trim().min(1, '请填写唯一到账流水号').max(100),
    accountId: z.string().min(1, '请选择实际收款账户'),
    note: z.string().trim().max(500).optional(),
  }).strict()
  app.post('/repayments', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_OR_BOSS.has(role)) return reply.status(403).send({ error: '仅财务可录还款' })
    const parsed = repaymentSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const paidAtDate = parseBusinessDate(parsed.data.paidAt)
    if (!paidAtDate) return reply.status(400).send({ error: '还款日期无效' })
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
    if (paidAtDate > endOfToday) return reply.status(400).send({ error: '还款日期不能晚于今天' })

    let result: {
      repayment: any
      project: { id: string; name: string }
      account: { id: string; name: string; type: string; accountNo: string | null; cmbBindAccount: string | null }
      amount: number
      paidAt: Date
      duplicated: boolean
    }
    try {
      result = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capital-project:${parsed.data.projectId}`}))`
        const projectRows = await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "capital_projects"
          WHERE "id" = ${parsed.data.projectId} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `) as Array<{ id: string }>
        if (projectRows.length !== 1) throw httpError('项目不存在', 404)
        const project = await tx.capitalProject.findUniqueOrThrow({ where: { id: parsed.data.projectId } })
        if (!project.storeId || project.storeId !== parsed.data.storeId) {
          throw httpError('还款门店必须与项目关联门店一致', 409)
        }

        const existing = await tx.storeRepayment.findFirst({
          where: { tenantId, projectId: project.id, bankTxNo: parsed.data.bankTxNo },
        })
        if (existing) {
          const existingTx = await tx.cashTransaction.findFirst({
            where: { tenantId, refType: 'CapitalRepayment', refId: existing.id, direction: 1 },
            include: { account: { select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true } } },
          })
          if (!existingTx) throw httpError('还款记录存在但缺少资金流水，请先由财务修复', 409)
          const same = existing.storeId === parsed.data.storeId && existing.amount.equals(parsed.data.amount) &&
            existing.source === parsed.data.source && existingTx.accountId === parsed.data.accountId &&
            (!parsed.data.paidAt || businessDateKey(existing.paidAt) === parsed.data.paidAt)
          if (!same) throw httpError('该到账流水号已用于其他还款参数，不可重复使用', 409)
          return {
            repayment: existing, project: { id: project.id, name: project.name }, account: existingTx.account,
            amount: Number(existing.amount), paidAt: existing.paidAt, duplicated: true,
          }
        }

        const amountD = new Prisma.Decimal(parsed.data.amount)
        const remaining = project.spent.minus(project.repaidAmount)
        if (amountD.gt(remaining)) {
          throw httpError(
            `本次还款 ¥${amountD.toFixed(2)} 超剩余应还 ¥${remaining.toFixed(2)}`, 409,
          )
        }
        const account = await tx.cashAccount.findFirst({
          where: { id: parsed.data.accountId, tenantId, status: 'ACTIVE', type: { in: ['BANK', 'CASH'] } },
          select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true },
        })
        if (!account) throw httpError('实际收款账户不存在、已停用或类型不支持', 404)
        const repayment = await tx.storeRepayment.create({
          data: {
            tenantId, projectId: project.id, storeId: parsed.data.storeId,
            amount: amountD, paidAt: paidAtDate, source: parsed.data.source,
            bankTxNo: parsed.data.bankTxNo, note: parsed.data.note || null, initiatedById: userId,
          },
        })
        const cashTx = await writeCashTransaction(tx, {
          tenantId, accountId: account.id, direction: 1, category: '门店代付还款',
          amount: parsed.data.amount, note: `${project.name} · 流水 ${parsed.data.bankTxNo}`,
          txDate: paidAtDate, refType: 'CapitalRepayment', refId: repayment.id, createdById: userId,
        })
        if (!cashTx) throw new Error('资金账户写入失败')
        const newRepaid = project.repaidAmount.plus(amountD)
        const repaid = newRepaid.equals(project.spent)
        await tx.capitalProject.update({
          where: { id: project.id },
          data: {
            repaidAmount: newRepaid, status: repaid ? 'REPAID' : project.status,
            closedAt: repaid ? new Date() : project.closedAt,
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: `还款 ¥${amountD.toFixed(2)} → 代付项目 ${project.name}`,
            entityType: 'StoreRepayment', targetId: repayment.id,
            metadata: { accountId: account.id, cashTransactionId: cashTx.id } as any,
          },
        })
        return {
          repayment, project: { id: project.id, name: project.name }, account,
          amount: parsed.data.amount, paidAt: paidAtDate, duplicated: false,
        }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'capital repayment create failed')
      return reply.status(500).send({ error: '代付还款入账失败，未保存任何变更' })
    }

    const ledger = cashLedgerAccount(result.account)
    let voucherId: string | null = null
    try {
      voucherId = await createVoucher({
        tenantId, date: result.paidAt,
        summary: `门店偿还总部代付款 (${result.project.name})`,
        sourceType: 'CapitalRepayment', sourceId: result.repayment.id,
        entries: [
          { accountCode: ledger.code, accountName: ledger.name, debit: result.amount },
          { accountCode: '1221', accountName: '其他应收款', credit: result.amount,
            summary: `收回 ${result.project.name} 代付款` },
        ],
        createdById: userId, lockMode: 'auto', autoPost: true,
      })
    } catch (error: any) {
      req.log.warn({ err: error }, 'capital repayment voucher failed after receipt')
    }
    return reply.status(result.duplicated ? 200 : 201).send({
      ...result.repayment, duplicated: result.duplicated, voucherId,
      voucherWarning: voucherId ? null : '还款已入账但凭证生成失败，可用相同参数重试补建',
    })
  })
}
