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
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { routeFor } from '../services/documentRouting'
import { nextDocumentNo } from '../services/documentNo'
import { createVoucher } from '../services/voucher'
import { writeCashTransaction } from '../services/cashbook'
import { requireStoreBinding } from '../lib/auth-scope'

const FINANCE_ROLES = ['FINANCE', 'ADMIN', 'SUPER_ADMIN']
// BUG#1: 真实业务里店长 / 总厨 也要能发起付款申请 (店里有维修/水电/采购需要付款)
// 创建权限放宽到店长 + 厨师长 + 总厨, 审批仍由财务/老板把关
const CREATE_ROLES = ['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'MANAGER', 'KITCHEN_LEAD', 'CHEF_DIRECTOR']
const auth = (app: any) => ({ preHandler: [app.authenticate] })
const BANK_CODES = ['100201', '100202', '1002', '1001'] as const
const DOCUMENT_STATUSES = ['PENDING', 'APPROVED', 'AUTO_APPROVED', 'REJECTED', 'CANCELED'] as const

const moneySchema = z.number()
  .positive('金额必须 > 0')
  .max(999_999_999_999.99, '金额超出系统上限')
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, '金额最多保留两位小数')
const optionalText = (max: number) => z.string().trim().max(max).optional()

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
  payeeName:    z.string().trim().min(1, '收款方必填').max(80),
  payeeBank:    z.string().trim().max(60).optional().default(''),
  payeeAccount: z.string().trim().max(40).optional().default(''),
  amount:       moneySchema,
  usage:        z.enum(Object.keys(USE_TO_ACCOUNT) as [string, ...string[]]),
  customAccountCode: optionalText(16),  // 仅财务可手动指定科目
  customAccountName: optionalText(80),
  note:         z.string().trim().max(500).optional().default(''),
  attachments:  z.array(z.string().trim().min(1).max(500)).max(10).optional().default([]),
  bankFrom:     z.enum(BANK_CODES).optional(),
}).strict()

const listSchema = z.object({
  status: z.union([z.enum(DOCUMENT_STATUSES), z.literal('ALL')]).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
}).strict()

const markPaidSchema = z.object({
  bankFrom: z.enum(BANK_CODES).optional(),
  bankTxNo: optionalText(100),
  note: optionalText(500),
}).strict()

function normalizeBankCode(code: string | undefined): '100201' | '100202' | '1001' {
  return code === '1002' ? '100201' : code === '100202' || code === '1001' ? code : '100201'
}

function bankInfo(code: '100201' | '100202' | '1001') {
  if (code === '100202') return { name: '建设银行3618', type: 'BANK' as const, suffix: '3618', bankKeyword: '建设银行' }
  if (code === '1001') return { name: '库存现金', type: 'CASH' as const, suffix: null, bankKeyword: null }
  return { name: '中国银行1674', type: 'BANK' as const, suffix: '1674', bankKeyword: '中国银行' }
}

