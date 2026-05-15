/**
 * 企微 OAuth bridge: 后端 redirect 到这里, hash 里带 token + user, 客户端落地后跳目标页
 * URL 形如: /v2/wecom-bridge#token=xxx&user={...}&tenant=dianjie&redirect=/v2/chef/home
 */
'use client'
import { useEffect, useState } from 'react'
import { setSession, routeForRole } from '@/lib/v2-auth'

export default function WeComBridgePage() {
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    try {
      const hash = window.location.hash.replace(/^#/, '')
      const params = new URLSearchParams(hash)
      const token = params.get('token')
      const userRaw = params.get('user')
      const tenant = params.get('tenant')
      const redirect = params.get('redirect') || ''
      if (!token || !userRaw) {
        setErr('企微登录回调缺少 token/user 信息')
        return
      }
      const user = JSON.parse(decodeURIComponent(userRaw))
      setSession(token, user, tenant ? { slug: tenant } : undefined)
      // 跳转到目标页 或 角色 home
      const target = redirect && redirect !== '/' ? decodeURIComponent(redirect) : routeForRole(user.role)
      window.location.replace(target)
    } catch (e: any) {
      setErr(e.message || '处理企微登录失败')
    }
  }, [])

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      {err ? (
        <div className="bg-red-bg border border-red/30 rounded-card p-6 text-center max-w-sm">
          <div className="text-[40px] mb-2 opacity-50">⚠</div>
          <p className="text-body text-red-fg">{err}</p>
          <a href="/v2/login" className="inline-block mt-4 px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">返回登录页</a>
        </div>
      ) : (
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-amber/10 flex items-center justify-center text-h2">企</div>
          <p className="text-body text-gray2">企微登录中…</p>
        </div>
      )}
    </div>
  )
}
