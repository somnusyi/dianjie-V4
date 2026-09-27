import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { BUSINESS_TZ, businessDateKey } from '../lib/businessTime'

dayjs.extend(utc)
dayjs.extend(timezone)

/** 门店收货/到货异常处理的统一业务截止时间（上海时间当天 12:00）。 */
export const STORE_RECEIPT_DEADLINE_HOUR = 12

/**
 * `Receipt.deliveryDate` 和 `PurchaseOrder.expectedDate` 都是 PostgreSQL `date`。
 * Prisma 将其表示为 UTC 零点；必须先保留该日期文本，再按业务时区构造 12:00，
 * 不能把它当作一个需要时区换算的事件时间。
 */
export function storeReceiptDateKey(receiptDate: Date): string {
  if (Number.isNaN(receiptDate.getTime())) throw new Error('收货业务日期无效')
  return receiptDate.toISOString().slice(0, 10)
}

export function storeReceiptDeadlineAt(receiptDate: Date): Date {
  const dateKey = storeReceiptDateKey(receiptDate)
  return dayjs.tz(`${dateKey} ${String(STORE_RECEIPT_DEADLINE_HOUR).padStart(2, '0')}:00`, BUSINESS_TZ).toDate()
}

/** Convert an actual arrival timestamp to the PostgreSQL date value for its Shanghai business day. */
export function storeReceiptDateFromArrivalAt(arrivalAt: Date): Date {
  const dateKey = businessDateKey(arrivalAt)
  return new Date(`${dateKey}T00:00:00.000Z`)
}

export function storeReceiptDeadlineStatus(receiptDate: Date, now: Date = new Date()) {
  const deadlineAt = storeReceiptDeadlineAt(receiptDate)
  const overdue = now.getTime() > deadlineAt.getTime()
  return {
    deadlineAt,
    overdue,
    requiresAction: overdue,
    requiresManualApproval: overdue,
  }
}
