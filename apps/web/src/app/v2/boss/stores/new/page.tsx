/**
 * v2 新建门店 · 仅 BOSS / ADMIN
 */
'use client'
import { useEffect, useState } from 'react'
import { getUser, getToken } from '@/lib/v2-auth'

export default function NewStorePage() {
  const [u, setU] = useState<any>(null)
  const [form, setForm] = useState({
    no: '', name: '', address: '', phone: '', managerName: '',
    bankAccountName: '', invoiceTaxId: '', bankName: '', bankAccountNo: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const user = getUser()
    setU(user)
    if (!user) { location.replace('/v2/login'); return }
    if (!['BOSS','ADMIN','SUPER_ADMIN','ENGINEERING'].includes(user.role)) {
      location.replace('/v2/login')
    }
    // 自动建议下一个 no (从全量 stores 推算, 工程部也能拿到避免冲突)
    const t = getToken()
    fetch('/api/stores/next-no', { headers: { Authorization: `Bearer ${t}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.suggested) setForm(f => ({ ...f, no: d.suggested }))
      })
      .catch(() => {})
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.no.trim() || !form.name.trim()) {
      return setError('门店编号和名称必填')
    }
    // 开票信息: 4 字段要么都填要么都不填
    const anyInv = form.bankAccountName.trim() || form.invoiceTaxId.trim() || form.bankName.trim() || form.bankAccountNo.trim()
    const allInv = form.bankAccountName.trim() && form.invoiceTaxId.trim() && form.bankName.trim() && form.bankAccountNo.trim()
    if (anyInv && !allInv) {
      return setError('开票信息要填就把户名 / 税号 / 开户行 / 银行账户都填上')
    }
    if (form.bankAccountNo.trim() && !/^[\d\s-]+$/.test(form.bankAccountNo.trim())) {
      return setError('银行账户只能是数字')
    }
    setSubmitting(true)
    try {
      const t = getToken()
      const res = await fetch('/api/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          no: form.no.trim(),
          name: form.name.trim(),
          address: form.address.trim() || undefined,
          phone: form.phone.trim() || undefined,
          managerName: form.managerName.trim() || undefined,
          bankAccountName: form.bankAccountName.trim() || undefined,
          invoiceTaxId: form.invoiceTaxId.trim() || undefined,
          bankName: form.bankName.trim() || undefined,
          bankAccountNo: form.bankAccountNo.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '创建失败')
      const isEng = u?.role === 'ENGINEERING'
      location.replace(isEng ? `/v2/engineer/stores/${data.id}` : '/v2/boss/stores')
    } catch (e: any) {
      setError(e.message || '创建失败')
      setSubmitting(false)
    }
  }

  if (!u) return null

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href={u?.role === 'ENGINEERING' ? '/v2/engineer/home' : '/v2/boss/stores'}
           className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1">{u?.role === 'ENGINEERING' ? '新建筹建店' : '新建门店'}</h1>
      </header>

      <form onSubmit={submit} className="px-4 mt-2 space-y-3">
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">门店编号</label>
          <input value={form.no} onChange={e => setForm({...form, no: e.target.value.toUpperCase()})}
            maxLength={20}
            className="w-full text-body bg-transparent outline-none font-num" placeholder="DJ001" />
          <div className="text-micro text-gray3 mt-1">建议保持 DJ + 三位数, 唯一</div>
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">门店名称</label>
          <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
            maxLength={40}
            className="w-full text-body bg-transparent outline-none" placeholder="翠湖店" />
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">地址 (选填)</label>
          <input value={form.address} onChange={e => setForm({...form, address: e.target.value})}
            className="w-full text-body bg-transparent outline-none"
            placeholder="昆明市五华区翠湖路 ××号" />
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">门店电话 (选填)</label>
          <input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})}
            inputMode="numeric"
            className="w-full text-body bg-transparent outline-none font-num" placeholder="0871-xxxxxxx" />
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">店长姓名 (选填)</label>
          <input value={form.managerName} onChange={e => setForm({...form, managerName: e.target.value})}
            className="w-full text-body bg-transparent outline-none"
            placeholder="先填名字, 之后在团队成员里建店长账号绑定" />
        </div>

        {/* 开票信息 */}
        <div className="text-caption text-gray3 px-1 pt-2">开票信息 · 选填 (开发票 / 聚合收款 T+1 到账都用这里)</div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">户名 (公司全称)</label>
          <input value={form.bankAccountName} onChange={e => setForm({...form, bankAccountName: e.target.value})}
            maxLength={80}
            className="w-full text-body bg-transparent outline-none"
            placeholder="合肥云岳之境餐饮管理有限公司" />
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">税号</label>
          <input value={form.invoiceTaxId} onChange={e => setForm({...form, invoiceTaxId: e.target.value.toUpperCase()})}
            maxLength={40}
            className="w-full text-body bg-transparent outline-none font-num"
            placeholder="91340102MAK7T6AY64" />
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">开户行</label>
          <input value={form.bankName} onChange={e => setForm({...form, bankName: e.target.value})}
            maxLength={60}
            className="w-full text-body bg-transparent outline-none"
            placeholder="中国银行南京中山东路支行" />
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">银行账户</label>
          <input value={form.bankAccountNo} onChange={e => setForm({...form, bankAccountNo: e.target.value})}
            inputMode="numeric" maxLength={40}
            className="w-full text-body bg-transparent outline-none font-num"
            placeholder="471583515987" />
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
        <button type="submit" disabled={submitting}
          className="w-full py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
          {submitting ? '创建中…' : '创建门店'}
        </button>
        <p className="text-micro text-gray3 text-center">
          创建后到「我 → 团队成员」邀请这家店的店长 / 厨师长
        </p>
      </form>
    </div>
  )
}
