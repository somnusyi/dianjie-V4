import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { executeBankPayment, approvePaymentSchedule } from './paymentSchedule'
import { sendNotification as notify } from './notification'

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
    include: { supplier: true, receipt: { include: { store: true } } },
  })

  for (const s of threeDaySchedules) {
    await notify({
      tenantId: s.tenantId,
      recipientRole: 'FINANCE',
      type: 'DUE_REMINDER_3DAY',
      title: '账期提醒：3天后到期',
      body: `${s.receipt.store.name} → ${s.supplier.name} ¥${Number(s.amount).toLocaleString()}，到期日 ${dayjs(s.dueAt).format('MM/DD')}`,
      refType: 'PaymentSchedule',
      refId: s.id,
    })
    await prisma.paymentSchedule.update({ where: { id: s.id }, data: { notified3Days: true } })
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
    include: { supplier: true, receipt: { include: { store: true } } },
  })

  for (const s of oneDaySchedules) {
    await notify({
      tenantId: s.tenantId,
      recipientRole: 'FINANCE',
      type: 'DUE_REMINDER_1DAY',
      title: '紧急：明日到期',
      body: `${s.receipt.store.name} → ${s.supplier.name} ¥${Number(s.amount).toLocaleString()}`,
      refType: 'PaymentSchedule',
      refId: s.id,
    })
    await prisma.paymentSchedule.update({ where: { id: s.id }, data: { notified1Day: true } })
  }

  // 3. 到期自动付款（APPROVED 状态 = 已审批或不需审批）
  const dueSchedules = await prisma.paymentSchedule.findMany({
    where: {
      status: 'APPROVED',
      dueAt: { lte: now.endOf('day').toDate() },
    },
  })

  for (const s of dueSchedules) {
    try {
      await executeBankPayment(s.id)
    } catch (e: any) {
      console.error(`付款失败 ${s.id}:`, e.message)
    }
  }

  // 4. 不需审批且到期的 PENDING 单直接触发
  const pendingDue = await prisma.paymentSchedule.findMany({
    where: {
      status: 'PENDING',
      needApproval: false,
      dueAt: { lte: now.endOf('day').toDate() },
    },
  })

  for (const s of pendingDue) {
    try {
      await executeBankPayment(s.id)
    } catch (e: any) {
      console.error(`付款失败 ${s.id}:`, e.message)
    }
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

  console.log(`✅ 账期扫描完成: 提醒${threeDaySchedules.length + oneDaySchedules.length}笔，付款${dueSchedules.length + pendingDue.length}笔`)

  // ── 6. 24h 自动收货 (供应商点送达 24h 后门店未确认 → 自动 RECEIVED) ───
  // 倒计时基准从 shippedAt (发出) 改为 deliveredAt (送达). 还在路上的不会被自动收货
  const overdueShipped = await prisma.purchaseOrder.findMany({
    where: {
      status: 'PENDING_CONFIRM',
      deliveredAt: { lt: now.subtract(24, 'hour').toDate() },   // 必须有 deliveredAt 且超 24h
    },
    include: { items: true, supplier: true, store: true },
    take: 200,
  })
  for (const o of overdueShipped) {
    try {
      // P0 race condition guard: 用 updateMany 抢占, 防止用户在同时间确认收货导致重复 receipt
      const claim = await prisma.purchaseOrder.updateMany({
        where: { id: o.id, status: 'PENDING_CONFIRM' },
        data: { autoConfirmed: true },   // 先标 autoConfirmed, 后续再补 status
      })
      if (claim.count === 0) {
        console.log(`⏭ 跳过 ${o.no} (并发竞争: 已不是 PENDING_CONFIRM)`)
        continue
      }
      // 默认按下单数量全收 (没有报损)
      const ym = dayjs().format('YYYYMM')
      const cnt = await prisma.receipt.count({ where: { tenantId: o.tenantId, no: { startsWith: `RK${ym}` } } })
      const no = `RK${ym}${String(cnt + 1).padStart(6, '0')}`
      // 24h 自动收货 — 按 shippedQty (供应商实发量), 没填回退 quantity
      const totalAmt = o.items.reduce((s, i) => s + Number(i.shippedQty ?? i.quantity) * Number(i.unitPrice), 0)
      const receipt = await prisma.receipt.create({
        data: {
          tenantId: o.tenantId, no,
          storeId: o.storeId, supplierId: o.supplierId,
          deliveryDate: new Date(),
          totalAmount: totalAmt, status: 'CONFIRMED',
          confirmedAt: new Date(), createdById: o.createdById,
          items: { create: o.items.map(i => {
            const q = i.shippedQty ?? i.quantity
            return { productId: i.productId, quantity: q, unitPrice: i.unitPrice, amount: Number(i.unitPrice) * Number(q) }
          }) },
        },
      })
      await prisma.purchaseOrder.update({
        where: { id: o.id },
        data: { status: 'COMPLETED', receivedAt: new Date(), receiptId: receipt.id, autoConfirmed: true },
      })
      const { autoProcessAfterConfirm } = await import('./paymentSchedule')
      const fullReceipt = await prisma.receipt.findUnique({ where: { id: receipt.id } }) as any
      fullReceipt.confirmedAt = new Date()
      await autoProcessAfterConfirm({ tenantId: o.tenantId, receipt: fullReceipt, supplier: o.supplier })
      await prisma.opLog.create({ data: { tenantId: o.tenantId, userId: o.createdById, action: `[自动] 24h 自动确认收货 ${o.no}`, target: o.no, entityType: 'PurchaseOrder', targetId: o.id } })
    } catch (e: any) {
      console.error(`自动收货失败 ${o.no}:`, e.message)
    }
  }

  // ── 7. 报损 24h 自动同意 (PENDING 超 24h → AUTO_APPROVED + 回补供应商库存) ───
  const overdueLossClaims = await prisma.lossClaim.findMany({
    where: { status: 'PENDING', createdAt: { lt: now.subtract(24, 'hour').toDate() } },
    include: { items: true, purchaseOrder: { include: { receipt: true } } },
    take: 200,
  })
  const { refundSupplierStockOnLossApproved } = await import('../routes/lossClaims')
  for (const c of overdueLossClaims) {
    try {
      // P0 race condition fix: 用 updateMany + WHERE status=PENDING guard
      // 防止供应商在 23:59 拒绝 / 同意时, scheduler 在 23:59 同时跑导致状态冲突
      const upd = await prisma.lossClaim.updateMany({
        where: { id: c.id, status: 'PENDING' },   // 只在仍是 PENDING 时改
        data: { status: 'AUTO_APPROVED', autoApproved: true, handledAt: new Date() },
      })
      if (upd.count === 0) {
        // 供应商在 schedule fire 之前已抢先操作 — 跳过此条
        console.log(`⏭ 跳过 ${c.no} (并发竞争: 已不是 PENDING)`)
        continue
      }
      await refundSupplierStockOnLossApproved(c, c.createdById, `[自动] 24h 自动同意报损 ${c.no}`)
      await prisma.opLog.create({ data: { tenantId: c.tenantId, userId: c.createdById, action: `[自动] 报损 ${c.no} 24h 自动同意`, target: c.no, entityType: 'LossClaim', targetId: c.id } })
    } catch (e: any) {
      console.error(`自动同意报损失败 ${c.no}:`, e.message)
    }
  }

  console.log(`✅ 自动收货 ${overdueShipped.length} 单, 自动同意报损 ${overdueLossClaims.length} 笔`)
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
}
