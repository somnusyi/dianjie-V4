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
import { assertPeriodOpen, shiftDateIfLocked } from '../accountingPeriod'

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
  /**
   * 月结锁账行为:
   *   - auto (默认): 当月已锁, 自动顺延 date 到下一个 OPEN 月 1 号
   *   - strict: 当月已锁, 直接抛错 (用于手工凭证 / post / unpost / void)
   */
  lockMode?: 'auto' | 'strict'
  /**
   * BUG#8: 凭证生成后立即设 POSTED (已发生业务事件用, 财务不需要再手工审)
   * 默认 false (DRAFT). 业务事件用 true, 手工凭证 / 期末结转用 false.
   */
  autoPost?: boolean
}

/**
 * 凭证生成失败落账 (2026-06 技术债修复): 原来失败只 console.error 静默吞.
 * best-effort 写库, 自身出错也不能影响业务主流程, 故吞掉自己的异常.
 */
async function recordVoucherFailure(opts: CreateVoucherOpts, reason: string, detail?: string): Promise<void> {
  try {
    await prisma.voucherGenerationFailure.create({
      data: {
        tenantId: opts.tenantId,
        sourceType: opts.sourceType ?? null,
        sourceId: opts.sourceId ?? null,
        summary: opts.summary,
        reason,
        detail: detail ?? null,
        entriesJson: opts.entries as any,
      },
    })
  } catch (e) {
    console.error('[voucher] 记录失败表失败 (已忽略, 不影响业务):', e)
  }
}

/** 生成凭证号 PZ-YYYYMM-NNNN, 按月递增. 并发安全: 用最大号 + 1 取号 (单次), 撞 unique 重试 */
async function generateNo(tenantId: string, date: Date): Promise<string> {
  const ym = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`
  const prefix = `PZ-${ym}-`
  // 用 max(no) 而不是 count, 避免删除后号码回退
  const last = await prisma.voucher.findFirst({
    where: { tenantId, no: { startsWith: prefix } },
    orderBy: { no: 'desc' },
    select: { no: true },
  })
  const lastSeq = last ? parseInt(last.no.slice(-4)) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

/**
 * 创建凭证
 * 幂等: 同 sourceType+sourceId 已有则返回旧 ID
 * 并发安全: 撞 unique (P2002) 时最多重试 3 次重新取号
 */
export async function createVoucher(opts: CreateVoucherOpts): Promise<string | null> {
  const { tenantId, sourceType, sourceId, entries, summary, word = '记', createdById = null, lockMode = 'auto', autoPost = false } = opts
  let date = typeof opts.date === 'string' ? new Date(opts.date) : opts.date

  // 月结锁账:
  //   - strict: 锁了直接抛 (手工凭证 / post / unpost / void)
  //   - auto:   锁了顺延到下一个 OPEN 月 (业务自动事件不能因为锁账丢)
  if (lockMode === 'strict') {
    await assertPeriodOpen(tenantId, date)
  } else {
    date = await shiftDateIfLocked(tenantId, date)
  }

  // 幂等检查 (DB unique 兜底, 这里先查避免不必要的写)
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
    await recordVoucherFailure(opts, 'unbalanced', `借=${totalDebit} 贷=${totalCredit}`)
    return null
  }
  if (totalDebit < 0.01) {
    return null  // 全 0 不建
  }

  // 最多 3 次重试 (撞凭证号 unique 或 sourceId unique 时)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const no = await generateNo(tenantId, date)
      const now = new Date()
      const voucher = await prisma.voucher.create({
        data: {
          tenantId, no, date, summary, word,
          sourceType, sourceId,
          totalDebit, totalCredit,
          // BUG#8: autoPost=true 时直接 POSTED, 关账不挡路
          status: autoPost ? 'POSTED' : 'DRAFT',
          postedAt: autoPost ? now : null,
          postedById: autoPost ? createdById : null,
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
    } catch (e: any) {
      // P2002 = unique violation
      if (e?.code !== 'P2002') {
        await recordVoucherFailure(opts, 'exception', e?.message || String(e))
        throw e
      }
      // 撞 sourceId unique → 已存在, 查到 ID 返回 (并发场景)
      if (sourceType && sourceId) {
        const existing = await prisma.voucher.findFirst({
          where: { tenantId, sourceType, sourceId }, select: { id: true },
        })
        if (existing) return existing.id
      }
      // 撞 no unique → 重新取号重试
      console.warn(`[voucher] P2002 撞号, attempt=${attempt + 1}, retrying...`)
    }
  }
  console.error(`[voucher] 重试 3 次仍 P2002, 放弃: ${sourceType}/${sourceId}`)
  await recordVoucherFailure(opts, 'retry_exhausted', '撞凭证号 unique 重试 3 次仍失败')
  return null
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
    autoPost: true,   // BUG#8: 收货已发生, 直接 POSTED
  })
}

/**
 * 付款给供应商: 借 应付账款 / 贷 银行存款 (按账户末四位决定明细科目)
 * 用户好会计科目体系 (小企业会计准则):
 *   100201 中国银行1674  / 100202 建设银行3618  / 100203 招商银行0001  / 1001 库存现金
 * 其余未登记账户兜底用一级 1002 银行存款 (财务可在凭证里手工改细)
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
    else if (opts.bankLast4 === '0001') { bankAccountCode = '100203'; bankAccountName = '招商银行0001' }
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
    autoPost: true,   // BUG#8: 付款已发生, 直接 POSTED
  })
}

/**
 * 内部转账: 同一一级科目 1002 银行存款 借/贷, 用明细科目区分账户
 * 2026-06-01 加: cashbook/internal-transfer 调银行成功后调用
 * 借 1002 银行存款 (toAcc, by 末四位) / 贷 1002 银行存款 (fromAcc, by 末四位)
 */
export function voucherForInternalTransfer(opts: {
  tenantId: string
  transferBizNo: string                  // 唯一 ID (cashbook int-YYYYMMDDhhmmss-xxxxxx)
  fromAccountName: string
  fromBankLast4?: string
  toAccountName: string
  toBankLast4?: string
  amount: number
  remark?: string
  date: Date
}) {
  // 末四位映射到明细科目 (跟 voucherForPayment 同一套约定)
  const resolve = (last4?: string, fallbackName?: string) => {
    if (last4 === '1674') return { code: '100201', name: '中国银行1674' }
    if (last4 === '3618') return { code: '100202', name: '建设银行3618' }
    if (last4 === '0001') return { code: '100203', name: '招商银行0001' }
    return { code: '1002', name: fallbackName ? `银行存款 (${fallbackName})` : '银行存款' }
  }
  const from = resolve(opts.fromBankLast4, opts.fromAccountName)
  const to   = resolve(opts.toBankLast4,   opts.toAccountName)
  return createVoucherAsync({
    tenantId: opts.tenantId,
    date: opts.date,
    summary: `内部转账 ${opts.fromAccountName} → ${opts.toAccountName}${opts.remark ? ` (${opts.remark})` : ''}`,
    sourceType: 'CmbInternalTransfer',
    sourceId: opts.transferBizNo,
    entries: [
      { accountCode: to.code,   accountName: to.name,   debit:  opts.amount, summary: `转入 ${opts.toAccountName}` },
      { accountCode: from.code, accountName: from.name, credit: opts.amount, summary: `转出 ${opts.fromAccountName}` },
    ],
    autoPost: true,   // BUG#8: 内部转账已发生, 直接 POSTED
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
    autoPost: true,
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
    autoPost: true,
  })
}
