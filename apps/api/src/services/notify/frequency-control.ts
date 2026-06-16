/**
 * 静默时段 + 频控辅助
 * 频控本身在 index.ts 里查 NotificationLog 实现, 这里只放工具函数
 */

/**
 * 静默时段开关
 * 业务决策 (2026-06-16, 客户要求): 取消静默时段, 重要通知任何时间都要送达,
 * 不因深夜(原 22:00-07:00)而丢弃。故恒返回 false。
 * 如需恢复时段静默, 用 Asia/Shanghai 时区判断 h>=22||h<7 即可 (见 git history)。
 */
export function isSilentHours(_now: Date = new Date()): boolean {
  return false
}
