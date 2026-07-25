/**
 * 供应商 · 商品报价表
 *
 * 接 GET /api/products （后端按 supplierId 自动过滤）
 * 行内可改：单价 / 安全库存 / 状态
 * PATCH /api/products/:id { price, stock, minStock, status }
 */
'use client'
import { Fragment, useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { EmptyState, SkeletonCard, FriendlyError } from '@/components/v2/skeleton'
import { ProductFilterSidebar } from '@/components/v2/product-filter-sidebar'
import { ProductImagePreview } from '@/components/v2/product-image-preview'
import { apiDownload, apiFetch } from '@/lib/v2-auth'
import { downloadProductExport, saveBlob } from './export-products'

type Product = {
  id: string; code: string; name: string; category: string; unit: string
  spec?: string | null
  imageKey?: string | null; imageUrl?: string | null
  price: number | string; stock: number | string; minStock: number | string
  physicalStock?: number | string; reservedStock?: number | string; availableStock?: number | string
  minOrderQty?: number | string; stepQty?: number | string
  shipUpperPct?: number | string       // 实发上限百分比 (1.10 = 110%)
  shipUpperBuffer?: number | string    // 实发上限绝对加量 (单位件)
  status: string
}

type NewSku = {
  code: string; name: string; spec: string; category: string; unit: string
  imageKey: string
  price: string; shelfDays: string
  minOrderQty: string; stepQty: string
}
// 默认值跟报价模板对齐: 必填只有 名称 + 规格 + 单位 + 单价
// code 留空会自动生成 (供应商前缀+时间戳), category 缺省"其他"
const EMPTY_SKU: NewSku = { code: '', name: '', spec: '', category: '', unit: '件', imageKey: '', price: '', shelfDays: '7', minOrderQty: '1', stepQty: '1' }

type CategoryOption = {
  id?: string | null; name: string; count: number
  sortOrder?: number; isActive?: boolean; isSystem?: boolean
}
type HistoryRow = {
  id: string; action: string; operator: string; createdAt: string
  target?: string | null
}

type Batch = {
  id: string; filename: string | null
  totalRows: number; createdCount: number; failedCount: number
  revokedAt: string | null
  createdAt: string
  canRevoke?: boolean
  _count?: { products: number }
}

function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  const d = new Date(iso)
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`
}

function ProductStatusChip({ status }: { status: string }) {
  if (status === 'DISABLED') return <Chip tone="gray">已停售</Chip>
  if (status === 'PENDING_APPROVAL') return <Chip tone="orange">上架待审</Chip>
  if (status === 'PENDING_DISABLE') return <Chip tone="orange">停售待审</Chip>
  return <Chip tone="green">供应中</Chip>
}

export default function SupplierProductsPage() {
  const [tab, setTab] = useState('me')
  const [products, setProducts] = useState<Product[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  // 编辑草稿: 单价 + 规格 + 起订量 + 步长 (库存请到库存页)
  const [draft, setDraft] = useState<{ price: string; spec: string; moq: string; step: string; shipPct: string; shipBuf: string }>({ price: '', spec: '', moq: '', step: '', shipPct: '', shipBuf: '' })
  const [searchQ, setSearchQ] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmState, openConfirm] = useConfirmSheet()
  const [createOpen, setCreateOpen] = useState(false)
  const [newSku, setNewSku] = useState<NewSku>(EMPTY_SKU)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [batches, setBatches] = useState<Batch[] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [categoryFilter, setCategoryFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkCategory, setBulkCategory] = useState('')
  const [operations, setOperations] = useState<HistoryRow[]>([])
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null)

  function load() {
    apiFetch<Product[]>('/api/products')
      .then(d => setProducts(Array.isArray(d) ? d : []))
      .catch(e => setError(String(e?.message || e)))
    apiFetch<Batch[]>('/api/products/batches')
      .then(d => setBatches(Array.isArray(d) ? d : []))
      .catch(() => setBatches([]))
    apiFetch<CategoryOption[]>('/api/products/categories')
      .then(d => setCategories(Array.isArray(d) ? d : []))
      .catch(() => setCategories([]))
    apiFetch<HistoryRow[]>('/api/products/history?limit=50')
      .then(d => setOperations(Array.isArray(d) ? d : []))
      .catch(() => setOperations([]))
  }
  useEffect(() => { load() }, [])

  async function handleExport() {
    if (exporting) return
    setExporting(true)
    setExportError(null)
    try {
      await downloadProductExport(apiDownload, saveBlob, searchQ, categoryFilter, statusFilter)
    } catch (reason: any) {
      setExportError(reason?.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  function revokeBatch(b: Batch) {
    openConfirm({
      title: `撤回这次上传?`,
      body: `${b.filename || '(未命名)'} · 上架 ${b.createdCount} 个商品\n撤回后会停止供应该批次商品，但商品、订单和库存历史会永久保留。`,
      confirmLabel: '撤回',
      tone: 'danger',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/products/batches/${b.id}/revoke`, { method: 'PATCH' })
          load()
        } catch (e: any) { alert(e.message || '撤回失败'); throw e }
      },
    })
  }

  function startEdit(p: Product) {
    setEditing(p.id)
    setDraft({
      price: String(p.price),
      spec: String(p.spec || ''),
      moq: String(p.minOrderQty ?? 1),
      step: String(p.stepQty ?? 1),
      shipPct: String(p.shipUpperPct ?? 1.10),
      shipBuf: String(p.shipUpperBuffer ?? 5),
    })
  }
  function cancelEdit() {
    setEditing(null)
  }
  async function save(p: Product) {
    if (submitting) return
    const newPrice = Number(draft.price)
    const newSpec  = draft.spec.trim()
    const newMoq   = Number(draft.moq) || 1
    // step 取消独立配置, 强制 = moq (用户感知"起订量"就是"递增单位")
    const newStep  = newMoq
    const newShipPct = Math.max(1, Math.min(10, Number(draft.shipPct) || 1.10))    // 钳制 [1, 10] (100%-1000%)
    const newShipBuf = Math.max(0, Math.min(10000, Number(draft.shipBuf) || 0))    // 钳制 [0, 10000]
    const oldPrice = Number(p.price)
    const priceChanged = Math.abs(newPrice - oldPrice) > 0.01
    const specChanged  = newSpec !== String(p.spec || '').trim()
    const moqChanged   = Math.abs(newMoq - Number(p.minOrderQty ?? 1)) > 0.001
    const stepChanged  = Math.abs(newStep - Number(p.stepQty ?? 1)) > 0.001
    const shipPctChanged = Math.abs(newShipPct - Number(p.shipUpperPct ?? 1.10)) > 0.001
    const shipBufChanged = Math.abs(newShipBuf - Number(p.shipUpperBuffer ?? 5)) > 0.001
    if (!priceChanged && !specChanged && !moqChanged && !stepChanged && !shipPctChanged && !shipBufChanged) { setEditing(null); return }
    const isUp = priceChanged && newPrice > oldPrice && oldPrice > 0

    // 所有字段一次提交给后端：涨价审批单与其他字段在同一数据库事务内创建/保存，
    // 避免“商品资料已保存、调价申请失败”的半成功状态。
    const updateBody: any = {}
    if (priceChanged)   updateBody.price = newPrice
    if (specChanged)    updateBody.spec = newSpec || null
    if (moqChanged)     updateBody.minOrderQty = newMoq
    if (stepChanged)    updateBody.stepQty = newStep
    if (shipPctChanged) updateBody.shipUpperPct = newShipPct
    if (shipBufChanged) updateBody.shipUpperBuffer = newShipBuf

    const summary: string[] = []
    if (priceChanged)    summary.push(`单价 ¥${oldPrice.toFixed(2)} → ¥${newPrice.toFixed(2)}${isUp ? ' ⚠涨价审批' : ''}`)
    if (specChanged)     summary.push(`规格 「${p.spec || '空'}」→「${newSpec || '空'}」`)
    if (moqChanged)      summary.push(`起订量 ${p.minOrderQty ?? 1} → ${newMoq}`)
    if (shipPctChanged)  summary.push(`实发百分比上限 ${Number(p.shipUpperPct ?? 1.10).toFixed(2)} → ${newShipPct.toFixed(2)} (${(newShipPct*100).toFixed(0)}%)`)
    if (shipBufChanged)  summary.push(`实发加量上限 ${Number(p.shipUpperBuffer ?? 5)} → ${newShipBuf} ${p.unit}`)

    openConfirm({
      title: `修改「${p.name}」`,
      body: summary.join('\n') + (isUp ? '\n\n⚠ 本次修改将一次提交；其他资料立即生效，涨价需总厨审批后生效。' : '\n\n✓ 立即生效, 无需审批.'),
      confirmLabel: isUp ? '提交' : '保存',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          const res: any = await apiFetch(`/api/products/${p.id}`, {
            method: 'PATCH',
            body: JSON.stringify(updateBody),
          })
          const approvalMsg = res?.priceChangeStatus === 'PENDING_APPROVAL'
            ? `\n⏳ 涨价单 ${res.documentNo} 已提交总厨审批`
            : ''
          setEditing(null)
          alert('✓ 已保存' + approvalMsg)
          load()
        } catch (e: any) {
          alert(e.message || '保存失败'); throw e
        } finally { setSubmitting(false) }
      },
    })
  }
  async function toggleStatus(p: Product) {
    const next = p.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    openConfirm({
      title: next === 'ENABLED' ? `恢复供应「${p.name}」?` : `停止供应「${p.name}」?`,
      body: next === 'DISABLED' ? '停止后餐厅下单时不会显示此商品' : '恢复后餐厅可重新下单',
      confirmLabel: next === 'ENABLED' ? '恢复' : '停止',
      tone: next === 'ENABLED' ? 'primary' : 'danger',
      onConfirm: async () => {
        try {
          const res: any = await apiFetch(`/api/products/${p.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: next }),
          })
          if (res?.statusChange === 'PENDING_APPROVAL') {
            alert(`✓ 停售申请已提交总厨审批 (单号 ${res.documentNo})`)
          }
          load()
        } catch (e: any) { alert(e.message || '操作失败'); throw e }
      },
    })
  }

  // 模糊搜索 (名称 / 规格 / 编码) + 按 category 分组
  function matches(p: Product, q: string) {
    if (!q.trim()) return true
    const hay = `${p.name} ${p.spec || ''} ${p.code}`.toLowerCase()
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))
  }
  const filtered = (products || []).filter(p =>
    matches(p, searchQ) &&
    (!categoryFilter || p.category === categoryFilter) &&
    (!statusFilter || p.status === statusFilter)
  )
  const byCat: Record<string, Product[]> = {}
  filtered.forEach(p => { (byCat[p.category] = byCat[p.category] || []).push(p) })
  const categoryOrder = new Map(categories.map((category, index) => [category.name, category.sortOrder ?? index]))
  const categorySections = Object.entries(byCat).sort(([a], [b]) =>
    (categoryOrder.get(a) ?? 9999) - (categoryOrder.get(b) ?? 9999) || a.localeCompare(b, 'zh-CN')
  )
  const activeCategories = categories.filter(category => category.isActive !== false)
  const desktopRows = [...filtered].sort((left, right) =>
    (categoryOrder.get(left.category) ?? 9999) - (categoryOrder.get(right.category) ?? 9999)
      || left.name.localeCompare(right.name, 'zh-CN')
  )

  function openCreate() {
    setNewSku(EMPTY_SKU)
    setCreateErr(null)
    setCreateOpen(true)
  }

  function toggleSelected(id: string) {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function uploadProductImage(product: Product | null, file: File) {
    const target = product?.id || 'new'
    setUploadingId(target)
    try {
      const form = new FormData()
      form.append('file', file)
      const uploaded: any = await apiFetch('/api/upload?category=products', { method: 'POST', body: form })
      if (product) {
        await apiFetch(`/api/products/${product.id}`, {
          method: 'PATCH', body: JSON.stringify({ imageKey: uploaded.key }),
        })
        load()
      } else {
        setNewSku(current => ({ ...current, imageKey: uploaded.key }))
      }
    } catch (e: any) {
      alert(e.message || '图片上传失败')
    } finally {
      setUploadingId(null)
    }
  }

  function batchChangeCategory() {
    if (selected.size === 0 || !bulkCategory.trim()) return
    openConfirm({
      title: `修改 ${selected.size} 个商品分类?`,
      body: `统一改为「${bulkCategory.trim()}」，操作记录会永久保留。`,
      confirmLabel: '确认修改', tone: 'primary',
      onConfirm: async () => {
        await apiFetch('/api/products/batch-category', {
          method: 'PATCH',
          body: JSON.stringify({ ids: [...selected], category: bulkCategory.trim() }),
        })
        setSelected(new Set()); setBulkCategory(''); load()
      },
    })
  }

  async function batchChangeStatus(status: 'ENABLED' | 'DISABLED') {
    if (selected.size === 0) return
    let impact: {
      impacted: number; alreadyInTargetStatus: number
      activeReservationSku: number; activeReservationQty: number
      recent28DayOrders: number; physicalStockValue: number
    }
    try {
      impact = await apiFetch('/api/products/batch-status/preview', {
        method: 'POST', body: JSON.stringify({ ids: [...selected], status }),
      })
    } catch (error: any) {
      alert(error?.message || '影响范围预览失败')
      return
    }
    const impactSummary = [
      `实际影响 ${impact.impacted} 个 SKU，已有 ${impact.alreadyInTargetStatus} 个无需变更。`,
      `当前库存货值 ¥${impact.physicalStockValue.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}。`,
      impact.activeReservationSku > 0
        ? `其中 ${impact.activeReservationSku} 个 SKU 已被订单占用，共 ${impact.activeReservationQty}；现有订单仍会继续履约。`
        : '当前没有有效订单预占。',
      `近 28 天涉及 ${impact.recent28DayOrders} 张订货单。`,
    ].join('\n')
    openConfirm({
      title: `${status === 'DISABLED' ? '批量停售' : '批量恢复'} ${selected.size} 个商品?`,
      body: status === 'DISABLED'
        ? `${impactSummary}\n\n将生成一张批量停售审批单，总厨批准后生效。`
        : `${impactSummary}\n\n所选已停售商品将恢复供应，完整操作记录会保留。`,
      confirmLabel: status === 'DISABLED' ? '提交审批' : '确认恢复',
      tone: status === 'DISABLED' ? 'danger' : 'primary',
      onConfirm: async () => {
        const res: any = await apiFetch('/api/products/batch-status', {
          method: 'PATCH', body: JSON.stringify({ ids: [...selected], status }),
        })
        if (res?.documentNo) alert(`✓ 已提交审批单 ${res.documentNo}`)
        setSelected(new Set()); load()
      },
    })
  }

  async function submitNew() {
    if (submitting) return
    // 必填: 名称 + 单价 (跟报价模板一致). code 留空后端自动生成, category 默认"其他"
    if (!newSku.name.trim() || !newSku.price) {
      setCreateErr('品项名称 + 金额 必填'); return
    }
    setCreateErr(null); setSubmitting(true)
    try {
      const body: any = {
        name: newSku.name.trim(),
        unit: newSku.unit.trim() || '件',
        price: Number(newSku.price),
        shelfDays: Number(newSku.shelfDays) || 7,
        minOrderQty: Number(newSku.minOrderQty) || 1,
        stepQty: Number(newSku.stepQty) || 1,
      }
      if (newSku.code.trim()) body.code = newSku.code.trim()
      if (newSku.spec.trim()) body.spec = newSku.spec.trim()
      if (newSku.category.trim()) body.category = newSku.category.trim()
      if (newSku.imageKey) body.imageKey = newSku.imageKey
      await apiFetch('/api/products', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setCreateOpen(false)
      alert('✓ 新建 SKU 已提交总厨审批, 通过后才会上架显示给餐厅')
      load()
    } catch (e: any) {
      setCreateErr(e.message || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">商品报价表</h1>
          <p className="text-caption text-gray3">
            {products ? `${products.length} SKU · ${Object.keys(byCat).length} 类` : '加载中…'}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <a
            href="/v2/supplier/categories"
            className="px-2 py-2 bg-white border border-border rounded-cta text-caption text-gray2"
          >分类管理</a>
          <button
            onClick={() => setOperationsOpen(v => !v)}
            className="px-2 py-2 bg-white border border-border rounded-cta text-caption text-gray2"
          >操作记录</button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2 disabled:opacity-50"
          >{exporting ? '导出中…' : '⤓ 导出当前结果'}</button>
          <a
            href="/v2/supplier/products/upload"
            className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2"
          >⤒ 批量上传</a>
          <button
            onClick={openCreate}
            className="px-3 py-2 bg-accent text-white rounded-cta text-button"
          >+ 新建 SKU</button>
        </div>
      </header>

      {exportError && (
        <div className="px-4 mt-2">
          <p className="text-caption text-red-fg">导出失败：{exportError}</p>
        </div>
      )}

      <p className="px-4 mt-1 text-micro text-gray3">点商品行可改单价 / 规格 / 起订量 · 涨价走总厨审批 · 库存请去「库存」页</p>

      <div className="lg:grid lg:grid-cols-[14rem_1fr] lg:gap-5">
        <ProductFilterSidebar
          products={products || []}
          categories={categories}
          categoryFilter={categoryFilter}
          statusFilter={statusFilter}
          onCategoryChange={setCategoryFilter}
          onStatusChange={setStatusFilter}
          onClear={() => { setCategoryFilter(''); setStatusFilter('') }}
        />
        <div className="min-w-0">
          {/* 搜索框 */}
      {products && products.length > 0 && (
        <div className="px-4 mt-2">
          <div className="relative">
            <input
              type="search"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="搜索 名称 / 规格 / 编码 (空格分隔多关键字)"
              className="w-full bg-bg-card border border-border rounded-cta pl-9 pr-9 py-2 text-body outline-none"
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray3 text-caption">🔍</span>
            {searchQ && (
              <button
                type="button"
                onClick={() => setSearchQ('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray5 text-gray2 text-caption flex items-center justify-center"
                aria-label="清除"
              >×</button>
            )}
          </div>
          {searchQ && (
            <p className="text-micro text-gray3 mt-1">{filtered.length} / {products.length} 命中</p>
          )}
          <div className="grid grid-cols-2 gap-2 mt-2 lg:hidden">
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className={INPUT_CLS}>
              <option value="">全部分类</option>
              {categories.map(category => <option key={category.name} value={category.name}>{category.name} ({category.count})</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={INPUT_CLS}>
              <option value="">全部状态</option>
              <option value="ENABLED">供应中</option>
              <option value="PENDING_APPROVAL">上架待审</option>
              <option value="PENDING_DISABLE">停售待审</option>
              <option value="DISABLED">已停售</option>
            </select>
          </div>
        </div>
      )}

      {operationsOpen && (
        <div className="px-4 mt-3">
          <div className="bg-bg-card border border-border rounded-card p-3">
            <div className="text-h2 mb-2">最近操作</div>
            {operations.length === 0 && <p className="text-caption text-gray3">暂无商品操作记录</p>}
            <ul className="space-y-2 max-h-64 overflow-y-auto">
              {operations.map(row => (
                <li key={row.id} className="border-b border-border/60 pb-2 last:border-0">
                  <div className="text-caption text-ink">{row.action}</div>
                  <div className="text-micro text-gray3 mt-0.5">{row.operator} · {new Date(row.createdAt).toLocaleString('zh-CN')}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {products && products.length > 0 && (
        <div className="px-4 mt-3">
          <div className="bg-bg-card border border-border rounded-card p-3">
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-caption text-gray2">
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && filtered.every(product => selected.has(product.id))}
                  onChange={e => setSelected(e.target.checked ? new Set(filtered.map(product => product.id)) : new Set())}
                />
                选择当前 {filtered.length} 项
              </label>
              <span className="ml-auto text-caption text-accent">已选 {selected.size}</span>
            </div>
            {selected.size > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <select value={bulkCategory} onChange={e => setBulkCategory(e.target.value)} className={INPUT_CLS}>
                  <option value="">选择新分类</option>
                  {activeCategories.map(category => <option key={category.name} value={category.name}>{category.name}</option>)}
                </select>
                <button onClick={batchChangeCategory} disabled={!bulkCategory} className="rounded-cta bg-white border border-border text-button disabled:opacity-40">批量改类</button>
                <button onClick={() => batchChangeStatus('DISABLED')} className="py-2 rounded-cta bg-red-bg text-red-fg text-button">批量停售</button>
                <button onClick={() => batchChangeStatus('ENABLED')} className="py-2 rounded-cta bg-green-bg text-green-fg text-button">批量恢复</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 上传历史 toggle */}
      {(batches?.length ?? 0) > 0 && (
        <div className="px-4 mt-3">
          <button
            onClick={() => setHistoryOpen(v => !v)}
            className="w-full flex items-center justify-between bg-bg-card border border-border rounded-card p-3"
          >
            <span className="text-button">📋 上传历史 <span className="text-caption text-gray3">({batches!.length})</span></span>
            <span className="text-gray3">{historyOpen ? '▾' : '▸'}</span>
          </button>
          {historyOpen && (
            <ul className="mt-2 space-y-2">
              {batches!.map(b => {
                const revoked = !!b.revokedAt
                return (
                  <li key={b.id} className={`bg-bg-card border border-border rounded-card p-3 ${revoked ? 'opacity-60' : ''}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-caption text-gray2 truncate flex-1">{b.filename || '(未命名)'}</span>
                      <span className="text-micro text-gray3">{timeAgo(b.createdAt)}</span>
                      {revoked && <Chip tone="gray">已撤回</Chip>}
                    </div>
                    <div className="flex items-center gap-3 text-caption text-gray3">
                      <span>共 {b.totalRows} 行</span>
                      <span className="text-green-fg">✓ {b.createdCount} 上架</span>
                      {b.failedCount > 0 && <span className="text-red-fg">✗ {b.failedCount} 失败</span>}
                      <span className="ml-auto">现存 {b._count?.products ?? '?'} SKU</span>
                    </div>
                    {!revoked && b.canRevoke !== false && (b._count?.products ?? 0) > 0 && (
                      <button
                        onClick={() => revokeBatch(b)}
                        className="mt-2 text-caption text-red-fg"
                      >↶ 撤回这次上传</button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {error && <div className="px-4 mt-3"><FriendlyError message={error} /></div>}
      {!products && !error && (
        <div className="px-4 mt-3 space-y-2">{[1,2,3].map(i => <SkeletonCard key={i} />)}</div>
      )}
      {products && products.length === 0 && (
        <div className="px-4 mt-4">
          <EmptyState icon="📋" title="还没有上架商品" hint="联系平台运营开通商品" />
        </div>
      )}

      {products && products.length > 0 && (
        <section className="hidden lg:block px-4 mt-4">
          <div className="overflow-hidden rounded-card border border-border bg-bg-card">
            <table className="w-full table-fixed text-caption">
              <thead className="bg-bg text-gray2">
                <tr className="border-b border-border text-left">
                  <th className="w-11 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={desktopRows.length > 0 && desktopRows.every(product => selected.has(product.id))}
                      onChange={event => setSelected(event.target.checked ? new Set(desktopRows.map(product => product.id)) : new Set())}
                      aria-label="选择当前筛选商品"
                    />
                  </th>
                  <th className="w-[30%] px-3 py-3 font-medium">商品 / SKU</th>
                  <th className="w-[13%] px-3 py-3 font-medium">分类</th>
                  <th className="w-[13%] px-3 py-3 font-medium text-right">报价</th>
                  <th className="w-[11%] px-3 py-3 font-medium text-right">起订量</th>
                  <th className="w-[13%] px-3 py-3 font-medium text-right">可用库存</th>
                  <th className="w-[11%] px-3 py-3 font-medium">状态</th>
                  <th className="w-32 px-3 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {desktopRows.map(product => {
                  const isEdit = editing === product.id
                  const available = Number(product.availableStock ?? product.stock ?? 0)
                  const reserved = Number(product.reservedStock ?? 0)
                  return (
                    <Fragment key={product.id}>
                      <tr className={selected.has(product.id) ? 'bg-accent/5' : 'hover:bg-bg/60'}>
                        <td className="px-3 py-3 align-middle">
                          <input type="checkbox" checked={selected.has(product.id)} onChange={() => toggleSelected(product.id)} aria-label={`选择 ${product.name}`} />
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <div className="flex min-w-0 items-center gap-3">
                            {product.imageUrl
                              ? (
                                <button
                                  type="button"
                                  onClick={() => setPreviewImage({ url: product.imageUrl!, name: product.name })}
                                  className="shrink-0 p-0 border-0 bg-transparent"
                                  aria-label={`查看 ${product.name} 大图`}
                                >
                                  <img src={product.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-chip border border-border object-cover" />
                                </button>
                              )
                              : <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-chip border border-border bg-bg text-gray3">图</div>}
                            <div className="min-w-0">
                              <div className="truncate font-medium text-ink">{product.name}</div>
                              <div className="truncate text-micro text-gray3">#{product.code}{product.spec ? ` · ${product.spec}` : ''}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 align-middle text-gray2">{product.category || '其他'}</td>
                        <td className="px-3 py-3 text-right align-middle font-num">¥{Number(product.price).toFixed(2)}<span className="ml-1 text-micro text-gray3">/{product.unit}</span></td>
                        <td className="px-3 py-3 text-right align-middle font-num">{Number(product.minOrderQty ?? 1)} {product.unit}</td>
                        <td className="px-3 py-3 text-right align-middle">
                          <div className={`font-num ${available <= Number(product.minStock || 0) ? 'text-red-fg' : 'text-ink'}`}>{available.toLocaleString('zh-CN')} {product.unit}</div>
                          {reserved > 0 && <div className="text-micro text-gray3">已占 {reserved.toLocaleString('zh-CN')}</div>}
                        </td>
                        <td className="px-3 py-3 align-middle"><ProductStatusChip status={product.status} /></td>
                        <td className="px-3 py-3 align-middle">
                          <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                            <button type="button" onClick={() => isEdit ? cancelEdit() : startEdit(product)} className="text-accent">{isEdit ? '收起' : '编辑'}</button>
                            {product.status === 'ENABLED' && <button type="button" onClick={() => toggleStatus(product)} className="text-red-fg">停售</button>}
                            {product.status === 'DISABLED' && <button type="button" onClick={() => toggleStatus(product)} className="text-green-fg">恢复</button>}
                          </div>
                        </td>
                      </tr>
                      {isEdit && (
                        <tr className="bg-bg/60">
                          <td colSpan={8} className="px-5 py-4">
                            <div className="grid grid-cols-6 gap-3">
                              <Field label="单价 (¥)"><input type="number" step="0.01" min="0" value={draft.price} onChange={event => setDraft({ ...draft, price: event.target.value })} className={INPUT_CLS} /></Field>
                              <Field label="规格"><input type="text" value={draft.spec} maxLength={80} onChange={event => setDraft({ ...draft, spec: event.target.value })} className={INPUT_CLS} /></Field>
                              <Field label={`起订量 (${product.unit})`}><input type="number" step="0.01" min="0.01" value={draft.moq} onChange={event => setDraft({ ...draft, moq: event.target.value })} className={INPUT_CLS} /></Field>
                              <Field label="实发百分比上限"><input type="number" step="0.01" min="1" max="10" value={draft.shipPct} onChange={event => setDraft({ ...draft, shipPct: event.target.value })} className={INPUT_CLS} /></Field>
                              <Field label={`实发加量上限 (${product.unit})`}><input type="number" step="0.01" min="0" max="10000" value={draft.shipBuf} onChange={event => setDraft({ ...draft, shipBuf: event.target.value })} className={INPUT_CLS} /></Field>
                              <div className="flex items-end justify-end gap-2">
                                <label className="cursor-pointer px-3 py-2 text-button text-accent">
                                  {uploadingId === product.id ? '上传中…' : '更换图片'}
                                  <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={uploadingId === product.id} onChange={event => { const file = event.target.files?.[0]; if (file) void uploadProductImage(product, file); event.target.value = '' }} />
                                </label>
                                <button type="button" onClick={cancelEdit} className="px-3 py-2 text-button text-gray3">取消</button>
                                <button type="button" onClick={() => save(product)} disabled={submitting} className="rounded-cta bg-accent px-4 py-2 text-button text-white disabled:opacity-50">保存</button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
            {desktopRows.length === 0 && <div className="p-10 text-center text-caption text-gray3">当前筛选条件没有商品</div>}
          </div>
        </section>
      )}

      <div className="lg:hidden">
      {products && categorySections.map(([cat, items]) => (
        <section key={cat} className="px-4 mt-4">
          <h2 className="text-h2 mb-2">{cat}<span className="text-caption text-gray3 ml-2">({items.length})</span></h2>
          <ul className="bg-bg-card rounded-card border border-border divide-y divide-border">
            {items.map(p => {
              const isEdit = editing === p.id
              return (
                <li key={p.id} className="px-3 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelected(p.id)}
                      aria-label={`选择 ${p.name}`}
                    />
                    {p.imageUrl ? (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); setPreviewImage({ url: p.imageUrl!, name: p.name }) }}
                        className="shrink-0 p-0 border-0 bg-transparent"
                        aria-label={`查看 ${p.name} 大图`}
                      >
                        <img src={p.imageUrl} alt="" className="w-10 h-10 rounded-chip object-cover border border-border" />
                      </button>
                    ) : (
                      <div className="w-10 h-10 rounded-chip bg-bg border border-border flex items-center justify-center text-gray3">图</div>
                    )}
                    <span className="text-h2 truncate flex-1">{p.name}</span>
                    {p.status === 'DISABLED' && <Chip tone="gray">已停售</Chip>}
                    {p.status === 'PENDING_APPROVAL' && <Chip tone="orange">待审核</Chip>}
                    {p.status === 'PENDING_DISABLE' && <Chip tone="orange">停售待审</Chip>}
                    <span className="text-micro text-gray3 font-num">#{p.code}</span>
                  </div>
                  {isEdit ? (
                    <div className="mt-2 space-y-2 bg-bg/40 rounded-cta p-2 border border-border">
                      <div className="flex items-center gap-2">
                        <label className="text-micro text-gray3 w-12">单价</label>
                        <span className="text-gray3 text-caption">¥</span>
                        <input type="number" step="0.01" min="0" value={draft.price}
                          onChange={e => setDraft({ ...draft, price: e.target.value })}
                          className="flex-1 bg-white rounded-chip px-2 py-1 font-num border border-border" />
                        <span className="text-micro text-gray3">/ {p.unit}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-micro text-gray3 w-12">规格</label>
                        <input type="text" value={draft.spec} maxLength={80}
                          onChange={e => setDraft({ ...draft, spec: e.target.value })}
                          placeholder="如 980ml/瓶 · 5kg/件"
                          className="flex-1 bg-white rounded-chip px-2 py-1 text-caption border border-border" />
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-micro text-gray3 w-12">起订</label>
                        <input type="number" step="0.01" min="0.01" value={draft.moq}
                          onChange={e => setDraft({ ...draft, moq: e.target.value })}
                          className="w-24 bg-white rounded-chip px-2 py-1 font-num border border-border text-right" />
                        <span className="text-micro text-gray3">{p.unit}</span>
                      </div>
                      {/* 实发量上限配置 (per-product, 2026-05-28 戊方案) */}
                      <div className="border-t border-border pt-2">
                        <div className="text-micro text-gray3 mb-1.5">实发量上限 (称重 / 库存浮动允许的弹性)</div>
                        <div className="flex items-center gap-2">
                          <label className="text-micro text-gray3 w-12">百分比</label>
                          <input type="number" step="0.01" min="1" max="10" value={draft.shipPct}
                            onChange={e => setDraft({ ...draft, shipPct: e.target.value })}
                            className="w-20 bg-white rounded-chip px-2 py-1 font-num border border-border text-right" />
                          <span className="text-micro text-gray3">× 下单 ({(Number(draft.shipPct) || 1.1) * 100 | 0}%)</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <label className="text-micro text-gray3 w-12">加量</label>
                          <input type="number" step="0.01" min="0" max="10000" value={draft.shipBuf}
                            onChange={e => setDraft({ ...draft, shipBuf: e.target.value })}
                            className="w-20 bg-white rounded-chip px-2 py-1 font-num border border-border text-right" />
                          <span className="text-micro text-gray3">{p.unit} 以内</span>
                        </div>
                        <p className="text-micro text-gray3 mt-1.5">
                          上限 = max(下单×百分比, 下单+加量) · 默认 1.10 / 5 ·
                          示例: 下单 1 → 上限 {Math.max((Number(draft.shipPct) || 1.1), 1 + (Number(draft.shipBuf) || 5)).toFixed(2)}{p.unit}
                        </p>
                      </div>
                      <div className="flex items-center justify-end gap-2 pt-1">
                        <button onClick={cancelEdit} className="px-3 py-1 text-gray3 text-button">取消</button>
                        <button onClick={() => save(p)} disabled={submitting}
                                className="px-4 py-1 bg-accent text-white rounded-cta text-button">保存</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => startEdit(p)} className="block w-full text-left mt-1">
                      <div className="flex items-center gap-3 text-caption">
                        <span className="text-gray2">
                          ¥<span className="font-num text-ink">{Number(p.price).toFixed(2)}</span>
                          <span className="text-gray3">/{p.unit}</span>
                          {Number(p.minOrderQty || 1) > 1 && (
                            <span className="ml-2 text-micro text-amber-fg">起订 {Number(p.minOrderQty)}</span>
                          )}
                        </span>
                        {p.spec && <span className="text-micro text-gray3 truncate">· {p.spec}</span>}
                        <span className="ml-auto flex items-center gap-2">
                          <label onClick={e => e.stopPropagation()} className="text-caption text-accent cursor-pointer">
                            {uploadingId === p.id ? '上传中…' : '图片'}
                            <input
                              type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                              disabled={uploadingId === p.id}
                              onChange={e => {
                                const file = e.target.files?.[0]
                                if (file) void uploadProductImage(p, file)
                                e.target.value = ''
                              }}
                            />
                          </label>
                          {p.status === 'ENABLED' && (
                            <span onClick={(e) => { e.stopPropagation(); toggleStatus(p) }}
                                  className="text-caption text-accent cursor-pointer">停售</span>
                          )}
                          {p.status === 'DISABLED' && (
                            <span onClick={(e) => { e.stopPropagation(); toggleStatus(p) }}
                                  className="text-caption text-accent cursor-pointer">恢复</span>
                          )}
                          {(p.status === 'PENDING_APPROVAL' || p.status === 'PENDING_DISABLE') && (
                            <span className="text-caption text-amber-fg">审批中…</span>
                          )}
                        </span>
                      </div>
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      </div>
        </div>
      </div>

      <BottomNav
        tabs={[
          { key: 'home',    label: '首页', icon: '⌂' },
          { key: 'orders',  label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me',      label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')    location.href = '/v2/supplier/home'
          if (k === 'orders')  location.href = '/v2/supplier/orders'
          if (k === 'inventory') location.href = '/v2/supplier/inventory'
          if (k === 'billing') location.href = '/v2/supplier/billing'
        }}
      />
      <ConfirmSheet {...confirmState} />
      <ProductImagePreview
        src={previewImage?.url ?? null}
        alt={previewImage?.name ?? ''}
        isOpen={!!previewImage}
        onClose={() => setPreviewImage(null)}
      />

      {/* 新建 SKU sheet */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40" onClick={() => setCreateOpen(false)}>
          <div className="bg-bg-card w-full max-w-md rounded-t-2xl p-5 max-h-[90vh] overflow-y-auto"
               style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom))' }}
               onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />
            <h3 className="text-h2 text-ink">新建 SKU</h3>
            <p className="text-micro text-gray3 mt-1">上架审批通过后餐厅可下单；库存请到「库存」页维护</p>

            <div className="grid grid-cols-2 gap-3 mt-4">
              <div className="col-span-2">
                <label className="text-micro text-gray3 block mb-1">商品主图</label>
                <label className="flex items-center justify-center gap-2 h-20 rounded-cta border-2 border-dashed border-border bg-bg cursor-pointer text-caption text-gray2">
                  {uploadingId === 'new' ? '上传中…' : newSku.imageKey ? '✓ 图片已上传，可重新选择' : '选择 JPG / PNG / WebP'}
                  <input
                    type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                    disabled={uploadingId === 'new'}
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) void uploadProductImage(null, file)
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
              {/* —— 报价模板必填的 4 项 —— */}
              <Field label="品项名称 *">
                <input value={newSku.name} onChange={e => setNewSku({...newSku, name: e.target.value})}
                       placeholder="例: 见手青啤酒" className={INPUT_CLS} />
              </Field>
              <Field label="规格型号">
                <input value={newSku.spec} onChange={e => setNewSku({...newSku, spec: e.target.value})}
                       placeholder="例: 24瓶*330ml/件" className={INPUT_CLS} />
              </Field>
              <Field label="采购单位 *">
                {/* 计量单位下拉 — 防止 "5kg" "2包起订" 等脏数据 */}
                <select value={['件','箱','袋','包','瓶','罐','盒','支','个','片','双','只','份','串','台','块','kg','g','斤','升','ml','L'].includes(newSku.unit) ? newSku.unit : '__other__'}
                        onChange={e => {
                          if (e.target.value === '__other__') setNewSku({...newSku, unit: ''})
                          else setNewSku({...newSku, unit: e.target.value})
                        }}
                        className={INPUT_CLS}>
                  <optgroup label="按件">
                    <option value="件">件</option>
                    <option value="箱">箱</option>
                    <option value="袋">袋</option>
                    <option value="包">包</option>
                    <option value="盒">盒</option>
                    <option value="瓶">瓶</option>
                    <option value="罐">罐</option>
                    <option value="支">支</option>
                    <option value="片">片</option>
                    <option value="个">个</option>
                    <option value="双">双</option>
                    <option value="只">只</option>
                    <option value="串">串</option>
                    <option value="份">份</option>
                    <option value="台">台</option>
                    <option value="块">块</option>
                  </optgroup>
                  <optgroup label="按重量/体积">
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="斤">斤</option>
                    <option value="L">L</option>
                    <option value="ml">ml</option>
                    <option value="升">升</option>
                  </optgroup>
                  <option value="__other__">自定义…</option>
                </select>
                {/* 自定义入口 — 仅当当前不在白名单时显示输入框 */}
                {!['件','箱','袋','包','瓶','罐','盒','支','个','片','双','只','份','串','台','块','kg','g','斤','升','ml','L'].includes(newSku.unit) && (
                  <input value={newSku.unit} onChange={e => setNewSku({...newSku, unit: e.target.value.replace(/^\d+/, '')})}
                         placeholder="只输干净单位, 不要数字" className={INPUT_CLS + ' mt-1'} />
                )}
                <p className="text-micro text-gray3 mt-0.5">⚠ 数量(如 5kg / 24瓶) 请记到「规格型号」, 起订量记到「起订量」字段</p>
              </Field>
              <Field label="金额 (¥) *">
                <input type="number" step="0.01" min="0" value={newSku.price}
                       onChange={e => setNewSku({...newSku, price: e.target.value})}
                       placeholder="0.00" className={INPUT_CLS} />
              </Field>

              {/* —— 选填扩展 —— */}
              <Field label="编码 (留空自动生成)">
                <input value={newSku.code} onChange={e => setNewSku({...newSku, code: e.target.value})}
                       placeholder="例: SH001" className={INPUT_CLS} />
              </Field>
              <Field label="类目 (默认其他)">
                <select value={newSku.category} onChange={e => setNewSku({...newSku, category: e.target.value})} className={INPUT_CLS}>
                  <option value="">其他（默认）</option>
                  {activeCategories.filter(category => category.name !== '其他').map(category => <option key={category.name} value={category.name}>{category.name}</option>)}
                </select>
              </Field>
              <Field label="保质期 (天)">
                <input type="number" min="0" value={newSku.shelfDays}
                       onChange={e => setNewSku({...newSku, shelfDays: e.target.value})}
                       className={INPUT_CLS} />
              </Field>
              <Field label="起订量 (默认1)">
                <input type="number" step="0.01" min="0.01" value={newSku.minOrderQty}
                       onChange={e => setNewSku({...newSku, minOrderQty: e.target.value, stepQty: e.target.value})}
                       placeholder="1" className={INPUT_CLS} />
              </Field>
            </div>

            {createErr && (
              <p className="text-caption text-red-fg mt-3 bg-red-bg rounded-cta p-2">{createErr}</p>
            )}

            <div className="grid grid-cols-2 gap-2 mt-5">
              <button onClick={() => setCreateOpen(false)} disabled={submitting}
                      className="py-3 rounded-cta text-button bg-white border border-border text-gray2 disabled:opacity-50">取消</button>
              <button onClick={submitNew} disabled={submitting}
                      className="py-3 rounded-cta text-button bg-accent text-white disabled:opacity-50">
                {submitting ? '上架中…' : '上架'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const INPUT_CLS = 'w-full bg-bg border border-border rounded-cta px-2 py-2 text-body text-ink placeholder:text-gray3 focus:outline-none focus:border-accent focus:bg-white'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-micro text-gray3 block mb-1">{label}</label>
      {children}
    </div>
  )
}
