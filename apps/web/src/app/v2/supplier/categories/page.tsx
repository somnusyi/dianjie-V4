'use client'

import { useEffect, useMemo, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { ProductToolTabs } from '@/components/v2/product-tool-tabs'
import { clientRequestId } from '@/lib/client-id'
import { filterSupplierCategories } from '@/lib/supplier-category-filter'
import { apiFetch, getUser } from '@/lib/v2-auth'

type SupplierOption = { id: string; no: string; name: string }

type Category = {
  id: string | null
  name: string
  count: number
  sortOrder: number
  isActive: boolean
  isSystem: boolean
  defaultMarkupPercent: number | null
}

type ViewFilter = 'all' | 'active' | 'inactive'

export default function SupplierCategoriesPage() {
  const internalSupplyChain = getUser()?.role === 'SUPPLY_CHAIN'
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [selectedSupplierId, setSelectedSupplierId] = useState('')
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewFilter>('all')
  const [orderDirty, setOrderDirty] = useState(false)
  const [markupEditId, setMarkupEditId] = useState<string | null>(null)
  const [markupEditValue, setMarkupEditValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  function scopedPath(path: string) {
    if (!internalSupplyChain || !selectedSupplierId) return path
    return `${path}${path.includes('?') ? '&' : '?'}supplierId=${encodeURIComponent(selectedSupplierId)}`
  }

  async function load() {
    if (internalSupplyChain && !selectedSupplierId) return
    try {
      const rows = await apiFetch<Category[]>(scopedPath('/api/products/categories'))
      setCategories(filterSupplierCategories(Array.isArray(rows) ? rows : []))
      setOrderDirty(false)
      setError(null)
    } catch (e: any) {
      setError(e.message || '分类加载失败')
    }
  }

  useEffect(() => {
    if (!internalSupplyChain) return
    apiFetch<SupplierOption[]>('/api/suppliers?status=ENABLED')
      .then(rows => {
        const list = Array.isArray(rows) ? rows : []
        setSuppliers(list)
        if (list[0]) setSelectedSupplierId(list[0].id)
      })
      .catch(e => setError(e.message || '供应商加载失败'))
  }, [internalSupplyChain])
  useEffect(() => { void load() }, [internalSupplyChain, selectedSupplierId])

  const activeCount = categories?.filter(category => category.isActive).length || 0
  const inactiveCount = categories?.filter(category => !category.isActive).length || 0
  const skuCount = categories?.reduce((sum, category) => sum + category.count, 0) || 0
  const sourceCategory = categories?.find(category => category.id === mergeSourceId) || null
  const mergeTargets = categories?.filter(category =>
    category.id && category.id !== mergeSourceId && category.isActive
  ) || []
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (categories || []).filter(category => {
      if (view === 'active' && !category.isActive) return false
      if (view === 'inactive' && category.isActive) return false
      return !keyword || category.name.toLowerCase().includes(keyword)
    })
  }, [categories, query, view])
  const canReorder = view === 'all' && !query.trim()

  async function createCategory() {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true); setError(null)
    try {
      await apiFetch(scopedPath('/api/products/categories'), {
        method: 'POST', body: JSON.stringify({ name }),
        headers: { 'Idempotency-Key': clientRequestId() },
      })
      setNewName('')
      await load()
    } catch (e: any) {
      setError(e.message || '新增分类失败')
    } finally {
      setBusy(false)
    }
  }

  async function renameCategory(category: Category, name: string) {
    setBusy(true); setError(null)
    try {
      await apiFetch(scopedPath(`/api/products/categories/${category.id}`), {
        method: 'PATCH', body: JSON.stringify({ name }),
        headers: { 'Idempotency-Key': clientRequestId() },
      })
      setEditingId(null)
      await load()
    } catch (e: any) {
      setError(e.message || '分类改名失败')
      throw e
    } finally {
      setBusy(false)
    }
  }

  function requestRename(category: Category) {
    const name = editingName.trim()
    if (!category.id || !name || name === category.name || busy) {
      setEditingId(null)
      return
    }
    openConfirm({
      title: `确认改名为「${name}」？`,
      body: category.count > 0
        ? `该分类下有 ${category.count} 个 SKU。确认后，商品报价和库存会同步改为新分类名，历史操作记录保留。`
        : '该分类暂无 SKU，确认后立即改名。',
      confirmLabel: '确认改名',
      tone: 'primary',
      onConfirm: () => renameCategory(category, name),
    })
  }

  async function setCategoryActive(category: Category, isActive: boolean) {
    setBusy(true); setError(null)
    try {
      await apiFetch(scopedPath(`/api/products/categories/${category.id}`), {
        method: 'PATCH', body: JSON.stringify({ isActive }),
        headers: { 'Idempotency-Key': clientRequestId() },
      })
      await load()
    } catch (e: any) {
      setError(e.message || '分类状态修改失败')
      throw e
    } finally {
      setBusy(false)
    }
  }

  function requestToggle(category: Category) {
    if (!category.id || category.isSystem || busy) return
    const nextActive = !category.isActive
    openConfirm({
      title: nextActive ? `恢复「${category.name}」？` : `停用「${category.name}」？`,
      body: nextActive
        ? '恢复后，新建商品、导入和批量改类可以重新选用此分类。'
        : `现有 ${category.count} 个 SKU 和库存不会删除，但新建、导入和批量改类不能再选用。`,
      confirmLabel: nextActive ? '确认恢复' : '确认停用',
      tone: nextActive ? 'primary' : 'danger',
      onConfirm: () => setCategoryActive(category, nextActive),
    })
  }

  async function saveCategoryMarkup(category: Category) {
    if (!category.id || busy) return
    const trimmed = markupEditValue.trim()
    if (trimmed !== '' && !/^\d+(\.\d{1,2})?$/.test(trimmed)) {
      setError('加价比例必须是非负数字，最多两位小数；留空表示清除')
      return
    }
    const next = trimmed === '' ? null : Number(trimmed)
    if (next !== null && next > 1000) {
      setError('加价比例不能超过 1000%')
      return
    }
    setBusy(true); setError(null)
    try {
      await apiFetch(scopedPath(`/api/products/categories/${category.id}`), {
        method: 'PATCH', body: JSON.stringify({ defaultMarkupPercent: next }),
        headers: { 'Idempotency-Key': clientRequestId() },
      })
      setMarkupEditId(null)
      await load()
    } catch (e: any) {
      setError(e.message || '加价比例保存失败')
    } finally {
      setBusy(false)
    }
  }

  function move(index: number, direction: -1 | 1) {
    if (!categories || busy || !canReorder) return
    const target = index + direction
    if (target < 0 || target >= categories.length) return
    const next = [...categories]
    ;[next[index], next[target]] = [next[target], next[index]]
    setCategories(next)
    setOrderDirty(true)
  }

  async function saveOrder() {
    if (!categories || !orderDirty || busy) return
    const ids = categories.map(category => category.id).filter((id): id is string => !!id)
    if (ids.length !== categories.length) {
      setError('存在尚未纳入主数据的历史分类，请先刷新或执行分类迁移')
      return
    }
    setBusy(true); setError(null)
    try {
      await apiFetch(scopedPath('/api/products/categories-order'), {
        method: 'PATCH', body: JSON.stringify({ ids }),
        headers: { 'Idempotency-Key': clientRequestId() },
      })
      await load()
    } catch (e: any) {
      setError(e.message || '分类排序保存失败')
      await load()
    } finally {
      setBusy(false)
    }
  }

  function startMerge(category: Category) {
    setMergeSourceId(category.id)
    const firstTarget = (categories || []).find(item => item.id && item.id !== category.id && item.isActive)
    setMergeTargetId(firstTarget?.id || '')
    setError(null)
  }

  function requestMerge() {
    if (!sourceCategory?.id || !mergeTargetId || busy) return
    const target = categories?.find(category => category.id === mergeTargetId)
    if (!target) return
    openConfirm({
      title: `合并「${sourceCategory.name}」到「${target.name}」？`,
      body: `${sourceCategory.count} 个 SKU 将永久移动到目标分类，来源分类随后停用。此操作会记录审计日志，但不能一键撤销。`,
      confirmLabel: '确认合并',
      tone: 'danger',
      onConfirm: async () => {
        setBusy(true); setError(null)
        try {
          await apiFetch(scopedPath(`/api/products/categories/${sourceCategory.id}/merge`), {
            method: 'POST', body: JSON.stringify({ targetId: mergeTargetId }),
            headers: { 'Idempotency-Key': clientRequestId() },
          })
          setMergeSourceId(null)
          setMergeTargetId('')
          await load()
        } catch (e: any) {
          setError(e.message || '分类合并失败')
          throw e
        } finally {
          setBusy(false)
        }
      },
    })
  }

  return (
    <div className="min-h-screen bg-bg pb-24 lg:pb-6">
      <header className="flex flex-wrap items-center gap-3 px-4 pb-2 pt-4 lg:px-6 lg:pt-5">
        <a href={internalSupplyChain ? '/v2/supply-chain/products' : '/v2/supplier/products'} className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-white">‹</a>
        <div className="min-w-0 flex-1">
          <h1 className="text-h1">分类管理</h1>
          <p className="text-caption text-gray3">商品报价与默认仓库存共用同一分类口径</p>
        </div>
        {internalSupplyChain && (
          <select
            value={selectedSupplierId}
            onChange={event => setSelectedSupplierId(event.target.value)}
            className="h-10 min-w-64 rounded-cta border border-border bg-white px-3 text-body"
          >
            {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.no} · {supplier.name}</option>)}
          </select>
        )}
        <a href={internalSupplyChain ? '/v2/supply-chain/inventory' : '/v2/supplier/inventory'} className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2">查看库存</a>
      </header>

      {internalSupplyChain && <ProductToolTabs />}

      {error && <div className="mx-4 mt-3 rounded-cta bg-red-bg p-3 text-caption text-red-fg lg:mx-6">{error}</div>}

      <div className="mt-2 grid gap-4 px-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:px-6">
        <aside className="space-y-3">
          <section className="rounded-card border border-border bg-white p-4">
            <h2 className="text-h2">分类概况</h2>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Metric label="启用" value={activeCount} />
              <Metric label="停用" value={inactiveCount} />
              <Metric label="SKU" value={skuCount} />
            </div>
          </section>

          <section className="rounded-card border border-border bg-bg-card p-4">
            <h2 className="text-h2">新增分类</h2>
            <input
              value={newName}
              onChange={event => setNewName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void createCategory() }}
              maxLength={40}
              placeholder="如：蔬菜、冻品、调味料"
              className="mt-3 w-full rounded-cta border border-border bg-white px-3 py-2 text-body outline-none focus:border-accent"
            />
            <button
              onClick={() => void createCategory()}
              disabled={!newName.trim() || busy}
              className="mt-2 w-full rounded-cta bg-accent py-2 text-button text-white disabled:opacity-40"
            >新增分类</button>
            <p className="mt-2 text-micro text-gray3">分类会同步用于商品报价、库存筛选和导入校验。</p>
          </section>

          {sourceCategory && (
            <section className="rounded-card border border-orange/40 bg-orange/5 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-h2">合并分类</h2>
                <button onClick={() => setMergeSourceId(null)} className="text-caption text-gray3">取消</button>
              </div>
              <p className="mt-2 text-caption text-gray2">来源：<b>{sourceCategory.name}</b>（{sourceCategory.count} 个 SKU）</p>
              <label className="mt-3 block text-micro text-gray3">目标分类</label>
              <select
                value={mergeTargetId}
                onChange={event => setMergeTargetId(event.target.value)}
                className="mt-1 w-full rounded-cta border border-border bg-white px-3 py-2 text-body"
              >
                <option value="">请选择目标分类</option>
                {mergeTargets.map(category => <option key={category.id!} value={category.id!}>{category.name}</option>)}
              </select>
              <button
                onClick={requestMerge}
                disabled={!mergeTargetId || busy}
                className="mt-2 w-full rounded-cta border border-red bg-white py-2 text-button text-red-fg disabled:opacity-40"
              >预览并确认合并</button>
            </section>
          )}
        </aside>

        <section className="min-w-0">
          <div className="rounded-card border border-border bg-white p-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索分类"
                className="min-w-0 flex-1 rounded-cta border border-border bg-bg px-3 py-2 text-body outline-none focus:border-accent"
              />
              <div className="flex gap-1 rounded-cta bg-bg p-1">
                {([['all', '全部'], ['active', '启用'], ['inactive', '停用']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setView(key)}
                    className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-caption ${view === key ? 'bg-white text-ink shadow-sm' : 'text-gray3'}`}
                  >{label}</button>
                ))}
              </div>
              {orderDirty && (
                <button onClick={() => void saveOrder()} disabled={busy} className="rounded-cta bg-ink px-4 py-2 text-button text-white disabled:opacity-50">
                  保存排序
                </button>
              )}
            </div>
            <p className="mt-2 text-micro text-gray3">
              {canReorder ? '使用上下箭头调整顺序，完成后统一保存。' : '搜索或筛选状态下不调整排序。'}
            </p>
          </div>

          {categories === null && <div className="py-10 text-center text-caption text-gray3">加载中…</div>}
          {categories !== null && filtered.length === 0 && (
            <div className="mt-3 rounded-card border border-border bg-white p-10 text-center text-caption text-gray3">没有符合条件的分类</div>
          )}

          <ul className="mt-3 space-y-2">
            {filtered.map(category => {
              const index = categories?.findIndex(item => item.id === category.id) ?? -1
              return (
                <li key={category.id || category.name} className={`rounded-card border border-border bg-white p-3 ${category.isActive ? '' : 'opacity-65'}`}>
                  <div className="flex items-center gap-3">
                    <div className={`flex flex-col gap-1 ${canReorder ? '' : 'invisible'}`}>
                      <button onClick={() => move(index, -1)} disabled={index <= 0 || busy} className="h-6 w-7 rounded bg-bg text-gray2 disabled:opacity-20" aria-label={`上移 ${category.name}`}>↑</button>
                      <button onClick={() => move(index, 1)} disabled={index < 0 || index === (categories?.length || 0) - 1 || busy} className="h-6 w-7 rounded bg-bg text-gray2 disabled:opacity-20" aria-label={`下移 ${category.name}`}>↓</button>
                    </div>

                    <div className="min-w-0 flex-1">
                      {editingId === category.id ? (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            autoFocus value={editingName} maxLength={40}
                            onChange={event => setEditingName(event.target.value)}
                            onKeyDown={event => {
                              if (event.key === 'Enter') requestRename(category)
                              if (event.key === 'Escape') setEditingId(null)
                            }}
                            className="min-w-0 flex-1 rounded-cta border border-accent bg-bg px-2 py-1 text-body"
                          />
                          <button onClick={() => requestRename(category)} className="rounded-cta bg-accent px-3 py-1 text-button text-white">预览修改</button>
                          <button onClick={() => setEditingId(null)} className="px-2 text-caption text-gray3">取消</button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-h2">{category.name}</span>
                          {category.isSystem && <Chip tone="gray">系统</Chip>}
                          {!category.isActive && <Chip tone="gray">已停用</Chip>}
                          {category.defaultMarkupPercent != null && (
                            <Chip tone="orange">加价 {category.defaultMarkupPercent}%</Chip>
                          )}
                        </div>
                      )}
                      <div className="mt-1 text-caption text-gray3">{category.count} 个 SKU · 商品和库存同步归类</div>
                      {editingId !== category.id && markupEditId === category.id && (
                        <div className="mt-2">
                          <div className="flex items-center gap-2">
                            <input
                              autoFocus type="number" min="0" max="1000" step="0.1"
                              value={markupEditValue}
                              onChange={event => setMarkupEditValue(event.target.value)}
                              onKeyDown={event => {
                                if (event.key === 'Enter') void saveCategoryMarkup(category)
                                if (event.key === 'Escape') setMarkupEditId(null)
                              }}
                              placeholder="如 20；留空清除"
                              className="w-36 rounded-cta border border-accent bg-bg px-2 py-1 text-body"
                            />
                            <span className="text-caption text-gray3">%</span>
                            <button onClick={() => void saveCategoryMarkup(category)} disabled={busy} className="rounded-cta bg-accent px-3 py-1 text-button text-white disabled:opacity-40">保存</button>
                            <button onClick={() => setMarkupEditId(null)} className="px-2 text-caption text-gray3">取消</button>
                          </div>
                          <p className="mt-1 text-micro text-gray3">启用「比例加价」的商品按 库存均价 × (1+比例) 自动调价；商品自填比例优先于分类。</p>
                        </div>
                      )}
                    </div>

                    {!category.isSystem && category.id && editingId !== category.id && (
                      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
                        <button onClick={() => {
                          setMarkupEditId(null)
                          setEditingId(category.id)
                          setEditingName(category.name)
                        }} className="text-caption text-accent">改名</button>
                        {internalSupplyChain && (
                          <button
                            onClick={() => {
                              setEditingId(null)
                              setMarkupEditId(markupEditId === category.id ? null : category.id)
                              setMarkupEditValue(category.defaultMarkupPercent != null ? String(category.defaultMarkupPercent) : '')
                            }}
                            className="text-caption text-accent"
                          >比例</button>
                        )}
                        {category.isActive && <button onClick={() => startMerge(category)} className="text-caption text-orange-fg">合并</button>}
                        <button onClick={() => requestToggle(category)} className={`text-caption ${category.isActive ? 'text-red-fg' : 'text-green-fg'}`}>
                          {category.isActive ? '停用' : '恢复'}
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      <BottomNav
        tabs={[
          { key: 'home', label: '首页', icon: '⌂' },
          { key: 'orders', label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me', label: '我的', icon: '◐' },
        ]}
        activeKey="inventory"
        onChange={key => {
          if (key === 'home') location.href = internalSupplyChain ? '/v2/supply-chain/home' : '/v2/supplier/home'
          if (key === 'orders') location.href = internalSupplyChain ? '/v2/supply-chain/fulfillment' : '/v2/supplier/orders'
          if (key === 'inventory') location.href = internalSupplyChain ? '/v2/supply-chain/inventory' : '/v2/supplier/inventory'
          if (key === 'billing') location.href = internalSupplyChain ? '/v2/supply-chain/billing' : '/v2/supplier/billing'
          if (key === 'me') location.href = internalSupplyChain ? '/v2/me' : '/v2/supplier/history'
        }}
      />
      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-bg p-2 text-center">
      <div className="font-num text-h2">{value}</div>
      <div className="text-micro text-gray3">{label}</div>
    </div>
  )
}
