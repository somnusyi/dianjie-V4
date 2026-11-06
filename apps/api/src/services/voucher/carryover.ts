/**
 * 期末结转凭证 (Carryover)
 *
 * 月末关账时, 把本月所有损益类科目余额结转到 **本年利润**:
 *   - 收入类: 借收入 / 贷本年利润 (清零收入)
 *   - 成本/费用类: 借本年利润 / 贷成本费用 (清零成本费用)
 *
 * 兼容两套会计科目体系 (通过 coa-config.ts):
 *   - 企业会计准则 2006 (dianjie/瑶海店实际用): 5xxx 损益 / 3103 本年利润
 *   - 好会计旧准则/小企业准则 (seed 模板): 6xxx 损益 / 4103 本年利润
 *
 * 数据源:
 *   - 本月 status=POSTED 凭证的分录 (DRAFT 不算; 关账前财务应已审完)
 *   - 按 4 位前缀归到 PNL_BUCKETS (coa-config.ts), 同 bucket 多前缀合并
 *
 * 同月只保留一个结转；仅未审未导出草稿可以重算并审计，确认后才允许关账
 */
import { Prisma, prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { nextVoucherNo, VoucherEntryInput } from './index'
import { PNL_BUCKETS, resolveProfitAccount } from './coa-config'
import { monthRangeForDateCol } from '../../lib/dateRange'

interface CarryoverOpts {
  tenantId: string
  month: string                  // YYYY-MM
  createdById?: string | null
  /** dry run: 不落库, 只返回会生成的分录, 用于预览 */
  dryRun?: boolean
}

export interface CarryoverPreview {
  month: string
  buckets: Array<{
    key: string
    name: string
    side: 'revenue' | 'expense'
    prefixesHit: string[]
    debit: number
    credit: number
    net: number           // revenue: credit-debit; expense: debit-credit
  }>
  entries: VoucherEntryInput[]
  profitAccount: { code: string; name: string }
  profitNet: number       // + = 净利, - = 净亏
  totalDebit: number
  totalCredit: number
  balanced: boolean
}

/** 仅查算不落库. includeDraft: 若 true 把 DRAFT 也计入预览 (验证用) */
export async function previewCarryover(opts: { tenantId: string; month: string; includeDraft?: boolean }): Promise<CarryoverPreview & { includedDraft: boolean }> {
  return computeCarryover(opts.tenantId, opts.month, opts.includeDraft || false)
}

async function computeCarryover(tenantId: string, month: string, includeDraft = false, db: Prisma.TransactionClient = prisma): Promise<CarryoverPreview & { includedDraft: boolean }> {
  // 用 UTC 边界避免 +8 时区把 4/30 凭证算成 5月 (PG DATE 列丢时间问题)
  const { start, end } = monthRangeForDateCol(month)
  const profitAccount = await resolveProfitAccount(tenantId, db)

  // 1. 拉本月凭证的所有分录 (默认仅 POSTED; preview 可选 includeDraft 看"假如 POST 了" 场景)
  const allowedStatuses: ('POSTED'|'DRAFT')[] = includeDraft ? ['POSTED', 'DRAFT'] : ['POSTED']
  const entries = await db.voucherEntry.findMany({
    where: {
      voucher: {
        tenantId,
        status: { in: allowedStatuses },
        date: { gte: start, lte: end },
        NOT: { sourceType: 'Carryover' },   // 不结转自己
      },
    },
    select: { accountCode: true, debit: true, credit: true },
  })

  // 2. 按 bucket 归集 (同 bucket 多前缀合并)
  const buckets = PNL_BUCKETS.map(b => ({
    key: b.key, name: b.name, side: b.side, prefixes: b.prefixes,
    prefixesHit: new Set<string>(),
    debit: 0, credit: 0,
  }))

  for (const e of entries) {
    const top4 = e.accountCode.slice(0, 4)
    const bucket = buckets.find(b => b.prefixes.includes(top4))
    if (!bucket) continue
    bucket.prefixesHit.add(top4)
    bucket.debit += Math.round(Number(e.debit) * 100)
    bucket.credit += Math.round(Number(e.credit) * 100)
  }

  for (const bucket of buckets) { bucket.debit /= 100; bucket.credit /= 100 }

  // 3. 生成 carryover 分录
  // 收入: 期末贷余 (credit > debit), 结转: 借收入 / 贷本年利润 (把收入抹平)
  // 费用: 期末借余 (debit > credit), 结转: 贷费用 / 借本年利润
  const carryEntries: VoucherEntryInput[] = []
  let profitDebit = 0      // 累计借方本年利润 = 总费用净额
  let profitCredit = 0     // 累计贷方本年利润 = 总收入净额

  for (const b of buckets) {
    const net = Math.round((b.side === 'revenue' ? (b.credit - b.debit) : (b.debit - b.credit)) * 100) / 100
    if (Math.abs(net) < 0.01) continue
    // 用首个命中的前缀作为分录的 accountCode (一般 dianjie 永远只命中 5xxx 或 6xxx 其中一组)
    const hitCode = Array.from(b.prefixesHit)[0] || b.prefixes[0]
    if (b.side === 'revenue') {
      // 正常: net > 0, 借 收入(净额) / 贷 本年利润
      // 异常 (退货过多): net < 0, 反向
      carryEntries.push({
        accountCode: hitCode,
        accountName: b.name,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? -net : 0,
        summary: `结转${b.name}`,
      })
      profitCredit += net > 0 ? net : 0
      profitDebit  += net < 0 ? -net : 0
    } else {
      // 正常: net > 0, 借 本年利润 / 贷 费用
      carryEntries.push({
        accountCode: hitCode,
        accountName: b.name,
        debit: net < 0 ? -net : 0,
        credit: net > 0 ? net : 0,
        summary: `结转${b.name}`,
      })
      profitDebit  += net > 0 ? net : 0
      profitCredit += net < 0 ? -net : 0
    }
  }

  // 4. 本年利润对冲
  const profitNet = Math.round((profitCredit - profitDebit) * 100) / 100   // + = 盈利, - = 亏损
  if (profitNet >= 0.01) {
    // 盈利: 贷 本年利润
    carryEntries.push({
      accountCode: profitAccount.code, accountName: profitAccount.name,
      credit: profitNet, summary: `结转本月净利`,
    })
  } else if (profitNet <= -0.01) {
    // 亏损: 借 本年利润
    carryEntries.push({
      accountCode: profitAccount.code, accountName: profitAccount.name,
      debit: -profitNet, summary: `结转本月亏损`,
    })
  }

  const totalDebit = carryEntries.reduce((s, e) => s + Number(e.debit || 0), 0)
  const totalCredit = carryEntries.reduce((s, e) => s + Number(e.credit || 0), 0)

  return {
    month,
    buckets: buckets.map(b => ({
      key: b.key, name: b.name, side: b.side,
      prefixesHit: Array.from(b.prefixesHit),
      debit: b.debit, credit: b.credit,
      net: b.side === 'revenue' ? (b.credit - b.debit) : (b.debit - b.credit),
    })),
    entries: carryEntries,
    profitAccount,
    profitNet,
    totalDebit: Math.round(totalDebit * 100) / 100,
    totalCredit: Math.round(totalCredit * 100) / 100,
    balanced: Math.abs(totalDebit - totalCredit) < 0.01,
    includedDraft: includeDraft,
  }
}

/** Amounts and account codes, rather than generated row IDs, define a confirmed carryover. */
function entrySnapshot(entries: Array<{ accountCode: string; debit?: unknown; credit?: unknown }>) {
  return entries.map(e => ({ accountCode: e.accountCode,
    debit: Math.round(Number(e.debit || 0) * 100), credit: Math.round(Number(e.credit || 0) * 100),
  })).sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.debit - b.debit || a.credit - b.credit)
}
function matches(v: { totalDebit: unknown; totalCredit: unknown; entries: any[] }, p: CarryoverPreview) {
  return Math.round(Number(v.totalDebit) * 100) === Math.round(p.totalDebit * 100)
    && Math.round(Number(v.totalCredit) * 100) === Math.round(p.totalCredit * 100)
    && JSON.stringify(entrySnapshot(v.entries)) === JSON.stringify(entrySnapshot(p.entries))
}
async function lockMonth(tx: Prisma.TransactionClient, tenantId: string, month: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`voucher-source:${tenantId}:Carryover:${month}`}))::text AS locked`
}
async function requireOpen(tx: Prisma.TransactionClient, tenantId: string, month: string) {
  const period = await tx.accountingPeriod.findUnique({ where: { tenantId_month: { tenantId, month } } })
  if (period?.status === 'CLOSED') throw new Error(`${month} 已关账，请先重开`)
}

/** Prepare/recalculate only an unexported draft. Confirmation is a separate finance action. */
export async function generateCarryoverVoucher(opts: CarryoverOpts): Promise<string | null> {
  const { tenantId, month, createdById = null, dryRun = false } = opts
  if (dryRun) { await computeCarryover(tenantId, month); return null }
  return prisma.$transaction(async tx => {
    await lockMonth(tx, tenantId, month)
    await requireOpen(tx, tenantId, month)
    const existing = await tx.voucher.findFirst({ where: { tenantId, sourceType: 'Carryover', sourceId: month }, include: { entries: true } })
    const preview = await computeCarryover(tenantId, month, false, tx)
    if (!preview.balanced) throw new Error('结转借贷不平，不能生成或修改')
    if (existing && matches(existing, preview) && existing.status !== 'VOIDED') return existing.id
    if (existing && (existing.status !== 'DRAFT' || existing.exportedAt)) {
      throw new Error('原结转已审核、已导出或已作废，不能自动重算；请由财务处理后再结转')
    }
    if (!existing && preview.entries.length === 0) return null
    const summary = `${month} 期末结转 损益 → ${preview.profitAccount.name}`
    const entries = preview.entries.map((e, i) => ({ lineNo: i + 1, summary: e.summary || summary,
      accountCode: e.accountCode, accountName: e.accountName, debit: Number(e.debit || 0), credit: Number(e.credit || 0) }))
    let id: string
    if (existing) {
      // The conditional update also protects against approval/export racing with this transaction.
      const changed = await tx.voucher.updateMany({ where: { id: existing.id, status: 'DRAFT', exportedAt: null, updatedAt: existing.updatedAt },
        data: { summary, totalDebit: preview.totalDebit, totalCredit: preview.totalCredit } })
      if (changed.count !== 1) throw new Error('结转状态已变化，请刷新重试')
      await tx.voucherEntry.deleteMany({ where: { voucherId: existing.id } })
      if (entries.length) await tx.voucherEntry.createMany({ data: entries.map(e => ({ ...e, voucherId: existing.id })) })
      id = existing.id
    } else {
      const date = monthRangeForDateCol(month).end
      const no = await nextVoucherNo(tx, tenantId, date)
      id = (await tx.voucher.create({ data: { tenantId, no, date, word: '结转', summary,
        sourceType: 'Carryover', sourceId: month, status: 'DRAFT', createdById,
        totalDebit: preview.totalDebit, totalCredit: preview.totalCredit, entries: { create: entries } } })).id
    }
    await tx.opLog.create({ data: { tenantId, userId: createdById, entityType: 'Voucher', targetId: id,
      action: existing ? `重算结转 ${month}` : `生成结转草稿 ${month}`,
      metadata: { before: existing ? { totalDebit: String(existing.totalDebit), totalCredit: String(existing.totalCredit), entries: entrySnapshot(existing.entries) } : null,
        after: { totalDebit: preview.totalDebit, totalCredit: preview.totalCredit, entries: entrySnapshot(entries) } } } })
    return id
  }, { isolationLevel: 'Serializable' })
}

/** Validate the current calculation before finance can confirm the carryover. */
export async function confirmCarryover(tenantId: string, id: string, userId: string) {
  return prisma.$transaction(async tx => {
    const v = await tx.voucher.findFirst({ where: { id, tenantId, sourceType: 'Carryover' }, include: { entries: true } })
    if (!v || !v.sourceId) throw new Error('结转凭证不存在')
    await lockMonth(tx, tenantId, v.sourceId)
    await requireOpen(tx, tenantId, v.sourceId)
    if (v.status !== 'DRAFT') throw new Error('结转已不是草稿，请刷新')
    const preview = await computeCarryover(tenantId, v.sourceId, false, tx)
    if (!preview.balanced || !matches(v, preview)) throw new Error('本月数据已变化，请先生成／更新结转草稿，再审核')
    const changed = await tx.voucher.updateMany({ where: { id, tenantId, status: 'DRAFT', updatedAt: v.updatedAt }, data: { status: 'POSTED', postedAt: new Date(), postedById: userId } })
    if (changed.count !== 1) throw new Error('结转状态已变化，请刷新重试')
    await tx.opLog.create({ data: { tenantId, userId, entityType: 'Voucher', targetId: id, action: `确认结转 ${v.sourceId}` } })
    return { ok: true }
  }, { isolationLevel: 'Serializable' })
}

/** Closing never creates or silently confirms a voucher. */
export async function closeConfirmedPeriod(opts: { tenantId: string; month: string; closedById: string; closeNote?: string | null }) {
  const { tenantId, month, closedById, closeNote = null } = opts
  return prisma.$transaction(async tx => {
    await lockMonth(tx, tenantId, month)
    await requireOpen(tx, tenantId, month)
    const preview = await computeCarryover(tenantId, month, false, tx)
    const v = await tx.voucher.findFirst({ where: { tenantId, sourceType: 'Carryover', sourceId: month }, include: { entries: true } })
    if (preview.entries.length || v) {
      if (!v || v.status !== 'POSTED') throw new Error('请先生成／更新结转草稿，并由财务审核确认后再关账')
      if (!preview.balanced || !matches(v, preview)) throw new Error('已确认结转与本月最新数据不一致，不能关账；请由财务处理')
    }
    const { start, end } = monthRangeForDateCol(month)
    const drafts = await tx.voucher.count({ where: { tenantId, status: 'DRAFT', date: { gte: start, lte: end } } })
    if (drafts) throw new Error('本月仍有未审核凭证，请审核后再关账')
    const data = { status: 'CLOSED' as const, closedAt: new Date(), closedById, closeNote, carryoverVoucherId: v?.id || null }
    const period = await tx.accountingPeriod.upsert({ where: { tenantId_month: { tenantId, month } }, create: { tenantId, month, ...data }, update: data })
    await tx.opLog.create({ data: { tenantId, userId: closedById, entityType: 'AccountingPeriod', targetId: period.id, action: `关账 ${month}` } })
    return period
  }, { isolationLevel: 'Serializable' })
}
