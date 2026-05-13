/**
 * v2 团队成员管理 · 仅 BOSS / ADMIN
 * 列表 + 新建 + 重置密码 + 启停
 */
'use client'
import { useEffect, useState } from 'react'
import { getToken, getUser, routeForRole } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

const ROLE_OPTIONS = [
  { value: 'MANAGER',        label: '店长' },
  { value: 'KITCHEN_LEAD',   label: '厨师长' },
  { value: 'CHEF_DIRECTOR',  label: '总厨' },
  { value: 'FINANCE',        label: '财务' },
  { value: 'PURCHASER',      label: '采购' },
  { value: 'ENGINEERING',    label: '工程部' },
]
const ROLE_LABEL: Record<string, string> = Object.fromEntries(ROLE_OPTIONS.map(r => [r.value, r.label]))

type User = {
  id: string; name: string; email: string; phone: string | null
  role: string; status: 'ACTIVE' | 'INACTIVE'
  storeId: string | null
  store?: { name: string } | null
  lastLoginAt?: string | null
}
type Store = { id: string; name: string; no: string }

export default function TeamPage() {
  const [me, setMe] = useState<any>(null)
  const [list, setList] = useState<User[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [resetTarget, setResetTarget] = useState<User | null>(null)
  const [newPwd, setNewPwd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  const [form, setForm] = useState({
    name: '', phone: '', password: '', role: 'MANAGER', storeId: '',
  })
  const [showInvite, setShowInvite] = useState(false)
  const [inviteRole, setInviteRole] = useState<string>('MANAGER')
  const [inviteStoreId, setInviteStoreId] = useState('')
  const [inviteNote, setInviteNote] = useState('')
  const [inviteResult, setInviteResult] = useState<{ token: string; expiresAt: string } | null>(null)

  useEffect(() => {
    setMe(getUser())
    refresh()
  }, [])

  async function refresh() {
    setLoading(true)
    try {
      const t = getToken()
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }
      const [u, s] = await Promise.all([
        fetch('/api/users', { headers }).then(r => r.json()),
        fetch('/api/stores', { headers }).then(r => r.json()),
      ])
      setList(Array.isArray(u) ? u : (u.items || []))
      setStores(Array.isArray(s) ? s : (s.items || []))
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.name || !form.phone || !form.password) {
      setError('姓名、手机号、密码必填')
      return
    }
    if (!/^1[3-9]\d{9}$/.test(form.phone)) {
      setError('手机号格式不对')
      return
    }
    if (form.role === 'MANAGER' && !form.storeId) {
      setError('店长必须绑定门店')
      return
    }
    try {
      const t = getToken()
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone.trim(),
          password: form.password,
          role: form.role,
          storeId: form.storeId || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '创建失败')
      setForm({ name: '', phone: '', password: '', role: 'MANAGER', storeId: '' })
      setShowForm(false)
      refresh()
    } catch (e: any) {
      setError(e.message || '创建失败')
    }
  }

  async function toggleStatus(u: User) {
    openConfirm({
      title: `${u.status === 'ACTIVE' ? '禁用' : '启用'} ${u.name}?`,
      body: u.status === 'ACTIVE' ? '禁用后该账号将无法登录。' : '启用后该账号可以登录。',
      confirmLabel: u.status === 'ACTIVE' ? '禁用' : '启用',
      tone: u.status === 'ACTIVE' ? 'danger' : 'primary',
      onConfirm: async () => {
        const t = getToken()
        await fetch(`/api/users/${u.id}/toggle`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${t}` },
        })
        refresh()
      },
    })
  }

  async function createInvite() {
    setError(null)
    if ((inviteRole === 'MANAGER') && !inviteStoreId) {
      return setError('店长必须选门店')
    }
    try {
      const t = getToken()
      const res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          role: inviteRole,
          storeId: inviteStoreId || undefined,
          note: inviteNote.trim() || undefined,
          expiresHours: 24,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '生成失败')
      setInviteResult({ token: data.token, expiresAt: data.expiresAt })
    } catch (e: any) {
      setError(e.message || '生成失败')
    }
  }

  async function resetPassword() {
    if (!resetTarget || newPwd.length < 6) return
    try {
      const t = getToken()
      const res = await fetch(`/api/users/${resetTarget.id}/reset-password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ password: newPwd }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '重置失败')
      setResetTarget(null)
      setNewPwd('')
    } catch (e: any) {
      setError(e.message || '重置失败')
    }
  }

  if (!me) return null

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/me" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1">团队成员</h1>
        <button
          onClick={() => { setShowInvite(true); setInviteRole('MANAGER'); setInviteStoreId(''); setInviteNote(''); setInviteResult(null); setError(null) }}
          className="px-3 py-2 bg-white border border-border text-button rounded-cta"
        >
          邀请链接
        </button>
        <button
          onClick={() => { setShowForm(true); setError(null) }}
          className="px-3 py-2 bg-amber text-white rounded-cta text-button"
        >
          + 直接建
        </button>
      </header>

      <div className="px-4 mt-2">
        {error && !showForm && !resetTarget && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-3">{error}</div>
        )}

        {loading ? (
          <div className="text-caption text-gray3 py-8 text-center">加载中…</div>
        ) : list.length === 0 ? (
          <div className="bg-white rounded-card border border-border p-8 text-center text-caption text-gray3">
            还没有团队成员。点右上角「+ 新增」添加店长/财务/厨师长。
          </div>
        ) : (
          <ul className="space-y-2">
            {list.map(u => (
              <li key={u.id} className="bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber/10 text-amber-fg flex items-center justify-center text-h2">
                    {u.name?.[0] || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium">{u.name}</span>
                      <span className="text-micro px-1.5 py-0.5 rounded bg-bg text-gray2">
                        {ROLE_LABEL[u.role] || u.role}
                      </span>
                      {u.status === 'INACTIVE' && (
                        <span className="text-micro px-1.5 py-0.5 rounded bg-red-bg text-red-fg">已停用</span>
                      )}
                    </div>
                    <div className="text-micro text-gray3 font-num truncate mt-0.5">
                      {u.phone || u.email}
                      {u.store?.name && ` · ${u.store.name}`}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 mt-3 pt-3 border-t border-border">
                  <button
                    onClick={() => { setResetTarget(u); setNewPwd(''); setError(null) }}
                    className="flex-1 py-1.5 bg-bg border border-border rounded text-caption"
                  >
                    重置密码
                  </button>
                  <button
                    onClick={() => toggleStatus(u)}
                    disabled={u.id === me.id || u.role === 'SUPER_ADMIN'}
                    className="flex-1 py-1.5 bg-bg border border-border rounded text-caption disabled:opacity-40"
                  >
                    {u.status === 'ACTIVE' ? '禁用' : '启用'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 新增表单 (sheet) */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setShowForm(false)}>
          <div className="w-full bg-white rounded-t-2xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">新增成员</h2>
              <button onClick={() => setShowForm(false)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="text-micro text-gray3 block mb-1">姓名</label>
                <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                  className="w-full bg-bg rounded p-2 outline-none text-body" placeholder="张三" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">手机号 (登录账号)</label>
                <input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})}
                  inputMode="numeric" maxLength={11}
                  className="w-full bg-bg rounded p-2 outline-none text-body font-num" placeholder="13800138000" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">初始密码 (≥6 位)</label>
                <input type="text" value={form.password} onChange={e => setForm({...form, password: e.target.value})}
                  className="w-full bg-bg rounded p-2 outline-none text-body font-num" placeholder="dj123456" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">角色</label>
                <select value={form.role} onChange={e => setForm({...form, role: e.target.value, storeId: ''})}
                  className="w-full bg-bg rounded p-2 outline-none text-body">
                  {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              {(form.role === 'MANAGER' || form.role === 'KITCHEN_LEAD') && (
                <div>
                  <label className="text-micro text-gray3 block mb-1">绑定门店 {form.role === 'MANAGER' && '(必填)'}</label>
                  <select value={form.storeId} onChange={e => setForm({...form, storeId: e.target.value})}
                    className="w-full bg-bg rounded p-2 outline-none text-body">
                    <option value="">{stores.length === 0 ? '请先去创建门店' : '请选择门店'}</option>
                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}
              {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption">{error}</div>}
              <button type="submit" className="w-full py-3 bg-amber text-white rounded-cta text-button">
                创建账号
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 邀请链接 sheet */}
      {showInvite && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setShowInvite(false)}>
          <div className="w-full bg-white rounded-t-2xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">{inviteResult ? '邀请链接已生成' : '生成邀请链接'}</h2>
              <button onClick={() => setShowInvite(false)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            {!inviteResult ? (
              <div className="space-y-3">
                <div>
                  <label className="text-micro text-gray3 block mb-1">角色</label>
                  <select value={inviteRole} onChange={e => { setInviteRole(e.target.value); setInviteStoreId('') }}
                    className="w-full bg-bg rounded p-2 outline-none text-body">
                    {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                {(inviteRole === 'MANAGER' || inviteRole === 'KITCHEN_LEAD') && (
                  <div>
                    <label className="text-micro text-gray3 block mb-1">绑定门店 (店长必填)</label>
                    <select value={inviteStoreId} onChange={e => setInviteStoreId(e.target.value)}
                      className="w-full bg-bg rounded p-2 outline-none text-body">
                      <option value="">{stores.length === 0 ? '请先创建门店' : '请选择门店'}</option>
                      {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="text-micro text-gray3 block mb-1">备注 (选填, 自己看)</label>
                  <input value={inviteNote} onChange={e => setInviteNote(e.target.value)}
                    maxLength={60}
                    className="w-full bg-bg rounded p-2 outline-none text-body"
                    placeholder="例如: 翠湖店店长 张三" />
                </div>
                <div className="text-caption text-gray3">链接 24 小时内有效, 一次性使用</div>
                {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption">{error}</div>}
                <button onClick={createInvite} className="w-full py-3 bg-amber text-white rounded-cta text-button">
                  生成链接
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-bg rounded p-3 break-all text-caption font-num">
                  {`${typeof window !== 'undefined' ? window.location.origin : ''}/v2/invite/${inviteResult.token}`}
                </div>
                <div className="text-caption text-gray3">
                  把链接发给员工 (微信 / 短信)。员工打开 → 输手机号 + 设密码 → 自动激活, 24 小时后失效。
                </div>
                <button
                  onClick={() => {
                    const url = `${window.location.origin}/v2/invite/${inviteResult.token}`
                    if (navigator.clipboard?.writeText) {
                      navigator.clipboard.writeText(url).then(() => alert('已复制'))
                    } else {
                      const el = document.createElement('textarea')
                      el.value = url; document.body.appendChild(el); el.select()
                      document.execCommand('copy'); document.body.removeChild(el)
                      alert('已复制')
                    }
                  }}
                  className="w-full py-3 bg-amber text-white rounded-cta text-button">
                  复制链接
                </button>
                <button onClick={() => setShowInvite(false)}
                  className="w-full py-2 text-button text-gray2">
                  关闭
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 重置密码 sheet */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setResetTarget(null)}>
          <div className="w-full bg-white rounded-t-2xl p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">重置密码 · {resetTarget.name}</h2>
              <button onClick={() => setResetTarget(null)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <input type="text" value={newPwd} onChange={e => setNewPwd(e.target.value)}
              className="w-full bg-bg rounded p-2 outline-none text-body font-num mb-3"
              placeholder="新密码 (≥6 位)" />
            {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption mb-3">{error}</div>}
            <button onClick={resetPassword} disabled={newPwd.length < 6}
              className="w-full py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
              确认重置
            </button>
          </div>
        </div>
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
