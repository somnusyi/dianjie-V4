/**
 * 商品主数据变更通知服务
 *
 * 职责:
 *   - 解析本租户内有效 CHEF_DIRECTOR / 兼容 legacy CHEF 收件人
 *   - 为每位收件人创建系统内 Notification(带 recipientId + dedupeKey)
 *   - 通过新通知层 notify() 发送企业微信, 使用同一批明确 toUsers
 *   - 提供 fireAndForget 包装, 失败不抛回调用方
 *
 * 约束:
 *   - 不调用旧群 webhook (services/notification.ts 中的 WECHAT_WEBHOOK_URL)
 *   - 不广播到其它角色
 *   - 不做 schema migration / 不改商品路由
 */
import { prisma } from '@dianjie/db'
import { notify } from './index'

export type ProductChangeAction = 'CREATE' | 'UPDATE' | 'PRICE_CHANGE' | 'DISABLE' | 'ENABLE'

export interface NotifyProductChangeInput {
  tenantId: string
  productId: string
  action: ProductChangeAction
  operatorId: string
  /** 调用方保证稳定的业务 eventKey, 同一商品同一变更全局唯一 */
  eventKey: string
  /** 变更前摘要, 用于渲染文案 */
  before: Record<string, any>
  /** 变更后摘要, 用于渲染文案 */
  after: Record<string, any>
}

export interface NotifyProductChangeResult {
  notifiedUserIds: string[]
  skipped: { noRecipients: boolean }
}

const ACTION_LABELS: Record<ProductChangeAction, string> = {
  CREATE: '新增',
  UPDATE: '更新',
  PRICE_CHANGE: '调价',
  DISABLE: '停售',
  ENABLE: '恢复',
}

function actionLabel(action: ProductChangeAction): string {
  return ACTION_LABELS[action]
}

function buildTitle(action: ProductChangeAction, productName?: string): string {
  return `商品${actionLabel(action)}${productName ? `:${productName}` : ''}`
}

function buildBody(payload: {
  action: ProductChangeAction
  operatorName?: string | null
  before: Record<string, any>
  after: Record<string, any>
}): string {
  const { action, operatorName, before, after } = payload
  const productName = after.name || before.name || '商品'
  const lines = [`${productName} 已由 ${operatorName || '系统'} ${actionLabel(action)}`]

  if (action === 'PRICE_CHANGE' && (before.price !== undefined || after.price !== undefined)) {
    lines.push(`价格: ¥${before.price ?? '-'} → ¥${after.price ?? '-'}`)
  }
  if ((action === 'DISABLE' || action === 'ENABLE') && (before.status || after.status)) {
    lines.push(`状态: ${before.status ?? '-'} → ${after.status ?? '-'}`)
  }
  if (action === 'CREATE' && after.category) {
    lines.push(`分类: ${after.category}`)
  }
  if (action === 'UPDATE' && (before.spec || after.spec)) {
    lines.push(`规格: ${before.spec ?? '-'} → ${after.spec ?? '-'}`)
  }

  lines.push('请核对商品主数据。')
  return lines.join('；')
}

/**
 * 只解析同一租户内有效的 CHEF_DIRECTOR, 兼容仍存在的 legacy CHEF;
 * 不包含其它角色, 不跨租户, 不返回 INACTIVE。
 */
async function resolveChefDirectorIds(tenantId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      role: { in: ['CHEF_DIRECTOR', 'CHEF'] },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  return users.map((u) => u.id)
}

/**
 * 新建/编辑/调价/停售/恢复商品后调用。
 * 返回实际通知到的 userId 列表; 未找到总厨时 skipped.noRecipients 为 true。
 */
export async function notifyProductChange(
  input: NotifyProductChangeInput,
): Promise<NotifyProductChangeResult> {
  const { tenantId, productId, action, operatorId, eventKey, before, after } = input

  const chefIds = await resolveChefDirectorIds(tenantId)
  if (chefIds.length === 0) {
    return { notifiedUserIds: [], skipped: { noRecipients: true } }
  }

  const operator = await prisma.user.findUnique({
    where: { id: operatorId },
    select: { name: true },
  })

  const productName = after.name || before.name
  const title = buildTitle(action, productName)
  const body = buildBody({ action, operatorName: operator?.name, before, after })

  // 1. 系统内 Notification: 逐人创建, dedupeKey 包含 recipientId 保证每人一条
  await Promise.all(
    chefIds.map(async (recipientId) => {
      const dedupeKey = `${eventKey}:${recipientId}`
      await prisma.notification.upsert({
        where: { tenantId_dedupeKey: { tenantId, dedupeKey } },
        create: {
          tenantId,
          dedupeKey,
          recipientRole: 'CHEF_DIRECTOR',
          recipientId,
          type: 'PRODUCT_CHANGED',
          title,
          body,
          refType: 'Product',
          refId: productId,
        },
        update: {},
      })
    }),
  )

  // 2. 企业微信: 通过现有通知层, 同一批明确 toUsers
  await notify({
    tenantId,
    event: 'PRODUCT_CHANGED',
    eventKey,
    payload: {
      productId,
      action,
      productName,
      operatorName: operator?.name,
      oldPrice: before.price,
      newPrice: after.price,
      oldStatus: before.status,
      newStatus: after.status,
      supplierName: after.supplierName || before.supplierName,
    },
    toUsers: chefIds,
  })

  return { notifiedUserIds: chefIds, skipped: { noRecipients: false } }
}

/**
 * Fire-and-forget 包装。
 * 商品核心事务提交后调用; 系统消息或企微失败不会抛回调用方,
 * 但会通过 Notification/NotificationLog 留下可重试证据。
 */
export function fireAndForgetNotifyProductChange(input: NotifyProductChangeInput): void {
  notifyProductChange(input).catch((err) => {
    console.error('[fireAndForgetNotifyProductChange] 商品变更通知失败:', err)
  })
}
