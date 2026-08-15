import { prisma } from '@dianjie/db'
import { businessMonthKey } from '../lib/businessTime'
import dayjs from 'dayjs'
import { executeBankPayment } from './paymentSchedule'
import { sendNotification as notify } from './notification'
import { fireAndForget as notifyWeCom } from './notify'
import { runMeituanHourlySync, runMeituanDailyReconcile } from './meituan/cron'
import { isCmbSyncEnabled, syncAllCmbAccounts } from './cmbAutoSync'
import { nextBusinessNo } from './purchaseOrderIntegrity'
import { ensureReceiptDerivatives, repairReceiptDerivatives } from './receiptDerivatives'
import { ensureReceiptInventoryUnitSnapshots } from './receiptInventoryUnits'
import { revalueStoreConsumptionCosts } from './inventoryCosting'
import { runDailyReportReminder } from './dailyReportReminder'
import { copyFrozenSupplyDocumentFourUnits } from './supplyDocumentUnitSnapshots'

/**
 * 对一张已经送达、超时未确认的订货单执行自动收货。
 * 配送单状态抢占、入库单、累计实收和订单状态在同一事务内提交；
 * 因而可与门店手工收货安全竞争，失败方只读取已生成的入库单。
 */
export async function autoReceivePurchaseOrder(orderId: string) {
  const overdueBefore = dayjs().subtract(24, 'hour').toDate()
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: orderId, status: 'PENDING_CONFIRM', deliveredAt: { lt: overdueBefore } },
    include: {
      items: { where: { isActive: true } },
      supplier: true,
      store: true,
      deliveries: {
        where: { status: 'DELIVERED' },
        orderBy: { deliveredAt: 'desc' },
        take: 1,
        include: { items: { include: { product: { select: { shelfDays: true } } } } },
      },
    },
  })
  if (!order) {
    const existing = await prisma.receipt.findFirst({
      where: { purchaseOrderId: orderId, deliveryOrderId: { not: null } },
      orderBy: { createdAt: 'desc' },
    })
    if (!existing) return null
    const derivatives = await ensureReceiptDerivatives(existing.id)
    return { receipt: existing, duplicated: true, derivatives }
  }

  const delivery = order.deliveries[0]
  if (!delivery) {
    console.error(`自动收货跳过 ${order.no}: 未找到待收货配送单`)
    return null
  }

  const receivedAt = new Date()
  const totalAmount = delivery.items.reduce(
    (sum, item) => sum + Number(item.shippedQty) * Number(item.unitPriceSnapshot),
    0,
  )
  const ym = businessMonthKey(receivedAt)

  const receipt = await prisma.$transaction(async tx => {
    const claimed = await tx.deliveryOrder.updateMany({
      where: {
        id: delivery.id,
        tenantId: order.tenantId,
        status: 'DELIVERED',
        rowVersion: delivery.rowVersion,
      },
      data: {
        status: 'RECEIVED',
        receivedAt,
        receivedById: order.createdById,
        rowVersion: { increment: 1 },
      },
    })
    if (claimed.count !== 1) return null

    const latestReceipt = await tx.receipt.findFirst({
      where: { tenantId: order.tenantId, no: { startsWith: `RK${ym}` } },
      orderBy: { no: 'desc' },
      select: { no: true },
    })
    const parsedFloor = Number(latestReceipt?.no.slice(`RK${ym}`.length) || 0)
    const receiptFloor = Number.isFinite(parsedFloor) ? parsedFloor : 0
    const no = await nextBusinessNo(tx, order.tenantId, 'RECEIPT', ym, 'RK', receiptFloor)

    const created = await tx.receipt.create({
      data: {
        tenantId: order.tenantId,
        no,
        storeId: order.storeId,
        supplierId: order.supplierId,
        purchaseOrderId: order.id,
        deliveryOrderId: delivery.id,
        deliveryDate: receivedAt,
        totalAmount,
        status: 'CONFIRMED',
        confirmedAt: receivedAt,
        createdById: order.createdById,
        items: {
          create: delivery.items.map(item => ({
            productId: item.productId,
            quantity: item.shippedQty,
            unitPrice: item.unitPriceSnapshot,
            amount: Number(item.unitPriceSnapshot) * Number(item.shippedQty),
            productCodeSnapshot: item.productCodeSnapshot,
            productNameSnapshot: item.productNameSnapshot,
            productSpecSnapshot: item.productSpecSnapshot,
            productUnitSnapshot: item.productUnitSnapshot,
            productCategorySnapshot: item.productCategorySnapshot,
            ...copyFrozenSupplyDocumentFourUnits(item),
            productionDate: item.manufactureDate || receivedAt,
            expiryDate: item.expiryDate || dayjs(receivedAt).add(item.product.shelfDays, 'day').toDate(),
          })),
        },
      },
    })
    await ensureReceiptInventoryUnitSnapshots(tx, created.id)

    for (const item of delivery.items) {
      await tx.deliveryOrderItem.update({
        where: { id: item.id },
        data: { receivedQty: item.shippedQty },
      })
      const previous = await tx.deliveryOrderItem.aggregate({
        where: {
          productId: item.productId,
          deliveryOrder: { purchaseOrderId: order.id, status: 'RECEIVED', id: { not: delivery.id } },
        },
        _sum: { receivedQty: true },
      })
      await tx.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: order.id, productId: item.productId },
        data: { receivedQty: Number(previous._sum.receivedQty || 0) + Number(item.shippedQty) },
      })
    }

    await tx.deliveryOrderEvent.create({
      data: {
        tenantId: order.tenantId,
        deliveryOrderId: delivery.id,
        eventType: 'RECEIVED',
        fromStatus: 'DELIVERED',
        toStatus: 'RECEIVED',
        metadata: { receiptId: created.id, autoConfirmed: true },
      },
    })
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        // 首次有效发货已关闭未发余量，自动收货后同样不得回到待发货状态。
        status: 'COMPLETED',
        receivedAt,
        receiptId: created.id,
        autoConfirmed: true,
      },
    })
    await tx.opLog.create({
      data: {
        tenantId: order.tenantId,
        userId: order.createdById,
        action: `[自动] 24h 自动确认收货 ${order.no}`,
        target: order.no,
        entityType: 'PurchaseOrder',
        targetId: order.id,
      },
    })
    return created
  })

  if (!receipt) {
    const existing = await prisma.receipt.findUnique({ where: { deliveryOrderId: delivery.id } })
    if (!existing) return null
    const derivatives = await ensureReceiptDerivatives(existing.id)
    return { receipt: existing, duplicated: true, derivatives }
  }

  const derivatives = await ensureReceiptDerivatives(receipt.id)
  if (!derivatives.voucher.ok) console.error(`自动收货凭证生成失败 ${order.no}:`, derivatives.voucher.error)
  if (!derivatives.finance.ok) console.error(`自动收货财务派生记录失败 ${order.no}:`, derivatives.finance.error)
  await revalueStoreConsumptionCosts(order.tenantId, order.storeId).catch(error => {
    console.error(`自动收货成本快照刷新失败 ${order.no}:`, error)
  })

  notifyWeCom({
    tenantId: order.tenantId,
    event: 'PO_AUTO_RECEIVED',
    eventKey: `PO:${order.id}:AUTO_RECEIVED`,
    payload: { orderId: order.id, no: order.no },
    toStoreIds: order.storeId ? [order.storeId] : undefined,
  })
  return { receipt, duplicated: false, derivatives }
}

