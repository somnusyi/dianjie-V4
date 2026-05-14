// ══════════════════════════════════════════════════════
// 自动对账 + 审批流 + 自动付款 核心逻辑
// apps/api/src/services/paymentSchedule.ts (更新版)
// ══════════════════════════════════════════════════════
import { notifyApprovalPending } from './notification'

import { prisma, Supplier, Receipt } from '@dianjie/db'
import dayjs from 'dayjs'
import { cmbTransferWithCheck, cmbHealthCheck, reportCmbError } from './cmbPayment'

const AUTO_PAY_THRESHOLD = 2000  // 超过此金额需总部审批

interface CreateScheduleParams {
  tenantId: string
  receipt: Receipt & { confirmedAt: Date }
  supplier: Supplier
}

/**
 * ★ 入库确认后全自动流程：
 * 1. 自动生成对账单
 * 2. 自动创建账期记录
 * 3. 判断是否需要审批（>2000）
 */
export async function autoProcessAfterConfirm({ tenantId, receipt, supplier }: CreateScheduleParams) {
  const confirmedAt = receipt.confirmedAt

  // ── 1. 自动生成对账单 ──────────────────────────
  const reconNo = await generateNo('DC', tenantId)
  const recon = await prisma.reconciliation.create({
    data: {
      tenantId,
      no: reconNo,
      supplierId: supplier.id,
      storeId: receipt.storeId,
      periodStart: receipt.deliveryDate,
      periodEnd: receipt.deliveryDate,
      totalAmount: receipt.totalAmount,
      status: 'APPROVED',  // 自动对账直接通过
      items: { create: [{ receiptId: receipt.id, amount: receipt.totalAmount }] },
    },
  })

  // 更新入库单状态为已对账
  await prisma.receipt.update({
    where: { id: receipt.id },
    data: { status: 'ACCOUNTED' },
  })

  // ── 2. 计算到期日 ──────────────────────────────
  let dueAt: Date
  switch (supplier.creditType) {
    case 'FIXED_DAYS':
      dueAt = dayjs(confirmedAt).add(supplier.creditDays, 'day').toDate()
      break
    case 'MONTHLY':
      dueAt = dayjs(confirmedAt).endOf('month').add(1, 'month').toDate()
      break
    case 'WEEKLY':
      dueAt = dayjs(confirmedAt).add(1, 'week').startOf('week').add(1, 'day').toDate()
      break
    case 'ON_DELIVERY':
      dueAt = dayjs(confirmedAt).endOf('day').toDate()
      break
    default:
      dueAt = dayjs(confirmedAt).add(30, 'day').toDate()
  }

  // ── 3. 判断是否需要总部审批 ────────────────────
  const amount = Number(receipt.totalAmount)
  const needApproval = amount > AUTO_PAY_THRESHOLD

  const schedule = await prisma.paymentSchedule.create({
    data: {
      tenantId,
      receiptId: receipt.id,
      supplierId: supplier.id,
      storeId: receipt.storeId,
      amount: receipt.totalAmount,
      creditDays: supplier.creditDays,
      confirmedAt,
      dueAt,
      needApproval,
      status: needApproval ? 'PENDING_APPROVAL' : 'PENDING',
    },
  })

  console.log(`
  ✅ 自动对账完成: ${receipt.no}
  📋 对账单: ${reconNo}
  📅 到期日: ${dayjs(dueAt).format('YYYY-MM-DD')}
  💰 金额: ¥${amount} ${needApproval ? '→ 需总部审批' : '→ 到期自动付款'}
  `)

  if (needApproval) {
    void notifyApprovalPending(tenantId, Number(receipt.totalAmount), supplier.name)
  }
  return { recon, schedule, needApproval }
}

/**
 * 总部审批账期付款（>2000的单子）
 */
export async function approvePaymentSchedule(
  scheduleId: string,
  approverId: string,
  action: 'approve' | 'reject',
  note?: string
) {
  const schedule = await prisma.paymentSchedule.findUnique({ where: { id: scheduleId } })
  if (!schedule) throw new Error('账期记录不存在')
  if (schedule.status !== 'PENDING_APPROVAL') throw new Error('当前状态不可审批')

  if (action === 'approve') {
    await prisma.paymentSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'APPROVED',
        approvedById: approverId,
        approvedAt: new Date(),
        approvalNote: note,
      },
    })
    console.log(`✅ 审批通过: ¥${schedule.amount}，到期日 ${dayjs(schedule.dueAt).format('YYYY-MM-DD')} 自动付款`)
  } else {
    await prisma.paymentSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        rejectionNote: note,
      },
    })
    console.log(`❌ 审批拒绝: ¥${schedule.amount}`)
  }
}

/**
 * 招行免前置自动付款
 * 到期时由 scheduler 自动触发，从招行对公账户向供应商打款
 */
