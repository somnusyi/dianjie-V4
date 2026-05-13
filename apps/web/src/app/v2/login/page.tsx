/**
 * v2 登录页 · 暖色风
 * - 手机号 / 邮箱 + 密码 (后端按格式自动判别)
 * - 登录成功按 role 跳到对应 home
 */
'use client'
import { useState, useEffect } from 'react'
import { setSession, routeForRole, pcRouteForRole, getToken, getUser } from '@/lib/v2-auth'

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 已登录直接跳 home
  useEffect(() => {
    const t = getToken()
    const u = getUser()
    if (t && u) {
      // PC 形态优先（老板/财务且屏幕宽）
      const isWide = window.innerWidth >= 1024
      const pc = isWide ? pcRouteForRole(u.role) : null
      location.replace(pc || routeForRole(u.role))
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null); setSubmitting(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || data.message || '登录失败')
      setSession(data.token, data.user, data.tenant)
      const isWide = window.innerWidth >= 1024
      const pc = isWide ? pcRouteForRole(data.user.role) : null
      location.replace(pc || routeForRole(data.user.role))
    } catch (e: any) {
      setError(e.message || '登录失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* 顶部品牌 · 琥珀金徽章 */}
      <header className="px-6 pt-14 pb-6 flex items-center gap-3">
        <span className="w-12 h-12 rounded-2xl bg-amber text-white flex items-center justify-center text-h1 font-medium shadow-sm">滇</span>
        <div>
          <div className="text-h1">滇界</div>
          <p className="text-caption text-gray3 mt-0.5">连锁餐饮管理系统 · v1.1</p>
        </div>
      </header>

      <main className="flex-1 px-6 max-w-md w-full mx-auto">
        {/* 暖色欢迎卡（替代黑卡，暖白底+琥珀金标） */}
        <section className="bg-bg-warm rounded-card border border-border p-5 mb-6">
          <p className="text-micro text-amber-fg uppercase tracking-wider">welcome back</p>
          <div className="text-h1 mt-1">登录账号</div>
          <p className="text-caption text-gray2 mt-1">老板 / 店长 / 厨师长 / 总厨 / 财务 / 供应商</p>
        </section>

        <form onSubmit={submit} className="space-y-3">
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">手机号 / 邮箱</label>
            <input
              type="text"
              inputMode="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoFocus
              required
              className="w-full text-body bg-transparent outline-none font-num"
              placeholder="13800138000 或 user@dianjie.com"
            />
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full text-body bg-transparent outline-none font-num"
              placeholder="••••••••"
            />
          </div>
          {error && (
            <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>
          )}
          <button
            type="submit"
            disabled={submitting || !identifier || !password}
            className="w-full py-3 bg-ink text-white rounded-cta text-button transition disabled:opacity-40"
          >
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>

        <div className="mt-6 flex items-center justify-center gap-3 text-caption">
          <a href="/v2/apply" className="text-amber-fg">申请账号 ›</a>
          <span className="text-gray4">·</span>
          <span className="text-gray3">忘记密码请联系老板</span>
        </div>
      </main>
    </div>
  )
}
