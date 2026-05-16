/**
 * 财务 · 非订单类付款申请 (PAYMENT_REQUEST)
 *
 * 复用 Document 审批引擎:
 *  - POST /api/payment-requests              发起 (创建 Document type=PAYMENT_REQUEST)
 *  - GET  /api/payment-requests              列表 (按 status 过滤)
 *  - GET  /api/payment-requests/:id          详情
 *  - PATCH /api/payment-requests/:id/mark-paid 财务执行付款(标 PAID + 建凭证 + 写 CashTransaction)
 *
 * 普通审批走现成的 /api/documents/inbox 路径 (老板批 PAYMENT_REQUEST 也在那里)
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import dayjs from 'dayjs'
import { routeFor } from '../services/documentRouting'
import { createVoucher } from '../services/voucher'

const FINANCE_ROLES = ['FINANCE', 'ADMIN', 'SUPER_ADMIN']
const auth = (app: any) => ({ preHandler: [app.authenticate] })

// 用途分类 → 默认会计科目 (借方)
const USE_TO_ACCOUNT: Record<string, { code: string; name: string }> = {
  tax:       { code: '5403',   name: '税金及附加' },
  rent:      { code: '560117', name: '门店租金' },
  utility:   { code: '560120', name: '电费' },
  water:     { code: '560119', name: '水费' },
  repair:    { code: '560113', name: '维修费' },
  consulting:{ code: '560211', name: '中介服务费' },
  accounting:{ code: '560210', name: '代账、代办费' },
  mgmt_fee:  { code: '560212', name: '总部管理费' },
  marketing: { code: '560104', name: '广告费' },
  other:     { code: '560125', name: '销售费用-其他' },
}

const createSchema = z.object({
  payeeName:    z.string().min(1, '收款方必填').max(80),
  payeeBank:    z.string().max(60).optional().default(''),
  payeeAccount: z.string().max(40).optional().default(''),
  amount:       z.number().positive('金额必须 > 0'),
  usage:        z.enum(Object.keys(USE_TO_ACCOUNT) as [string, ...string[]]),
  customAccountCode: z.string().optional(),  // 财务可手动指定科目
  customAccountName: z.string().optional(),
  note:         z.string().max(500).optional().default(''),
  attachments:  z.array(z.string()).optional().default([]),
  bankFrom:     z.string().optional(),  // 从哪个银行付 (100201/100202/1001)
})

export const paymentRequestRoutes: FastifyPluginAsync = async (app) => {

  // ── 创建付款申请 ─────────────────────────────────
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    if (!FINANCE_ROLES.includes(role)) {
      return reply.status(403).send({ error: '仅财务可发起付款申请' })
    }
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message })
    }
    const d = parsed.data
    const accountInfo = d.customAccountCode && d.customAccountName
      ? { code: d.customAccountCode, name: d.customAccountName }
      : USE_TO_ACCOUNT[d.usage]
    if (!accountInfo) return reply.status(400).send({ error: '科目无效' })

    // 编号 + 路由
    const ym = dayjs().format('YYYYMM')
    const count = await prisma.document.count({ where: { tenantId, no: { startsWith: `DOC${ym}` } } })
    const no = `DOC${ym}${String(count + 1).padStart(6, '0')}`
    const plan = routeFor('PAYMENT_REQUEST' as any, d.amount)

    const usageLabel = ({
      tax: '税费', rent: '房租', utility: '电费', water: '水费',
      repair: '维修费', consulting: '咨询费', accounting: '代账费',
      mgmt_fee: '总部管理费', marketing: '广告费', other: '其他',
    } as any)[d.usage] || d.usage
    const title = `${usageLabel} · ${d.payeeName} · ¥${d.amount.toFixed(2)}`

    const doc = await prisma.document.create({
      data: {
        tenantId, no,
        type: 'PAYMENT_REQUEST',
        title, amount: d.amount,
        isOverThreshold: plan.isOverThreshold,
        thresholdRule: plan.thresholdRule || null,
        payload: {
          payeeName: d.payeeName, payeeBank: d.payeeBank, payeeAccount: d.payeeAccount,
          usage: d.usage, usageLabel,
          accountCode: accountInfo.code, accountName: accountInfo.name,
          note: d.note, attachments: d.attachments,
          bankFrom: d.bankFrom || null,
        } as any,
        storeId: storeId || null,
        initiatorId: userId,
        status: plan.autoApprove ? 'AUTO_APPROVED' : 'PENDING',
        finalizedAt: plan.autoApprove ? new Date() : null,
        steps: {
          create: plan.steps.map((r: any, i: number) => ({
            seq: i + 1, approverRole: r, status: 'PENDING' as const,
          })),
        },
      },
      include: { steps: true },
    })
    return reply.status(201).send(doc)
  })

  // ── 列表 ──────────────────────────────────────────
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role) && role !== 'ADMIN') {
      return reply.status(403).send({ error: '无权' })
    }
    const { status, page = '1', pageSize = '20' } = req.query as any
    const where: any = { tenantId, type: 'PAYMENT_REQUEST' }
    if (status && status !== 'ALL') where.status = status
    const p = Math.max(1, parseInt(page))
    const ps = Math.min(100, Math.max(1, parseInt(pageSize)))
    const [items, total] = await Promise.all([
      prisma.document.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (p - 1) * ps, take: ps,
        include: {
          initiator: { select: { name: true } },
          store: { select: { name: true } },
          steps: true,
        },
      }),
      prisma.document.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  // ── 详情 ──────────────────────────────────────────
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role) && role !== 'ADMIN') {
      return reply.status(403).send({ error: '无权' })
    }
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, tenantId, type: 'PAYMENT_REQUEST' },
      include: {
        initiator: { select: { id: true, name: true, role: true } },
        store: { select: { id: true, name: true } },
        steps: { include: { approver: { select: { name: true, role: true } } } },
        decisions: { include: { user: { select: { name: true, role: true } } }, orderBy: { createdAt: 'desc' } },
      },
    })
    if (!doc) return reply.status(404).send({ error: '付款申请不存在' })
    return doc
  })

  // ── 标记已付 (财务执行后回写) ──────────────────────
  //  必要前置: status = APPROVED 或 AUTO_APPROVED
  //  执行后: status -> PAID(payload.paidAt), 写 CashTransaction, 自动建凭证草稿
  app.patch('/:id/mark-paid', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) {
      return reply.status(403).send({ error: '仅财务可执行' })
    }
    const { bankFrom, bankTxNo, note } = (req.body || {}) as any
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, tenantId, type: 'PAYMENT_REQUEST' },
    })
    if (!doc) return reply.status(404).send({ error: '付款申请不存在' })
    if (!['APPROVED', 'AUTO_APPROVED'].includes(doc.status)) {
      return reply.status(400).send({ error: `当前状态 ${doc.status}, 不可执行付款` })
    }
    const payload: any = doc.payload || {}
    if (payload.paidAt) return reply.status(400).send({ error: '已标记付款, 请勿重复' })

    const amount = Number(doc.amount || 0)
    if (amount <= 0) return reply.status(400).send({ error: '金额无效' })

    // 决定付款账户 (用户传 或 payload 里的 或默认中国银行)
    const bankCode = bankFrom || payload.bankFrom || '100201'
    const bankName = bankCode === '100202' ? '建设银行3618'
                  : bankCode === '1001'   ? '库存现金'
                  : '中国银行1674'

    // 找 CashAccount 用于 CashTransaction. 选 tenant 第一个 BANK 账户
    const account = await prisma.cashAccount.findFirst({
      where: { tenantId, type: 'BANK' as any },
    })

    const now = new Date()
    await prisma.$transaction(async (tx) => {
      // 1. 写 CashTransaction (审计 + 现金流可见)
      if (account) {
        const last = await tx.cashTransaction.findFirst({
          where: { accountId: account.id }, orderBy: { txDate: 'desc' },
        })
        const balanceAfter = (Number(last?.balanceAfter || 0)) - amount
        await tx.cashTransaction.create({
          data: {
            tenantId, accountId: account.id,
            direction: -1, amount,
            balanceAfter,
            category: `付款申请-${payload.usageLabel || '其他'}`,
            note: `${doc.no} ${payload.payeeName}${note ? ' · ' + note : ''}`,
            txDate: now,
            refType: 'PaymentRequest', refId: doc.id,
            createdById: userId,
          },
        })
      }
      // 2. 更新 Document payload 加 paidAt
      await tx.document.update({
        where: { id: doc.id },
        data: {
          payload: {
            ...payload,
            paidAt: now.toISOString(),
            paidBy: userId,
            bankFrom: bankCode,
            bankTxNo: bankTxNo || null,
            paidNote: note || null,
          } as any,
        },
      })
      // 3. opLog
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `执行付款 ${doc.no} (${payload.payeeName}, ¥${amount}) → ${bankName}`,
          target: doc.no, entityType: 'Document', targetId: doc.id,
        },
      })
    })

    // 4. 生成凭证草稿 (借: 费用科目 / 贷: 银行存款)
    try {
      const vid = await createVoucher({
        tenantId,
        date: now,
        summary: `${doc.no} ${payload.payeeName} ${payload.usageLabel || ''}`,
        sourceType: 'PaymentRequest',
        sourceId: doc.id,
        entries: [
          { accountCode: payload.accountCode, accountName: payload.accountName, debit: amount,
            summary: `${payload.payeeName} ${payload.usageLabel || ''}` },
          { accountCode: bankCode, accountName: bankName, credit: amount },
        ],
        createdById: userId,
      })
      return reply.send({ ok: true, voucherId: vid })
    } catch (e: any) {
      req.log.warn({ err: e }, '付款申请凭证生成失败 (主流程已完成)')
      return reply.send({ ok: true, voucherId: null, voucherWarning: e.message })
    }
  })

  // ── 撤回 (发起人, 仅 PENDING 可撤) ─────────────────
  app.patch('/:id/cancel', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, tenantId, type: 'PAYMENT_REQUEST' },
    })
    if (!doc) return reply.status(404).send({ error: '不存在' })
    if (doc.status !== 'PENDING') return reply.status(400).send({ error: `当前状态 ${doc.status}, 不可撤回` })
    if (doc.initiatorId !== userId && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅发起人可撤回' })
    }
    await prisma.document.update({
      where: { id: doc.id }, data: { status: 'CANCELED', finalizedAt: new Date() },
    })
    return { ok: true }
  })

  // 用途科目映射 (前端下拉用)
  app.get('/usage-options', auth(app), async (_req: any) => {
    return Object.entries(USE_TO_ACCOUNT).map(([key, v]) => ({
      key,
      label: ({
        tax: '税费', rent: '房租', utility: '电费', water: '水费',
        repair: '维修费', consulting: '咨询费', accounting: '代账费',
        mgmt_fee: '总部管理费', marketing: '广告费', other: '其他',
      } as any)[key] || key,
      accountCode: v.code, accountName: v.name,
    }))
  })
}
