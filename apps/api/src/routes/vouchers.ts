/**
 * 财务凭证 HTTP 路由
 *
 * 列表 / 详情 / 审 / 反审 / 删 (草稿) / 导出 Excel / 手工建凭证 / 科目表
 *
 * 权限: 仅 FINANCE / ADMIN / SUPER_ADMIN
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import dayjs from 'dayjs'
import { createVoucher } from '../services/voucher'
import { exportVouchersExcel, ExportFilter } from '../services/voucher/export'
import { seedRestaurantCoA } from '../services/voucher/chart-of-accounts-restaurant'
import { assertPeriodOpen, closePeriod, reopenPeriod, getOrCreatePeriod, isPeriodLocked } from '../services/accountingPeriod'
import { generateCarryoverVoucher } from '../services/voucher/carryover'

const FINANCE_ROLES = ['FINANCE', 'ADMIN', 'SUPER_ADMIN']

const auth = (app: any) => ({ preHandler: [app.authenticate] })

function ensureFinance(role: string): boolean {
  return FINANCE_ROLES.includes(role)
}

const entrySchema = z.object({
  accountCode: z.string().min(1),
  accountName: z.string().min(1),
  debit: z.number().nonnegative().optional().default(0),
  credit: z.number().nonnegative().optional().default(0),
  summary: z.string().optional(),
})

const manualVoucherSchema = z.object({
  date: z.string(),
  summary: z.string().min(1),
  word: z.string().optional().default('记'),
  entries: z.array(entrySchema).min(2, '至少 2 条分录(借 + 贷)'),
})

export const voucherRoutes: FastifyPluginAsync = async (app) => {

  // ── 列表 (支持日期/状态过滤) ───────────────────────────
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '仅财务/老板可查看' })
    const { from, to, status, sourceType, page = '1', pageSize = '20' } = req.query as any
    const where: any = { tenantId }
    if (from || to) {
      where.date = {}
      if (from) where.date.gte = new Date(from)
      if (to) where.date.lte = new Date(to)
    }
    if (status && status !== 'ALL') where.status = status
    if (sourceType) where.sourceType = sourceType
    const p = Math.max(1, parseInt(page))
    const ps = Math.min(200, Math.max(1, parseInt(pageSize)))
    const [items, total] = await Promise.all([
      prisma.voucher.findMany({
        where, orderBy: [{ date: 'desc' }, { no: 'desc' }],
        skip: (p - 1) * ps, take: ps,
        include: { entries: { orderBy: { lineNo: 'asc' } } },
      }),
      prisma.voucher.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  // ── 详情 ──────────────────────────────────────────────
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const v = await prisma.voucher.findFirst({
      where: { id: req.params.id, tenantId },
      include: { entries: { orderBy: { lineNo: 'asc' } } },
    })
    if (!v) return reply.status(404).send({ error: '凭证不存在' })
    return v
  })

  // ── 手工创建凭证 ──────────────────────────────────────
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const parsed = manualVoucherSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message })
    }
    let id: string | null
    try {
      id = await createVoucher({
        tenantId,
        date: parsed.data.date,
        summary: parsed.data.summary,
        word: parsed.data.word,
        entries: parsed.data.entries,
        createdById: userId,
        sourceType: 'Manual',
        sourceId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        lockMode: 'strict',  // 手工凭证: 锁了直接拒绝
      })
    } catch (e: any) {
      return reply.status(423).send({ error: e.message || '月份已关账' })
    }
    if (!id) return reply.status(400).send({ error: '借贷不平或金额为 0' })
    const v = await prisma.voucher.findUnique({ where: { id }, include: { entries: true } })
    return reply.status(201).send(v)
  })

  // ── 审核 (DRAFT → POSTED) ─────────────────────────────
  app.patch('/:id/post', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const v = await prisma.voucher.findFirst({ where: { id: req.params.id, tenantId } })
    if (!v) return reply.status(404).send({ error: '凭证不存在' })
    if (v.status !== 'DRAFT') return reply.status(400).send({ error: `当前状态 ${v.status},不可审核` })
    // 月结锁账: 该凭证所属月份已关账, 不可审核
    if (await isPeriodLocked(tenantId, v.date)) {
      return reply.status(423).send({ error: `${dayjs(v.date).format('YYYY-MM')} 已关账, 不可审核` })
    }
    await prisma.voucher.update({
      where: { id: v.id },
      data: { status: 'POSTED', postedAt: new Date(), postedById: userId },
    })
    return { ok: true }
  })

  // ── 反审 (POSTED → DRAFT) — 仅未导出可反 ──────────────
  app.patch('/:id/unpost', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const v = await prisma.voucher.findFirst({ where: { id: req.params.id, tenantId } })
    if (!v) return reply.status(404).send({ error: '凭证不存在' })
    if (v.status !== 'POSTED') return reply.status(400).send({ error: '仅已审核可反审' })
    if (v.exportedAt) return reply.status(400).send({ error: '已导出的凭证不能反审 (避免好会计端不一致)' })
    if (await isPeriodLocked(tenantId, v.date)) {
      return reply.status(423).send({ error: `${dayjs(v.date).format('YYYY-MM')} 已关账, 不可反审` })
    }
    await prisma.voucher.update({
      where: { id: v.id },
      data: { status: 'DRAFT', postedAt: null, postedById: null },
    })
    return { ok: true }
  })

  // ── 作废 ──────────────────────────────────────────────
  app.patch('/:id/void', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const v = await prisma.voucher.findFirst({ where: { id: req.params.id, tenantId } })
    if (!v) return reply.status(404).send({ error: '凭证不存在' })
    if (v.exportedAt) return reply.status(400).send({ error: '已导出的凭证不能作废, 请在好会计端冲销' })
    if (await isPeriodLocked(tenantId, v.date)) {
      return reply.status(423).send({ error: `${dayjs(v.date).format('YYYY-MM')} 已关账, 不可作废` })
    }
    await prisma.voucher.update({ where: { id: v.id }, data: { status: 'VOIDED' } })
    return { ok: true }
  })

  // ── 月结锁账: 列表 ────────────────────────────────────
  app.get('/periods', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const periods = await prisma.accountingPeriod.findMany({
      where: { tenantId },
      orderBy: { month: 'desc' },
      take: 24,
    })
    return periods
  })

  // ── 月结锁账: 关账 (含期末结转) ─────────────────────
  // body: { month: 'YYYY-MM', closeNote?: string, withCarryover?: boolean (默认 true) }
  app.post('/periods/close', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const { month, closeNote, withCarryover = true } = req.body as any
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return reply.status(400).send({ error: 'month 必须 YYYY-MM' })
    }
    try {
      // 1. 期末结转: 生成 carryover 凭证 (本期主营收入 / 各类成本费用 → 本年利润)
      let carryoverId: string | undefined
      if (withCarryover) {
        carryoverId = await generateCarryoverVoucher({ tenantId, month, createdById: userId }) || undefined
      }
      // 2. 关账
      const p = await closePeriod({ tenantId, month, closedById: userId, closeNote, carryoverVoucherId: carryoverId })
      await prisma.opLog.create({
        data: { tenantId, userId,
          action: `关账 ${month}` + (carryoverId ? ` · 生成期末结转凭证` : ''),
          entityType: 'AccountingPeriod', targetId: p.id,
        },
      })
      return { ok: true, period: p, carryoverVoucherId: carryoverId || null }
    } catch (e: any) {
      return reply.status(400).send({ error: e.message })
    }
  })

  // ── 月结锁账: 重开 ──────────────────────────────────
  app.post('/periods/reopen', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const { month, reopenNote } = req.body as any
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return reply.status(400).send({ error: 'month 必须 YYYY-MM' })
    }
    if (!reopenNote?.trim()) return reply.status(400).send({ error: '重开必须填原因' })
    try {
      const p = await reopenPeriod({ tenantId, month, reopenedById: userId, reopenNote })
      await prisma.opLog.create({
        data: { tenantId, userId,
          action: `重开关账 ${month} - ${reopenNote}`,
          entityType: 'AccountingPeriod', targetId: p.id,
        },
      })
      return { ok: true, period: p }
    } catch (e: any) {
      return reply.status(400).send({ error: e.message })
    }
  })

  // ── 导出 Excel ───────────────────────────────────────
  // GET /api/vouchers/export?from=2026-05-01&to=2026-05-31&status=POSTED
  // 或 POST { voucherIds: [...] }
  app.get('/export', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const { from, to, status } = req.query as any
    const buf = await exportVouchersExcel({ tenantId, from, to, status: status || 'ALL' })
    const fname = `凭证_${dayjs(from || undefined).format('YYYYMMDD')}_${dayjs(to || undefined).format('YYYYMMDD')}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`)
      .send(buf)
  })

  app.post('/export', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const { voucherIds } = req.body as any
    if (!Array.isArray(voucherIds) || voucherIds.length === 0) {
      return reply.status(400).send({ error: 'voucherIds 必填' })
    }
    const buf = await exportVouchersExcel({ tenantId, voucherIds })
    const fname = `凭证_${dayjs().format('YYYYMMDD_HHmmss')}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`)
      .send(buf)
  })

  // ── 科目表 ───────────────────────────────────────────
  app.get('/coa', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    const accounts = await prisma.chartOfAccount.findMany({
      where: { tenantId, enabled: true },
      orderBy: { code: 'asc' },
    })
    return accounts
  })

  // ── 初始化餐饮标准科目表 (老板首次进入触发, 或财务手动调) ──
  app.post('/coa/seed', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!ensureFinance(role)) return reply.status(403).send({ error: '无权' })
    await seedRestaurantCoA(prisma, tenantId)
    const count = await prisma.chartOfAccount.count({ where: { tenantId } })
    return { ok: true, total: count }
  })
}
