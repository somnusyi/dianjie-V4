/**
 * v2 供应商管理 · 老板/管理员
 * 列表 + 新建 + 给负责人发邀请链接
 */
'use client'
import { useEffect, useState } from 'react'
import { getToken } from '@/lib/v2-auth'

type Supplier = {
  id: string; no: string; name: string
  contactName?: string | null; contactPhone?: string | null
  category?: string | null
  status: 'ENABLED' | 'DISABLED'
  creditDays?: number
}

export default function SuppliersPage() {
  const [list, setList] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    no: '', name: '', contactName: '', contactPhone: '',
    category: '', creditDays: 30,
  })
  const [inviteFor, setInviteFor] = useState<Supplier | null>(null)
  const [inviteResult, setInviteResult] = useState<{ token: string; expiresAt: string } | null>(null)

  useEffect(() => { refresh() }, [])

  async function refresh() {
    setLoading(true); setError(null)
    try {
      const t = getToken()
      const res = await fetch('/api/suppliers', { headers: { Authorization: `Bearer ${t}` } })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '加载失败')
      setList(Array.isArray(data) ? data : (data.items || []))
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.no.trim() || !form.name.trim()) return setError('编号和名称必填')
    try {
      const t = getToken()
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          no: form.no.trim(),
          name: form.name.trim(),
          contactName: form.contactName.trim() || undefined,
          contactPhone: form.contactPhone.trim() || undefined,
          category: form.category.trim() || undefined,
          creditDays: form.creditDays || 30,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '创建失败')
      setForm({ no: '', name: '', contactName: '', contactPhone: '', category: '', creditDays: 30 })
      setShowForm(false)
      refresh()
    } catch (e: any) {
      setError(e.message || '创建失败')
    }
  }

  async function generateInvite(s: Supplier) {
    setError(null); setInviteFor(s); setInviteResult(null)
    try {
      const t = getToken()
      const res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          role: 'SUPPLIER_OWNER',
          supplierId: s.id,
          note: `${s.name} 负责人`,
          expiresHours: 72,  // 供应商通道给宽一点
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '生成失败')
      setInviteResult({ token: data.token, expiresAt: data.expiresAt })
    } catch (e: any) {
      setError(e.message || '生成失败')
    }
  }

  const next = (() => {
    const nums = list
      .map(s => /^SUP(\d+)$/.exec(s.no || ''))
      .filter(Boolean)
      .map((m: any) => parseInt(m[1], 10))
    return (nums.length ? Math.max(...nums) : 0) + 1
  })()

  function startCreate() {
    setForm(f => ({ ...f, no: `SUP${String(next).padStart(3, '0')}` }))
    setShowForm(true); setError(null)
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/me" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1">供应商</h1>
        <button onClick={startCreate}
          className="px-3 py-2 bg-amber text-white rounded-cta text-button">
          + 新增
        </button>
      </header>

      <div className="px-4 mt-2">
        {error && !showForm && !inviteFor && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-3">{error}</div>
        )}
        {loading ? (
          <div className="text-caption text-gray3 py-8 text-center">加载中…</div>
        ) : list.length === 0 ? (
          <div className="bg-white rounded-card border border-border p-8 text-center text-caption text-gray3">
            还没有供应商。点右上角「+ 新增」加第一家。
          </div>
        ) : (
          <ul className="space-y-2">
            {list.map(s => (
              <li key={s.id} className="bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-body font-medium flex-1">{s.name}</span>
                  <span className="text-micro text-gray3 font-num">{s.no}</span>
                  {s.status === 'DISABLED' && <span className="text-micro px-1.5 py-0.5 rounded bg-red-bg text-red-fg">已停用</span>}
                </div>
                <div className="text-micro text-gray3 mt-1">
                  {s.category && <span>{s.category} · </span>}
                  {s.contactName && <span>{s.contactName}</span>}
                  {s.contactPhone && <span className="font-num"> {s.contactPhone}</span>}
                  {s.creditDays != null && <span> · 账期 {s.creditDays} 天</span>}
                </div>
                <div className="flex gap-2 mt-3 pt-3 border-t border-border">
                  <button onClick={() => generateInvite(s)}
                    className="flex-1 py-1.5 bg-amber text-white rounded text-caption">
                    生成邀请链接
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 新增表单 */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setShowForm(false)}>
          <div className="w-full bg-white rounded-t-2xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">新增供应商</h2>
              <button onClick={() => setShowForm(false)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="text-micro text-gray3 block mb-1">编号</label>
                <input value={form.no} onChange={e => setForm({...form, no: e.target.value.toUpperCase()})}
                  className="w-full bg-bg rounded p-2 outline-none text-body font-num" placeholder="SUP001" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">供应商名称</label>
                <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                  className="w-full bg-bg rounded p-2 outline-none text-body" placeholder="例如: ××蔬菜批发" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">类目 (选填)</label>
                <input value={form.category} onChange={e => setForm({...form, category: e.target.value})}
                  className="w-full bg-bg rounded p-2 outline-none text-body" placeholder="蔬菜 / 菌类 / 水产" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">负责人姓名 (选填)</label>
                <input value={form.contactName} onChange={e => setForm({...form, contactName: e.target.value})}
                  className="w-full bg-bg rounded p-2 outline-none text-body" placeholder="例如: 张师傅" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">负责人电话 (选填)</label>
                <input value={form.contactPhone} onChange={e => setForm({...form, contactPhone: e.target.value})}
                  inputMode="numeric" maxLength={11}
                  className="w-full bg-bg rounded p-2 outline-none text-body font-num" placeholder="138xxxx8888" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">账期天数</label>
                <input type="number" value={form.creditDays}
                  onChange={e => setForm({...form, creditDays: parseInt(e.target.value || '30', 10)})}
                  className="w-full bg-bg rounded p-2 outline-none text-body font-num" />
              </div>
              {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption">{error}</div>}
              <button type="submit" className="w-full py-3 bg-amber text-white rounded-cta text-button">
                创建
              </button>
            </form>
            <p className="text-micro text-gray3 mt-3 text-center">
              创建后点「生成邀请链接」, 把链接发给供应商负责人, 他可以自己设密码登录。
            </p>
          </div>
        </div>
      )}

      {/* 邀请链接 sheet */}
      {inviteFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => { setInviteFor(null); setInviteResult(null) }}>
          <div className="w-full bg-white rounded-t-2xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">{inviteFor.name} · 邀请链接</h2>
              <button onClick={() => { setInviteFor(null); setInviteResult(null) }} className="text-h2 text-gray3 px-2">×</button>
            </div>
            {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption mb-3">{error}</div>}
            {!inviteResult ? (
              <div className="text-caption text-gray3 py-4 text-center">生成中…</div>
            ) : (
              <div className="space-y-3">
                <div className="bg-bg rounded p-3 break-all text-caption font-num">
                  {`${typeof window !== 'undefined' ? window.location.origin : ''}/v2/invite/${inviteResult.token}`}
                </div>
                <div className="text-caption text-gray3">
                  72 小时内有效, 一次性使用。把链接通过微信发给 {inviteFor.contactName || '供应商负责人'}。
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
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
