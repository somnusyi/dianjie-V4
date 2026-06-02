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
 * 幂等: 同 tenantId + sourceType=Carryover + sourceId=month 已存在则返
 */
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { createVoucher, VoucherEntryInput } from './index'
import { PNL_BUCKETS, resolveProfitAccount } from './coa-config'

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

async function computeCarryover(tenantId: string, month: string, includeDraft = false): Promise<CarryoverPreview & { includedDraft: boolean }> {
  const start = dayjs(month + '-01').startOf('month').toDate()
  const end = dayjs(month + '-01').endOf('month').toDate()
  const profitAccount = await resolveProfitAccount(tenantId)

  // 1. 拉本月凭证的所有分录 (默认仅 POSTED; preview 可选 includeDraft 看"假如 POST 了" 场景)
  const allowedStatuses: ('POSTED'|'DRAFT')[] = includeDraft ? ['POSTED', 'DRAFT'] : ['POSTED']
  const entries = await prisma.voucherEntry.findMany({
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
    bucket.debit += Number(e.debit)
    bucket.credit += Number(e.credit)
  }

  // 3. 生成 carryover 分录
  // 收入: 期末贷余 (credit > debit), 结转: 借收入 / 贷本年利润 (把收入抹平)
  // 费用: 期末借余 (debit > credit), 结转: 贷费用 / 借本年利润
  const carryEntries: VoucherEntryInput[] = []
  let profitDebit = 0      // 累计借方本年利润 = 总费用净额
  let profitCredit = 0     // 累计贷方本年利润 = 总收入净额

  for (const b of buckets) {
    const net = b.side === 'revenue' ? (b.credit - b.debit) : (b.debit - b.credit)
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
  const profitNet = profitCredit - profitDebit   // + = 盈利, - = 亏损
  if (profitNet > 0.01) {
    // 盈利: 贷 本年利润
    carryEntries.push({
      accountCode: profitAccount.code, accountName: profitAccount.name,
      credit: profitNet, summary: `结转本月净利`,
    })
  } else if (profitNet < -0.01) {
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

/**
 * 期末结转
 * 返回新建 voucher.id (无可结转时返 null)
 */
export async function generateCarryoverVoucher(opts: CarryoverOpts): Promise<string | null> {
  const { tenantId, month, createdById = null, dryRun = false } = opts

  // 幂等
  const existing = await prisma.voucher.findFirst({
    where: { tenantId, sourceType: 'Carryover', sourceId: month },
    select: { id: true },
  })
  if (existing && !dryRun) return existing.id

  const preview = await computeCarryover(tenantId, month)
  if (preview.entries.length === 0) {
    console.log(`[carryover] ${tenantId} ${month} 无可结转损益, skip`)
    return null
  }
  if (!preview.balanced) {
    console.error(`[carryover] ${tenantId} ${month} 不平! debit=${preview.totalDebit} credit=${preview.totalCredit}`)
    return null
  }
  if (dryRun) return null

  // 落库 (期末结转日期 = 该月最后一天)
  const end = dayjs(month + '-01').endOf('month').toDate()
  const id = await createVoucher({
    tenantId,
    date: end,
    summary: `${month} 期末结转 损益 → ${preview.profitAccount.name}`,
    word: '结转',
    sourceType: 'Carryover',
    sourceId: month,
    entries: preview.entries,
    createdById,
    lockMode: 'strict',
  })

  console.log(`[carryover] ${tenantId} ${month} 结转完毕: 借 ${preview.totalDebit.toFixed(2)} / 贷 ${preview.totalCredit.toFixed(2)}, 净利 ${preview.profitNet.toFixed(2)}, voucherId=${id}`)
  return id
}
