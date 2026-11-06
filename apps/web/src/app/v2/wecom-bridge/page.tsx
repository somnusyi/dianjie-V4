/**
 * 企微 OAuth bridge: 后端 redirect 到这里, hash 里带 token + user, 客户端落地后跳目标页
 * URL 形如: /v2/wecom-bridge#token=xxx&refreshToken=xxx&user={...}&tenant=dianjie&redirect=/v2/chef/home
 */
'use client'
import { useEffect, useState } from 'react'
import { refreshAccessOnce, getUser, routeForRole } from '@/lib/v2-auth'

export default function WeComBridgePage() {
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    void (async()=>{
      // Discard obsolete credential-bearing fragments without reading or persisting them.
      if(location.hash) history.replaceState(null,'',location.pathname+location.search)
      const token=await refreshAccessOnce()
      const user=getUser()
      if(!token||!user){setErr('企微登录校验失败，请重新登录');return}
      const value=new URLSearchParams(location.search).get('redirect')||''
      const safe=value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\')&&new URL(value,location.origin).origin===location.origin
      location.replace(safe&&value!=='/'?value:routeForRole(user.role))
    })().catch(()=>setErr('企微登录失败，请重新登录'))
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