async function findPaymentAccount(tx: any, tenantId: string, code: '100201' | '100202' | '1001') {
  const info = bankInfo(code)
  if (info.type === 'CASH') {
    return tx.cashAccount.findFirst({
      where: { tenantId, type: 'CASH', status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    })
  }
  return tx.cashAccount.findFirst({
    where: {
      tenantId, type: 'BANK', status: 'ACTIVE',
      OR: [
        { accountNo: { endsWith: info.suffix! } },
        { name: { contains: info.suffix! } },
        { name: { contains: info.bankKeyword! } },
        { bankName: { contains: info.bankKeyword! } },
      ],
    },
    orderBy: { id: 'asc' },
    select: { id: true, name: true },
  })
}

export const paymentRequestRoutes: FastifyPluginAsync = async (app) => {

  // ── 创建付款申请 (店长/厨师长/财务都可发起, 审批由财务+老板把关) ──
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    if (!CREATE_ROLES.includes(role)) {
      return reply.status(403).send({ error: '此角色不可发起付款申请' })
    }
    const documentStoreId = requireStoreBinding(role, storeId) || storeId
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message })
    }
    const d = parsed.data
    const hasCustomCode = Boolean(d.customAccountCode)
    const hasCustomName = Boolean(d.customAccountName)
    if (hasCustomCode !== hasCustomName) {
      return reply.status(400).send({ error: '自定义科目编码和名称必须同时填写' })
    }
    if ((hasCustomCode || hasCustomName) && !FINANCE_ROLES.includes(role)) {
      return reply.status(403).send({ error: '仅财务可手动指定会计科目' })
    }
    const accountInfo = d.customAccountCode && d.customAccountName
      ? { code: d.customAccountCode, name: d.customAccountName }
      : USE_TO_ACCOUNT[d.usage]
    if (!accountInfo) return reply.status(400).send({ error: '科目无效' })

    const plan = routeFor('PAYMENT_REQUEST' as any, d.amount)

    const usageLabel = ({
      tax: '税费', rent: '房租', utility: '电费', water: '水费',
      repair: '维修费', consulting: '咨询费', accounting: '代账费',
      mgmt_fee: '总部管理费', marketing: '广告费', other: '其他',
    } as any)[d.usage] || d.usage
    const title = `${usageLabel} · ${d.payeeName} · ¥${d.amount.toFixed(2)}`

    const doc = await prisma.$transaction(async tx => {
      const no = await nextDocumentNo(tx, tenantId)
      const created = await tx.document.create({
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
          storeId: documentStoreId || null,
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
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: plan.autoApprove
            ? `提交付款申请 ${no} ¥${d.amount.toFixed(2)} → 阈值内自动通过`
            : `提交付款申请 ${no} ¥${d.amount.toFixed(2)} → ${plan.steps.join(' → ')}`,
          target: no, entityType: 'Document', targetId: created.id,
        },
      })
      return created
    })
    return reply.status(201).send(doc)
  })

  // ── 列表 ──────────────────────────────────────────
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role) && role !== 'ADMIN') {
      return reply.status(403).send({ error: '无权' })
    }
    const parsed = listSchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { status, page: p, pageSize: ps } = parsed.data
    const where: any = { tenantId, type: 'PAYMENT_REQUEST' }
    if (status && status !== 'ALL') where.status = status
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
  //  执行后: 保持审批终态, payload 写 paidAt, 原子更新资金余额与流水, 自动建已记账凭证
  app.patch('/:id/mark-paid', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) {
      return reply.status(403).send({ error: '仅财务可执行' })
    }
    const parsed = markPaidSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })

    let result: {
      duplicated: boolean
      doc: { id: string; no: string; amount: Prisma.Decimal | null; payload: unknown }
      payload: any
      amount: number
      bankCode: '100201' | '100202' | '1001'
      bankName: string
      paidAt: Date
    }
    try {
      result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document:${id}`}))`
        const rows = await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "documents"
          WHERE "id" = ${id} AND "tenantId" = ${tenantId} AND "type" = 'PAYMENT_REQUEST'
          FOR UPDATE
        `) as Array<{ id: string }>
        if (rows.length !== 1) throw Object.assign(new Error('付款申请不存在'), { statusCode: 404 })
        const doc = await tx.document.findUniqueOrThrow({
          where: { id }, select: { id: true, no: true, amount: true, payload: true, status: true },
        })
        const payload: any = doc.payload || {}
        const amount = Number(doc.amount || 0)
        if (!Number.isFinite(amount) || amount <= 0) {
          throw Object.assign(new Error('金额无效'), { statusCode: 400 })
        }
        const requestedCode = parsed.data.bankFrom || payload.bankFrom || '100201'
        const bankCode = normalizeBankCode(requestedCode)
        const info = bankInfo(bankCode)
        if (payload.paidAt) {
          return {
            duplicated: true, doc, payload, amount,
            bankCode: normalizeBankCode(payload.bankFrom), bankName: bankInfo(normalizeBankCode(payload.bankFrom)).name,
            paidAt: new Date(payload.paidAt),
          }
        }
        if (!['APPROVED', 'AUTO_APPROVED'].includes(doc.status)) {
          throw Object.assign(new Error(`当前状态 ${doc.status}, 不可执行付款`), { statusCode: 409 })
        }
        const account = await findPaymentAccount(tx, tenantId, bankCode)
        if (!account) {
          throw Object.assign(new Error(`未配置可用的${info.name}资金账户，请先在资金台账配置`), { statusCode: 409 })
        }
        const now = new Date()
        const cashTx = await writeCashTransaction(tx, {
          tenantId, accountId: account.id, direction: -1, amount,
          category: `付款申请-${payload.usageLabel || '其他'}`,
          note: `${doc.no} ${payload.payeeName}${parsed.data.note ? ' · ' + parsed.data.note : ''}`,
          txDate: now, refType: 'PaymentRequest', refId: doc.id, createdById: userId,
        })
        if (!cashTx) throw new Error('资金账户写入失败')
        const nextPayload = {
          ...payload,
          paidAt: now.toISOString(), paidBy: userId,
          bankFrom: bankCode, bankTxNo: parsed.data.bankTxNo || null,
          paidNote: parsed.data.note || null, cashAccountId: account.id,
          cashTransactionId: cashTx.id,
        }
        await tx.document.update({ where: { id: doc.id }, data: { payload: nextPayload as any } })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: `执行付款 ${doc.no} (${payload.payeeName}, ¥${amount.toFixed(2)}) → ${info.name}`,
            target: doc.no, entityType: 'Document', targetId: doc.id,
            metadata: { cashAccountId: account.id, cashTransactionId: cashTx.id } as any,
          },
        })
        return { duplicated: false, doc, payload: nextPayload, amount, bankCode, bankName: info.name, paidAt: now }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'payment request mark-paid failed')
      return reply.status(500).send({ error: '付款执行失败，未保存任何变更' })
    }

    // 凭证在真实付款事务之后幂等补建；失败不会重复扣款，重试 mark-paid 可再次补建。
    let vid: string | null = null
    let voucherWarning: string | null = null
    try {
      vid = await createVoucher({
        tenantId,
        date: result.paidAt,
        summary: `${result.doc.no} ${result.payload.payeeName} ${result.payload.usageLabel || ''}`,
        sourceType: 'PaymentRequest',
        sourceId: result.doc.id,
        entries: [
          { accountCode: result.payload.accountCode, accountName: result.payload.accountName, debit: result.amount,
            summary: `${result.payload.payeeName} ${result.payload.usageLabel || ''}` },
          { accountCode: result.bankCode, accountName: result.bankName, credit: result.amount },
        ],
        createdById: userId,
        autoPost: true,
      })
    } catch (e: any) {
      req.log.warn({ err: e }, '付款申请凭证生成失败 (主流程已完成)')
      voucherWarning = '凭证生成失败，请在失败队列补建或重新执行“标记已付”'
    }

    // BUG#2: voucherId 写回 payload, PC UI 才能展示"关联凭证"
    if (vid) {
      try {
        await prisma.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document:${result.doc.id}`}))`
          const fresh = await tx.document.findFirst({
            where: { id: result.doc.id, tenantId, type: 'PAYMENT_REQUEST' }, select: { payload: true },
          })
          if (!fresh) throw new Error('付款申请不存在')
          const freshPayload: any = fresh.payload || {}
          await tx.document.update({
            where: { id: result.doc.id }, data: { payload: { ...freshPayload, voucherId: vid } as any },
          })
        })
      } catch (e: any) {
        req.log.warn({ err: e }, 'voucherId 回写 payload 失败 (不阻断)')
      }
    }

    return reply.send({ ok: true, duplicated: result.duplicated, voucherId: vid, voucherWarning })
  })

  // ── 撤回 (发起人, 仅 PENDING 可撤) ─────────────────
  app.patch('/:id/cancel', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    try {
      const duplicated = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document:${id}`}))`
        const doc = await tx.document.findFirst({
          where: { id, tenantId, type: 'PAYMENT_REQUEST' },
        })
        if (!doc) throw Object.assign(new Error('不存在'), { statusCode: 404 })
        if (doc.initiatorId !== userId && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
          throw Object.assign(new Error('仅发起人可撤回'), { statusCode: 403 })
        }
        if (doc.status === 'CANCELED') return true
        if (doc.status !== 'PENDING') {
          throw Object.assign(new Error(`当前状态 ${doc.status}, 不可撤回`), { statusCode: 409 })
        }
        await tx.document.update({
          where: { id: doc.id }, data: { status: 'CANCELED', finalizedAt: new Date() },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, action: `撤回付款申请 ${doc.no}`,
            target: doc.no, entityType: 'Document', targetId: doc.id,
          },
        })
        return false
      })
      return { ok: true, duplicated }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'payment request cancel failed')
      return reply.status(500).send({ error: '撤回失败，未保存任何变更' })
    }
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
