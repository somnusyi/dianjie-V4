/**
 * 日报未上传提醒 (每天 11:00 Asia/Shanghai)
 *
 * 业务规则: 门店须在 11:00 前上传前一营业日双表并确认。
 * 本服务在 11:00 窗口扫描所有「已正式运行」门店, 前一营业日无已确认日报时
 * 通知该店店长/厨师长, 每店每天最多一条。
 *
 * 「已正式运行」口径 (避免骚扰 DJ002 包河万达等未开业门店):
 *   status = ENABLED 且 (lifecyclePhase = OPERATING 或 已有过至少一份已确认日报)
 *   且门店已绑定 ACTIVE 的店长/厨师长账号 (否则无人可收)
 *
 * 防重: eventKey 含 storeId + bizDate; notify 内部 5 分钟频控窗口之外,
 * 另查 NotificationLog 持久去重 (进程在 11:00 窗口内重启不会二次推送)。
 */
import { prisma } from '@dianjie/db'
import { fireAndForget as notify } from './notify'

const BOUND_ROLES = ['MANAGER', 'KITCHEN_LEAD'] as const

/** 上海时区的日期文本 (服务器时区无关) */
export function shanghaiDateText(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 前一营业日 = 上海昨天 */
export function previousBizDate(now: Date = new Date()): string {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  return shanghaiDateText(yesterday)
}

/** 门店是否达到「已正式运行」口径 (纯函数, 便于单测) */
export function isStoreEligibleForReminder(
  store: { status: string; lifecyclePhase: string },
  hasConfirmedReport: boolean,
): boolean {
  if (store.status !== 'ENABLED') return false
  return store.lifecyclePhase === 'OPERATING' || hasConfirmedReport
}

export type MissingReportStore = {
  id: string
  tenantId: string
  name: string
  no: string
}

/** 找出 bizDate 没有已确认日报、且应被提醒的门店 */
export async function findStoresMissingDailyReport(bizDate: string): Promise<MissingReportStore[]> {
  const stores = await prisma.store.findMany({
    where: { status: 'ENABLED' },
    select: {
      id: true, tenantId: true, name: true, no: true, status: true, lifecyclePhase: true,
      users: {
        where: { role: { in: [...BOUND_ROLES] }, status: 'ACTIVE' },
        select: { id: true },
        take: 1,
      },
      dailyBusinessImports: {
        where: { status: 'CONFIRMED' },
        select: { id: true, businessDate: true },
        orderBy: { businessDate: 'desc' },
        take: 5,
      },
    },
  })
  return stores
    .filter(store => store.users.length > 0)
    .filter(store => isStoreEligibleForReminder(store, store.dailyBusinessImports.length > 0))
    .filter(store => !store.dailyBusinessImports.some(row => row.businessDate.toISOString().slice(0, 10) === bizDate))
    .map(({ id, tenantId, name, no }) => ({ id, tenantId, name, no }))
}

/** 该店当天的提醒是否已经成功发出/在发 (持久去重) */
export async function alreadyReminded(tenantId: string, eventKey: string): Promise<boolean> {
  const existing = await prisma.notificationLog.findFirst({
    where: {
      tenantId,
      eventType: 'DAILY_REPORT_MISSING',
      eventKey,
      status: { in: ['processing', 'sent'] },
    },
    select: { id: true },
  })
  return Boolean(existing)
}

export async function runDailyReportReminder(bizDate: string = previousBizDate()): Promise<{ checked: number; reminded: number; skipped: number }> {
  const missing = await findStoresMissingDailyReport(bizDate)
  let reminded = 0
  let skipped = 0
  for (const store of missing) {
    const eventKey = `DAILY_REPORT:${store.id}:${bizDate}:MISSING`
    try {
      if (await alreadyReminded(store.tenantId, eventKey)) {
        skipped++
        continue
      }
      notify({
        tenantId: store.tenantId,
        event: 'DAILY_REPORT_MISSING',
        eventKey,
        payload: { storeName: store.name, bizDate },
        toStoreIds: [store.id],
      })
      reminded++
    } catch (error: any) {
      console.error(`[daily-report-reminder] ${store.no} ${store.name} 提醒失败:`, error?.message || error)
    }
  }
  if (missing.length > 0) {
    console.log(`📅 日报未上传提醒 (${bizDate}): 缺报 ${missing.length} 店, 新提醒 ${reminded}, 已提醒跳过 ${skipped}`)
  }
  return { checked: missing.length, reminded, skipped }
}
