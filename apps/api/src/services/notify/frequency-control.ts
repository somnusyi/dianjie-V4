/**
 * 静默时段 + 频控辅助
 * 频控本身在 index.ts 里查 NotificationLog 实现, 这里只放工具函数
 */

/** 静默时段: 22:00 - 07:00 (亚洲/上海) */
export function isSilentHours(now: Date = new Date()): boolean {
  // 用上海时区 (生产 ECS 默认 +08, 直接 getHours 即可)
  const h = now.getHours()
  return h >= 22 || h < 7
}
