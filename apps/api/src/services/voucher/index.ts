/**
 * 凭证生成服务
 *
 * 业务事件 → 自动建凭证草稿 (status=DRAFT)
 * 财务在 /v2/finance/vouchers 看草稿, 可改可审, 审完导出 Excel 进好会计
 *
 * 设计:
 *   - 凭证一律先建 DRAFT, 由财务确认后转 POSTED
 *   - sourceType+sourceId 唯一(同业务事件触发多次不重建,加 idempotent)
 *   - 借贷自动平账, 不平的不写入 DB
 *
 * 提供原子函数:
 *   - createVoucher({...}) : 创建并落库, 返回凭证 ID
 *   - generateNo(tenantId, date): 生成 PZ-YYYYMM-NNNN 编号
 */
import { prisma } from '@dianjie/db'

export interface VoucherEntryInput {
  accountCode: string
  accountName: string
  debit?: number
  credit?: number
  summary?: string
}

export interface CreateVoucherOpts {
  tenantId: string
  date: Date | string
  summary: string
  sourceType?: string
  sourceId?: string
  entries: VoucherEntryInput[]
  word?: string
  createdById?: string | null
}

/** 生成凭证号 PZ-YYYYMM-NNNN, 按月递增 */
async function generateNo(tenantId: string, date: Date): Promise<string> {
  const ym = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`
  const prefix = `PZ-${ym}-`
  const count = await prisma.voucher.count({ where: { tenantId, no: { startsWith: prefix } } })
  return `${prefix}${String(count + 1).padStart(4, '0')}`
}

/**
 * 创建凭证 (幂等: 同 sourceType+sourceId 已有则返回旧 ID, 不重建)
 */
export async function createVoucher(opts: CreateVoucherOpts): Promise<string | null> {
  const { tenantId, sourceType, sourceId, entries, summary, word = '记', createdById = null } = opts
  const date = typeof opts.date === 'string' ? new Date(opts.date) : opts.date

  // 幂等检查
  if (sourceType && sourceId) {
    const existing = await prisma.voucher.findFirst({
      where: { tenantId, sourceType, sourceId },
      select: { id: true },
    })
    if (existing) return existing.id
  }

  // 平账校验
  let totalDebit = 0, totalCredit = 0
  for (const e of entries) {
    totalDebit += Number(e.debit || 0)
    totalCredit += Number(e.credit || 0)
  }
  totalDebit = Math.round(totalDebit * 100) / 100
  totalCredit = Math.round(totalCredit * 100) / 100
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    console.error(`[voucher] 借贷不平 ${sourceType}/${sourceId}: debit=${totalDebit} credit=${totalCredit}`)
    return null
  }
  if (totalDebit < 0.01) {
    return null  // 全 0 不建
  }

  const no = await generateNo(tenantId, date)
  const voucher = await prisma.voucher.create({
    data: {
      tenantId, no, date, summary, word,
      sourceType, sourceId,
      totalDebit, totalCredit,
      status: 'DRAFT',
      createdById,
      entries: {
        create: entries.map((e, i) => ({
          lineNo: i + 1,
          summary: e.summary || summary,
          accountCode: e.accountCode,
          accountName: e.accountName,
          debit: Number(e.debit || 0),
          credit: Number(e.credit || 0),
        })),
      },
    },
    select: { id: true },
  })
  return voucher.id
}

/** 业务侧用的 fire-and-forget */
export function createVoucherAsync(opts: CreateVoucherOpts): void {
  createVoucher(opts).catch((e) => console.error('[voucher async]', e))
}

// ── 业务模板 ──────────────────────────────────────────
// 把业务事件转成借贷分录, 业务路由直接调对应函数, 不需要懂会计

/** 收货入库: 借 库存商品 / 贷 应付账款 */
export function voucherForReceipt(opts: {
  tenantId: string
  receiptId: string
  receiptNo: string
  supplierName: string
  storeName: string
  amount: number
  date: Date
}) {
  return createVoucherAsync({
    tenantId: opts.tenantId,
    date: opts.date,
    summary: `${opts.storeName} 收货 ${opts.receiptNo} ${opts.supplierName}`,
    sourceType: 'Receipt',
    sourceId: opts.receiptId,
    entries: [
      { accountCode: '1405', accountName: '库存商品', debit: opts.amount },
      { accountCode: '2202', accountName: '应付账款', credit: opts.amount,
        summary: `应付 ${opts.supplierName}` },
    ],
  })
}

/**
 * 付款给供应商: 借 应付账款 / 贷 银行存款 (按账户末四位决定明细科目)
 * 用户好会计科目体系 (小企业会计准则):
 *   100201 中国银行1674  / 100202 建设银行3618  / 1001 库存现金
 * 招行账户在好会计里还没加, 暂兜底用一级 1002 银行存款 (财务可在凭证里手工改细)
 */
export function voucherForPayment(opts: {
  tenantId: string
  paymentId: string
  paymentNo: string
  supplierName: string
  amount: number
  method: string             // BANK_TRANSFER / CMB_AUTOPAY / OFFLINE / CASH
  date: Date
  bankLast4?: string         // 付款银行末四位, 便于匹配明细科目
}) {
  const isCash = opts.method === 'CASH'
  let bankAccountCode = '1002'
  let bankAccountName = '银行存款'
  if (isCash) {
    bankAccountCode = '1001'; bankAccountName = '库存现金'
  } else if (opts.bankLast4) {
    if (opts.bankLast4 === '1674') { bankAccountCode = '100201'; bankAccountName = '中国银行1674' }
    else if (opts.bankLast4 === '3618') { bankAccountCode = '100202'; bankAccountName = '建设银行3618' }
  }
  return createVoucherAsync({
    tenantId: opts.tenantId,
    date: opts.date,
    summary: `付款 ${opts.paymentNo} ${opts.supplierName}`,
    sourceType: 'Payment',
    sourceId: opts.paymentId,
    entries: [
      { accountCode: '2202', accountName: '应付账款', debit: opts.amount,
        summary: `应付 ${opts.supplierName}` },
      { accountCode: bankAccountCode, accountName: bankAccountName, credit: opts.amount },
    ],
  })
}

/** 报损 (供应商同意): 借 营业外支出-存货毁损报废损失 / 贷 库存商品
 *  小企业会计准则: 571106 营业外支出-存货毁损报废损失 */
export function voucherForLossApproved(opts: {
  tenantId: string
  lossClaimId: string
  lossClaimNo: string
  storeName: string
  supplierName: string
  amount: number
  date: Date
}) {
  return createVoucherAsync({
    tenantId: opts.tenantId,
    date: opts.date,
    summary: `${opts.storeName} 报损 ${opts.lossClaimNo} (${opts.supplierName} 已同意)`,
    sourceType: 'LossClaim',
    sourceId: opts.lossClaimId,
    entries: [
      { accountCode: '571106', accountName: '存货毁损报废损失', debit: opts.amount },
      { accountCode: '1405', accountName: '库存商品', credit: opts.amount,
        summary: `${opts.storeName} 短量 ${opts.lossClaimNo}` },
    ],
  })
}

/** 营业额录入: 借 银行/渠道资金 / 贷 主营业务收入
 *  好会计小企业准则: 主营业务收入 5001 (无明细堂食/外卖, 摘要里区分)
 *  收款渠道走 5601 销售费用-平台手续费 体现 (用户可在凭证里手工拆) */
export function voucherForRevenue(opts: {
  tenantId: string
  revenueId: string
  storeName: string
  channel: 'dine_in' | 'takeout' | 'card'      // 堂食 / 外卖 / 储值
  amount: number
  date: Date
  paymentMethod?: 'cash' | 'wechat' | 'alipay' | 'meituan' | 'douyin' | 'bank'
}) {
  const channelLabel = { dine_in: '堂食', takeout: '外卖', card: '储值' }[opts.channel] || '堂食'
  // 收款资金落地科目 (按收款渠道; 银行用 1002 一级, 暂未拆明细)
  const payMap: Record<string, { code: string; name: string }> = {
    cash:    { code: '1001',  name: '库存现金' },
    wechat:  { code: '1012',  name: '其他货币资金' },
    alipay:  { code: '1012',  name: '其他货币资金' },
    meituan: { code: '1012',  name: '其他货币资金' },
    douyin:  { code: '1012',  name: '其他货币资金' },
    bank:    { code: '1002',  name: '银行存款' },
  }
  const pay = payMap[opts.paymentMethod || 'bank'] || payMap.bank
  return createVoucherAsync({
    tenantId: opts.tenantId,
    date: opts.date,
    summary: `${opts.storeName} 营业额 ${channelLabel}`,
    sourceType: 'Revenue',
    sourceId: opts.revenueId,
    entries: [
      { accountCode: pay.code, accountName: pay.name, debit: opts.amount },
      { accountCode: '5001', accountName: '主营业务收入', credit: opts.amount,
        summary: `${channelLabel} 收入` },
    ],
  })
}
