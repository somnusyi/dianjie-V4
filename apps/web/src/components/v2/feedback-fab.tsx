/**
 * 全局悬浮反馈按钮 (右下角)
 * 登录 / 申请 / 邀请 / 企微中转 / 反馈提交页 不显示
 * 点击跳 /v2/feedback/new, 并把来源页面带过去做上下文快照
 */
'use client'
import { usePathname } from 'next/navigation'

const HIDE_PREFIXES = ['/v2/login', '/v2/apply', '/v2/invite/', '/v2/wecom-bridge', '/v2/feedback/new']

export function FeedbackFab() {
  const pathname = usePathname() || ''
  if (HIDE_PREFIXES.some((p) => pathname.startsWith(p))) return null
  return (
    <a
      href={`/v2/feedback/new?from=${encodeURIComponent(pathname)}`}
      aria-label="提交反馈"
      className="fixed right-4 bottom-24 z-50 flex items-center gap-1.5 pl-3 pr-3.5 py-2.5 rounded-full bg-ink text-white shadow-lg text-button"
    >
      <span aria-hidden>✉</span>
      反馈
    </a>
  )
}
