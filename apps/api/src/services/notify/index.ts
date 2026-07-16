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

interface DeliveryReservationOptions {
  tenantId: string
  userId: string
  eventType: string
  eventKey: string
  channel: string
  payload: Record<string, any>
  bypassFrequency?: boolean
}

/**
 * Reserve one external delivery before calling the provider. The advisory lock
 * closes the find-then-send race across application instances. A stale
 * `processing` row suppresses duplicates for the same five-minute window;
 * `failed` rows do not block a retry.
 */
export async function reserveNotificationDelivery(opts: DeliveryReservationOptions): Promise<string | null> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`notification:${opts.tenantId}:${opts.userId}:${opts.eventKey}:${opts.channel}`}))::text AS locked`
    if (!opts.bypassFrequency) {
      const since = new Date(Date.now() - 5 * 60 * 1000)
      const duplicate = await tx.notificationLog.findFirst({
        where: {
          tenantId: opts.tenantId,
          userId: opts.userId,
          eventKey: opts.eventKey,
          channel: opts.channel,
          status: { in: ['processing', 'sent'] },
          createdAt: { gte: since },
        },
        select: { id: true },
      })
      if (duplicate) return null
    }
    const reservation = await tx.notificationLog.create({
      data: {
        tenantId: opts.tenantId,
        userId: opts.userId,
        eventType: opts.eventType,
        eventKey: opts.eventKey,
        channel: opts.channel,
        status: 'processing',
        payload: opts.payload as any,
      },
      select: { id: true },
    })
    return reservation.id
  })
}

export async function completeNotificationDelivery(reservationId: string, status: 'sent' | 'failed', errorMsg?: string) {
  return prisma.notificationLog.update({
    where: { id: reservationId },
    data: { status, errorMsg: status === 'failed' ? (errorMsg || 'unknown delivery failure') : null },
  })
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

  // P1: 并发处理收件人, 避免 N 个用户串行 DB roundtrip 拖垮 prisma 连接池
  const rendered = renderTemplate(event, payload)
  const results = await Promise.all(userIds.map(async (userId) => {
    try {
      // 3. 用户偏好
      const pref = await prisma.notificationPref.findUnique({
        where: { userId_eventType: { userId, eventType: event } },
      })
      if (pref && !pref.enabled) {
        await logSuppressed(tenantId, userId, event, eventKey, 'user_disabled')
        return 'suppressed' as const
      }

      // 4. 选通道并在外部发送前原子占位
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user || user.status === 'INACTIVE') return 'suppressed' as const
      const channels = pref?.channels?.length ? pref.channels : ['wecom']

      for (const channel of channels) {
        if (channel === 'wecom' && user.wecomUserId) {
          const reservationId = await reserveNotificationDelivery({
            tenantId, userId, eventType: event, eventKey, channel: 'wecom', payload, bypassFrequency,
          })
          if (!reservationId) {
            await logSuppressed(tenantId, userId, event, eventKey, 'frequency_blocked')
            return 'suppressed' as const
          }
          try {
            await sendViaWeCom(tenantId, user.wecomUserId, rendered)
          } catch (e: any) {
            await completeNotificationDelivery(reservationId, 'failed', e.message || String(e)).catch(logError => {
              console.error(`[notify] 更新失败投递日志 ${reservationId}:`, logError)
            })
            // 继续尝试下一个通道 (未来加 SMS / inapp)
            continue
          }
          try {
            await completeNotificationDelivery(reservationId, 'sent')
          } catch (logError) {
            // 外部发送已经成功时绝不能把占位改成 failed，否则下一次会重复触达。
            // 保留 processing 让当前频控窗口继续抑制，并记录基础设施告警。
            console.error(`[notify] 投递已成功但日志完成失败 ${reservationId}:`, logError)
          }
          return 'sent' as const
        }
      }
      return 'failed' as const
    } catch (e: any) {
      console.error(`[notify] ${event} → ${userId} 异常:`, e.message)
      return 'failed' as const
    }
  }))

  const sent = results.filter((r) => r === 'sent').length
  const suppressed = results.filter((r) => r === 'suppressed').length
  const failed = results.filter((r) => r === 'failed').length
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
