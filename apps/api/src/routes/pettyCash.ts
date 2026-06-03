/**
 * 备用金管理 (P1-3)
 *
 * 流程: 店长申请 → 财务批准 + 发放 → 店长使用 + 记开支 → 月底退余款 + 财务对账归档
 *
 * Endpoints:
 *   GET    /api/petty-cash                   列表 (财务看所有, 店长看自己店)
 *   GET    /api/petty-cash/:id               详情 (含开支明细)
 *   POST   /api/petty-cash                   店长申请 { storeId, month, requestedAmount, requestNote? }
 *   PATCH  /api/petty-cash/:id/approve       财务批 { approvedAmount, paymentMethod?, bankTxNo? } (含发放)
 *   PATCH  /api/petty-cash/:id/reconcile     店长报账 { spentAmount, returnedAmount, reconcileNote? }
 *   PATCH  /api/petty-cash/:id/close         财务关账 (归档)
 *   PATCH  /api/petty-cash/:id/cancel        取消申请 (REQUESTED 时)
 *   POST   /api/petty-cash/:id/expenses      店长录开支 { date, category, amount, note?, attachments?, receiptId?, supplierId? }
 *   DELETE /api/petty-cash/:id/expenses/:eid 删除某条开支
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { createVoucher } from '../services/voucher'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const FINANCE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])
const STORE_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF_DIRECTOR'])

export const pettyCashRoutes: FastifyPluginAsync = async (app) => {

  // 列表
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, storeId, role } = req.user
    const { month, status, storeId: queryStoreId } = (req.query as any) || {}
    const where: any = { tenantId }
    if (month) where.month = month
    if (status) where.status = status
    // 店长仅看自己店
    if (STORE_ROLES.has(role)) {
      if (!storeId) return []
      where.storeId = storeId
    } else if (queryStoreId) {
      where.storeId = queryStoreId
    }
    if (!FINANCE_ROLES.has(role) && !STORE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权访问备用金' })
    }
    const items = await prisma.pettyCash.findMany({
      where,
      include: {
        store: { select: { id: true, name: true } },
        _count: { select: { expenses: true } },
      },
      orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
    })
    return items
  })

  // 详情 (含开支)
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, storeId, role } = req.user
    const item = await prisma.pettyCash.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        store: { select: { id: true, name: true } },
        expenses: { orderBy: { date: 'desc' } },
      },
    })
    if (!item) return reply.status(404).send({ error: '不存在' })
    if (STORE_ROLES.has(role) && item.storeId !== storeId) {
      return reply.status(403).send({ error: '非本店备用金' })
    }
    return item
  })

  // 店长申请
  const createSchema = z.object({
    storeId: z.string().optional(),    // 店长可不传, 默认自己店
    month: z.string().regex(/^\d{4}-\d{2}$/, 'month 必须 YYYY-MM'),
    requestedAmount: z.number().positive(),
    requestNote: z.string().max(500).optional(),
  })
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const targetStoreId = parsed.data.storeId || storeId
    if (!targetStoreId) return reply.status(400).send({ error: '请指定 storeId' })
    if (STORE_ROLES.has(role) && targetStoreId !== storeId) {
      return reply.status(403).send({ error: '只能为自己店申请' })
    }
    // 校验 store 属于 tenant
    const store = await prisma.store.findFirst({ where: { id: targetStoreId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })
    try {
      const item = await prisma.pettyCash.create({
        data: {
          tenantId, storeId: targetStoreId,
          month: parsed.data.month,
          requestedAmount: parsed.data.requestedAmount,
          requestedById: userId,
          requestNote: parsed.data.requestNote || null,
          status: 'REQUESTED',
        },
      })
      return reply.status(201).send(item)
    } catch (e: any) {
      if (e?.code === 'P2002') return reply.status(409).send({ error: '本月该店已有备用金记录, 不可重复申请' })
      throw e
    }
  })

  // BUG#12: 拆分 批准 / 发放 两步
  // 财务批 (REQUESTED → APPROVED), 不立即扣款
  const approveSchema = z.object({
    approvedAmount: z.number().positive(),
  })
  app.patch('/:id/approve', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可批' })
    const parsed = approveSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const item = await prisma.pettyCash.findFirst({ where: { id: req.params.id, tenantId } })
    if (!item) return reply.status(404).send({ error: '不存在' })
    if (item.status !== 'REQUESTED') return reply.status(400).send({ error: `当前状态 ${item.status} 不可批准` })
    const updated = await prisma.pettyCash.update({
      where: { id: item.id },
      data: {
        status: 'APPROVED',
        approvedById: userId, approvedAt: new Date(),
        approvedAmount: parsed.data.approvedAmount,
      },
    })
    return updated
  })

  // 财务发放 (APPROVED → PAID, 真扣款 + 建凭证)
  const paySchema = z.object({
    paymentMethod: z.string().optional(),
    bankTxNo: z.string().optional(),
  })
  app.patch('/:id/pay', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可发放' })
    const parsed = paySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const item = await prisma.pettyCash.findFirst({
      where: { id: req.params.id, tenantId },
      include: { store: { select: { name: true } } },
    })
    if (!item) return reply.status(404).send({ error: '不存在' })
    if (item.status !== 'APPROVED') return reply.status(400).send({ error: `当前状态 ${item.status} 不可发放 (需先 APPROVE)` })
    const now = new Date()
    const updated = await prisma.pettyCash.update({
      where: { id: item.id },
      data: {
        status: 'PAID',
        paymentMethod: parsed.data.paymentMethod || '现金',
        bankTxNo: parsed.data.bankTxNo || null,
        paidAt: now, paidById: userId,
      },
    })
    // BUG#5: 发放时自动建凭证 借 其他应收-备用金 / 贷 1001 库存现金 或 银行
    const amt = Number(item.approvedAmount || 0)
    const isCash = (parsed.data.paymentMethod || '现金') === '现金'
    const cashCode = isCash ? '1001' : '100201'
    const cashName = isCash ? '库存现金' : '中国银行1674'
    try {
      await createVoucher({
        tenantId,
        date: now,
        summary: `${item.month} 备用金发放 (${item.store.name})`,
        sourceType: 'PettyCashPay',
        sourceId: item.id,
        entries: [
          { accountCode: '1221', accountName: '其他应收款-备用金', debit: amt,
            summary: `${item.store.name} ${item.month} 备用金发放` },
          { accountCode: cashCode, accountName: cashName, credit: amt },
        ],
        createdById: userId,
        lockMode: 'auto',
        autoPost: true,
      })
    } catch (e: any) {
      console.warn('[pettyCash] approve voucher failed', e?.message)
    }
    return updated
  })

  // 店长报账 (月底退余款 + 申报花销)
  const reconcileSchema = z.object({
    spentAmount: z.number().nonnegative(),
    returnedAmount: z.number().nonnegative(),
    reconcileNote: z.string().max(500).optional(),
  })
  app.patch('/:id/reconcile', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    const parsed = reconcileSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const item = await prisma.pettyCash.findFirst({ where: { id: req.params.id, tenantId } })
    if (!item) return reply.status(404).send({ error: '不存在' })
    if (STORE_ROLES.has(role) && item.storeId !== storeId) return reply.status(403).send({ error: '非本店' })
    if (item.status !== 'PAID') return reply.status(400).send({ error: '仅已发放可报账' })
    // 花销 + 退款 应该 == 批准额
    const approved = Number(item.approvedAmount || 0)
    const total = parsed.data.spentAmount + parsed.data.returnedAmount
    if (Math.abs(total - approved) > 0.01) {
      return reply.status(400).send({
        error: `花销 + 退余款 = ${total.toFixed(2)} ≠ 批准 ${approved.toFixed(2)}, 差 ${(total - approved).toFixed(2)}`,
      })
    }
    const updated = await prisma.pettyCash.update({
      where: { id: item.id },
      data: {
        status: 'RECONCILING',
        spentAmount: parsed.data.spentAmount,
        returnedAmount: parsed.data.returnedAmount,
        reconcileNote: parsed.data.reconcileNote || null,
        reconciledById: userId, reconciledAt: new Date(),
      },
    })
    return updated
  })

  // 财务关账 (RECONCILING → CLOSED)
  app.patch('/:id/close', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可关账' })
    const item = await prisma.pettyCash.findFirst({
      where: { id: req.params.id, tenantId },
      include: { store: { select: { name: true } }, expenses: true },
    })
    if (!item) return reply.status(404).send({ error: '不存在' })
    if (item.status !== 'RECONCILING') return reply.status(400).send({ error: '仅 RECONCILING 可关账' })
    const updated = await prisma.pettyCash.update({ where: { id: item.id }, data: { status: 'CLOSED' } })
    // BUG#5: 关账时自动建凭证 借 5602 ¥spent + 借 1001 ¥returned / 贷 1221 ¥approved
    const now = new Date()
    const approved = Number(item.approvedAmount || 0)
    const spent = Number(item.spentAmount || 0)
    const returned = Number(item.returnedAmount || 0)
    if (approved > 0 && Math.abs(spent + returned - approved) < 0.01) {
      const entries: any[] = []
      if (spent > 0) entries.push({
        accountCode: '5602', accountName: '管理费用-备用金核销', debit: spent,
        summary: `${item.month} 备用金核销 (${item.store.name})`,
      })
      if (returned > 0) entries.push({
        accountCode: '1001', accountName: '库存现金', debit: returned,
        summary: '退余款入库',
      })
      entries.push({
        accountCode: '1221', accountName: '其他应收款-备用金',
        credit: approved,
      })
      try {
        await createVoucher({
          tenantId, date: now,
          summary: `${item.month} 备用金关账 (${item.store.name})`,
          sourceType: 'PettyCashClose', sourceId: item.id,
          entries, createdById: userId, lockMode: 'auto',
          autoPost: true,
        })
      } catch (e: any) {
        console.warn('[pettyCash] close voucher failed', e?.message)
      }
    }
    return updated
  })

  // 取消申请 (REQUESTED 时)
  app.patch('/:id/cancel', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const item = await prisma.pettyCash.findFirst({ where: { id: req.params.id, tenantId } })
    if (!item) return reply.status(404).send({ error: '不存在' })
    if (item.status !== 'REQUESTED') return reply.status(400).send({ error: '仅 REQUESTED 可取消' })
    if (!FINANCE_ROLES.has(role) && item.requestedById !== userId) {
      return reply.status(403).send({ error: '仅申请人或财务可取消' })
    }
    const updated = await prisma.pettyCash.update({ where: { id: item.id }, data: { status: 'CANCELED' } })
    return updated
  })

  // 录开支
  const expenseSchema = z.object({
    date: z.string(),
    category: z.string().min(1),
    amount: z.number().positive(),
    note: z.string().max(500).optional(),
    attachments: z.array(z.string()).optional().default([]),
    receiptId: z.string().optional(),
    supplierId: z.string().optional(),
  })
  app.post('/:id/expenses', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    const parsed = expenseSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const item = await prisma.pettyCash.findFirst({ where: { id: req.params.id, tenantId } })
    if (!item) return reply.status(404).send({ error: '备用金不存在' })
    if (STORE_ROLES.has(role) && item.storeId !== storeId) return reply.status(403).send({ error: '非本店' })
    if (!['PAID', 'RECONCILING'].includes(item.status)) {
      return reply.status(400).send({ error: '仅已发放/已报账时可录开支' })
    }
    const exp = await prisma.pettyCashExpense.create({
      data: {
        pettyCashId: item.id,
        date: new Date(parsed.data.date),
        category: parsed.data.category,
        amount: parsed.data.amount,
        note: parsed.data.note || null,
        attachments: parsed.data.attachments || [],
        receiptId: parsed.data.receiptId || null,
        supplierId: parsed.data.supplierId || null,
        createdById: userId,
      },
    })
    return reply.status(201).send(exp)
  })

  // 删除开支
  app.delete('/:id/expenses/:eid', auth(app), async (req: any, reply: any) => {
    const { tenantId, storeId, role } = req.user
    const item = await prisma.pettyCash.findFirst({ where: { id: req.params.id, tenantId } })
    if (!item) return reply.status(404).send({ error: '备用金不存在' })
    if (STORE_ROLES.has(role) && item.storeId !== storeId) return reply.status(403).send({ error: '非本店' })
    if (item.status === 'CLOSED') return reply.status(400).send({ error: '已归档不可删除开支' })
    await prisma.pettyCashExpense.deleteMany({ where: { id: req.params.eid, pettyCashId: item.id } })
    return { ok: true }
  })
}
