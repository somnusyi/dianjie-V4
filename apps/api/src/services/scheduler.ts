import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { executeBankPayment } from './paymentSchedule'
import { sendNotification as notify } from './notification'
import { runMeituanHourlySync, runMeituanDailyReconcile } from './meituan/cron'
import { isCmbSyncEnabled, syncAllCmbAccounts } from './cmbAutoSync'
import { repairReceiptDerivatives } from './receiptDerivatives'
import { runDailyReportReminder } from './dailyReportReminder'
import { storeReceiptDeadlineStatus } from './storeReceiptDeadline'

/**
 * 自动收货已取消：收货事实只能由门店人工确认。保留导出以兼容历史脚本，
 * 但无论调用方为何均不会读取或写入订单、入库、库存、账期或派生记录。
 */
export async function autoReceivePurchaseOrder(orderId: string) {
  console.warn(`自动收货已停用，等待门店人工收货：${orderId}`)
  return null
}

export type PaymentReminderKind = '3DAY' | '1DAY'

/**
 * 送达兜底（2026-08-15 与供应链确认）：发货后 24h 内必达，但"点送达"目前由
 * 负责人/会计代点、经常遗忘，导致配送单永久停在 SHIPPED、门店无法收货。
 * 超 24h 未人工送达的配送单由系统自动推进到 DELIVERED（标记 autoDelivered）。
 *
 * 安全约束：autoDelivered 的配送单跳过 24h 自动收货——自动送达只解锁状态，
 * 收货事实仍以门店人工确认为准，防止"货未到 → 自动送达 → 自动收货 → 幽灵入账"。
 */
export async function autoDeliverStaleShipments() {
  const cutoff = dayjs().subtract(24, 'hour').toDate()
  const stale = await prisma.deliveryOrder.findMany({
    where: { status: 'SHIPPED', shippedAt: { lt: cutoff } },
    select: {
      id: true, tenantId: true, rowVersion: true, purchaseOrderId: true,
      purchaseOrder: { select: { no: true, status: true, storeId: true, supplierId: true } },
    },
    take: 100,
  })
  let delivered = 0
  for (const d of stale) {
    if (d.purchaseOrder.status !== 'DELIVERING') continue
    const deliveredAt = new Date()
    try {
      const advanced = await prisma.$transaction(async tx => {
        const upd = await tx.deliveryOrder.updateMany({
          where: { id: d.id, status: 'SHIPPED', rowVersion: d.rowVersion },
          data: { status: 'DELIVERED', deliveredAt, autoDelivered: true, rowVersion: { increment: 1 } },
        })
        if (upd.count === 0) return false // 并发竞争：已被人点过，跳过
        const orderUpd = await tx.purchaseOrder.updateMany({
          where: { id: d.purchaseOrderId, status: 'DELIVERING' },
          data: { status: 'PENDING_CONFIRM', deliveredAt },
        })
        if (orderUpd.count === 0) return false // 订单侧已被并发推进，配送单状态保留实际事实
        await tx.deliveryOrderEvent.create({
          data: {
            tenantId: d.tenantId, deliveryOrderId: d.id, eventType: 'DELIVERED',
            fromStatus: 'SHIPPED', toStatus: 'DELIVERED',
            metadata: { autoDelivered: true },
          },
        })
        await tx.opLog.create({
          data: {
            tenantId: d.tenantId,
            action: `[自动] 发货超 24h 未点送达，系统自动送达 ${d.purchaseOrder.no}；等待门店人工验收（不自动收货）`,
            target: d.purchaseOrder.no, entityType: 'PurchaseOrder', targetId: d.purchaseOrderId,
          },
        })
        return true
      })
      if (!advanced) continue
      delivered++
      notify({
        tenantId: d.tenantId, recipientRole: 'MANAGER',
        type: 'ORDER_DELIVERED',
        title: `订单已自动送达, 请验收 ${d.purchaseOrder.no}`,
        body: `发货超 24 小时未确认送达，系统已自动推进。请门店尽快人工验收；如有异常请立即联系供应链。`,
        refType: 'PurchaseOrder', refId: d.purchaseOrderId,
      } as Parameters<typeof notify>[0]).catch(() => undefined)
    } catch (e: any) {
      console.error(`自动送达失败 ${d.purchaseOrder.no}:`, e?.message || e)
    }
  }
  if (delivered > 0) console.log(`📦 送达兜底: ${delivered}/${stale.length} 单自动送达（跳过自动收货）`)
  return { scanned: stale.length, delivered }
}

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

