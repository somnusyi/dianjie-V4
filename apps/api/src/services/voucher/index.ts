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

/** 付款给供应商: 借 应付账款 / 贷 银行存款 */
export function voucherForPayment(opts: {
  tenantId: string
  paymentId: string
  paymentNo: string
  supplierName: string
  amount: number
  method: string             // BANK_TRANSFER / CMB_AUTOPAY / OFFLINE / CASH
  date: Date
}) {
  // 默认走招行子户; OFFLINE/CASH 走库存现金
  const isCash = opts.method === 'CASH'
  const bankAccountCode = isCash ? '1001' : '100201'
  const bankAccountName = isCash ? '库存现金' : '银行存款-招商银行'
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

/** 报损 (供应商同意): 借 销售费用-报损 / 贷 库存商品 */
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
      { accountCode: '660103', accountName: '销售费用-报损', debit: opts.amount },
      { accountCode: '1405', accountName: '库存商品', credit: opts.amount,
        summary: `${opts.storeName} 短量 ${opts.lossClaimNo}` },
    ],
  })
}

/** 营业额录入: 借 银行/平台 / 贷 主营业务收入-堂食 (按渠道拆分) */
export function voucherForRevenue(opts: {
  tenantId: string
  revenueId: string
  storeName: string
  channel: 'dine_in' | 'takeout' | 'card'      // 堂食 / 外卖 / 储值
  amount: number
  date: Date
  paymentMethod?: 'cash' | 'wechat' | 'alipay' | 'meituan' | 'douyin' | 'bank'
}) {
  const channelMap = {
    dine_in: { code: '600101', name: '主营业务收入-堂食' },
    takeout: { code: '600102', name: '主营业务收入-外卖' },
    card:    { code: '600103', name: '主营业务收入-储值' },
  }
  const payMap: Record<string, { code: string; name: string }> = {
    cash:    { code: '1001',   name: '库存现金' },
    wechat:  { code: '101204', name: '其他货币资金-微信' },
    alipay:  { code: '101203', name: '其他货币资金-支付宝' },
    meituan: { code: '101201', name: '其他货币资金-美团' },
    douyin:  { code: '101202', name: '其他货币资金-抖音' },
    bank:    { code: '100201', name: '银行存款-招商银行' },
  }
  const pay = payMap[opts.paymentMethod || 'bank'] || payMap.bank
  const ch = channelMap[opts.channel] || channelMap.dine_in
  return createVoucherAsync({
    tenantId: opts.tenantId,
    date: opts.date,
    summary: `${opts.storeName} 营业额 ${ch.name.replace('主营业务收入-','')}`,
    sourceType: 'Revenue',
    sourceId: opts.revenueId,
    entries: [
      { accountCode: pay.code, accountName: pay.name, debit: opts.amount },
      { accountCode: ch.code, accountName: ch.name, credit: opts.amount },
    ],
  })
}
