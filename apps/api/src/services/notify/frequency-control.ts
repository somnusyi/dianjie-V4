/**
 * 静默时段 + 频控辅助
 * 频控本身在 index.ts 里查 NotificationLog 实现, 这里只放工具函数
 */

/** 静默时段: 22:00 - 07:00 (上海时区, 不依赖宿主时区) */
export function isSilentHours(now: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric', hour12: false,
  })
  const h = parseInt(fmt.format(now))
  return h >= 22 || h < 7
}
