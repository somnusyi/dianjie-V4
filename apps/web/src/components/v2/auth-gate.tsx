/**
 * v2 路由守卫：未登录 → /v2/login
 * 用法：在每个 v2 page (除 login) 顶层包一层 <AuthGate role={...}> 也可
 * 实际我们用 layout 自动包，不需要每页手写
 */
'use client'
import { useEffect, useState } from 'react'
import { getToken, getUser, routeForRole } from '@/lib/v2-auth'
import { FeedbackFab } from '@/components/v2/feedback-fab'

// 有独立 sub-login 页的路径前缀 (PWA scope 内, 防止桌面 PWA 跳出 scope)
// 访问 /v2/finance-pc/* 未登录 → 跳 /v2/finance-pc/login (留在 PWA 窗口里)
const SUB_LOGIN_FOR: Array<{ prefix: string; login: string; allowedRoles: string[] }> = [
  {
    prefix: '/v2/finance-pc/',
    login: '/v2/finance-pc/login',
    allowedRoles: ['FINANCE', 'BOSS', 'ADMIN', 'SUPER_ADMIN'],
  },
]

export function AuthGate({ children, requireRole }: { children: React.ReactNode; requireRole?: string[] }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const pathname = typeof window !== 'undefined' ? location.pathname : ''
    const subLogin = SUB_LOGIN_FOR.find(s => pathname.startsWith(s.prefix))
    const loginUrl = subLogin ? subLogin.login : '/v2/login'

    const token = getToken()
    if (!token) {
      location.href = loginUrl
      return
    }
    // sub-scope (例如 finance-pc) 自带角色检查
    if (subLogin) {
      const u = getUser()
      if (!u || !subLogin.allowedRoles.includes(u.role)) {
        location.href = `${loginUrl}?error=role`
        return
      }
    }
    if (requireRole && requireRole.length) {
      const u = getUser()
      if (!u || !requireRole.includes(u.role)) {
        // 不匹配角色 → 跳到该用户自己的 home (或 sub-login)
        location.href = u ? routeForRole(u.role) : loginUrl
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
  return <>{children}<FeedbackFab /></>
}