export type PaymentReminderKind = '3DAY' | '1DAY'

/**
 * Persist a due reminder once and then advance the schedule marker. The durable
 * notification dedupe key closes both multi-instance races and the crash window
 * between notification insertion and marker update.
 */
export async function ensurePaymentDueReminder(scheduleId: string, kind: PaymentReminderKind) {
  const schedule = await prisma.paymentSchedule.findFirst({
    where: { id: scheduleId, status: { in: ['PENDING', 'APPROVED'] } },
    include: { supplier: true, receipt: { include: { store: true } } },
  })
  if (!schedule) return { created: false, duplicated: false, skipped: true }
  if ((kind === '3DAY' && schedule.notified3Days) || (kind === '1DAY' && schedule.notified1Day)) {
    return { created: false, duplicated: true, skipped: true }
  }

  const type = kind === '3DAY' ? 'DUE_REMINDER_3DAY' : 'DUE_REMINDER_1DAY'
  const result = await notify({
    tenantId: schedule.tenantId,
    recipientRole: 'FINANCE',
    type,
    title: kind === '3DAY' ? '账期提醒：3天后到期' : '紧急：明日到期',
    body: kind === '3DAY'
      ? `${schedule.receipt.store.name} → ${schedule.supplier.name} ¥${Number(schedule.amount).toLocaleString()}，到期日 ${dayjs(schedule.dueAt).format('MM/DD')}`
      : `${schedule.receipt.store.name} → ${schedule.supplier.name} ¥${Number(schedule.amount).toLocaleString()}`,
    refType: 'PaymentSchedule',
    refId: schedule.id,
    dedupeKey: `PaymentSchedule:${schedule.id}:${type}`,
  })

  if (kind === '3DAY') {
    await prisma.paymentSchedule.updateMany({
      where: { id: schedule.id, notified3Days: false }, data: { notified3Days: true },
    })
  } else {
    await prisma.paymentSchedule.updateMany({
      where: { id: schedule.id, notified1Day: false }, data: { notified1Day: true },
    })
  }
  return { ...result, skipped: false }
}