/**
 * Scan every pending arrival claim eligible for the existing 24-hour automatic
 * rule. Late same-day reports are intentionally counted but never approved.
 * A stable cursor prevents an arbitrary first 200 late reports from starving
 * older eligible records behind them.
 */
export async function autoApproveEligibleLossClaims(now = dayjs()) {
  const { approveLossClaimAtomically } = await import('../routes/lossClaims')
  let autoApprovedCount = 0
  let overdueManualReviewCount = 0
  let scannedLossClaims = 0
  let cursor: string | undefined
  for (;;) {
    const overdueLossClaims = await prisma.lossClaim.findMany({
      where: { status: 'PENDING', isManual: false, createdAt: { lt: now.subtract(24, 'hour').toDate() } },
      include: { items: true, purchaseOrder: { include: { receipt: true } }, receipt: { select: { deliveryDate: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!overdueLossClaims.length) break
    scannedLossClaims += overdueLossClaims.length
    for (const c of overdueLossClaims) {
      if (c.receipt?.deliveryDate && storeReceiptDeadlineStatus(c.receipt.deliveryDate, c.createdAt).overdue) {
        overdueManualReviewCount++
        console.log(`⏭ 跳过逾期补报 ${c.no}：需要人工审批`)
        continue
      }
      try {
        const result = await approveLossClaimAtomically({
          claimId: c.id, tenantId: c.tenantId, operatorId: c.createdById,
          reason: `[自动] 24h 自动同意报损 ${c.no}`, automatic: true,
        })
        if (!result.transitioned) {
          console.log(`⏭ 跳过 ${c.no} (并发竞争: 已不是 PENDING)`)
          continue
        }
        autoApprovedCount++
      } catch (e: any) {
        console.error(`自动同意报损失败 ${c.no}:`, e.message)
      }
    }
    if (overdueLossClaims.length < 200) break
    cursor = overdueLossClaims[overdueLossClaims.length - 1].id
  }
  return { autoApprovedCount, overdueManualReviewCount, scannedLossClaims }
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

  // ── 6. 报损 24h 自动同意（逾期补报必须保留人工审批） ───
  const { autoApprovedCount, overdueManualReviewCount, scannedLossClaims } = await autoApproveEligibleLossClaims(now)

  console.log(`✅ 自动收货已停用；自动同意报损 ${autoApprovedCount} 笔，逾期补报人工审批 ${overdueManualReviewCount} 笔（扫描 ${scannedLossClaims} 笔）`)

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

  // ── 送达兜底: 每小时扫描发货超 24h 未点送达的配送单, 系统自动送达 ──
  // 送达目前由负责人/会计代点、经常遗忘 → 门店卡在收不了货。业务已确认
  // 发货 24h 内必达；自动送达的单跳过 24h 自动收货（防幽灵入账），收货只认门店人工确认。
  setTimeout(() => {
    autoDeliverStaleShipments().catch(err => console.error('[auto-deliver-first] failed:', err))
  }, 90_000)
  setInterval(() => {
    autoDeliverStaleShipments().catch(err => console.error('[auto-deliver] failed:', err))
  }, 60 * 60 * 1000)
  console.log('📦 送达兜底已启动（启动后 90s 首跑, 之后每小时一次）')

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
