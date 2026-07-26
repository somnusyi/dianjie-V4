/**
 * 反馈系统共享 UI 常量: 状态 badge / 分类标签 (非页面文件, 仅供 v2/feedback 与 v2/boss/feedback 引用)
 * 颜色一律用 tailwind.config 已有 token (参考 Chip 组件口径)
 */

export const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  CLARIFYING: { label: '沟通中', cls: 'bg-bg text-blue' },
  AWAITING_APPROVAL: { label: '待管理员审批', cls: 'bg-amber/15 text-amber-fg' },
  APPROVED: { label: '已批准', cls: 'bg-green-bg text-green-fg' },
  IN_DEV: { label: '已立项开发', cls: 'bg-green-bg text-green-fg' },
  REJECTED: { label: '已驳回', cls: 'bg-red-bg text-red-fg' },
  RESOLVED: { label: '已解决', cls: 'bg-green-bg text-green-fg' },
  CLOSED: { label: '已闭环', cls: 'bg-bg text-gray3' },
}

export function statusBadge(status: string) {
  return STATUS_LABEL[status] || { label: status, cls: 'bg-bg text-gray3' }
}

export const CATEGORY_LABEL: Record<string, { label: string; icon: string }> = {
  BUG_BLOCKING: { label: '紧急故障', icon: '🚨' },
  IMPROVEMENT: { label: '体验改进', icon: '💡' },
  NEW_FEATURE: { label: '新需求', icon: '✨' },
  QUESTION: { label: '操作咨询', icon: '❓' },
}

export function categoryBadge(category: string | null | undefined) {
  if (!category) return { label: '待分诊', icon: '💬' }
  return CATEGORY_LABEL[category] || { label: category, icon: '💬' }
}
