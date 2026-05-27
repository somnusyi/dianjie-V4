import { prisma } from '@dianjie/db'
import { createId } from '@paralleldrive/cuid2'
import dayjs from 'dayjs'
import * as Sentry from '@sentry/node'
import { syncInstoreOrders, syncReverseOrders } from './sync'
import { processPendingOrders } from './processor'

const ORG_ID = Number(process.env.MEITUAN_ORG_ID || 0)
const INSTORE_API = '/rms/pos/api/v2/poi/orders/instore/query'
const ROLLING_HOURS = 24
const AUTO_CRON_MAX_LOOKBACK_DAYS = 30

/**
 * 每小时跑: 主路 (instore) + 退单兜底 + processor
 */
export async function runMeituanHourlySync(): Promise<void> {
  if (process.env.MEITUAN_ENABLED !== 'true') return
  if (!ORG_ID) {
    console.warn('⚠️ MEITUAN_ENABLED=true but MEITUAN_ORG_ID not set, skip cron')
    return
  }

  const correlationId = createId()
  const now = new Date()
  console.log(`⏰ [meituan-cron-hourly] correlationId=${correlationId}`)

  try {
    // 1. 主路：店内订单 (结账时间, 24h 滚动 + 30 天硬 cap)
    const cursor = await prisma.meituanSyncCursor.findUnique({
      where: { apiPath_orgId: { apiPath: INSTORE_API, orgId: ORG_ID } },
    })
    const since = new Date(Math.max(
      now.getTime() - ROLLING_HOURS * 3600_000,
      cursor?.lastSyncedAt?.getTime() ?? 0,
      now.getTime() - AUTO_CRON_MAX_LOOKBACK_DAYS * 24 * 3600_000,
    ))
    const instoreReport = await syncInstoreOrders({
      correlationId,
      since, until: now,
      queryTimeType: 2,             // 结账时间
      sortField: 2, sort: 2,        // 按结账时间正序
    })
    console.log(`✅ instore: ${instoreReport.orders} orders / ${instoreReport.pages} pages / ${instoreReport.durationMs}ms`)

    // 2. 退单兜底 (过去 2 营业日)
    const refundSince = new Date(now.getTime() - 2 * 24 * 3600_000)
    const reverseReport = await syncReverseOrders({
      correlationId,
      since: refundSince, until: now,
    })
    console.log(`✅ reverse: ${reverseReport.refunds} refunds / ${reverseReport.pages} pages`)

    // 3. 处理层
    const processReport = await processPendingOrders()
    console.log(`✅ processed: ${processReport.processed} / skipped-nostore: ${processReport.skippedNoStore} / errors: ${processReport.errors.length}`)
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'meituan-cron-hourly', correlationId } })
    throw e   // 让 caller 知道, 但不要让 cron 自身崩溃 — caller (scheduler) 应该 catch
  }
}

/**
 * 每天 04:00 跑: 日对账 (按营业日全量重拉昨天)
 */
export async function runMeituanDailyReconcile(): Promise<void> {
  if (process.env.MEITUAN_ENABLED !== 'true') return
  if (!ORG_ID) return

  const correlationId = createId()
  const yesterday = dayjs().subtract(1, 'day').startOf('day')
  const yesterdayEnd = dayjs().subtract(1, 'day').endOf('day')
  console.log(`⏰ [meituan-cron-daily-reconcile] correlationId=${correlationId} businessDate=${yesterday.format('YYYY-MM-DD')}`)

  try {
    await syncInstoreOrders({
      correlationId,
      since: yesterday.toDate(),
      until: yesterdayEnd.toDate(),
      queryTimeType: 4,             // 营业日期
    })
    await syncReverseOrders({
      correlationId,
      since: yesterday.toDate(),
      until: yesterdayEnd.toDate(),
    })
    await processPendingOrders()
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'meituan-cron-daily', correlationId } })
    throw e
  }
}

/**
 * 任意区间回拉 (admin 手动触发, 内部按 31 天切片)
 */
export async function backfillMeituan(p: { since: Date; until: Date }): Promise<void> {
  if (!ORG_ID) throw new Error('MEITUAN_ORG_ID not set')
  const MAX_WIN_DAYS = 31
  const correlationId = createId()

  let cur = p.since
  while (cur < p.until) {
    const winEnd = new Date(Math.min(
      cur.getTime() + MAX_WIN_DAYS * 24 * 3600_000,
      p.until.getTime(),
    ))
    await syncInstoreOrders({
      correlationId,
      since: cur, until: winEnd,
      queryTimeType: 4,             // 按营业日, 回拉用
    })
    await syncReverseOrders({
      correlationId,
      since: cur, until: winEnd,
    })
    cur = winEnd
  }
  await processPendingOrders()
}
