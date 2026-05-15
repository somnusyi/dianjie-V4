/**
 * 总厨 · 代店下单
 * 与厨师长 /v2/chef/purchase/new 几乎一致, 差异:
 *   - 顶部必选「为哪家店下单」
 *   - 提交时显式传 storeId
 *   - 完成后跳回 /v2/chef-director/home (而非厨师长 po-success)
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'

type Store    = { id: string; name: string; no?: string | null }
type Supplier = { id: string; name: string; category: string | null; bankAccount: string | null }
type Product  = { id: string; name: string; unit: string; price: string; supplierId: string | null
                  spec?: string | null; category?: string | null; code?: string
                  minOrderQty?: string | number; stepQty?: string | number
                  stock?: string | number | null }
type LineItem = { productId: string; quantity: number; unitPrice: number }

function matchesQuery(p: Product, q: string) {
  if (!q.trim()) return true
  const hay = `${p.name} ${p.spec || ''} ${p.code || ''}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))
}

export default function ChefDirectorPONewPage() {
  const router = useRouter()
  const sp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const [stores, setStores] = useState<Store[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts]   = useState<Product[]>([])
  const [storeId, setStoreId] = useState<string>(sp?.get('storeId') || '')
  const [supplierId, setSupplierId] = useState<string>('')
  const [expectedDate, setExpectedDate] = useState<string>(() => new Date(Date.now() + 86400_000).toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [items, setItems] = useState<LineItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [idempotencyKey] = useState(() => `po-cd-${Date.now()}-${Math.random().toString(36).slice(2,10)}`)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()
  const [searchQ, setSearchQ] = useState('')
  const [catFilter, setCatFilter] = useState<string>('全部')

  useEffect(() => {
    apiFetch<any>('/api/stores').then((d) => {
      const arr = Array.isArray(d) ? d : d?.items || []
      setStores(arr)
    }).catch(() => {})
    apiFetch<Supplier[]>('/api/suppliers').then(setSuppliers).catch(e => setError(String(e?.message || e)))
    apiFetch<{items: Product[]}>('/api/products').then(d => setProducts(Array.isArray(d) ? d : (d?.items || []))).catch(() => {})
  }, [])

  const supplierProducts = supplierId
    ? products.filter(p => p.supplierId === supplierId)
    : products
  const allCategories = ['全部', ...Array.from(new Set(supplierProducts.map(p => p.category || '其他'))).sort()]
  const filteredProducts = supplierProducts.filter(p => {
    if (catFilter !== '全部' && (p.category || '其他') !== catFilter) return false
    return matchesQuery(p, searchQ)
  })
  const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)

  function moq(p: Product) { return Math.max(0.01, Number(p.minOrderQty || 1)) }
  function step(p: Product) { return Math.max(0.01, Number(p.stepQty || 1)) }
  function snap(p: Product, q: number) {
    const m = moq(p), s = step(p)
    if (q < m) return m
    const k = Math.round((q - m) / s)
    return +(m + k * s).toFixed(2)
  }
  function addItem(p: Product) {
    if (items.some(i => i.productId === p.id)) return
    setItems(prev => [...prev, { productId: p.id, quantity: moq(p), unitPrice: Number(p.price) }])
  }
  function updateItem(idx: number, patch: Partial<LineItem>) {
    setItems(items.map((it, i) => i === idx ? { ...it, ...patch } : it))
  }
  function removeItem(idx: number) {
    setItems(items.filter((_, i) => i !== idx))
  }
  function setQtyByProduct(p: Product, qty: number) {
    setItems(prev => {
      const existing = prev.find(i => i.productId === p.id)
      if (qty <= 0) return prev.filter(i => i.productId !== p.id)
      const snapped = snap(p, qty)
      if (existing) return prev.map(i => i.productId === p.id ? { ...i, quantity: snapped } : i)
      return [...prev, { productId: p.id, quantity: snapped, unitPrice: Number(p.price) }]
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!storeId) { setError('请选择为哪家店下单'); return }
    if (!supplierId) { setError('请选择供应商'); return }
    if (items.length === 0) { setError('请至少添加一个商品'); return }
    setError(null); setSubmitting(true)
    try {
      const order = await apiFetch<{ id: string; no: string }>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ storeId, supplierId, expectedDate, note, items, idempotencyKey }),
      })
      router.push(`/v2/chef-director/home?ok=${order.no}`)
    } catch (e: any) {
      setError(e.message || '提交失败')
      setSubmitting(false)
    }
  }

  const selectedStore = stores.find(s => s.id === storeId)

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">代店下单</h1>
      </header>

      <div className="mx-4 mt-2 bg-bg-warm rounded-card border border-border p-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-md bg-amber-bg text-amber-fg flex items-center justify-center text-h2">📦</span>
          <div className="flex-1">
            <div className="text-h2">总厨代下采购单</div>
            <p className="text-caption text-gray2 mt-0.5">为指定门店下单 · 厨师长视角会标「总厨代下」</p>
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3 mt-4 px-4">
        {/* 门店选择 (总厨独有) */}
        <div className={`bg-white rounded-card border p-3 ${!storeId ? 'border-amber/50' : 'border-border'}`}>
          <label className="text-micro text-gray3 block mb-1">为哪家店下单 <span className="text-red-fg">*</span></label>
          <select
            value={storeId}
            onChange={(e) => { setStoreId(e.target.value); setItems([]); setSupplierId('') }}
            required
            className="w-full text-body bg-transparent outline-none py-1"
          >
            <option value="">— 选择门店 —</option>
            {stores.map(s => (
              <option key={s.id} value={s.id}>{s.name}{s.no ? ` · ${s.no}` : ''}</option>
            ))}
          </select>
        </div>

        {/* 供应商选择 */}
        <div className={`bg-white rounded-card border border-border p-3 ${!storeId ? 'opacity-50 pointer-events-none' : ''}`}>
          <label className="text-micro text-gray3 block mb-1">供应商</label>
          <select
            value={supplierId}
            onChange={(e) => { setSupplierId(e.target.value); setItems([]) }}
            required
            disabled={!storeId}
            className="w-full text-body bg-transparent outline-none py-1"
          >
            <option value="">— 选择供应商 —</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>{s.name}{s.category ? ` · ${s.category}` : ''}</option>
            ))}
          </select>
        </div>

        {/* 期望到货日期 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">期望到货日期</label>
          <input
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
            required
            min={new Date().toISOString().slice(0, 10)}
            className="w-full text-body bg-transparent outline-none"
          />
        </div>

        {/* 商品列表 */}
        <div className="bg-white rounded-card border border-border p-3">
          <div className="flex items-center justify-between mb-2">
            <label className="text-micro text-gray3">采购商品 ({items.length})</label>
            {supplierId && supplierProducts.length > 0 && (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="text-button text-accent"
              >+ 添加商品</button>
            )}
          </div>
          {!supplierId && <p className="text-micro text-gray3">{storeId ? '请先选供应商' : '请先选门店和供应商'}</p>}
          {supplierId && supplierProducts.length === 0 && (
            <div className="bg-amber/10 border border-amber/30 rounded-cta p-3 text-caption text-amber-fg">
              ⚠ 该供应商暂未上架商品
            </div>
          )}
          {supplierId && supplierProducts.length > 0 && items.length === 0 && (
            <p className="text-micro text-gray3">点击右上角「+ 添加商品」</p>
          )}
          <ul className="space-y-2 mt-2">
            {items.map((it, i) => {
              const p = products.find(pr => pr.id === it.productId)
              return (
                <li key={it.productId} className="flex items-center gap-2 py-1.5 border-b border-border last:border-b-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-body truncate">{p?.name || it.productId}</div>
                    <div className="text-micro text-gray3">¥{it.unitPrice.toFixed(2)} / {p?.unit || '件'}{p && Number(p.minOrderQty || 1) > 1 && <span className="text-amber-fg ml-1">· 起订 {moq(p)}</span>}</div>
                  </div>
                  <input
                    type="number"
                    min={p ? moq(p) : 0.01}
                    step={p ? step(p) : 0.01}
                    value={it.quantity}
                    onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })}
                    onBlur={(e) => p && updateItem(i, { quantity: snap(p, Number(e.target.value) || moq(p)) })}
                    className="w-16 text-right font-num bg-bg rounded-chip px-2 py-1"
                  />
                  <span className="font-num text-body w-20 text-right">¥{(it.quantity * it.unitPrice).toFixed(2)}</span>
                  <button type="button" onClick={() => removeItem(i)} className="text-gray3 px-1">×</button>
                </li>
              )
            })}
          </ul>
          {items.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border flex items-center justify-between">
              <span className="text-h2">合计</span>
              <span className="font-num text-h2">¥{total.toFixed(2)}</span>
            </div>
          )}
        </div>

        {total > 0 && selectedStore && (
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone="amber">总厨代 {selectedStore.name} 下单</Chip>
            <Chip tone="green">提交后直发供应商</Chip>
          </div>
        )}

        {/* 备注 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">备注(可选)</label>
          <textarea
            value={note} onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="代下原因 · 特殊要求 · 验收标准..."
            className="w-full text-body bg-transparent outline-none resize-none"
          />
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>
        )}
      </form>

      {/* 商品选择 底部抽屉 — 与厨师长完全一致 */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50" onClick={() => setPickerOpen(false)}>
          <div className="absolute inset-0 bg-ink/60" />
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card shadow-drawer max-h-[75vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
            <div className="flex items-baseline justify-between px-4 pt-3 pb-2">
              <h3 className="text-h2">选择商品</h3>
              <span className="text-caption text-gray3">{filteredProducts.length}/{supplierProducts.length} SKU · 已选 {items.length}</span>
            </div>
            <div className="px-4 pb-2">
              <div className="relative">
                <input
                  type="search"
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  placeholder="搜索 名称 / 规格 / 编码"
                  className="w-full bg-bg rounded-chip pl-9 pr-9 py-2 text-body outline-none"
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray3 text-caption">🔍</span>
                {searchQ && (
                  <button type="button" onClick={() => setSearchQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray5 text-gray2 text-caption flex items-center justify-center">×</button>
                )}
              </div>
            </div>
            {allCategories.length > 2 && (
              <div className="px-4 pb-2 overflow-x-auto">
                <div className="flex gap-2 whitespace-nowrap">
                  {allCategories.map(c => (
                    <button key={c} type="button" onClick={() => setCatFilter(c)}
                      className={`px-3 py-1 rounded-chip text-caption ${catFilter === c ? 'bg-ink text-white' : 'bg-bg text-gray2'}`}>{c}</button>
                  ))}
                </div>
              </div>
            )}
            <ul className="overflow-auto flex-1 divide-y divide-border">
              {filteredProducts.length === 0 && (
                <li className="px-4 py-8 text-center text-caption text-gray3">无匹配商品</li>
              )}
              {filteredProducts.map(p => {
                const picked = items.find(i => i.productId === p.id)
                const qty = picked?.quantity || 0
                const stockNum = Number(p.stock || 0)
                const outOfStock = stockNum <= 0
                return (
                  <li key={p.id} className={`flex items-center px-4 py-3 ${picked ? 'bg-amber/5' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-body truncate flex items-center gap-1 flex-wrap">
                        <span>{p.name}</span>
                        {Number(p.minOrderQty || 1) > 1 && (
                          <span className="text-micro px-1.5 py-0.5 bg-amber/10 text-amber-fg rounded-chip whitespace-nowrap">起订 {moq(p)}{step(p) > 1 ? `·步 ${step(p)}` : ''}</span>
                        )}
                        {outOfStock && (
                          <span className="text-micro px-1.5 py-0.5 bg-red-50 text-red-600 rounded-chip whitespace-nowrap">⚠ 供应商断货</span>
                        )}
                      </div>
                      <div className="text-micro text-gray3 font-num">¥{Number(p.price).toFixed(2)} / {p.unit}{qty > 0 && <span className="text-amber-fg ml-2">小计 ¥{(qty * Number(p.price)).toFixed(2)}</span>}</div>
                    </div>
                    {qty === 0 ? (
                      <button type="button"
                        onClick={() => {
                          if (outOfStock) {
                            openConfirm({
                              title: '供应商断货提醒',
                              body: <span>「<b>{p.name}</b>」供应商当前库存为 <b className="text-red-600">0</b>,可能无法按时发货。仍要加入吗?</span>,
                              confirmLabel: '仍然加入', cancelLabel: '取消', tone: 'danger',
                              onConfirm: () => addItem(p),
                            })
                          } else { addItem(p) }
                        }}
                        className={`px-3 py-1.5 rounded-cta text-button ${outOfStock ? 'bg-red-50 text-red-600' : 'bg-amber/10 text-amber-fg'}`}
                      >+ 加入</button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setQtyByProduct(p, +(qty - step(p)).toFixed(2))} className="w-8 h-8 rounded-full bg-bg text-h2 leading-none flex items-center justify-center">−</button>
                        <input type="number" inputMode="decimal" min={moq(p)} step={step(p)}
                          value={qty}
                          onChange={e => setQtyByProduct(p, Number(e.target.value))}
                          onBlur={e => setQtyByProduct(p, snap(p, Number(e.target.value) || moq(p)))}
                          className="w-14 text-center font-num text-body bg-bg rounded-chip py-1 outline-none"
                        />
                        <button type="button" onClick={() => setQtyByProduct(p, +(qty + step(p)).toFixed(2))} className="w-8 h-8 rounded-full bg-amber text-white text-h2 leading-none flex items-center justify-center">+</button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="border-t border-border p-3 flex items-center gap-3">
              <div className="flex-1">
                <div className="text-micro text-gray3">已选 {items.length} 项</div>
                <div className="font-num text-h2">¥{total.toFixed(2)}</div>
              </div>
              <button onClick={() => setPickerOpen(false)} className="px-6 py-3 bg-ink text-white rounded-cta text-button">完成</button>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button type="button" onClick={() => router.back()} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
        <button
          onClick={submit}
          disabled={submitting || !storeId || !supplierId || items.length === 0}
          className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40"
        >
          {submitting ? '提交中…' : `提交${selectedStore ? '为 ' + selectedStore.name : ''}${total > 0 ? ` · ¥${total.toFixed(2)}` : ''}`}
        </button>
      </div>
      <ConfirmSheet {...confirm} />
    </div>
  )
}
