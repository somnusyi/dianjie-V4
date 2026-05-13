/**
 * v2 公开账号申请页 · 无需登录
 * 提交后等老板在 /v2/me/applications 审批
 */
'use client'
import { useState, useEffect } from 'react'

// PURCHASER 是 v2 legacy 别名 (路由到 /v2/manager/home, 实际拿店长权限),
// 已从申请表单移除以防止"供应商误申请→拿店长权限"的安全漏洞。
const ROLE_OPTIONS = [
  { value: 'MANAGER',         label: '店长' },
  { value: 'KITCHEN_LEAD',    label: '厨师长' },
  { value: 'CHEF_DIRECTOR',   label: '总厨' },
  { value: 'FINANCE',         label: '财务' },
  { value: 'ENGINEERING',     label: '工程部' },
  { value: 'SUPPLIER_OWNER',  label: '供应商 - 注册新公司 (我是公司负责人)' },
  { value: 'SUPPLIER_STAFF',  label: '供应商 - 加入已有公司' },
]

type SupplierLite = { id: string; name: string; no: string }
type StoreLite = { id: string; name: string; no: string }

export default function ApplyPage() {
  const [form, setForm] = useState({
    name: '', phone: '', password: '', confirmPwd: '',
    requestedRole: 'MANAGER', reason: '',
    supplierId: '',     // SUPPLIER_STAFF 用
    supplierName: '',   // SUPPLIER_OWNER 用
    requestedStoreId: '', // MANAGER / KITCHEN_LEAD 用
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [suppliers, setSuppliers] = useState<SupplierLite[]>([])
  const [loadingSuppliers, setLoadingSuppliers] = useState(false)
  const [stores, setStores] = useState<StoreLite[]>([])
  const [loadingStores, setLoadingStores] = useState(false)

  const needsStore = ['MANAGER', 'KITCHEN_LEAD'].includes(form.requestedRole)

  useEffect(() => {
    if (form.requestedRole !== 'SUPPLIER_STAFF' || suppliers.length > 0) return
    setLoadingSuppliers(true)
    fetch('/api/auth/supplier-list')
      .then(r => r.json())
      .then((d) => { if (Array.isArray(d)) setSuppliers(d) })
      .catch(() => {})
      .finally(() => setLoadingSuppliers(false))
  }, [form.requestedRole, suppliers.length])

  // 选择"店长/厨师长"时, 拉取门店列表
  useEffect(() => {
    if (!needsStore || stores.length > 0) return
    setLoadingStores(true)
    fetch('/api/auth/store-list')
      .then(r => r.json())
      .then((d) => { if (Array.isArray(d)) setStores(d) })
      .catch(() => {})
      .finally(() => setLoadingStores(false))
  }, [needsStore, stores.length])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.name.trim()) return setError('请填写姓名')
    if (!/^1[3-9]\d{9}$/.test(form.phone)) return setError('手机号格式不正确')
    if (form.password.length < 6) return setError('密码至少 6 位')
    if (form.password !== form.confirmPwd) return setError('两次密码不一致')
    if (form.requestedRole === 'SUPPLIER_OWNER' && !form.supplierName.trim()) {
      return setError('请填写新供应商公司名称')
    }
    if (form.requestedRole === 'SUPPLIER_STAFF' && !form.supplierId) {
      return setError('请选择要加入的供应商公司')
    }
    if (needsStore && !form.requestedStoreId) {
      return setError('请选择所属门店')
    }

    setSubmitting(true)
    try {
      const body: any = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        password: form.password,
        requestedRole: form.requestedRole,
        reason: form.reason.trim() || undefined,
      }
      if (form.requestedRole === 'SUPPLIER_OWNER') body.supplierName = form.supplierName.trim()
      if (form.requestedRole === 'SUPPLIER_STAFF') body.supplierId = form.supplierId
      if (needsStore) body.requestedStoreId = form.requestedStoreId
      const res = await fetch('/api/auth/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '提交失败')
      setDone(true)
    } catch (e: any) {
      setError(e.message || '提交失败')
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-bg flex flex-col">
        <header className="px-6 pt-14 pb-6">
          <div className="text-h1">滇界</div>
        </header>
        <main className="flex-1 px-6 max-w-md w-full mx-auto">
          <div className="bg-bg-warm rounded-card border border-border p-6 text-center">
            <div className="w-14 h-14 rounded-full bg-amber/10 text-amber-fg flex items-center justify-center text-h1 mx-auto mb-3">✓</div>
            <div className="text-h2">申请已提交</div>
            <p className="text-caption text-gray2 mt-2">老板审批通过后, 你就可以用手机号登录了。</p>
            <a href="/v2/login" className="block mt-5 py-3 bg-ink text-white rounded-cta text-button">返回登录</a>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col pb-12">
      <header className="px-6 pt-14 pb-4 flex items-center gap-3">
        <a href="/v2/login" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <div>
          <div className="text-h1">申请账号</div>
          <p className="text-caption text-gray3 mt-0.5">提交后由老板审批</p>
        </div>
      </header>

      <main className="flex-1 px-6 max-w-md w-full mx-auto">
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
              className="w-full text-body bg-transparent outline-none font-num"
              placeholder="13800138000" />
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">设置密码 (≥6 位)</label>
            <input type="password" value={form.password} onChange={e => setForm({...form, password: e.target.value})}
              className="w-full text-body bg-transparent outline-none font-num" />
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">再次输入密码</label>
            <input type="password" value={form.confirmPwd} onChange={e => setForm({...form, confirmPwd: e.target.value})}
              className="w-full text-body bg-transparent outline-none font-num" />
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">申请角色</label>
            <select value={form.requestedRole} onChange={e => setForm({...form, requestedRole: e.target.value})}
              className="w-full text-body bg-transparent outline-none">
              {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>

          {/* 店长 / 厨师长 → 必须选门店 */}
          {needsStore && (
            <div className="bg-white rounded-card border border-border p-3">
              <label className="text-micro text-gray3 block mb-1">所属门店 *</label>
              {loadingStores ? (
                <div className="text-caption text-gray3">加载中…</div>
              ) : stores.length === 0 ? (
                <div className="text-caption text-gray3">暂无可选门店, 请联系老板创建</div>
              ) : (
                <select value={form.requestedStoreId} onChange={e => setForm({...form, requestedStoreId: e.target.value})}
                  className="w-full text-body bg-transparent outline-none">
                  <option value="">— 请选择 —</option>
                  {stores.map(s => (
                    <option key={s.id} value={s.id}>{s.no ? `${s.no} · ${s.name}` : s.name}</option>
                  ))}
                </select>
              )}
              <p className="text-micro text-gray3 mt-1">{form.requestedRole === 'MANAGER' ? '店长' : '厨师长'} 角色严格按本店数据隔离, 不能查看其它门店。</p>
            </div>
          )}

          {/* 供应商-注册新公司 → 输入公司名 */}
          {form.requestedRole === 'SUPPLIER_OWNER' && (
            <div className="bg-white rounded-card border border-border p-3">
              <label className="text-micro text-gray3 block mb-1">新供应商公司名称</label>
              <input value={form.supplierName} onChange={e => setForm({...form, supplierName: e.target.value})}
                maxLength={80}
                className="w-full text-body bg-transparent outline-none"
                placeholder="例如: 上海浦东鲜蔬贸易有限公司" />
              <p className="text-micro text-gray3 mt-1">老板审批通过后会自动创建这家供应商, 你成为公司负责人 (Owner)。</p>
            </div>
          )}

          {/* 供应商-加入已有公司 → 下拉选 */}
          {form.requestedRole === 'SUPPLIER_STAFF' && (
            <div className="bg-white rounded-card border border-border p-3">
              <label className="text-micro text-gray3 block mb-1">加入哪家供应商公司</label>
              {loadingSuppliers ? (
                <div className="text-caption text-gray3">加载中…</div>
              ) : suppliers.length === 0 ? (
                <div className="text-caption text-gray3">暂无可加入的供应商, 请联系公司负责人先注册</div>
              ) : (
                <select value={form.supplierId} onChange={e => setForm({...form, supplierId: e.target.value})}
                  className="w-full text-body bg-transparent outline-none">
                  <option value="">— 请选择 —</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>{s.no} · {s.name}</option>
                  ))}
                </select>
              )}
              <p className="text-micro text-gray3 mt-1">老板审批通过后, 你将以员工 (Staff) 身份加入这家供应商。</p>
            </div>
          )}

          <div className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">备注 (选填)</label>
            <textarea value={form.reason} onChange={e => setForm({...form, reason: e.target.value})}
              maxLength={200} rows={2}
              className="w-full text-body bg-transparent outline-none resize-none"
              placeholder="例如: 翠湖店店长, 已经入职" />
          </div>
          {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
          <button type="submit" disabled={submitting}
            className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : '提交申请'}
          </button>
        </form>
      </main>
    </div>
  )
}
