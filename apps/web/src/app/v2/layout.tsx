/**
 * /v2/* 全局守卫
 * - 登录页例外（pathname === '/v2/login'）
 * - 其余页面未登录跳 login
 */
'use client'
import { usePathname } from 'next/navigation'
import { AuthGate } from '@/components/v2/auth-gate'
import { Onboarding } from '@/components/v2/onboarding'
import { InstallHint } from '@/components/v2/install-hint'

export default function V2Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || ''
  // 登录页 / 申请账号页 / 邀请激活页 不守卫
  if (pathname.startsWith('/v2/login') || pathname.startsWith('/v2/apply') || pathname.startsWith('/v2/invite/')) {
    return <>{children}<InstallHint /></>
  }
  // home 页才弹 onboarding (不打扰二级页)
  const isHome = /^\/v2\/[^/]+\/home\/?$/.test(pathname)
  return <AuthGate>{children}{isHome && <Onboarding />}<InstallHint /></AuthGate>
}