export async function runDailyCheck() {
  console.log(`⏰ [${dayjs().format('YYYY-MM-DD HH:mm')}] 开始账期日扫描...`)
  const now = dayjs()

  // 1. T-3天提醒
  const threeDaySchedules = await prisma.paymentSchedule.findMany({
    where: {
      status: { in: ['PENDING', 'APPROVED'] },
      notified3Days: false,
      dueAt: {
        gte: now.add(2, 'day').startOf('day').toDate(),
        lte: now.add(3, 'day').endOf('day').toDate(),
      },
    },
    select: { id: true },
  })

  let reminderSuccess = 0
  let reminderFailed = 0
  for (const s of threeDaySchedules) {
    try {
      await ensurePaymentDueReminder(s.id, '3DAY')
      reminderSuccess++
    } catch (error: any) {
      reminderFailed++
      console.error(`账期 T-3 提醒失败 ${s.id}:`, error?.message || error)
    }
  }

  // 2. T-1天提醒
  const oneDaySchedules = await prisma.paymentSchedule.findMany({
    where: {
      status: { in: ['PENDING', 'APPROVED'] },
      notified1Day: false,
      dueAt: {
        gte: now.add(0, 'day').startOf('day').toDate(),
        lte: now.add(1, 'day').endOf('day').toDate(),
      },
    },
    select: { id: true },
  })

  for (const s of oneDaySchedules) {
    try {
      await ensurePaymentDueReminder(s.id, '1DAY')
      reminderSuccess++
    } catch (error: any) {
      reminderFailed++
      console.error(`账期 T-1 提醒失败 ${s.id}:`, error?.message || error)
    }
  }

  // 3. 到期自动付款（APPROVED 状态 = 已审批或不需审批）
  const autoPayEnabled = process.env.NODE_ENV === 'production'
    && process.env.CMB_AUTOPAY_ENABLED === 'true'
    && process.env.PREVIEW_MODE !== 'true'
  const dueSchedules = autoPayEnabled ? await prisma.paymentSchedule.findMany({
    where: {
      status: 'APPROVED',
      dueAt: { lte: now.endOf('day').toDate() },
    },
  }) : []

  for (const s of dueSchedules) {
    try {
      await executeBankPayment(s.id)
    } catch (e: any) {
      console.error(`付款失败 ${s.id}:`, e.message)
    }
  }

  // 4. 不需审批且到期的 PENDING 单直接触发
  const pendingDue = autoPayEnabled ? await prisma.paymentSchedule.findMany({
    where: {
      status: 'PENDING',
      needApproval: false,
      dueAt: { lte: now.endOf('day').toDate() },
    },
  }) : []

  for (const s of pendingDue) {
    try {
      await executeBankPayment(s.id)
    } catch (e: any) {
      console.error(`付款失败 ${s.id}:`, e.message)
    }
  }

  // 4.5 OVERDUE 重试 (2026-06-01 修: 之前 OVERDUE 单永远不再被 retry, 卡死)
  // 银行临时错误 (网络抖动 / 余额不足等) 应该自动复活, retryCount<5 才重试避免死循环
  // needApproval=true 的不动 (业务流程要求重审)
  const RETRY_MAX = 5
  const overduePending = autoPayEnabled ? await prisma.paymentSchedule.findMany({
    where: {
      status: 'OVERDUE',
      needApproval: false,
      retryCount: { lt: RETRY_MAX },
      // 加 throttle: 至少距上次失败 1 小时, 防 cron 跑两次 retry 太密
      // (PaymentSchedule 没 updatedAt 字段方便用, 用 dueAt 兜底 — OVERDUE 后 dueAt 不变, OK)
    },
  }) : []
  let overdueOk = 0
  for (const s of overduePending) {
    try {
      // 先恢复 PENDING (executeBankPayment 会走 status=PROCESSING → PAID/OVERDUE)
      // 但 executeBankPayment 没校验 status, 直接调即可
      await executeBankPayment(s.id)
      overdueOk++
    } catch (e: any) {
      // 失败 retryCount 在 executeBankPayment 里 increment 了
      console.error(`OVERDUE 重试失败 ${s.id} (第 ${s.retryCount + 1}/${RETRY_MAX} 次):`, e.message)
    }
  }
  if (overduePending.length > 0) {
    console.log(`🔁 OVERDUE 重试: ${overduePending.length} 单, ${overdueOk} 成功`)
  }

  // 5. 标记逾期
  await prisma.paymentSchedule.updateMany({
    where: {
      status: { in: ['PENDING', 'NOTIFIED'] },
      needApproval: false,
      dueAt: { lt: now.startOf('day').toDate() },
    },
    data: { status: 'OVERDUE' },
  })

  console.log(`✅ 账期扫描完成: 提醒成功${reminderSuccess}笔/失败${reminderFailed}笔，付款${dueSchedules.length + pendingDue.length}笔，OVERDUE 复活${overdueOk}笔`)

  // ── 6. 24h 自动收货 (供应商点送达 24h 后门店未确认 → 自动 RECEIVED) ───
  // 倒计时基准从 shippedAt (发出) 改为 deliveredAt (送达). 还在路上的不会被自动收货
  const overdueShipped = await prisma.purchaseOrder.findMany({
    where: {
      status: 'PENDING_CONFIRM',
      deliveredAt: { lt: now.subtract(24, 'hour').toDate() },   // 必须有 deliveredAt 且超 24h
    },
    select: { id: true, no: true },
    take: 200,
  })
  let autoReceivedCount = 0
  for (const o of overdueShipped) {
    try {
      const result = await autoReceivePurchaseOrder(o.id)
      if (result && !result.duplicated) autoReceivedCount++
    } catch (e: any) {
      console.error(`自动收货失败 ${o.no}:`, e.message)
    }
  }

  // 已确认的入库单不会再次进入待确认扫描；独立补偿最近缺失的财务派生记录。
  try {
    const derivativeRepair = await repairReceiptDerivatives()
    if (derivativeRepair.incomplete > 0) {
      console.log(`🧾 入库派生修复: ${derivativeRepair.repaired}/${derivativeRepair.incomplete} 成功, ${derivativeRepair.failed} 失败`)
      for (const failure of derivativeRepair.failures) {
        console.error(`入库派生修复失败 ${failure.receiptId}: ${failure.errors.join('; ')}`)
      }
    }
  } catch (error: any) {
    // 修复扫描本身失败不能阻断后续报损、周期凭证等日任务。
    console.error('入库派生修复扫描失败:', error?.message || error)
  }

  // ── 7. 报损 24h 自动同意 (PENDING 超 24h → AUTO_APPROVED + 回补供应商库存) ───
  const overdueLossClaims = await prisma.lossClaim.findMany({
    where: { status: 'PENDING', createdAt: { lt: now.subtract(24, 'hour').toDate() } },
    include: { items: true, purchaseOrder: { include: { receipt: true } } },
    take: 200,
  })
  const { approveLossClaimAtomically } = await import('../routes/lossClaims')
  for (const c of overdueLossClaims) {
    try {
      // 状态抢占、库存回补、库存流水和审计日志同事务，且与供应商人工处理共用事务锁。
      const result = await approveLossClaimAtomically({
        claimId: c.id,
        tenantId: c.tenantId,
        operatorId: c.createdById,
        reason: `[自动] 24h 自动同意报损 ${c.no}`,
        automatic: true,
      })
      if (!result.transitioned) {
        // 供应商在 schedule fire 之前已抢先操作 — 跳过此条
        console.log(`⏭ 跳过 ${c.no} (并发竞争: 已不是 PENDING)`)
        continue
      }
    } catch (e: any) {
      console.error(`自动同意报损失败 ${c.no}:`, e.message)
    }
  }

  console.log(`✅ 自动收货 ${autoReceivedCount}/${overdueShipped.length} 单, 自动同意报损 ${overdueLossClaims.length} 笔`)

  // 5. 周期性凭证模板 (房租/水电/折旧 月度自动建凭证)
  try {
    const { runAllTenants } = await import('./voucher/templates')
    const r = await runAllTenants()
    if (r.totalRun > 0) console.log(`✅ 周期凭证生成 ${r.totalRun} 笔 (${r.tenants} 租户)`)
  } catch (e: any) {
    console.error('凭证模板扫描失败:', e.message)
  }
}

