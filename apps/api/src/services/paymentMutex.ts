/**
 * 防重付互斥锁
 *
 * 问题:
 *   1. Receipt R 有 PaymentSchedule (账期到期自动 cmb 付款)
 *   2. Receipt R 又被 Invoice I 引用 (财务通过发票后, 可发起 InvoicePayment)
 *   两条路径都成功 → 供应商被付了两次, 严重事故
 *
 * 策略:
 *   - 任一路径开始落账, 锁住另一路径
 *   - PaymentSchedule.executeBankPayment 调用 cmb 前:
 *       check 该 receipt 关联 invoice 上有没有 PENDING/SUCCESS InvoicePayment
 *       有 → 取消 schedule (status=CANCELLED, failReason="已通过发票付款路径承担")
 *   - InvoicePayment 创建前:
 *       check 关联 receipts 的 PaymentSchedule 状态
 *         - 已 PAID                          → 409 ("订单 X 已通过账期路径付清")
 *         - PROCESSING                       → 409 ("订单 X 银行付款进行中, 等结果")
 *         - PENDING / PENDING_APPROVAL / APPROVED → CANCEL (锁路径)
 *
 * 边界: 此互斥仅作用 receipt 级别的两条路径; CapitalExpense / PaymentRequest 不参与
 */
import { prisma } from '@dianjie/db'

type TxClient = any  // Prisma transaction client; 避免 .prisma/client 类型解析问题

/**
 * 判断 receipt 是否已被发票付款路径承担
 * 调用方: executeBankPayment 在调银行接口前
 *
 * 返回 null = 路径自由可继续付款
 * 返回 reason = 已被发票路径占用, 调用方应将 schedule 标 CANCELLED
 */
export async function checkReceiptBlockedByInvoicePath(
  tx: TxClient,
  receiptId: string,
): Promise<string | null> {
  const receipt = await tx.receipt.findUnique({
    where: { id: receiptId },
    select: { invoiceId: true, no: true },
  })
  if (!receipt?.invoiceId) return null

  // 该 invoice 上有任何 PENDING/SUCCESS 的 InvoicePayment 都视为路径占用
  // (PENDING 可能正在调 cmb, 取消很麻烦, 索性保守)
  const occupied = await tx.invoicePayment.findFirst({
    where: {
      invoiceId: receipt.invoiceId,
      status: { in: ['PENDING', 'SUCCESS'] },
    },
    select: { id: true, status: true, amount: true },
  })
  if (!occupied) return null

  return `订单 ${receipt.no} 关联发票已发起付款 (状态 ${occupied.status}), 账期路径锁定 — 避免重复付款`
}

/**
 * InvoicePayment 创建前互斥
 * 调用方: POST /api/invoice-payments 处理逻辑里
 *
 * 行为:
 *   - 扫描该 invoice 所有 receipts → 收集 paymentSchedule
 *   - 任一 PAID  → 抛错 (前端 409)
 *   - 任一 PROCESSING → 抛错 (前端 409)
 *   - 其他 PENDING/PENDING_APPROVAL/APPROVED → 一并 cancel (锁定账期路径)
 *
 * 用法: await lockSchedulesForInvoicePayment(tx, invoiceId, userId)
 */
export async function lockSchedulesForInvoicePayment(
  tx: TxClient,
  invoiceId: string,
  userId: string,
): Promise<{ cancelledCount: number }> {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      tenantId: true,
      receipts: {
        select: {
          id: true, no: true,
          paymentSchedule: {
            select: { id: true, status: true, amount: true },
          },
        },
      },
    },
  })
  if (!invoice) throw new Error('发票不存在')

  // 1. 致命冲突: PAID 或 PROCESSING
  for (const r of invoice.receipts) {
    const sch = r.paymentSchedule
    if (!sch) continue
    if (sch.status === 'PAID') {
      throw new Error(`订单 ${r.no} 已通过账期路径付清 ¥${Number(sch.amount).toLocaleString()}, 不能再发票付款`)
    }
    if (sch.status === 'PROCESSING') {
      throw new Error(`订单 ${r.no} 招行付款进行中, 请等银行结果再发起 (避免重复付)`)
    }
  }

  // 2. 可取消的: PENDING / PENDING_APPROVAL / APPROVED → CANCELLED
  const cancellableIds: string[] = []
  for (const r of invoice.receipts as any[]) {
    const s = r.paymentSchedule
    if (s && ['PENDING', 'PENDING_APPROVAL', 'APPROVED'].includes(s.status)) {
      cancellableIds.push(s.id)
    }
  }

  if (cancellableIds.length === 0) return { cancelledCount: 0 }

  await tx.paymentSchedule.updateMany({
    where: { id: { in: cancellableIds } },
    data: {
      status: 'CANCELLED',
      failReason: '已通过发票付款路径承担, 账期自动取消',
    },
  })

  // 写 opLog (每条单独写, 不阻塞主路径)
  await tx.opLog.create({
    data: {
      tenantId: invoice.tenantId,
      userId,
      action: `发起发票付款, 锁定 ${cancellableIds.length} 条关联账期 (避免重复付)`,
      entityType: 'Invoice',
      targetId: invoiceId,
      metadata: { cancelledScheduleIds: cancellableIds },
    },
  }).catch(() => {})

  return { cancelledCount: cancellableIds.length }
}

/**
 * 取消 schedule 时, 自动给同事记录原因
 * 调用方: executeBankPayment 检测被发票路径占用时
 */
export async function cancelScheduleDueToInvoiceLock(
  scheduleId: string,
  reason: string,
): Promise<void> {
  const schedule = await prisma.paymentSchedule.findUnique({
    where: { id: scheduleId },
    select: { tenantId: true, receiptId: true },
  })
  if (!schedule) return

  await prisma.paymentSchedule.update({
    where: { id: scheduleId },
    data: { status: 'CANCELLED', failReason: reason },
  })
  await prisma.opLog.create({
    data: {
      tenantId: schedule.tenantId,
      isAi: true,
      action: `自动取消账期付款: ${reason}`,
      entityType: 'PaymentSchedule',
      targetId: scheduleId,
    },
  }).catch(() => {})
}