export async function executeBankPayment(scheduleId: string) {
  const schedule = await prisma.paymentSchedule.findUnique({
    where: { id: scheduleId },
    include: {
      supplier: true,
      receipt: { include: { store: true } },
    },
  })
  if (!schedule) throw new Error('账期记录不存在')

  const supplier = schedule.supplier
  const store    = schedule.receipt.store

  // ── 前置检查 ──────────────────────────────────────────
  // test tenant 演示环境保护: 禁止发起真实银行转账 (cmb 共享同一个生产 .env 配置,
  // 不挡的话 test 老板手滑点付款会真从公司账户扣钱)
  const tenant = await prisma.tenant.findUnique({
    where: { id: schedule.tenantId },
    select: { slug: true },
  })
  if (tenant?.slug === 'test') {
    await prisma.paymentSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'FAILED',
        failReason: 'test tenant 演示环境 · 已阻止真实银行转账 (mock 成功不会扣钱)',
      },
    })
    throw new Error('test tenant 演示环境禁止真实银行转账')
  }

  if (!supplier.bankAccount) {
    throw new Error(`供应商「${supplier.name}」未配置收款账户，请先完善供应商信息`)
  }

  // 检查招行微服务是否在线
  const cmbOnline = await cmbHealthCheck()
  if (!cmbOnline) {
    throw new Error('招行微服务不可用，请检查 dianjie-cmb 进程是否正常运行')
  }

  // ── 标记支付中 ────────────────────────────────────────
  await prisma.paymentSchedule.update({
    where: { id: scheduleId },
    data: { status: 'PROCESSING' },
  })

  try {
    // ── 调用招行免前置接口（含 yurRef 防重发协议）────────
    // cmbTransferWithCheck 会在网络/业务失败时:
    //   等 11s 避限流 → BB1PAYQR 按 yurRef 查重 → 已收认成功 / 未收同 yurRef 重发
    //   重试上限 2 次（首发+2 重发 = 3 次尝试），仍失败返 CMB_RETRY_EXHAUSTED
    const bankResult = await cmbTransferWithCheck({
      toAccount : supplier.bankAccount,
      toName    : supplier.bankAccountName || supplier.name,
      amount    : Number(schedule.amount),
      bizNo     : scheduleId,          // 业务参考号 = scheduleId 全局唯一，重发不变
      remark    : `货款-${schedule.receipt.no}-${supplier.name}`,
      bankCode  : supplier.bankCode || undefined,
    })

    // 失败 → 上 Sentry 并按错误码归类（docs/cmb/CMB_ERROR_CODES.md §3）
    if (!bankResult.success) {
      reportCmbError(bankResult.resultMsg || '招行付款失败', {
        funcode:    'BB1PAYOP',
        resultCode: bankResult.resultCode,
        bizNo:      scheduleId,
        raw:        bankResult.raw,
      })
    }

    if (bankResult.success) {
      // ── 付款成功 ───────────────────────────────────
      await prisma.paymentSchedule.update({
        where: { id: scheduleId },
        data: {
          status          : 'PAID',
          paidAt          : new Date(),
          bankTxNo        : bankResult.txNo,
          bankRawResponse : bankResult.raw,
        },
      })

      await prisma.opLog.create({
        data: {
          tenantId  : schedule.tenantId,
          isAi      : true,
          action    : `招行自动付款成功：${supplier.name} ¥${schedule.amount}`,
          target    : schedule.receipt.no,
          entityType: 'PaymentSchedule',
          targetId  : schedule.id,
          metadata  : {
            toAccount  : supplier.bankAccount,
            txNo       : bankResult.txNo,
            amount     : schedule.amount,
            resultCode : bankResult.resultCode,
          },
        },
      })

      console.log(`✅ 招行付款成功: ${store.name} → ${supplier.name} ¥${schedule.amount} txNo=${bankResult.txNo}`)

    } else {
      // ── 银行受理失败（非网络问题，是业务拒绝）────────
      const reason = `[${bankResult.resultCode}] ${bankResult.resultMsg}`
      await prisma.paymentSchedule.update({
        where: { id: scheduleId },
        data: {
          status      : 'OVERDUE',
          failReason  : reason,
          retryCount  : { increment: 1 },
          bankRawResponse: bankResult.raw,
        },
      })

      await prisma.opLog.create({
        data: {
          tenantId  : schedule.tenantId,
          isAi      : true,
          action    : `招行付款被拒绝：${supplier.name} ¥${schedule.amount} — ${reason}`,
          target    : schedule.receipt.no,
          entityType: 'PaymentSchedule',
          targetId  : schedule.id,
          metadata  : { resultCode: bankResult.resultCode, resultMsg: bankResult.resultMsg },
        },
      })

      throw new Error(reason)
    }

  } catch (err: any) {
    // ── 网络/服务异常（与银行业务拒绝区分） ──────────
    if (!err.message.startsWith('[')) {
      await prisma.paymentSchedule.update({
        where: { id: scheduleId },
        data: {
          status    : 'OVERDUE',
          failReason: err.message,
          retryCount: { increment: 1 },
        },
      })
    }
    throw err
  }
}

async function generateNo(prefix: string, tenantId: string): Promise<string> {
  const ym = dayjs().format('YYYYMM')
  const count = await prisma.reconciliation.count({
    where: { tenantId, no: { startsWith: `${prefix}${ym}` } },
  })
  return `${prefix}${ym}${String(count + 1).padStart(6, '0')}`
}
