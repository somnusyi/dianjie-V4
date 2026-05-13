/**
 * v2 顶角消息铃铛 · 显示未读 badge, 点击跳 /v2/notifications
 * 30s 轮询一次未读数 (低频, 避免压数据库)
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch, getToken } from '@/lib/v2-auth'

export function NotificationBell() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!getToken()) return
    let alive = true
    const tick = () => {
      apiFetch<{ count: number }>('/api/notifications/unread-count')
        .then(d => { if (alive) setCount(d.count || 0) })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  return (
    <a href="/v2/notifications"
       className="relative w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center"
       aria-label="消息">
      <span className="text-h2">⌬</span>
      {count > 0 && (
        <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-red text-white text-[10px] font-num flex items-center justify-center">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </a>
  )
}
