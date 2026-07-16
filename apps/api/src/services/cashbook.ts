/**
 * 现金流账 helper — 让"4 个 sink"复用同一套"写流水 + 更新账户余额" 逻辑
 *
 * 解决之前的"账实不平"老问题:
 *   - paymentSchedule.executeBankPayment (招行自动付款)
 *   - capital.ts /expenses/:id/pay (资本支出付款)
 *   - invoicePayments.ts /:id/confirm SUCCESS (发票付款到账)
 *   - cashbook /internal-transfer (内部转账, 已有但当作参考)
 *
 * 这 4 个事件都"真实出钱", 之前只动业务表 (status=PAID) 不写 CashTransaction,
 * 月底导凭证给会计师就缺一大块 → 账实不平 → 报税出错.
 *
 * 本 helper 提供 2 个函数:
 *   - writeCashTransaction(tx, opts): 在 prisma transaction 内, 找账户 + 算余额 + 写流水 + 更新账户
 *   - findCmbAccount(tenantId): 找到该 tenant 的招行实时账户 (单账户假设)
 *
 * 设计原则:
 *   - 必须在 prisma.$transaction 内调用, 保证账户余额 + 流水原子写入
 *   - 如果 cmbBindAccount 找不到匹配账户, 不阻断业务, 返 null + 告警 (让付款本身成功)
 *   - createdById 必填, 上游传 (审批人/操作人 fallback 到 receipt creator)
 */
import { Prisma, prisma } from '@dianjie/db'

// prisma 事务 client 类型 — 不精确导出, 用 any 避免 .prisma/client type 解析问题
// (runtime 行为完全一致, 调用方传入 prisma.$transaction(async (tx) => {...}) 的 tx)
type TxClient = any

export interface WriteCashTxOpts {
  tenantId: string
  accountId?: string                     // 显式传 (capital/invoice 财务手动选时); 不传走 cmbBindAccount auto-find
  direction: 1 | -1                       // +1 收 / -1 支
  category: string                        // '供应商付款' / '发票付款' / '资本支出' / 'internal-transfer' 等
  amount: number                          // 恒正
  note?: string
  txDate?: Date                           // 默认 now()
  refType: string                         // 'PaymentSchedule' / 'InvoicePayment' / 'CapitalExpense' 等
  refId: string                           // 关联业务 ID
  createdById: string                     // 操作人 (审批人/财务/receipt creator fallback)
}

/**
 * 找该 tenant 的招行实时账户 (单账户假设).
 * 若有多个 cmbBindAccount 账户, 取第一个 ACTIVE 的 (TODO: 多账户场景下需要业务层显式选)
 */
export async function findCmbAccount(tenantId: string) {
  return prisma.cashAccount.findFirst({
    where: { tenantId, cmbBindAccount: { not: null }, status: 'ACTIVE' },
    select: { id: true, name: true, cmbBindAccount: true, balance: true },
  })
}

/**
 * 在 prisma transaction 内写一笔 CashTransaction + 更新账户 balance
 * 必须传 prisma transaction client (来自 prisma.$transaction(async (tx) => {...}))
 *
 * 返回写入的 transaction record, 或 null (账户没找到, 不阻断业务)
 */
export async function writeCashTransaction(
  tx: TxClient,
  opts: WriteCashTxOpts,
): Promise<{ id: string; balanceAfter: number } | null> {
  if (!Number.isFinite(opts.amount) || opts.amount <= 0) {
    throw new Error('现金流水金额必须是正数')
  }
  let accountId = opts.accountId
  let candidate: { id: string } | null = null

  if (accountId) {
    candidate = await tx.cashAccount.findFirst({
      where: { id: accountId, tenantId: opts.tenantId, status: 'ACTIVE' },
      select: { id: true },
    })
  } else {
    // 不传 accountId 走 cmbBindAccount auto-find (招行自动付款场景)
    candidate = await tx.cashAccount.findFirst({
      where: { tenantId: opts.tenantId, cmbBindAccount: { not: null }, status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      select: { id: true },
    })
    accountId = candidate?.id
  }

  if (!candidate || !accountId) {
    // 不阻断业务, 但告警
    console.warn(
      `[cashbook] writeCashTransaction 找不到账户 tenantId=${opts.tenantId} refType=${opts.refType} refId=${opts.refId} ` +
      `(${opts.accountId ? '显式传的 accountId 不存在' : '招行 cmbBindAccount 账户未配置'}), 跳过流水`
    )
    return null
  }

  const locked = await tx.$queryRaw(Prisma.sql`
    SELECT "id", "balance"
    FROM "cash_accounts"
    WHERE "id" = ${accountId}
      AND "tenantId" = ${opts.tenantId}
      AND "status" = 'ACTIVE'
    FOR UPDATE
  `) as Array<{ id: string; balance: Prisma.Decimal }>
  if (locked.length !== 1) throw new Error('现金账户状态已变化，请刷新后重试')
  const newBalance = locked[0].balance.plus(new Prisma.Decimal(opts.amount).times(opts.direction))

  await tx.cashAccount.update({
    where: { id: accountId },
    data: { balance: newBalance },
  })

  const created = await tx.cashTransaction.create({
    data: {
      tenantId: opts.tenantId,
      accountId,
      direction: opts.direction,
      category: opts.category,
      amount: opts.amount,
      balanceAfter: newBalance,
      note: opts.note,
      txDate: opts.txDate ?? new Date(),
      refType: opts.refType,
      refId: opts.refId,
      createdById: opts.createdById,
    },
    select: { id: true },
  })

  return { id: created.id, balanceAfter: Number(newBalance) }
}
