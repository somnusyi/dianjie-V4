/**
 * 总厨 · 菜品详情 + 配方编辑
 * - 看成本/毛利
 * - 加配料 (SKU + 用量 + 损耗)
 * - 改/删配料
 * - 停用/启用菜品
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Product = {
  id: string; name: string; unit: string; price: string; code?: string
  supplier?: { name: string } | null
}
type Recipe = {
  id: string; productId: string
  quantity: string; unit: string
  lossRate: string; isMain: boolean
  note?: string | null
  product: Product
}
type Dish = {
  id: string; name: string; code?: string | null
  category?: string | null; unit: string; salePrice: string
  status: 'ACTIVE' | 'DISABLED' | 'UPCOMING'
  imageUrl?: string | null
  description?: string | null
  recipes: Recipe[]
  foodCost: number
  grossProfit: number
  grossMargin: number
}

function fmt(n: number, d = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

export default function DishDetailPage() {
  const router = useRouter()
  const params = useParams() as any
  const id = String(params.id)
  const [d, setD] = useState<Dish | null>(null)
  const [products, setProducts] = useState<Product[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [productQ, setProductQ] = useState('')
  const [editing, setEditing] = useState<Recipe | null>(null)

  async function reload() {
    try { setD(await apiFetch<Dish>(`/api/dishes/${id}`)) }
    catch (e: any) { setError(e.message) }
  }
  useEffect(() => {
    reload()
    apiFetch<any>('/api/products?all=1').then(d => setProducts(Array.isArray(d) ? d : d?.items || []))
  }, [id])

  const filteredProducts = useMemo(() => {
    if (!products) return []
    const used = new Set((d?.recipes || []).map(r => r.productId))
    return products.filter(p => {
      if (used.has(p.id)) return false
      if (!productQ.trim()) return true
      const hay = `${p.name} ${p.code || ''}`.toLowerCase()
      return productQ.toLowerCase().split(/\s+/).every(t => hay.includes(t))
    }).slice(0, 60)
  }, [products, productQ, d])

  if (error) return <ErrorScreen message={error} />
  if (!d) return <div className="min-h-screen bg-bg flex items-center justify-center text-gray3">加载中…</div>

  const marginTone: any = d.grossMargin >= 0.6 ? 'green' : d.grossMargin >= 0.4 ? 'amber' : 'red'

  async function addRecipe(productId: string) {
    setBusy(true)
    try {
      const p = products?.find(x => x.id === productId)
      if (!p) return
      await apiFetch(`/api/dishes/${id}/recipes`, {
        method: 'POST',
        body: JSON.stringify({ productId, quantity: 1, unit: p.unit, lossRate: 0 }),
      })
      setPickerOpen(false)
      setProductQ('')
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  async function updateRecipe(rid: string, patch: Partial<{ quantity: number; lossRate: number; isMain: boolean; note: string }>) {
    setBusy(true)
    try {
      await apiFetch(`/api/dishes/recipes/${rid}`, { method: 'PUT', body: JSON.stringify(patch) })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  async function removeRecipe(r: Recipe) {
    openConfirm({
      title: '删除配料?',
      body: <span>「<b>{r.product.name}</b>」从配方中移除</span>,
      confirmLabel: '删除', tone: 'danger',
      onConfirm: async () => {
        setBusy(true)
        try {
          await apiFetch(`/api/dishes/recipes/${r.id}`, { method: 'DELETE' })
          await reload()
        } catch (e: any) { alert(e.message) } finally { setBusy(false) }
      },
    })
  }

  async function toggleStatus() {
    const next = d!.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    setBusy(true)
    try {
      await apiFetch(`/api/dishes/${id}`, { method: 'PUT', body: JSON.stringify({ status: next }) })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">{d.name}</h1>
      </header>

      {/* 概览 */}
      <div className="mx-4 mt-2 bg-bg-warm rounded-card border border-border p-4">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Chip tone={d.status === 'ACTIVE' ? 'green' : d.status === 'UPCOMING' ? 'amber' : 'gray'}>
            {d.status === 'ACTIVE' ? '在售' : d.status === 'UPCOMING' ? '研发中' : '已停'}
          </Chip>
          {d.category && <span className="text-micro text-gray3">{d.category}</span>}
          <Chip tone={marginTone}>毛利 {(d.grossMargin * 100).toFixed(1)}%</Chip>
        </div>
        <div className="grid grid-cols-3 gap-2 text-caption mt-2">
          <div>
            <div className="text-gray3">售价</div>
            <div className="font-num text-h2">¥{fmt(Number(d.salePrice))}</div>
          </div>
          <div>
            <div className="text-gray3">食材成本</div>
            <div className="font-num text-h2 text-red-fg">¥{fmt(d.foodCost)}</div>
          </div>
          <div>
            <div className="text-gray3">毛利</div>
            <div className="font-num text-h2 text-green-fg">¥{fmt(d.grossProfit)}</div>
          </div>
        </div>
        {d.description && <p className="text-caption text-gray2 mt-2">{d.description}</p>}
      </div>

      {/* 配料列表 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-h2">配料 ({d.recipes.length})</span>
          <button onClick={() => setPickerOpen(true)}
                  className="px-3 py-1.5 bg-amber/10 text-amber-fg rounded-cta text-button">+ 加配料</button>
        </div>
        {d.recipes.length === 0 && (
          <p className="text-caption text-gray3 py-6 text-center">还没加配料 — 点上方「+ 加配料」</p>
        )}
        <ul className="space-y-2">
          {d.recipes.map(r => {
            const qty = Number(r.quantity)
            const loss = Number(r.lossRate)
            const price = Number(r.product.price)
            const itemCost = price * qty * (1 + loss)
            return (
              <li key={r.id} className="py-2 border-b border-border last:border-b-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-body truncate flex-1">
                    {r.isMain && <Chip tone="amber">主料</Chip>}
                    {' '}{r.product.name}
                  </span>
                  <span className="font-num text-caption text-gray3">¥{fmt(price)}/{r.product.unit}</span>
                </div>
                <div className="flex items-center gap-2 text-caption">
                  <span className="text-gray3">用量</span>
                  <input type="number" step="0.01" min="0.01"
                         value={qty}
                         onChange={e => updateRecipe(r.id, { quantity: Number(e.target.value) })}
                         className="w-20 bg-bg rounded-chip px-2 py-1 text-right font-num" />
                  <span>{r.unit}</span>
                  <span className="text-gray3 ml-2">损耗</span>
                  <input type="number" step="0.01" min="0" max="1"
                         value={loss}
                         onChange={e => updateRecipe(r.id, { lossRate: Number(e.target.value) })}
                         className="w-16 bg-bg rounded-chip px-2 py-1 text-right font-num" />
                  <span className="ml-auto font-num text-body">¥{fmt(itemCost)}</span>
                  <button onClick={() => removeRecipe(r)} disabled={busy} className="text-gray3 px-1">×</button>
                </div>
              </li>
            )
          })}
        </ul>
        {d.recipes.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border flex justify-between">
            <span className="text-h2">食材总成本</span>
            <span className="font-num text-h2">¥{fmt(d.foodCost)}</span>
          </div>
        )}
      </div>

      {/* 食材成本结构 (饼图替代:占比条) */}
      {d.recipes.length > 0 && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
          <div className="text-h2 mb-2">成本占比</div>
          {d.recipes.map(r => {
            const itemCost = Number(r.product.price) * Number(r.quantity) * (1 + Number(r.lossRate))
            const pct = d.foodCost > 0 ? (itemCost / d.foodCost) * 100 : 0
            return (
              <div key={r.id} className="mb-2">
                <div className="flex justify-between text-caption">
                  <span className="truncate">{r.product.name}</span>
                  <span className="font-num">¥{fmt(itemCost)} <span className="text-gray3">({pct.toFixed(0)}%)</span></span>
                </div>
                <div className="h-1.5 bg-gray5 rounded-full mt-1 overflow-hidden">
                  <div className="h-full bg-amber rounded-full" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 操作 */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-2">
        <button onClick={() => router.back()}
                className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">返回</button>
        <button onClick={toggleStatus} disabled={busy}
                className={`flex-1 py-3 rounded-cta text-button disabled:opacity-40 ${d.status === 'ACTIVE' ? 'border border-red text-red bg-white' : 'bg-ink text-white'}`}>
          {d.status === 'ACTIVE' ? '停用菜品' : '启用菜品'}
        </button>
      </div>

      {/* 配料选择抽屉 */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 bg-ink/60" onClick={() => setPickerOpen(false)}>
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
            <div className="px-4 pt-3 pb-2">
              <h3 className="text-h2">选食材加入配方</h3>
              <input value={productQ} onChange={e => setProductQ(e.target.value)}
                     placeholder="搜索 名称 / 编码"
                     className="w-full bg-bg rounded-cta px-3 py-2 text-body mt-2" />
            </div>
            <ul className="overflow-y-auto flex-1 divide-y divide-border">
              {filteredProducts.length === 0 && <li className="p-6 text-center text-caption text-gray3">无匹配 SKU</li>}
              {filteredProducts.map(p => (
                <li key={p.id} className="px-4 py-3 flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-body truncate">{p.name}</div>
                    <div className="text-micro text-gray3 font-num">¥{fmt(Number(p.price))} / {p.unit}{p.supplier?.name && ` · ${p.supplier.name}`}</div>
                  </div>
                  <button onClick={() => addRecipe(p.id)} disabled={busy}
                          className="px-3 py-1.5 bg-amber/10 text-amber-fg rounded-cta text-button">+ 加</button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <ConfirmSheet {...confirm} />
    </div>
  )
}
