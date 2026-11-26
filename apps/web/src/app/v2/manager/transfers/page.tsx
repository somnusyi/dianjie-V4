'use client'

import { useEffect, useRef, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { businessDateKey } from '@/lib/business-date'

type Store = { id: string; no: string; name: string }
type Product = { id: string; code: string; name: string; inventoryUnit: string | null }
type Transfer = {
  id: string; no: string; transferDate: string; status: string
  fromStore: Store; toStore: Store
  items: { id: string; name: string; quantity: number; unit: string }[]
}
type EligibleStores = { sources: Store[]; destinations: Store[] }

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待供应链审核', RECEIVED: '已完成', REVOKED: '已驳回或撤回',
  SHIPPED: '历史调拨：已发货', PARTIALLY_RECEIVED: '历史调拨：待处理',
}

export default function ManagerTransfersPage() {
  const [eligible, setEligible] = useState<EligibleStores>({ sources: [], destinations: [] })
  const [products, setProducts] = useState<Product[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [form, setForm] = useState({ fromStoreId: '', toStoreId: '', productId: '', transferDate: businessDateKey(), quantity: '1', note: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isManager, setIsManager] = useState<boolean | null>(null)
  const request = useRef<{ body: string; key: string } | null>(null)

  async function reload() {
    const rows = await apiFetch<Transfer[]>('/api/store-transfers')
    setTransfers(rows)
  }

  useEffect(() => {
    const allowed = getUser()?.role === 'MANAGER'
    setIsManager(allowed)
    if (!allowed) { setLoading(false); return }
    Promise.all([
      apiFetch<EligibleStores>('/api/store-transfers/eligible-stores'),
      apiFetch<Product[]>('/api/store-transfers/products'),
      apiFetch<Transfer[]>('/api/store-transfers'),
    ]).then(([stores, items, rows]) => {
      setEligible(stores)
      setProducts(items)
      setTransfers(rows)
      setForm(current => ({ ...current, fromStoreId: stores.sources[0]?.id || '' }))
    }).catch(e => setError(e.message || '调拨信息加载失败')).finally(() => setLoading(false))
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    const quantity = Number(form.quantity)
    if (!form.fromStoreId || !form.toStoreId || !form.productId || !form.transferDate || !Number.isFinite(quantity) || quantity <= 0) {
      setError('请选择门店、商品并填写有效数量')
      return
    }
    if (form.fromStoreId === form.toStoreId) { setError('调出和调入不能是同一家门店'); return }
    const body = JSON.stringify({ ...form, quantity })
    if (!request.current || request.current.body !== body) request.current = { body, key: crypto.randomUUID() }
    setBusy(true)
    try {
      await apiFetch('/api/store-transfers', {
        method: 'POST',
        body: JSON.stringify({
          fromStoreId: form.fromStoreId, toStoreId: form.toStoreId,
          transferDate: form.transferDate, note: form.note, requestKey: request.current.key,
          items: [{ productId: form.productId, quantity, cost: 0, settlement: 0 }],
        }),
      })
      request.current = null
      setForm(current => ({ ...current, productId: '', quantity: '1', note: '' }))
      await reload()
    } catch (e: any) { setError(e.message || '提交调拨失败') }
    finally { setBusy(false) }
  }

  async function cancel(row: Transfer) {
    if (!window.confirm(`撤回调拨单 ${row.no}？`)) return
    setError(''); setBusy(true)
    try {
      await apiFetch(`/api/store-transfers/${row.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'REVOKED' }) })
      await reload()
    } catch (e: any) { setError(e.message || '撤回失败') }
    finally { setBusy(false) }
  }

  if (isManager === null) return <div className="p-5 text-caption text-gray3">加载中…</div>
  if (!isManager) return <div className="p-5 text-red-fg">仅店长可发起门店调拨</div>
  const destinations = eligible.destinations.filter(store => store.id !== form.fromStoreId)

  return <main className="min-h-screen bg-bg px-4 py-5 lg:px-8">
    <div className="mx-auto max-w-5xl">
      <header className="mb-5 flex items-center gap-3"><a href="/v2/manager/home" className="text-caption text-gray2">‹ 返回</a><h1 className="text-h1">门店调拨</h1></header>
      <p className="mb-4 text-caption text-gray2">本店发起，同品牌门店接收；供应链审核通过后库存立即转移。</p>
      {error && <p role="alert" className="mb-4 rounded-card bg-red-bg p-3 text-red-fg">{error}</p>}
      {loading ? <p className="text-caption text-gray3">加载中…</p> : <>
        {eligible.sources.length === 0 || destinations.length === 0 ?
          <p className="rounded-card bg-white p-4 text-caption text-gray2">暂无可调拨的同品牌门店，请先由管理员确认门店品牌归属。</p> :
          <form onSubmit={submit} className="mb-6 grid gap-3 rounded-card border border-border bg-white p-4 md:grid-cols-2">
            <label className="text-caption">调出门店<select value={form.fromStoreId} onChange={e => setForm({ ...form, fromStoreId: e.target.value, toStoreId: '' })} className="mt-1 block h-11 w-full rounded border border-border p-2"><option value="">请选择</option>{eligible.sources.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}</select></label>
            <label className="text-caption">调入门店<select value={form.toStoreId} onChange={e => setForm({ ...form, toStoreId: e.target.value })} className="mt-1 block h-11 w-full rounded border border-border p-2"><option value="">请选择</option>{destinations.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}</select></label>
            <label className="text-caption">调拨日期<input type="date" value={form.transferDate} onChange={e => setForm({ ...form, transferDate: e.target.value })} className="mt-1 block h-11 w-full rounded border border-border p-2" /></label>
            <label className="text-caption">商品<select value={form.productId} onChange={e => setForm({ ...form, productId: e.target.value })} className="mt-1 block h-11 w-full rounded border border-border p-2"><option value="">请选择</option>{products.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}{item.inventoryUnit ? ` / ${item.inventoryUnit}` : ''}</option>)}</select></label>
            <label className="text-caption">数量<input type="number" min="0.000001" step="0.000001" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} className="mt-1 block h-11 w-full rounded border border-border p-2" /></label>
            <label className="text-caption">备注<input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} maxLength={500} className="mt-1 block h-11 w-full rounded border border-border p-2" /></label>
            <button disabled={busy} type="submit" className="h-11 rounded-cta bg-accent px-4 text-button text-white disabled:opacity-60 md:col-span-2">{busy ? '提交中…' : '提交供应链审核'}</button>
          </form>}
        <section className="rounded-card border border-border bg-white p-4"><h2 className="mb-3 text-h2">本店调拨记录</h2>
          {transfers.length === 0 ? <p className="text-caption text-gray3">暂无调拨记录</p> :
            <ul className="divide-y divide-border">{transfers.map(row => <li key={row.id} className="py-3 text-caption">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong>{row.no}</strong><span>{STATUS_LABEL[row.status] || row.status}</span></div>
              <div className="mt-1 text-gray2">{row.fromStore.name} → {row.toStore.name} · {row.transferDate}</div>
              <div className="mt-1 text-gray2">{row.items.map(item => `${item.name} ${item.quantity}${item.unit}`).join('、')}</div>
              {row.status === 'PENDING' && <button disabled={busy} onClick={() => cancel(row)} className="mt-2 text-red-fg disabled:opacity-50">撤回申请</button>}
            </li>)}</ul>}
        </section>
      </>}
    </div>
  </main>
}
