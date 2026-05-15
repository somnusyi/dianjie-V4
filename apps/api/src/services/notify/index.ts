/**
 * 触达层入口 (Layer 2)
 *
 * 业务代码只调 notify(...), 由本层决定:
 *   1. 解析收件人 (toUsers / toRoles + scope)
 *   2. 检查用户偏好 (NotificationPref)
 *   3. 频控去重 (NotificationLog eventKey)
 *   4. 静默时段 (22:00-07:00)
 *   5. 选通道 (wecom > sms > inapp)
 *   6. 实际发送 + 写日志
 *
 * 业务事件追加方法:
 *   - 在 events.ts 加常量 + 默认模板 + 路由规则
 *   - 业务路由调 notify({ event: 'XXX', ... })
 */
import { prisma } from '@dianjie/db'
import { EVENTS, EventKey, renderTemplate, defaultRecipients } from './events'
import { sendViaWeCom } from './channels/wecom'
import { isSilentHours } from './frequency-control'

export interface NotifyOptions {
  tenantId: string
  event: EventKey
  /** 去重 key: 同 key 在频控窗口内只发一次. 例 'PO:xxx:DELIVERED' */
  eventKey: string
  /** 业务上下文, 用于渲染模板 */
  payload: Record<string, any>
  /** 显式指定 user.id 列表 */
  toUsers?: string[]
  /** 按角色发 (与 scope 组合) */
  toRoles?: string[]
  toStoreIds?: string[]
  toSupplierIds?: string[]
  /** 跳过频控 (慎用, 紧急升级用) */
  bypassFrequency?: boolean
  /** 跳过静默时段 (紧急) */
  bypassSilent?: boolean
}

export async function notify(opts: NotifyOptions): Promise<{ sent: number; suppressed: number; failed: number }> {
  const { tenantId, event, eventKey, payload, bypassFrequency, bypassSilent } = opts
  const meta = EVENTS[event]
  if (!meta) {
    console.warn(`[notify] 未知事件: ${event}`)
    return { sent: 0, suppressed: 0, failed: 0 }
  }

  // 1. 解析收件人
  let userIds = opts.toUsers || []
  if (userIds.length === 0) {
    userIds = await defaultRecipients(tenantId, opts)
  }
  if (userIds.length === 0) {
    return { sent: 0, suppressed: 0, failed: 0 }
  }

  // 2. 静默时段判断 (除紧急)
  if (!bypassSilent && !meta.urgent && isSilentHours()) {
    // 静默时段: 暂不实现延迟队列, 直接 suppress
    for (const userId of userIds) {
      await logSuppressed(tenantId, userId, event, eventKey, 'silent_hours')
    }
    return { sent: 0, suppressed: userIds.length, failed: 0 }
  }

  let sent = 0, suppressed = 0, failed = 0
  for (const userId of userIds) {
    try {
      // 3. 用户偏好检查
      const pref = await prisma.notificationPref.findUnique({
        where: { userId_eventType: { userId, eventType: event } },
      })
      if (pref && !pref.enabled) {
        await logSuppressed(tenantId, userId, event, eventKey, 'user_disabled')
        suppressed++
        continue
      }

      // 4. 频控去重 (默认 5 分钟内同 eventKey 不重发)
      if (!bypassFrequency) {
        const since = new Date(Date.now() - 5 * 60 * 1000)
        const dup = await prisma.notificationLog.findFirst({
          where: { tenantId, userId, eventKey, status: 'sent', createdAt: { gte: since } },
        })
        if (dup) {
          await logSuppressed(tenantId, userId, event, eventKey, 'frequency_blocked')
          suppressed++
          continue
        }
      }

      // 5. 选通道
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user || user.status === 'INACTIVE') {
        suppressed++
        continue
      }
      const channels = pref?.channels?.length ? pref.channels : ['wecom']

      // 渲染消息
      const rendered = renderTemplate(event, payload)

      let delivered = false
      for (const channel of channels) {
        if (channel === 'wecom' && user.wecomUserId) {
          try {
            await sendViaWeCom(tenantId, user.wecomUserId, rendered)
            await prisma.notificationLog.create({
              data: {
                tenantId, userId, eventType: event, eventKey,
                channel: 'wecom', status: 'sent',
                payload: payload as any,
              },
            })
            delivered = true
            sent++
            break
          } catch (e: any) {
            await prisma.notificationLog.create({
              data: {
                tenantId, userId, eventType: event, eventKey,
                channel: 'wecom', status: 'failed',
                errorMsg: e.message || String(e),
                payload: payload as any,
              },
            })
            // 继续尝试下一个通道
          }
        }
        // 未来加 SMS / inapp 通道时在此扩展
      }
      if (!delivered) failed++
    } catch (e: any) {
      console.error(`[notify] ${event} → ${userId} 异常:`, e.message)
      failed++
    }
  }
  return { sent, suppressed, failed }
}

async function logSuppressed(tenantId: string, userId: string, event: string, eventKey: string, reason: string) {
  await prisma.notificationLog.create({
    data: {
      tenantId, userId, eventType: event, eventKey,
      channel: 'wecom', status: reason,
    },
  })
}

/**
 * Best-effort 调用, 业务路由用 fireAndForget 不阻塞响应
 */
export function fireAndForget(opts: NotifyOptions): void {
  notify(opts).catch((e) => console.error('[notify async]', e))
}
