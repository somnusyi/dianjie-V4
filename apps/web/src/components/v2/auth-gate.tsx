/**
 * v2 路由守卫：未登录 → /v2/login
 * 用法：在每个 v2 page (除 login) 顶层包一层 <AuthGate role={...}> 也可
 * 实际我们用 layout 自动包，不需要每页手写
 */
'use client'
import { useEffect, useState } from 'react'
import { getToken, getUser, routeForRole } from '@/lib/v2-auth'

export function AuthGate({ children, requireRole }: { children: React.ReactNode; requireRole?: string[] }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const token = getToken()
    if (!token) {
      location.href = '/v2/login'
      return
    }
    if (requireRole && requireRole.length) {
      const u = getUser()
      if (!u || !requireRole.includes(u.role)) {
        // 不匹配角色 → 跳到该用户自己的 home
        location.href = u ? routeForRole(u.role) : '/v2/login'
        return
      }
    }
    setReady(true)
  }, [requireRole])

  if (!ready) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <span className="text-caption text-gray3">加载中…</span>
      </div>
    )
  }
  return <>{children}</>
}
