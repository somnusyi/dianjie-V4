/**
 * v2 登录页 · 暖色风
 * - 手机号 / 邮箱 + 密码 (后端按格式自动判别)
 * - 登录成功按 role 跳到对应 home
 */
'use client'
import { useState, useEffect } from 'react'
import { setSession, routeForRole, pcRouteForRole, getToken, getUser, clearSession } from '@/lib/v2-auth'

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // tenant 隔离: 默认 dianjie (真实公司), URL ?tenant=test 进 test tenant (8 个演示账号)
  const [tenantSlug, setTenantSlug] = useState('dianjie')
  // 已登录用户信息: 给"继续 / 换号"选择, 不再自动跳走 (同事的 UX 升级)
  const [existingUser, setExistingUser] = useState<{ name?: string; role: string } | null>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    const t = (url.searchParams.get('tenant') || '').trim()
    if (t === 'test') setTenantSlug('test')

    const token = getToken()
    const u = getUser()
    if (token && u) setExistingUser(u as any)
  }, [])

  function continueAsExisting() {
    if (!existingUser) return
    const isWide = window.innerWidth >= 1024
    const pc = isWide ? pcRouteForRole(existingUser.role) : null
    location.replace(pc || routeForRole(existingUser.role))
  }
  function switchAccount() {
    clearSession()
    setExistingUser(null)
  }

  // 8 个测试账号短名 — 输到这些 auto 切到 test tenant, 免去手动加 ?tenant=test
  const TEST_SHORTNAMES = new Set(['boss', 'fin', 'mgr', 'cd', 'chef', 'eng', 'sup1', 'sup2'])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null); setSubmitting(true)
    const idTrim = identifier.trim()
    // 短账号自动落 test tenant, 不依赖 URL 参数 (手机 app webview 加载远程 URL 没 query)
    const effectiveTenant = TEST_SHORTNAMES.has(idTrim.toLowerCase()) ? 'test' : tenantSlug
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: idTrim, password, tenantSlug: effectiveTenant }),
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
        {/* 已登录提示 — 给"继续 / 换号"选项 */}
        {existingUser && (
          <section className="bg-amber/10 border border-amber/40 rounded-card p-4 mb-4">
            <p className="text-caption text-amber-fg">检测到已有登录: <b>{existingUser.name}</b> ({existingUser.role})</p>
            <div className="flex gap-2 mt-3">
              <button onClick={continueAsExisting}
                      className="flex-1 py-2 bg-ink text-white rounded-cta text-button">继续使用 →</button>
              <button onClick={switchAccount}
                      className="flex-1 py-2 border border-border bg-white rounded-cta text-button text-gray2">换个账号</button>
            </div>
          </section>
        )}

        {/* 暖色欢迎卡（替代黑卡，暖白底+琥珀金标） */}
        <section className="bg-bg-warm rounded-card border border-border p-5 mb-6">
          <p className="text-micro text-amber-fg uppercase tracking-wider">welcome back</p>
          <div className="text-h1 mt-1">{existingUser ? '换号登录' : '登录账号'}</div>
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

        {/* tenant 当前状态指示 — 让你一眼看到登的是真实公司还是测试环境 */}
        <div className="mt-3 text-center text-micro">
          {tenantSlug === 'test' ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-bg text-amber-fg">
              测试环境 (滇界测试 · 演示账号专用) · <a href="/v2/login" className="underline">切回真实</a>
            </span>
          ) : (
            <span className="text-gray4">
              正式环境 · <a href="/v2/login?tenant=test" className="underline text-gray3">用测试账号</a>
            </span>
          )}
        </div>
      </main>
    </div>
  )
}
