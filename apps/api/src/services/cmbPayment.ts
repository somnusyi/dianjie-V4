// ══════════════════════════════════════════════════════
// 招行免前置 · TypeScript 客户端
// 调用 apps/cmb/app.py 提供的 HTTP 微服务
// ══════════════════════════════════════════════════════

const CMB_SERVICE = process.env.CMB_SERVICE_URL || 'http://localhost:5001'

export interface CmbTransferParams {
  toAccount : string   // 收款账号
  toName    : string   // 收款户名
  amount    : number   // 金额（Number，内部转 string）
  bizNo     : string   // 业务参考号（全局唯一，建议用 scheduleId）
  remark?   : string   // 附言
  bankCode? : string   // 收款行行号（他行必填）
  bankCity? : string   // 收款开户地（他行必填）
}

export interface CmbTransferResult {
  success    : boolean
  resultCode : string
  resultMsg  : string
  txNo?      : string   // 银行流水号（成功时）
  raw?       : any      // 银行原始响应（用于存档）
}

export interface CmbQueryResult {
  success    : boolean
  resultCode : string
  resultMsg  : string
  payStatus? : string   // 银行侧转账状态
  raw?       : any
}

/** 向供应商发起转账 */
export async function cmbTransfer(params: CmbTransferParams): Promise<CmbTransferResult> {
  const resp = await fetch(`${CMB_SERVICE}/transfer`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      toAccount: params.toAccount,
      toName   : params.toName,
      amount   : params.amount.toFixed(2),
      bizNo    : params.bizNo,
      remark   : params.remark || '',
      bankCode : params.bankCode || '',
      bankCity : params.bankCity || '',
    }),
    signal: AbortSignal.timeout(30_000),  // 招行接口 30s 超时
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '无响应')
    throw new Error(`招行服务响应异常 ${resp.status}: ${text}`)
  }

  return resp.json()
}

/** 查询付款结果（付款后轮询确认） */
export async function cmbQueryPayment(bizNo: string): Promise<CmbQueryResult> {
  const resp = await fetch(`${CMB_SERVICE}/query`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ bizNo }),
    signal : AbortSignal.timeout(15_000),
  })
  return resp.json()
}

export interface CmbBalanceResult {
  success     : boolean
  resultCode  : string
  resultMsg   : string
  account?    : string   // 账号
  accountName?: string   // 户名
  balance?    : string   // 账户余额（元，字符串）
  available?  : string   // 可用余额
  held?       : string   // 冻结余额
  currency?   : string   // 货币码 10=RMB
  status?     : string   // A=正常
  raw?        : any
}

/**
 * 查询账户余额 · NTQACINF（规范 §3.2）
 * @param account 账号（可选，默认用 CMB_ACCOUNT 结算户）
 * ⚠️ 限流：同账号 10s 内只能查一次，调用方需自行节流
 */
export async function cmbBalance(account?: string): Promise<CmbBalanceResult> {
  const resp = await fetch(`${CMB_SERVICE}/balance`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ account: account || '' }),
    signal : AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    throw new Error(`招行余额查询响应异常 ${resp.status}`)
  }
  return resp.json()
}

export interface CmbTransaction {
  date        : string   // yyyymmdd
  time        : string   // HHMMSS
  sequence    : string   // 交易流水 idn (DCSIGREC trsseq 入参)
  direction   : 'D' | 'C' | string   // D=借/出, C=贷/入
  amount      : string   // 出账负数, 入账正数
  counterName : string   // 对方户名
  counterAcct : string   // 对方账号
  remark      : string   // 转账附言
  yurRef      : string   // 业务参考号（我方 = scheduleId）
}

export interface CmbTransactionsResult {
  success      : boolean
  resultCode   : string
  resultMsg    : string
  hasMore?     : boolean       // Y/N，是否需要续传
  nextSequence?: string
  summary?     : {
    credit: { amount: string; count: string }   // 入账（贷）汇总
    debit:  { amount: string; count: string }   // 出账（借）汇总
  }
  transactions?: CmbTransaction[]
  raw?         : any
}

/**
 * 交易概要查询 · trsQryByBreakPoint（规范 §3.5）
 * 对账主接口 — 拉账户日期范围内的实际入账/出账明细，按 yurRef 可匹配 PaymentSchedule
 *
 * @param opts.account   账号（可选，默认 CMB_ACCOUNT）
 * @param opts.beginDate yyyymmdd（可选，默认当天）
 * @param opts.endDate   yyyymmdd（可选，默认当天）
 * ⚠️ 限流：同账号 10s 内只能查一次
 */
export async function cmbTransactions(opts: {
  account?  : string
  beginDate?: string
  endDate?  : string
} = {}): Promise<CmbTransactionsResult> {
  const resp = await fetch(`${CMB_SERVICE}/transactions`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(opts),
    signal : AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(`招行交易概要响应异常 ${resp.status}`)
  }
  return resp.json()
}

export interface CmbReceiptResult {
  success    : boolean
  resultCode : string
  resultMsg  : string
  checkCode? : string   // 防伪校验码
  pdfBase64? : string   // PDF 二进制 base64（可直接 Buffer.from(b64,'base64') 存 OSS）
  raw?       : any
}

/**
 * 单笔电子回单查询 · DCSIGREC（规范 §3.6）
 * 付款成功后调一次，把 PDF 存 OSS，绑到 PaymentSchedule
 *
 * @param opts.account  账号（可选，默认 CMB_ACCOUNT）
 * @param opts.yurRef   业务参考号 = scheduleId
 * @param opts.date     交易日期 yyyy-MM-dd（带横杠！）
 * @param opts.sequence 来自 /transactions 返回项的 sequence 字段
 *
 * ⚠️ DCSIGREC 接口规定字段名全部小写（yurref/eacnbr/quedat/trsseq），
 *    跟 BB1PAY 驼峰命名不同，已由 Python 微服务内部转换，TS 这层保持驼峰
 */
export async function cmbReceipt(opts: {
  account?  : string
  yurRef    : string
  date      : string
  sequence  : string
}): Promise<CmbReceiptResult> {
  const resp = await fetch(`${CMB_SERVICE}/receipt`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(opts),
    signal : AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(`招行电子回单响应异常 ${resp.status}`)
  }
  return resp.json()
}

/** 检查招行微服务是否在线 */
export async function cmbHealthCheck(): Promise<boolean> {
  try {
    const resp = await fetch(`${CMB_SERVICE}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    return resp.ok
  } catch {
    return false
  }
}
