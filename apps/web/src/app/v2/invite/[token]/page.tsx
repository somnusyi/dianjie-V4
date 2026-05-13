/**
 * v2 邀请激活页 · 公开 (token 在路径上)
 */
'use client'
import { useEffect, useState } from 'react'

const ROLE_LABEL: Record<string, string> = {
  MANAGER: '店长', KITCHEN_LEAD: '厨师长', CHEF_DIRECTOR: '总厨',
  FINANCE: '财务', PURCHASER: '采购', ENGINEERING: '工程部',
  SUPPLIER_OWNER: '供应商负责人', SUPPLIER_STAFF: '供应商员工',
}

export default function InviteAcceptPage({ params }: { params: { token: string } }) {
  const { token } = params
  const [info, setInfo] = useState<any>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', phone: '', password: '', confirmPwd: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    fetch(`/api/invite-accept/${token}`)
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || '邀请无效')
        setInfo(d)
      })
      .catch(e => setLoadErr(e.message || '邀请无效'))
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.name.trim()) return setError('请填写姓名')
    if (!/^1[3-9]\d{9}$/.test(form.phone)) return setError('手机号格式不正确')
    if (form.password.length < 6) return setError('密码至少 6 位')
    if (form.password !== form.confirmPwd) return setError('两次密码不一致')

    setSubmitting(true)
    try {
      const res = await fetch(`/api/invite-accept/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone.trim(),
          password: form.password,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '激活失败')
      setDone(true)
    } catch (e: any) {
      setError(e.message || '激活失败')
      setSubmitting(false)
    }
  }

  if (loadErr) {
    return (
      <div className="min-h-screen bg-bg flex flex-col">
        <header className="px-6 pt-14 pb-6"><div className="text-h1">滇界</div></header>
        <main className="flex-1 px-6 max-w-md w-full mx-auto">
          <div className="bg-red-bg text-red-fg rounded-card p-6 text-center">
            <div className="text-h2">⚠ {loadErr}</div>
            <a href="/v2/login" className="block mt-4 py-3 bg-ink text-white rounded-cta text-button">去登录</a>
          </div>
        </main>
      </div>
    )
  }

  if (done) {
    return (
      <div className="min-h-screen bg-bg flex flex-col">
        <header className="px-6 pt-14 pb-6"><div className="text-h1">滇界</div></header>
        <main className="flex-1 px-6 max-w-md w-full mx-auto">
          <div className="bg-bg-warm rounded-card border border-border p-6 text-center">
            <div className="w-14 h-14 rounded-full bg-amber/10 text-amber-fg flex items-center justify-center text-h1 mx-auto mb-3">✓</div>
            <div className="text-h2">账号激活成功</div>
            <p className="text-caption text-gray2 mt-2">你现在可以用刚才填的手机号 + 密码登录了。</p>
            <a href="/v2/login" className="block mt-5 py-3 bg-ink text-white rounded-cta text-button">去登录</a>
          </div>
        </main>
      </div>
    )
  }

  if (!info) {
    return <div className="min-h-screen bg-bg flex items-center justify-center text-caption text-gray3">加载邀请...</div>
  }

  const expDate = new Date(info.expiresAt)
  const expHrs = Math.max(0, Math.round((expDate.getTime() - Date.now()) / 3600_000))

  return (
    <div className="min-h-screen bg-bg flex flex-col pb-12">
      <header className="px-6 pt-14 pb-4">
        <div className="text-h1">{info.tenantName}</div>
        <p className="text-caption text-gray3">老板邀请你加入</p>
      </header>

      <main className="flex-1 px-6 max-w-md w-full mx-auto">
        <section className="bg-bg-warm rounded-card border border-border p-4 mb-4">
          <div className="text-caption text-gray2">将以以下身份激活账号</div>
          <div className="text-h2 mt-1">{ROLE_LABEL[info.role] || info.role}</div>
          {info.storeName && <div className="text-caption text-gray2 mt-1">门店: {info.storeName}</div>}
          {info.supplierName && <div className="text-caption text-gray2 mt-1">供应商: {info.supplierName}</div>}
          {info.note && <div className="text-caption text-gray3 mt-2 bg-white rounded p-2">备注: {info.note}</div>}
          <div className="text-micro text-gray3 mt-2">链接 {expHrs} 小时后失效</div>
        </section>

        <form onSubmit={submit} className="space-y-3">
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">姓名</label>
            <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
              className="w-full text-body bg-transparent outline-none" placeholder="张三" />
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">手机号 (登录账号)</label>
            <input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})}
              inputMode="numeric" maxLength={11}
              className="w-full text-body bg-transparent outline-none font-num" placeholder="13800138000" />
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">设置密码 (≥6 位)</label>
            <input type="password" value={form.password} onChange={e => setForm({...form, password: e.target.value})}
              className="w-full text-body bg-transparent outline-none font-num" />
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">再次输入</label>
            <input type="password" value={form.confirmPwd} onChange={e => setForm({...form, confirmPwd: e.target.value})}
              className="w-full text-body bg-transparent outline-none font-num" />
          </div>
          {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
          <button type="submit" disabled={submitting}
            className="w-full py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '激活中…' : '激活账号'}
          </button>
        </form>
      </main>
    </div>
  )
}
