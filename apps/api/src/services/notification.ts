import dayjs from 'dayjs'
import { prisma } from '@dianjie/db'

interface NotifyPayload {
  tenantId: string
  recipientRole: string          // 目标角色
  recipientId?: string           // 指定用户（可选）
  type: string                   // 通知类型
  title: string
  body: string
  refType?: string               // 关联实体类型
  refId?: string                 // 关联实体 ID
  // 兼容旧调用
  supplierName?: string
  amount?: number
  dueAt?: Date
  scheduleId?: string
}

/**
 * 统一通知入口
 * 1. 写入 notifications 表（系统内通知）
 * 2. 控制台日志
 * 3. 企业微信 Webhook（配置后生效）
 */
export async function sendNotification(payload: NotifyPayload) {
  const { tenantId, recipientRole, recipientId, type, title, body, refType, refId } = payload

  // 1. 写入 DB
  try {
    await prisma.notification.create({
      data: { tenantId, recipientRole, recipientId, type, title, body, refType, refId },
    })
  } catch (err) {
    console.error('写入通知失败:', err)
  }

  // 2. 控制台日志
  console.log(`\n📨 [通知] [${recipientRole}] ${title} — ${body}\n`)

  // 3. 企业微信 Webhook
  const webhookUrl = process.env.WECHAT_WEBHOOK_URL
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { content: buildWechatMarkdown(payload) },
        }),
      })
    } catch (err) {
      console.error('企业微信通知失败:', err)
    }
  }
}

function buildWechatMarkdown(payload: NotifyPayload): string {
  const isUrgent = ['LOSS_CLAIM_CREATED', 'APPROVAL_PENDING', 'DUE_REMINDER_1DAY'].includes(payload.type)
  const icon = isUrgent ? '🚨' : '📋'
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

  const linkMap: Record<string, string> = {
    ORDER_SUBMITTED: '/orders',
    ORDER_SHIPPED: '/receipts',
    RECEIPT_CONFIRMED: '/finance',
    LOSS_CLAIM_CREATED: '/loss-claims',
    LOSS_CLAIM_RESULT: '/loss-claims',
    APPROVAL_PENDING: '/approval',
    APPROVAL_DONE: '/finance',
    DUE_REMINDER_3DAY: '/finance',
    DUE_REMINDER_1DAY: '/finance',
  }
  const link = linkMap[payload.type] || '/dashboard'

  return `${icon} **滇界云管 · ${payload.title}**
> ${payload.body}

[前往处理 →](${frontendUrl}${link})`
}

// ── 便捷方法（业务代码调用）──────────────────────────

export function notifyOrderSubmitted(tenantId: string, orderNo: string, storeName: string, supplierId: string) {
  return sendNotification({
    tenantId,
    recipientRole: 'SUPPLIER_STAFF',
    type: 'ORDER_SUBMITTED',
    title: '新采购订单',
    body: `${storeName} 提交了采购订单 ${orderNo}，请及时确认`,
    refType: 'PurchaseOrder',
  })
}

/** 供应商接单 → 通知店长 + 厨师长 (本店) */
export async function notifyOrderConfirmed(tenantId: string, orderNo: string, supplierName: string, storeId: string) {
  for (const role of ['MANAGER', 'KITCHEN_LEAD']) {
    await sendNotification({
      tenantId, recipientRole: role,
      type: 'ORDER_CONFIRMED',
      title: '供应商已接单',
      body: `${supplierName} 已接单 ${orderNo}, 等待发货`,
      refType: 'PurchaseOrder',
    })
  }
}

/** 供应商拒单 → 通知店长 + 厨师长 (需重新下单) */
export async function notifyOrderRejected(tenantId: string, orderNo: string, supplierName: string, reason: string, storeId: string) {
  for (const role of ['MANAGER', 'KITCHEN_LEAD']) {
    await sendNotification({
      tenantId, recipientRole: role,
      type: 'ORDER_REJECTED',
      title: '⚠ 供应商拒单',
      body: `${supplierName} 拒绝了 ${orderNo}: ${reason}. 请改换供应商或调整下单内容.`,
      refType: 'PurchaseOrder',
    })
  }
}

export function notifyOrderShipped(tenantId: string, orderNo: string, supplierName: string, storeId: string) {
  return sendNotification({
    tenantId,
    recipientRole: 'MANAGER',
    type: 'ORDER_SHIPPED',
    title: '供应商已发货',
    body: `${supplierName} 已发货 ${orderNo}，请安排收货`,
    refType: 'PurchaseOrder',
  })
}

export function notifyReceiptConfirmed(tenantId: string, receiptNo: string, storeName: string, hasLoss: boolean, lossAmount: number) {
  const body = hasLoss
    ? `${storeName} 确认收货 ${receiptNo}，报损 ¥${lossAmount.toLocaleString()}，请24h内处理`
    : `${storeName} 确认收货 ${receiptNo}，无损耗`
  return sendNotification({
    tenantId,
    recipientRole: 'SUPPLIER_STAFF',
    type: 'RECEIPT_CONFIRMED',
    title: '入库确认',
    body,
    refType: 'Receipt',
  })
}

export function notifyLossClaimResult(tenantId: string, claimNo: string, action: 'approve' | 'reject', amount: number) {
  const label = action === 'approve' ? '已同意' : '已拒绝'
  return sendNotification({
    tenantId,
    recipientRole: 'MANAGER',
    type: 'LOSS_CLAIM_RESULT',
    title: `报损${label}`,
    body: `供应商${label}报损 ${claimNo}，金额 ¥${amount.toLocaleString()}`,
    refType: 'LossClaim',
  })
}

export function notifyApprovalPending(tenantId: string, amount: number, supplierName: string) {
  return sendNotification({
    tenantId,
    recipientRole: 'ADMIN',
    type: 'APPROVAL_PENDING',
    title: '付款审批待处理',
    body: `${supplierName} 付款 ¥${amount.toLocaleString()} 待审批`,
    refType: 'PaymentSchedule',
  })
}

export function notifyApprovalDone(tenantId: string, amount: number, supplierName: string) {
  return sendNotification({
    tenantId,
    recipientRole: 'FINANCE',
    type: 'APPROVAL_DONE',
    title: '付款已审批',
    body: `${supplierName} 付款 ¥${amount.toLocaleString()} 已审批通过`,
    refType: 'PaymentSchedule',
  })
}
