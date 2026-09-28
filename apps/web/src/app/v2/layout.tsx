/**
 * /v2/* 全局守卫
 * - 登录页例外（pathname === '/v2/login'）
 * - 其余页面未登录跳 login
 */
'use client'
import { usePathname } from 'next/navigation'
import { AuthGate } from '@/components/v2/auth-gate'
import { Onboarding } from '@/components/v2/onboarding'
import { rolesForV2Path } from '@/lib/v2-route-access'

export default function V2Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || ''
  // 登录页 / 申请账号页 / 邀请激活页 不守卫
  // 还要例外 sub-login (/v2/finance-pc/login), 不然 PWA 桌面图标双击 → 跳出 scope
  // 企微 OAuth 中转页 (/v2/wecom-bridge) 也必须例外: 它的职责就是从 URL hash 里
  // setSession 建立登录态, 若被守卫拦 → 还没存 token 就被踢回 login, 企微登录永远进不去
  if (
    pathname.startsWith('/v2/login') ||
    pathname.startsWith('/v2/wecom-bridge') ||
    pathname.startsWith('/v2/apply') ||
    pathname.startsWith('/v2/invite/') ||
    pathname === '/v2/finance-pc/login'
  ) {
    return <>{children}</>
  }
  // home 页才弹 onboarding (不打扰二级页)
  const isHome = /^\/v2\/[^/]+\/home\/?$/.test(pathname)
  const requireRole = rolesForV2Path(pathname)
  return <AuthGate requireRole={requireRole ? [...requireRole] : undefined}>{children}{isHome && <Onboarding />}</AuthGate>
}
