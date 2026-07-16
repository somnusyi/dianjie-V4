// ══════════════════════════════════════════════════════
// 自动对账 + 审批流 + 自动付款 核心逻辑
// apps/api/src/services/paymentSchedule.ts (更新版)
// ══════════════════════════════════════════════════════
import { notifyApprovalPending } from './notification'

import { prisma, Supplier, Receipt } from '@dianjie/db'
import dayjs from 'dayjs'
import { cmbTransferWithCheck, cmbHealthCheck, reportCmbError } from './cmbPayment'
import { writeCashTransaction } from './cashbook'
import { voucherForPayment } from './voucher'
import { checkReceiptBlockedByInvoicePath, cancelScheduleDueToInvoiceLock } from './paymentMutex'
import { nextBusinessNo } from './purchaseOrderIntegrity'

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

  // P2-2: 总仓 (HEADQ_WAREHOUSE) 是内部调拨, 不走外部付款
  //   只更新 receipt 状态, 不建对账单 / 不建 paymentSchedule
  //   后续走 cost-check 4 方核对完毕 → 财务自己建凭证 (借库存 / 贷 总仓往来)
  if ((supplier as any).sourceType === 'HEADQ_WAREHOUSE') {
    await prisma.receipt.update({
      where: { id: receipt.id },
      data: { status: 'CONFIRMED' },     // 入库即终态, 等财务核对入账
    })
    console.log(`[autoProcess] 总仓入库 ${receipt.no} 不建 paymentSchedule (HEADQ_WAREHOUSE 内部调拨)`)
    return { isHeadqWarehouse: true }
  }

  // ── 1. 计算到期日 ──────────────────────────────
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

  // ── 2. 判断是否需要总部审批 ────────────────────
  const amount = Number(receipt.totalAmount)
  const needApproval = amount > AUTO_PAY_THRESHOLD

  // ── 3. 原子生成对账单和账期 ────────────────────
  // receiptId 级 advisory lock 让并发重试串行化；第二个请求会读回首个请求的结果。
  // 对账单、账期和 Receipt.status 在同一事务内提交，避免留下孤立对账单或无账期入库单。
  const processed = await prisma.$transaction(async tx => {
    // PostgreSQL advisory lock 返回 void；显式转 text，避免 Prisma 尝试反序列化 void。
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt-finance:${receipt.id}`}))::text AS locked`

    const existingSchedule = await tx.paymentSchedule.findUnique({ where: { receiptId: receipt.id } })
    const existingReconItem = await tx.reconciliationItem.findFirst({
      where: { receiptId: receipt.id },
      include: { reconciliation: true },
    })

    let schedule = existingSchedule
    let scheduleCreated = false
    if (!schedule) {
      schedule = await tx.paymentSchedule.create({
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
      scheduleCreated = true
    }

    let recon = existingReconItem?.reconciliation
    let reconciliationCreated = false
    if (!recon) {
      const ym = dayjs(confirmedAt).format('YYYYMM')
      const latestRecon = await tx.reconciliation.findFirst({
        where: { tenantId, no: { startsWith: `DC${ym}` } },
        orderBy: { no: 'desc' },
        select: { no: true },
      })
      const parsedFloor = Number(latestRecon?.no.slice(`DC${ym}`.length) || 0)
      const reconFloor = Number.isFinite(parsedFloor) ? parsedFloor : 0
      const reconNo = await nextBusinessNo(tx, tenantId, 'RECONCILIATION', ym, 'DC', reconFloor)
      recon = await tx.reconciliation.create({
        data: {
          tenantId,
          no: reconNo,
          supplierId: supplier.id,
          storeId: receipt.storeId,
          periodStart: receipt.deliveryDate,
          periodEnd: receipt.deliveryDate,
          totalAmount: receipt.totalAmount,
          status: 'APPROVED',
          items: { create: [{ receiptId: receipt.id, amount: receipt.totalAmount }] },
        },
      })
      reconciliationCreated = true
    }

    await tx.receipt.update({
      where: { id: receipt.id },
      data: { status: 'ACCOUNTED' },
    })

    if (scheduleCreated || reconciliationCreated) {
      await tx.opLog.create({
        data: {
          tenantId,
          userId: receipt.createdById,
          action: `自动补全入库财务派生 ${receipt.no}`,
          target: receipt.no,
          targetId: receipt.id,
          entityType: 'Receipt',
          metadata: {
            paymentScheduleId: schedule.id,
            reconciliationId: recon.id,
            scheduleCreated,
            reconciliationCreated,
          },
        },
      })
    }

    return {
      recon,
      schedule,
      needApproval: schedule.needApproval,
      duplicated: Boolean(existingSchedule && existingReconItem),
      scheduleCreated,
      reconciliationCreated,
    }
  })

  const { recon, schedule } = processed

  console.log(`
  ✅ 自动对账完成: ${receipt.no}
  📋 对账单: ${recon.no}
  📅 到期日: ${dayjs(dueAt).format('YYYY-MM-DD')}
  💰 金额: ¥${amount} ${needApproval ? '→ 需总部审批' : '→ 到期自动付款'}
  `)

  if (processed.needApproval && processed.scheduleCreated) {
    void notifyApprovalPending(tenantId, Number(receipt.totalAmount), supplier.name)
    // M2 触达层: 大额付款通知财务+老板
    const { fireAndForget: notify } = await import('./notify')
    notify({
      tenantId, event: 'PAYMENT_LARGE',
      eventKey: `SCH:${schedule.id}:PENDING_APPROVAL`,
      payload: {
        scheduleId: schedule.id, amount: Number(receipt.totalAmount),
        supplierName: supplier.name, orderCount: 1,
      },
    })
  }
  return { recon, schedule, needApproval: processed.needApproval, duplicated: processed.duplicated }
}

/**
 * 招行免前置自动付款
 * 到期时由 scheduler 自动触发，从招行对公账户向供应商打款
 */
export async function executeBankPayment(scheduleId: string) {
  // 真实扣款必须显式开启；缺失或非 true 时默认关闭（fail closed）。
  // 临时停用期间仍保留余额查询、流水同步等只读 CMB 能力。
  if (process.env.NODE_ENV !== 'production' || process.env.PREVIEW_MODE === 'true'
      || process.env.CMB_AUTOPAY_ENABLED !== 'true') {
    throw new Error('自动账期付款已临时停用，未调用银行')
  }

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
        status: 'CANCELLED',
        failReason: 'test tenant 演示环境 · 已阻止真实银行转账 (不会扣钱)',
      },
    })
    throw new Error('test tenant 演示环境禁止真实银行转账')
  }

  if (!supplier.bankAccount) {
    throw new Error(`供应商「${supplier.name}」未配置收款账户，请先完善供应商信息`)
  }

  // 防重付互斥: 若该 receipt 关联发票已发起 InvoicePayment, 取消此 schedule
  // (避免两条路径同时打款 → 供应商收两次)
  const blockReason = await checkReceiptBlockedByInvoicePath(prisma, schedule.receiptId)
  if (blockReason) {
    await cancelScheduleDueToInvoiceLock(scheduleId, blockReason)
    throw new Error(blockReason)
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
      // 2026-06-01 Phase 1 修底盘: 招行付款成功后必须同步:
      //   1. 改 PaymentSchedule.status=PAID (原有)
      //   2. 写 CashTransaction -1 笔 (原来漏掉, 导致现金流账缺这笔出账)
      //   3. 调 voucherForPayment 自动建凭证 DRAFT (原来漏掉, 导致月底导好会计缺这笔)
      // 用一个事务包起来, 保证 3 件事原子
      const paidAt = new Date()
      // createdById fallback 链: 审批人 → receipt 创建人 (chef) — 自动付款没操作人
      const createdById = schedule.approvedById || schedule.receipt.createdById
      const amtNum = Number(schedule.amount)

      await prisma.$transaction(async (tx) => {
        await tx.paymentSchedule.update({
          where: { id: scheduleId },
          data: {
            status          : 'PAID',
            paidAt,
            bankTxNo        : bankResult.txNo,
            bankRawResponse : bankResult.raw,
          },
        })
        // 写现金流水 (招行实时账户 cmbBindAccount, 不传 accountId 让 helper auto-find)
        await writeCashTransaction(tx, {
          tenantId: schedule.tenantId,
          direction: -1,
          category: '供应商付款',
          amount: amtNum,
          note: `招行自动付款 ${supplier.name} ${schedule.receipt.no}`,
          txDate: paidAt,
          refType: 'PaymentSchedule',
          refId: scheduleId,
          createdById,
        })
      })

      // 生凭证 (async, 不阻塞主流程; 凭证失败不影响付款落账)
      voucherForPayment({
        tenantId: schedule.tenantId,
        paymentId: scheduleId,
        paymentNo: schedule.receipt.no,
        supplierName: supplier.name,
        amount: amtNum,
        method: 'CMB_AUTOPAY',
        date: paidAt,
        // 招行单账户 (尾号 0001) → 好会计明细科目 100203 招商银行0001
        bankLast4: '0001',
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
            // 操作日志供通用后台查询，不能保存完整收款账号；完整业务请求只留在受控付款记录。
            toAccountLast4: supplier.bankAccount.slice(-4),
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