// 兼容旧版调用
export function startScheduler() {
  // 立即执行一次
  runDailyCheck().catch(console.error)
  
  // 每天 01:00 执行
  const now = dayjs()
  const next1am = now.hour() < 1 
    ? now.startOf('day').add(1, 'hour')
    : now.startOf('day').add(1, 'day').add(1, 'hour')
  
  const msUntilNext = next1am.diff(now)
  
  setTimeout(() => {
    runDailyCheck().catch(console.error)
    setInterval(() => runDailyCheck().catch(console.error), 24 * 60 * 60 * 1000)
  }, msUntilNext)
  
  console.log('⏰ 账期调度器已启动（每天 01:00 扫描）')
  
  // ── 日报未上传提醒: 每天 11:00 (Asia/Shanghai, 业务要求 11:00 前传前一营业日双表) ──
  // 沿用美团 cron 的 setInterval + 时间窗模式, 不引入 cron 库;
  // 每分钟检查一次, 命中 11:00-11:05 窗口即扫; eventKey + NotificationLog 持久去重保每店每天一条。
  setInterval(() => {
    const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    if (shanghaiNow.getUTCHours() === 11 && shanghaiNow.getUTCMinutes() < 5) {
      runDailyReportReminder().catch(err => console.error('[daily-report-reminder] failed:', err))
    }
  }, 60 * 1000)
  console.log('📅 日报未上传提醒已启动（每天 11:00 Asia/Shanghai）')

  // ── 美团智能版 API 同步 (spec: 2026-05-27) ──
  if (process.env.MEITUAN_ENABLED === 'true') {
    console.log('🍔 启动美团 cron: 每小时 + 每天 04:00')

    // 进程启动 30s 后跑首次 (避免启动风暴)
    setTimeout(() => {
      runMeituanHourlySync().catch(err =>
        console.error('[meituan-hourly-first-run] failed:', err)
      )
    }, 30_000)

    // 每小时跑
    setInterval(() => {
      runMeituanHourlySync().catch(err =>
        console.error('[meituan-hourly] failed:', err)
      )
    }, 60 * 60 * 1000)

    // 每天 04:00 (用 setInterval + 时间窗判断, 简单不引 cron 库)
    setInterval(() => {
      const now = new Date()
      if (now.getHours() === 4 && now.getMinutes() < 5) {
        runMeituanDailyReconcile().catch(err =>
          console.error('[meituan-daily-reconcile] failed:', err)
        )
      }
    }, 5 * 60 * 1000)   // 每 5 分钟检查一次 04:00 窗口
  } else {
    console.log('🍔 美团 cron 未启用 (MEITUAN_ENABLED != true)')
  }

  // ── CMB 流水自动同步到本地 cashbook ──
  // 解决: 老板/财务在招行 APP 直接转账等不经过滇界的流水永远不进本地账本
  // 频率: 启动 60s 后跑首次 (拉近 3 天), 之后每 30 分钟跑一次 (拉昨天+今天)
  if (!isCmbSyncEnabled()) {
    console.log('🔒 CMB 流水自动同步未启用 (需要生产环境显式设置 CMB_SYNC_ENABLED=true)')
    return
  }
  setTimeout(() => {
    syncAllCmbAccounts(3)
      .then(results => {
        const totals = results.reduce((acc, r) => ({
          pulled: acc.pulled + r.pulled,
          matched: acc.matched + r.matched,
          alreadySynced: acc.alreadySynced + r.alreadySynced,
          newlyWritten: acc.newlyWritten + r.newlyWritten,
          errors: acc.errors + r.errors,
        }), { pulled: 0, matched: 0, alreadySynced: 0, newlyWritten: 0, errors: 0 })
        console.log(`💰 cmb-auto-sync 首跑: ${results.length} 账户, 拉 ${totals.pulled} 条 (${totals.matched} 已 sink / ${totals.alreadySynced} 同步过 / ${totals.newlyWritten} 新写入 / ${totals.errors} 错)`)
      })
      .catch(err => console.error('[cmb-auto-sync-first] failed:', err))
  }, 60_000)

  setInterval(() => {
    syncAllCmbAccounts(1).catch(err => console.error('[cmb-auto-sync] failed:', err))
  }, 30 * 60 * 1000)

  console.log('💰 CMB 流水自动同步已启动 (启动后 60s 首跑, 之后每 30 分钟一次)')
}
