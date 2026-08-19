/**
 * 内部供应链 · 供应商供货商品管理（桌面端，全屏）
 *
 * 对齐美团「供应商档案 - 供货关系」：在供应商维度批量绑定可供商品。
 * 「已绑定」tab 支持行内改价、设主供（二次确认切换）、软解绑；
 * 「添加商品」tab 勾选商品后自动预填档案单位/换算比/价，一次批量提交。
 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { EmptyState, FriendlyError, SkeletonList } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'
import { clientRequestId } from '@/lib/client-id'
import {
  buildBindItems,
  categoriesOfProducts,
  type BindItemDraft,
  type RelationProduct,
  type RelationSupplier,
  type SupplyRelation,
} from '@/lib/supply-relations'

type CatalogProduct = RelationProduct & {
  upstreamSources?: Array<{ supplierId: string; isActive?: boolean }>
}

type DraftRow = BindItemDraft & { name: string; code: string; category: string | null }

function toNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export default function SupplierUpstreamProductsPage({ params }: { params: { id: string } }) {
  const supplierId = params.id
  const [supplier, setSupplier] = useState<RelationSupplier | null>(null)
  const [bindings, setBindings] = useState<SupplyRelation[] | null>(null)
  const [catalog, setCatalog] = useState<CatalogProduct[] | null>(null)
  const [tab, setTab] = useState<'bound' | 'add'>('bound')
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, Partial<BindItemDraft>>>({})
  const [batchUnit, setBatchUnit] = useState('')
  const [batchPrice, setBatchPrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  function loadBindings() {
    return apiFetch<{ supplier: RelationSupplier; items: SupplyRelation[] }>(
      `/api/suppliers/${supplierId}/upstream-products`,
    ).then(data => {
      setSupplier(data.supplier)
      setBindings(Array.isArray(data.items) ? data.items : [])
    })
  }

  function loadAll() {
    setError(null)
    Promise.all([
      loadBindings(),
      apiFetch<CatalogProduct[]>('/api/products').then(rows => setCatalog(Array.isArray(rows) ? rows : [])),
    ]).catch(reason => setError(String(reason?.message || reason)))
  }

  useEffect(() => { loadAll() }, [supplierId])

  const boundProductIds = useMemo(
    () => new Set((bindings ?? []).map(row => row.productId)),
    [bindings],
  )

  const filteredBindings = useMemo(() => {
    const keyword = q.trim().toLowerCase()
    return (bindings ?? []).filter(row =>
      (!keyword || (row.product?.name || '').toLowerCase().includes(keyword)
        || (row.product?.code || '').toLowerCase().includes(keyword))
      && (!category || (row.product?.category || '其他') === category))
  }, [bindings, q, category])

  const addableProducts = useMemo(() => {
    const keyword = q.trim().toLowerCase()
    return (catalog ?? [])
      .filter(product => product.status === 'ENABLED')
      .filter(product =>
        (!keyword || product.name.toLowerCase().includes(keyword) || product.code.toLowerCase().includes(keyword))
        && (!category || (product.category || '其他') === category))
  }, [catalog, q, category])

  const categoryOptions = useMemo(() => {
    const fromBindings = (bindings ?? []).map(row => ({ category: row.product?.category ?? null }))
    return categoriesOfProducts([...fromBindings, ...(catalog ?? [])])
  }, [bindings, catalog])

  const selectedProducts = useMemo(
    () => addableProducts.filter(product => checked[product.id] && !boundProductIds.has(product.id)),
    [addableProducts, checked, boundProductIds],
  )

  function toggleProduct(product: CatalogProduct) {
    if (boundProductIds.has(product.id)) return
    setChecked(current => ({ ...current, [product.id]: !current[product.id] }))
    if (!drafts[product.id]) {
      const [first] = buildBindItems([product]).items
      setDrafts(current => ({
        ...current,
        [product.id]: first
          ? { purchaseUnit: first.purchaseUnit, inventoryUnitsPerPurchaseUnit: first.inventoryUnitsPerPurchaseUnit, quotedUnitPrice: first.quotedUnitPrice }
          : { purchaseUnit: product.purchaseUnit || product.unit },
      }))
    }
  }

  function applyBatchDefaults() {
    const price = batchPrice.trim() === '' ? undefined : Number(batchPrice)
    if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
      setError('批量价格必须是不小于 0 的数字')
      return
    }
    setError(null)
    setDrafts(current => {
      const next = { ...current }
      for (const product of selectedProducts) {
        next[product.id] = {
          ...next[product.id],
          ...(batchUnit.trim() ? { purchaseUnit: batchUnit.trim() } : {}),
          ...(price !== undefined ? { quotedUnitPrice: price } : {}),
        }
      }
      return next
    })
  }

  async function submitBind() {
    if (selectedProducts.length === 0 || saving) return
    setSaving(true)
    setError(null)
    const items = selectedProducts.map(product => ({
      productId: product.id,
      purchaseUnit: drafts[product.id]?.purchaseUnit || product.purchaseUnit || product.unit,
      inventoryUnitsPerPurchaseUnit: Number(drafts[product.id]?.inventoryUnitsPerPurchaseUnit),
      quotedUnitPrice: drafts[product.id]?.quotedUnitPrice ?? null,
      isPrimary: false,
    }))
    const bad = items.find(item => !Number.isFinite(item.inventoryUnitsPerPurchaseUnit) || item.inventoryUnitsPerPurchaseUnit <= 0)
    if (bad) {
      setSaving(false)
      setError('有商品缺有效换算比（每采购单位库存量），请先在商品档案补齐单位换算')
      return
    }
    try {
      const result = await apiFetch<{ boundCount: number; reactivatedCount: number; skipped: Array<{ name: string }> }>(
        `/api/suppliers/${supplierId}/upstream-products`,
        {
          method: 'POST',
          body: JSON.stringify({ items }),
          headers: { 'Idempotency-Key': clientRequestId() },
        },
      )
      setNotice(`已绑定 ${result.boundCount + result.reactivatedCount} 个商品${result.skipped.length ? `，${result.skipped.length} 个已存在被跳过` : ''}`)
      setChecked({})
      setDrafts({})
      setTab('bound')
      await loadBindings()
    } catch (reason: any) {
      setError(reason?.message || '绑定失败')
    } finally {
      setSaving(false)
    }
  }

  async function savePrice(row: SupplyRelation, value: string) {
    const price = value.trim() === '' ? null : Number(value)
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      setError('协议价必须是数字')
      return
    }
    try {
      await apiFetch(`/api/suppliers/${supplierId}/upstream-products/${row.productId}`, {
        method: 'PATCH',
        body: JSON.stringify({ quotedUnitPrice: price }),
        headers: { 'Idempotency-Key': clientRequestId() },
      })
      setNotice(`「${row.product?.name}」协议价已更新`)
      await loadBindings()
    } catch (reason: any) {
      setError(reason?.message || '保存失败')
    }
  }

  function makePrimary(row: SupplyRelation) {
    const currentPrimary = (bindings ?? []).find(item => item.isPrimary && item.productId === row.productId)
    openConfirm({
      title: `把「${row.product?.name}」主供设为本供应商？`,
      body: currentPrimary
        ? `当前主供是「${currentPrimary.supplier?.name || '其他供应商'}」，切换后它变为备选。`
        : '该商品还没有主供，设置后采购与入库默认走本供应商。',
      confirmLabel: '设为主供',
      tone: 'primary',
      onConfirm: async () => {
        await apiFetch(`/api/suppliers/${supplierId}/upstream-products/${row.productId}`, {
          method: 'PATCH',
          body: JSON.stringify({ isPrimary: true }),
          headers: { 'Idempotency-Key': clientRequestId() },
        })
        await loadBindings()
      },
    })
  }

  function unbind(row: SupplyRelation) {
    openConfirm({
      title: `解绑「${row.product?.name}」？`,
      body: '解绑后该商品不再出现在本供应商的入库可选范围；历史单据不受影响，重新绑定即恢复。',
      confirmLabel: '确认解绑',
      tone: 'danger',
      onConfirm: async () => {
        await apiFetch(`/api/suppliers/${supplierId}/upstream-products/${row.productId}`, {
          method: 'DELETE',
        })
        setNotice(`「${row.product?.name}」已解绑`)
        await loadBindings()
      },
    })
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="mx-auto flex max-w-[1440px] items-end justify-between px-6 pt-6">
        <div>
          <div className="text-caption text-gray3">供应商档案 · 供货关系</div>
          <h1 className="text-h1">供货商品 · {supplier?.name || '…'}</h1>
          <p className="mt-1 text-caption text-gray2">
            {bindings ? `已绑定 ${bindings.length} 个商品` : '加载中…'}
          </p>
        </div>
        <a href="/v2/supply-chain/suppliers" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button text-gray2">← 返回供应商</a>
      </header>

      <main className="mx-auto max-w-[1440px] px-6">
        <nav aria-label="供货商品视图" className="flex gap-2 border-b border-border py-4">
          <button
            onClick={() => setTab('bound')}
            aria-pressed={tab === 'bound'}
            className={`rounded-cta px-4 py-2 text-button ${tab === 'bound' ? 'bg-ink text-white' : 'border border-border bg-white text-gray2'}`}
          >已绑定 {bindings ? `(${bindings.length})` : ''}</button>
          <button
            onClick={() => setTab('add')}
            aria-pressed={tab === 'add'}
            className={`rounded-cta px-4 py-2 text-button ${tab === 'add' ? 'bg-ink text-white' : 'border border-border bg-white text-gray2'}`}
          >＋ 添加商品</button>
        </nav>

        {notice && (
          <div className="mt-4 flex items-center justify-between rounded-card border border-green-fg/20 bg-green-bg px-4 py-3 text-caption text-green-fg">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="text-button">关闭</button>
          </div>
        )}
        {error && <div className="mt-4"><FriendlyError message={error} onRetry={loadAll} /></div>}

        <div className="flex flex-wrap items-end gap-3 py-4">
          <label className="flex flex-col gap-1">
            <span className="text-micro text-gray3">关键字</span>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="名称 / 编码"
              className="rounded-cta border border-border bg-white px-3 py-2 text-body outline-none" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-micro text-gray3">分类</span>
            <select value={category} onChange={e => setCategory(e.target.value)}
              className="rounded-cta border border-border bg-white px-3 py-2 text-body outline-none">
              <option value="">全部分类</option>
              {categoryOptions.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        </div>

        {!bindings && !error && <SkeletonList count={5} />}

        {bindings && tab === 'bound' && (
          filteredBindings.length === 0 ? (
            <EmptyState icon="📦" title={bindings.length === 0 ? '还没有供货商品' : '没有匹配的商品'}
              hint={bindings.length === 0 ? '点上方「＋ 添加商品」批量绑定这家供应商可供的 SKU' : '调整筛选条件'} />
          ) : (
            <div className="overflow-hidden rounded-card border border-border bg-white">
              <table className="w-full text-left text-caption">
                <thead className="bg-bg text-gray3">
                  <tr>
                    <th className="px-4 py-3">编码</th>
                    <th className="px-4 py-3">名称</th>
                    <th className="px-4 py-3">分类</th>
                    <th className="px-4 py-3">采购单位</th>
                    <th className="px-4 py-3">换算比</th>
                    <th className="px-4 py-3 text-right">协议价</th>
                    <th className="px-4 py-3">主供</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredBindings.map(row => (
                    <tr key={row.id}>
                      <td className="px-4 py-2.5 font-num text-gray2">{row.product?.code}</td>
                      <td className="px-4 py-2.5"><b>{row.product?.name}</b></td>
                      <td className="px-4 py-2.5 text-gray2">{row.product?.category || '其他'}</td>
                      <td className="px-4 py-2.5 text-gray2">{row.purchaseUnit}</td>
                      <td className="px-4 py-2.5 font-num text-gray2">×{row.inventoryUnitsPerPurchaseUnit}</td>
                      <td className="px-4 py-2.5 text-right">
                        <input
                          key={`${row.id}-${row.quotedUnitPrice}`}
                          defaultValue={row.quotedUnitPrice ?? ''}
                          inputMode="decimal"
                          aria-label={`${row.product?.name} 协议价`}
                          onBlur={e => {
                            const value = e.target.value.trim()
                            if (value !== String(row.quotedUnitPrice ?? '')) void savePrice(row, value)
                          }}
                          className="w-24 rounded border border-border bg-bg px-2 py-1 text-right font-num outline-none"
                          placeholder="未谈价"
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        {row.isPrimary
                          ? <Chip tone="amber">主供</Chip>
                          : <button onClick={() => makePrimary(row)} className="text-button text-accent">设为主供</button>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button onClick={() => unbind(row)} className="text-button text-red-fg">解绑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {bindings && catalog && tab === 'add' && (
          <div className="overflow-hidden rounded-card border border-border bg-white">
            <table className="w-full text-left text-caption">
              <thead className="bg-bg text-gray3">
                <tr>
                  <th className="w-10 px-3 py-3"></th>
                  <th className="px-4 py-3">商品</th>
                  <th className="px-4 py-3">分类</th>
                  <th className="px-4 py-3">采购单位</th>
                  <th className="px-4 py-3">换算比</th>
                  <th className="px-4 py-3 text-right">协议价</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {addableProducts.map(product => {
                  const bound = boundProductIds.has(product.id)
                  const selected = !!checked[product.id] && !bound
                  const draft = drafts[product.id] || {}
                  return (
                    <tr key={product.id} className={bound ? 'opacity-45' : selected ? 'bg-accent/5' : ''}>
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={bound}
                          aria-label={`选择 ${product.name}`}
                          onChange={() => toggleProduct(product)}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <b>{product.name}</b>
                        {bound && <span className="ml-2 text-micro text-gray3">已绑</span>}
                        <div className="font-num text-micro text-gray3">{product.code}{product.spec ? ` · ${product.spec}` : ''}</div>
                      </td>
                      <td className="px-4 py-2.5 text-gray2">{product.category || '其他'}</td>
                      {selected ? (
                        <>
                          <td className="px-4 py-2.5">
                            <input value={draft.purchaseUnit ?? ''} maxLength={8} aria-label="采购单位"
                              onChange={e => setDrafts(c => ({ ...c, [product.id]: { ...c[product.id], purchaseUnit: e.target.value } }))}
                              className="w-16 rounded border border-border bg-white px-2 py-1 outline-none" />
                          </td>
                          <td className="px-4 py-2.5">
                            <input value={draft.inventoryUnitsPerPurchaseUnit ?? ''} inputMode="decimal" aria-label="换算比"
                              onChange={e => setDrafts(c => ({ ...c, [product.id]: { ...c[product.id], inventoryUnitsPerPurchaseUnit: toNumber(e.target.value) ?? undefined } }))}
                              className="w-20 rounded border border-border bg-white px-2 py-1 font-num outline-none" />
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <input value={draft.quotedUnitPrice ?? ''} inputMode="decimal" aria-label="协议价"
                              onChange={e => setDrafts(c => ({ ...c, [product.id]: { ...c[product.id], quotedUnitPrice: toNumber(e.target.value) } }))}
                              className="w-24 rounded border border-border bg-white px-2 py-1 text-right font-num outline-none" placeholder="未谈价" />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-2.5 text-gray3">{product.purchaseUnit || product.unit}</td>
                          <td className="px-4 py-2.5 font-num text-gray3">×{product.inventoryUnitsPerPurchaseUnit ?? '?'}</td>
                          <td className="px-4 py-2.5 text-right font-num text-gray3">{product.price === null ? '—' : `¥${Number(product.price).toFixed(2)}`}</td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {tab === 'add' && selectedProducts.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-6 py-3">
            <b className="text-button">已选 {selectedProducts.length} 个</b>
            <span className="text-micro text-gray3">批量设置:</span>
            <input value={batchUnit} onChange={e => setBatchUnit(e.target.value)} placeholder="采购单位"
              className="w-24 rounded border border-border bg-bg px-2 py-1.5 text-caption outline-none" />
            <input value={batchPrice} onChange={e => setBatchPrice(e.target.value)} placeholder="协议价" inputMode="decimal"
              className="w-24 rounded border border-border bg-bg px-2 py-1.5 text-caption font-num outline-none" />
            <button onClick={applyBatchDefaults} className="rounded-cta border border-border bg-white px-3 py-1.5 text-caption">
              应用到已选
            </button>
            <div className="flex-1" />
            <button onClick={() => setChecked({})} className="text-caption text-gray2">清空选择</button>
            <button
              onClick={submitBind}
              disabled={saving}
              className="rounded-cta bg-accent px-5 py-2.5 text-button text-white disabled:opacity-40"
            >{saving ? '绑定中…' : `确认绑定 ${selectedProducts.length} 个商品`}</button>
          </div>
        </div>
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
