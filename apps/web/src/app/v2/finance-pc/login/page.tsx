/**
 * 财务 PC 工作台 · 独立登录页
 *
 * 为什么要独立:
 *   - PWA manifest scope = /v2/finance-pc/, 退出后必须留在 scope 内, 否则桌面 PWA 窗口跳出浏览器
 *   - 财务多账号场景: 桌面 PWA 共享, 任何人到工位前用自己账号登
 *   - 角色限定: 只允许 FINANCE/BOSS/ADMIN/SUPER_ADMIN, 其他角色拒绝并提示去主登录
 *
 * UX:
 *   - PC 横版 split-screen: 左品牌+说明, 右表单
 *   - 已登录态展示 "继续 / 切换" 双按钮 (多账号常用)
 *   - 角色不匹配 显式红色错误条
 */
'use client'
import { useEffect, useState } from 'react'
import { setSession, getToken, getUser, clearSession } from '@/lib/v2-auth'

const ALLOWED_ROLES = ['FINANCE', 'BOSS', 'ADMIN', 'SUPER_ADMIN']

export default function FinancePCLoginPage() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tenantSlug, setTenantSlug] = useState('dianjie')
  const [existingUser, setExistingUser] = useState<{ name?: string; role: string; email?: string } | null>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    const t = (url.searchParams.get('tenant') || '').trim()
    if (t === 'test') setTenantSlug('test')
    // 跳进来时带的 error 参数 (AuthGate 角色拒绝时会带 ?error=role)
    if (url.searchParams.get('error') === 'role') {
      setError('您的角色无权使用财务工作台 (仅 财务 / 老板 可登录)')
    }
    const token = getToken()
    const u = getUser()
    if (token && u) setExistingUser(u as any)
  }, [])

  function continueAsExisting() {
    if (!existingUser) return
    if (!ALLOWED_ROLES.includes(existingUser.role)) {
      setError('当前账号角色无权使用财务工作台')
      return
    }
    location.replace('/v2/finance-pc/home')
  }
  function switchAccount() {
    clearSession()
    setExistingUser(null)
    setIdentifier(''); setPassword(''); setError(null)
  }

  const TEST_SHORTNAMES = new Set(['boss', 'fin', 'mgr', 'cd', 'chef', 'eng', 'sup1', 'sup2'])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null); setSubmitting(true)
    const idTrim = identifier.trim()
    const effectiveTenant = TEST_SHORTNAMES.has(idTrim.toLowerCase()) ? 'test' : tenantSlug
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: idTrim, password, tenantSlug: effectiveTenant }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || data.message || '登录失败')
      // 角色检查
      if (!ALLOWED_ROLES.includes(data.user.role)) {
        throw new Error(`您的角色 (${data.user.role}) 无权使用财务工作台. 请用 财务 / 老板 账号登录, 或访问主登录页 /v2/login`)
      }
      setSession(data.token, data.user, data.tenant, data.refreshToken)
      location.replace('/v2/finance-pc/home')
    } catch (e: any) {
      setError(e.message || '登录失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex">
      {/* 左侧 品牌 + 说明 (lg 才显示) */}
      <aside className="hidden lg:flex flex-col justify-between w-[420px] bg-ink text-white p-10">
        <div>
          <div className="flex items-center gap-3 mb-12">
            <span className="bg-red text-white text-button px-3 py-1.5 rounded-chip font-num">FIN</span>
            <span className="text-h1">滇界 · 财务系统</span>
          </div>
          <div className="space-y-4 text-caption opacity-80 leading-relaxed">
            <p>专为财务设计的 PC 工作台 — 凭证 / 月结 / 报税 / 应付 全流程在一个窗口里完成.</p>
            <p>多账号支持: 几位财务可以共用同一台电脑, 各自账号独立, 不互相干扰.</p>
          </div>
        </div>
        <div className="space-y-3 text-micro opacity-50 font-num">
          <div>合肥瑶海店 · dianjie tenant</div>
          <div>© 滇界云管 v4 · {new Date().getFullYear()}</div>
        </div>
      </aside>

      {/* 右侧 登录 */}
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* 移动端 brand fallback (lg 以下) */}
          <div className="lg:hidden mb-8 flex items-center gap-2">
            <span className="bg-red text-white text-micro px-2 py-1 rounded-chip font-num">FIN</span>
            <span className="text-h2">滇界 · 财务系统</span>
          </div>

          {existingUser && (
            <section className="bg-amber/10 border border-amber/40 rounded-card p-4 mb-4">
              <p className="text-caption text-amber-fg">
                检测到已登录: <b>{existingUser.name}</b>
                <span className="text-gray3 ml-1">({existingUser.role}{existingUser.email ? ` · ${existingUser.email}` : ''})</span>
              </p>
              <div className="flex gap-2 mt-3">
                <button onClick={continueAsExisting} type="button"
                        className="flex-1 py-2.5 bg-ink text-white rounded-cta text-button">继续使用 →</button>
                <button onClick={switchAccount} type="button"
                        className="flex-1 py-2.5 border border-border bg-white rounded-cta text-button text-gray2">换个账号</button>
              </div>
            </section>
          )}

          <section className="bg-bg-warm rounded-card border border-border p-5 mb-6">
            <p className="text-micro text-amber-fg uppercase tracking-wider">finance workstation</p>
            <div className="text-h1 mt-1">{existingUser ? '换号登录' : '登录财务工作台'}</div>
            <p className="text-caption text-gray2 mt-1">仅财务 / 老板可访问</p>
          </section>

          <form onSubmit={submit} className="space-y-3">
            <div className="bg-white rounded-card border border-border p-3">
              <label className="text-micro text-gray3 block mb-1">手机号 / 邮箱</label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoFocus
                required
                className="w-full text-body bg-transparent outline-none font-num"
                placeholder="13800138000 或 fin@dianjie.com"
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
              {submitting ? '登录中…' : '登录财务工作台'}
            </button>
          </form>

          <div className="mt-6 flex items-center justify-center gap-3 text-caption">
            <a href="/v2/login" className="text-gray3">其他角色登录 →</a>
            <span className="text-gray4">·</span>
            <span className="text-gray3">忘记密码请联系老板</span>
          </div>

          <div className="mt-3 text-center text-micro">
            {tenantSlug === 'test' ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-bg text-amber-fg">
                测试环境 · <a href="/v2/finance-pc/login" className="underline">切回真实</a>
              </span>
            ) : (
              <span className="text-gray4">
                正式环境 · <a href="/v2/finance-pc/login?tenant=test" className="underline text-gray3">用测试账号</a>
              </span>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
