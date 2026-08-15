/**
 * 业务时区工具：单号月份、期间、归属日的唯一权威来源。
 *
 * 背景：dayjs() 默认按宿主机本地时区解释时间，导致
 *   - 开发/CI 机时区非华东时，月度单号序列错月（DOC202607000001）；
 *   - 传入 UTC 时间戳（receivedAt/confirmedAt）在上海月末 16:00Z 后错月。
 * 所有月度序列号与业务归属日必须经由本模块，禁止在业务代码里直接
 * dayjs(at).format('YYYYMM')。
 *
 * 刻意不做成环境变量：业务月份契约必须全局唯一，不允许按部署环境漂移。
 */
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)

/** 业务时区：全部门店与仓库均在华东。 */
export const BUSINESS_TZ = 'Asia/Shanghai'

/** 单号月份键 YYYYMM（业务时区）。 */
export function businessMonthKey(at: Date | string | number = new Date()): string {
  return dayjs(at).tz(BUSINESS_TZ).format('YYYYMM')
}

/** 业务日期键 YYYY-MM-DD（业务时区），用于导出文件名与归属日展示。 */
export function businessDateKey(at: Date | string | number = new Date()): string {
  return dayjs(at).tz(BUSINESS_TZ).format('YYYY-MM-DD')
}

/** 业务时间戳 YYYYMMDD_HHmmss（业务时区），用于导出文件名。 */
export function businessTimestampKey(at: Date | string | number = new Date()): string {
  return dayjs(at).tz(BUSINESS_TZ).format('YYYYMMDD_HHmmss')
}

/** 紧凑业务时间戳 YYYYMMDDHHmmss（业务时区），用于招行 yurRef 等定长契约。 */
export function businessCompactTimestampKey(at: Date | string | number = new Date()): string {
  return dayjs(at).tz(BUSINESS_TZ).format('YYYYMMDDHHmmss')
}
