/**
 * 内部供应链 · 商品管理（桌面端）
 *
 * 沿用 GET /api/products 分页列表 + PATCH /api/products/:id 直接生效。
 * 支持：当前页行选择、导出当前筛选、批量分类/停售/恢复。
 * 不显示审批按钮或"待总厨审批"语义；不复用外部供应商身份。
 */
'use client'
import { useEffect, useRef, useState } from 'react'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { EmptyState, FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { ProductImagePreview } from '@/components/v2/product-image-preview'
import { apiDownload, apiFetch } from '@/lib/v2-auth'
import {
  buildBatchCategoryBody,
  buildBatchStatusBody,
  buildBatchStatusPreviewBody,
  buildBatchSuccessNotice,
  buildSupplyProductExportPath,
  bulkCategoryBlockedReason,
  canBulkCategory,
  clearRowSelection,
  formatBatchStatusPreviewSummary,
  productExportFilename,
  selectPageRows,
  toggleRowSelection,
} from '@/lib/supply-product-bulk-pc'
import {
  buildCreateBody,
  buildEditBody,
  buildPriceChangeBody,
  buildProductQuery,
  buildStatusChangeBody,
  DEFAULT_SUPPLY_PRODUCT_FILTERS,
  formatCostUnitPriceLabel,
  formatMoney,
  formatPriceChangeConfirmBody,
  formatProductStatusLabel,
  hasActiveFilters,
  keepFiltersForPage,
  productImageAlt,
  productStatusTone,
  resetPageFilters,
  resolveProductImageUrl,
  SUPPLY_PRODUCT_STATUS_OPTIONS,
  validateNewProductForm,
  validateProductQuantities,
  formatProductQuantity,
  type CategoryOption,
  type SupplierOption,
  type SupplyProduct,
  type SupplyProductFilters,
  type SupplyProductQuantityForm,
} from '@/lib/supply-product-pc'
import {
  buildFourUnitCreateBody,
  buildFourUnitEditBody,
  buildFourUnitValues,
  DEFAULT_FOUR_UNIT_FORM,
  formatCompactUnitSummary,
  formatConversionSummary,
  formatOrderUnitPriceHint,
  fourUnitFormFromProduct,
  type FourUnitForm,
  validateFourUnitForm,
} from '@/lib/supply-product-four-units'

type ProductRow = SupplyProduct & {
  spec?: string | null
  inventoryUnit?: string | null
  shelfDays?: number | null
  purchaseUnit?: string | null
  orderUnit?: string | null
  costUnit?: string | null
  inventoryUnitsPerPurchaseUnit?: number | string | null
  inventoryUnitsPerOrderUnit?: number | string | null
  inventoryUnitsPerCostUnit?: number | string | null
  unitConversionStatus?: string | null
  stock?: number | string | null
  minStock?: number | string | null
  minOrderQty?: number | string | null
  stepQty?: number | string | null
}

type FormState = {
  name: string
  code: string
  category: string
  unit: string
  price: string
  spec: string
  shelfDays: string
  supplierId: string
} & FourUnitForm & SupplyProductQuantityForm

const EMPTY_FORM: FormState = {
  name: '',
  code: '',
  category: '',
  unit: '件',
  price: '',
  spec: '',
  shelfDays: '7',
  supplierId: '',
  ...DEFAULT_FOUR_UNIT_FORM,
  stock: '0',
  minStock: '0',
  minOrderQty: '1',
  stepQty: '1',
}

export default function InternalSupplyChainProductsPage() {
  const [products, setProducts] = useState<ProductRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<SupplyProductFilters>(DEFAULT_SUPPLY_PRODUCT_FILTERS)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [bulkCategories, setBulkCategories] = useState<CategoryOption[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProductRow | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null)
  const [pendingImagePreview, setPendingImagePreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const [priceTarget, setPriceTarget] = useState<ProductRow | null>(null)
  const [newPrice, setNewPrice] = useState('')

  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()
  const imageInputRef = useRef<HTMLInputElement>(null)
  const requestSequence = useRef(0)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkCategory, setBulkCategory] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  function load() {
    const sequence = ++requestSequence.current
    setLoading(true)
    setError(null)
    apiFetch<{ items: ProductRow[]; total: number; page: number; pageSize: number }>(
      `/api/products${buildProductQuery(filters)}`,
    )
      .then(data => {
        if (sequence !== requestSequence.current) return
        setProducts(data.items || [])
        setTotal(data.total || 0)
      })
      .catch(reason => {
        if (sequence === requestSequence.current) setError(String(reason?.message || reason))
      })
      .finally(() => {
        if (sequence === requestSequence.current) setLoading(false)
      })
  }
  useEffect(() => { load() }, [filters])
  useEffect(() => {
    setSelectedIds(clearRowSelection())
    setBulkCategory('')
  }, [filters.q, filters.category, filters.status, filters.supplierId, filters.pageSize])

  useEffect(() => {
    apiFetch<CategoryOption[]>('/api/products/categories')
      .then(data => setCategories(Array.isArray(data) ? data : []))
      .catch(() => {})
    apiFetch<SupplierOption[]>('/api/suppliers?status=ENABLED')
      .then(data => {
        const list = Array.isArray(data) ? data : []
        setSuppliers(list.map((s: any) => ({ id: s.id, name: s.name })))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    setBulkCategory('')
    if (!filters.supplierId) {
      setBulkCategories([])
      return
    }
    let active = true
    apiFetch<Array<CategoryOption & { isActive?: boolean }>>(
      `/api/products/categories?supplierId=${encodeURIComponent(filters.supplierId)}`,
    )
      .then(data => {
        if (!active) return
        setBulkCategories(
          (Array.isArray(data) ? data : []).filter(category => category.isActive !== false),
        )
      })
      .catch(() => {
        if (active) setBulkCategories([])
      })
    return () => { active = false }
  }, [filters.supplierId])

  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize))

  function updateFilters(changes: Partial<SupplyProductFilters>) {
    setFilters(current => resetPageFilters(current, changes))
  }

  function clearFilters() {
    setFilters({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS })
  }

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY_FORM, supplierId: filters.supplierId })
    setFormError(null)
    setPendingImageFile(null)
    setPendingImagePreview(null)
    setFormOpen(true)
  }

  function openEdit(product: ProductRow) {
    setEditing(product)
    setForm({
      name: product.name,
      code: product.code || '',
      category: product.category || '',
      unit: product.unit || '件',
      price: String(product.price),
      spec: product.spec || '',
      shelfDays: String(product.shelfDays ?? 7),
      supplierId: product.supplier?.id || '',
      ...fourUnitFormFromProduct(product),
      stock: String(product.stock ?? 0),
      minStock: String(product.minStock ?? 0),
      minOrderQty: String(product.minOrderQty ?? 1),
      stepQty: String(product.stepQty ?? 1),
    })
    setFormError(null)
    setPendingImageFile(null)
    setPendingImagePreview(null)
    setFormOpen(true)
  }

  async function handleImageSelect(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setFormError('图片不能超过 10MB')
      return
    }
    setPendingImageFile(file)
    setPendingImagePreview(URL.createObjectURL(file))
  }

  async function uploadPendingImage(): Promise<string | null> {
    if (!pendingImageFile) return null
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', pendingImageFile)
      const result: any = await apiFetch('/api/upload?category=products', { method: 'POST', body: formData })
      return result?.key || null
    } catch (reason: any) {
      setFormError(reason?.message || '图片上传失败')
      throw reason
    } finally {
      setUploading(false)
    }
  }

  async function submitForm() {
    const validationError = validateNewProductForm(form) || validateFourUnitForm(form) || validateProductQuantities(form)
    if (validationError) { setFormError(validationError); return }
    setFormError(null)
    setSubmitting(true)
    try {
      const fourUnitForm: FourUnitForm = {
        purchaseUnit: form.purchaseUnit,
        inventoryUnit: form.inventoryUnit,
        orderUnit: form.orderUnit,
        costUnit: form.costUnit,
        inventoryUnitsPerPurchaseUnit: form.inventoryUnitsPerPurchaseUnit,
        inventoryUnitsPerOrderUnit: form.inventoryUnitsPerOrderUnit,
        inventoryUnitsPerCostUnit: form.inventoryUnitsPerCostUnit,
      }
      if (editing) {
        const body = {
          ...buildEditBody(form, {
            name: editing.name,
            code: editing.code || '',
            category: editing.category || '',
            unit: editing.unit || '',
            spec: editing.spec || '',
            shelfDays: Number(editing.shelfDays ?? 7),
            stock: editing.stock,
            minStock: editing.minStock,
            minOrderQty: editing.minOrderQty,
            stepQty: editing.stepQty,
          }),
          ...buildFourUnitEditBody(fourUnitForm, fourUnitFormFromProduct(editing)),
        }
        let imageKey: string | null = null
        if (pendingImageFile) imageKey = await uploadPendingImage()
        if (imageKey) (body as any).imageKey = imageKey
        if (Object.keys(body).length === 0) { setFormOpen(false); return }
        await apiFetch(`/api/products/${editing.id}`, {
          method: 'PATCH', body: JSON.stringify(body),
        })
      } else {
        let imageKey: string | null = null
        if (pendingImageFile) imageKey = await uploadPendingImage()
        const body = {
          ...buildCreateBody({ ...form, imageKey }),
          ...buildFourUnitCreateBody(fourUnitForm),
        }
        await apiFetch('/api/products', { method: 'POST', body: JSON.stringify(body) })
      }
      setFormOpen(false)
      setNotice(editing ? '商品修改已直接生效，并已通知总厨。' : '商品已创建并直接生效，已通知总厨。')
      load()
    } catch (reason: any) {
      setFormError(reason?.message || '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  function openPriceChange(product: ProductRow) {
    setPriceTarget(product)
    setNewPrice(String(product.price))
  }

  function submitPriceChange() {
    if (!priceTarget) return
    const price = Number(newPrice)
    if (!Number.isFinite(price) || price < 0) return
    const oldPrice = Number(priceTarget.price)
    if (Math.abs(price - oldPrice) < 0.001) { setPriceTarget(null); return }
    const orderUnitHint = formatOrderUnitPriceHint(price, priceTarget)
    openConfirm({
      title: `调价「${priceTarget.name}」`,
      body: formatPriceChangeConfirmBody(oldPrice, price, priceTarget.costUnit || '', orderUnitHint),
      confirmLabel: '确认调价',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/products/${priceTarget.id}`, {
            method: 'PATCH', body: JSON.stringify(buildPriceChangeBody(price)),
          })
          setPriceTarget(null)
          setNotice('调价已直接生效，并已通知总厨。')
          load()
        } catch (reason: any) {
          alert(reason?.message || '调价失败')
          throw reason
        } finally { setSubmitting(false) }
      },
    })
  }

  function toggleStatus(product: ProductRow) {
    const next = product.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    const isDisable = next === 'DISABLED'
    openConfirm({
      title: isDisable ? `停售「${product.name}」？` : `恢复供应「${product.name}」？`,
      body: isDisable
        ? '停售后餐厅下单时将不再显示此商品。\n\n直接生效并通知总厨。'
        : '恢复后餐厅可重新下单此商品。\n\n直接生效并通知总厨。',
      confirmLabel: isDisable ? '确认停售' : '确认恢复',
      tone: isDisable ? 'danger' : 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/products/${product.id}`, {
            method: 'PATCH', body: JSON.stringify(buildStatusChangeBody(next)),
          })
          setNotice(`${isDisable ? '停售' : '恢复'}已直接生效，并已通知总厨。`)
          load()
        } catch (reason: any) {
          alert(reason?.message || '操作失败')
          throw reason
        } finally { setSubmitting(false) }
      },
    })
  }

  const pageProductIds = (products || []).map(p => p.id)
  const currentPageSelected = pageProductIds.length > 0 && pageProductIds.every(id => selectedIds.has(id))
  const selectedCount = selectedIds.size

  function toggleSelected(id: string) {
    setSelectedIds(current => toggleRowSelection(current, id))
  }

  function selectCurrentPage(checked: boolean) {
    setSelectedIds(current => selectPageRows(current, pageProductIds, checked))
  }

  async function handleExport() {
    if (exporting) return
    setExporting(true)
    setExportError(null)
    try {
      const path = buildSupplyProductExportPath(filters)
      const { blob, filename } = await apiDownload(path, productExportFilename())
      const { saveBlob } = await import('@/app/v2/supplier/products/export-products')
      saveBlob(blob, filename)
    } catch (reason: any) {
      setExportError(reason?.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  function submitBulkCategory() {
    if (selectedCount === 0 || !bulkCategory.trim()) return
    const blocked = bulkCategoryBlockedReason(filters)
    if (blocked) {
      alert(blocked)
      return
    }
    openConfirm({
      title: `批量分类 ${selectedCount} 个商品`,
      body: `统一改为「${bulkCategory.trim()}」。\n\n直接生效并通知总厨。`,
      confirmLabel: '确认分类',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          const res: any = await apiFetch('/api/products/batch-category', {
            method: 'PATCH',
            body: JSON.stringify(buildBatchCategoryBody([...selectedIds], bulkCategory)),
          })
          setSelectedIds(clearRowSelection())
          setBulkCategory('')
          setNotice(buildBatchSuccessNotice('category', res?.count ?? selectedCount))
          load()
        } catch (reason: any) {
          alert(reason?.message || '批量分类失败')
          throw reason
        } finally { setSubmitting(false) }
      },
    })
  }

  async function submitBulkStatus(status: 'ENABLED' | 'DISABLED') {
    if (selectedCount === 0) return
    setSubmitting(true)
    let impact: any
    try {
      impact = await apiFetch('/api/products/batch-status/preview', {
        method: 'POST',
        body: JSON.stringify(buildBatchStatusPreviewBody([...selectedIds], status)),
      })
    } catch (reason: any) {
      setSubmitting(false)
      alert(reason?.message || '影响范围预览失败')
      return
    }
    setSubmitting(false)
    const isDisable = status === 'DISABLED'
    openConfirm({
      title: `${isDisable ? '批量停售' : '批量恢复'} ${selectedCount} 个商品`,
      body: `${formatBatchStatusPreviewSummary(impact)}\n\n直接生效并通知总厨。`,
      confirmLabel: isDisable ? '确认停售' : '确认恢复',
      tone: isDisable ? 'danger' : 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          const res: any = await apiFetch('/api/products/batch-status', {
            method: 'PATCH',
            body: JSON.stringify(buildBatchStatusBody([...selectedIds], status)),
          })
          setSelectedIds(clearRowSelection())
          setBulkCategory('')
          setNotice(buildBatchSuccessNotice(isDisable ? 'disable' : 'restore', res?.count ?? selectedCount))
          load()
        } catch (reason: any) {
          alert(reason?.message || '批量状态变更失败')
          throw reason
        } finally { setSubmitting(false) }
      },
    })
  }

  const filterActive = hasActiveFilters(filters)

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="green">内部管理</Chip>
            <span className="text-caption text-gray3">商品 · 直接生效并通知总厨</span>
          </div>
          <h1 className="text-h1">商品管理</h1>
          <p className="mt-1 text-caption text-gray2">
            {products ? `${total} 个商品` : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/v2/supply-chain/home" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button text-gray2">← 返回工作台</a>
          <button onClick={openCreate} className="rounded-cta bg-accent px-4 py-2.5 text-button text-white">＋ 新增商品</button>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px]">
        <div className="flex flex-wrap items-end gap-3 py-4">
          <FilterInput label="关键字" value={filters.q} onChange={value => updateFilters({ q: value })} placeholder="名称 / 编码 / 规格" />
          <FilterSelect label="分类" value={filters.category} onChange={value => updateFilters({ category: value })}>
            <option value="">全部分类</option>
            {categories.map(cat => <option key={cat.name} value={cat.name}>{cat.name} ({cat.count})</option>)}
          </FilterSelect>
          <FilterSelect label="状态" value={filters.status} onChange={value => updateFilters({ status: value })}>
            <option value="">全部状态</option>
            {SUPPLY_PRODUCT_STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </FilterSelect>
          <FilterSelect label="供应商" value={filters.supplierId} onChange={value => updateFilters({ supplierId: value })}>
            <option value="">全部供应商</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </FilterSelect>
          <button
            onClick={clearFilters}
            disabled={!filterActive}
            className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2 disabled:opacity-40"
          >清空</button>
          <button
            onClick={handleExport}
            disabled={exporting || loading}
            className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2 disabled:opacity-40"
          >{exporting ? '导出中…' : '⤓ 导出当前筛选'}</button>
        </div>

        {exportError && (
          <div className="mb-4 rounded-card border border-red-fg/20 bg-red-bg px-4 py-3 text-caption text-red-fg">
            导出失败：{exportError}
          </div>
        )}

        {notice && (
          <div className="mb-4 flex items-center justify-between rounded-card border border-green-fg/20 bg-green-bg px-4 py-3 text-caption text-green-fg">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="text-button">关闭</button>
          </div>
        )}

        {error && <div className="mb-4"><FriendlyError message={error} onRetry={load} /></div>}

        {!products && !error && <div className="space-y-2">{[1, 2, 3].map(i => <SkeletonCard key={i} />)}</div>}

        {products && products.length === 0 && !loading && (
          <EmptyState icon="📋" title={filterActive ? '没有匹配的商品' : '暂无商品'} hint={filterActive ? '尝试调整筛选条件' : '点击「新增商品」开始建档'} />
        )}

        {products && products.length > 0 && (
          <div className="overflow-hidden rounded-card border border-border bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-border bg-bg px-4 py-3">
              <label className="flex items-center gap-2 text-caption text-gray2">
                <input
                  type="checkbox"
                  checked={currentPageSelected}
                  onChange={e => selectCurrentPage(e.target.checked)}
                  aria-label="选择当前页全部商品"
                />
                全选当前页 {products.length} 项
              </label>
              <span className="text-caption text-accent">已选 {selectedCount} 项</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-caption">
                <thead className="bg-bg text-gray3">
                  <tr>
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={currentPageSelected}
                        onChange={e => selectCurrentPage(e.target.checked)}
                        aria-label="从表头选择当前页全部商品"
                      />
                    </th>
                    <th className="px-4 py-3">图片</th>
                    <th className="px-4 py-3">编码</th>
                    <th className="px-4 py-3">名称</th>
                    <th className="px-4 py-3">规格</th>
                    <th className="px-4 py-3">分类</th>
                    <th className="px-4 py-3 text-right">库存</th>
                    <th className="px-4 py-3 text-right">安全库存</th>
                    <th className="px-4 py-3 text-right">起订量</th>
                    <th className="px-4 py-3 text-right">步长</th>
                    <th className="px-4 py-3 text-right">单价（元 / 成本单位）</th>
                    <th className="px-4 py-3">供应商</th>
                    <th className="px-4 py-3">状态</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {products.map(product => {
                    const imageUrl = resolveProductImageUrl(product.imageUrl)
                    const selected = selectedIds.has(product.id)
                    return (
                      <tr key={product.id} className={`hover:bg-bg/50 ${selected ? 'bg-accent/5' : ''}`}>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelected(product.id)}
                            aria-label={`选择 ${product.name}`}
                          />
                        </td>
                        <td className="px-4 py-3">
                          {imageUrl ? (
                            <button onClick={() => setPreview({ url: imageUrl, name: product.name })} className="block">
                              <img src={imageUrl} alt={productImageAlt(product.name, product.code)} className="h-10 w-10 rounded object-cover" />
                            </button>
                          ) : (
                            <span className="flex h-10 w-10 items-center justify-center rounded bg-bg text-micro text-gray3">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-num text-gray2">{product.code || '—'}</td>
                        <td className="px-4 py-3"><b>{product.name}</b></td>
                        <td className="px-4 py-3 text-gray2">{product.spec || '—'}</td>
                        <td className="px-4 py-3 text-gray2">{product.category || '—'}</td>
                        <td className="px-4 py-3 text-right font-num">{formatProductQuantity(product.stock)}</td>
                        <td className="px-4 py-3 text-right font-num">{formatProductQuantity(product.minStock)}</td>
                        <td className="px-4 py-3 text-right font-num">{formatProductQuantity(product.minOrderQty)}</td>
                        <td className="px-4 py-3 text-right font-num">{formatProductQuantity(product.stepQty)}</td>
                        <td className="px-4 py-3 text-right font-num">
                      {(() => {
                        const unitValues = buildFourUnitValues(fourUnitFormFromProduct(product))
                        const orderUnitHint = formatOrderUnitPriceHint(Number(product.price), product)
                        return (
                          <>
                            {formatMoney(product.price)}
                            <span className="block text-micro text-gray2">
                              元 / {unitValues.costUnit}
                            </span>
                            {orderUnitHint && (
                              <span className="block text-micro text-gray2">{orderUnitHint}</span>
                            )}
                          </>
                        )
                      })()}
                    </td>
                    <td className="px-4 py-3 text-gray2">{product.supplier?.name || '—'}</td>
                        <td className="px-4 py-3"><Chip tone={productStatusTone(product.status)}>{formatProductStatusLabel(product.status)}</Chip></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <button onClick={() => openEdit(product)} className="text-button text-accent">编辑</button>
                            <button onClick={() => openPriceChange(product)} className="text-button text-accent">调价</button>
                            <button
                              onClick={() => toggleStatus(product)}
                              className={`text-button ${product.status === 'ENABLED' ? 'text-red-fg' : 'text-green-fg'}`}
                            >
                              {product.status === 'ENABLED'
                                ? '停售'
                                : product.status === 'DISABLED'
                                  ? '恢复'
                                  : '按新流程启用'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {selectedCount > 0 && (
              <div className="flex flex-wrap items-center gap-3 border-t border-border bg-bg px-4 py-3">
                <span className="text-caption text-gray2">批量操作：</span>
                <FilterSelect label="" value={bulkCategory} onChange={value => setBulkCategory(value)}>
                  <option value="">选择新分类</option>
                  {bulkCategories.map(cat => <option key={cat.name} value={cat.name}>{cat.name}</option>)}
                </FilterSelect>
                <button
                  onClick={submitBulkCategory}
                  disabled={!bulkCategory || !canBulkCategory(filters)}
                  className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2 disabled:opacity-40"
                >批量分类</button>
                <button
                  onClick={() => submitBulkStatus('DISABLED')}
                  className="rounded-cta bg-red-bg px-3 py-2 text-button text-red-fg"
                >批量停售</button>
                <button
                  onClick={() => submitBulkStatus('ENABLED')}
                  className="rounded-cta bg-green-bg px-3 py-2 text-button text-green-fg"
                >批量恢复</button>
                {!canBulkCategory(filters) && (
                  <span className="text-caption text-amber-fg">{bulkCategoryBlockedReason(filters)}</span>
                )}
              </div>
            )}
          </div>
        )}

        {total > 0 && (
          <PaginationBar
            page={filters.page}
            totalPages={totalPages}
            pageSize={filters.pageSize}
            total={total}
            onPage={page => setFilters(current => keepFiltersForPage(current, page))}
          />
        )}
      </main>

      {formOpen && (
        <FormDialog
          editing={editing}
          form={form}
          formError={formError}
          submitting={submitting || uploading}
          pendingImagePreview={pendingImagePreview}
          categories={categories}
          suppliers={suppliers}
          priceOnly={false}
          onFieldChange={(key, value) => setForm(current => ({ ...current, [key]: value }))}
          onImageSelect={handleImageSelect}
          onImageClear={() => { setPendingImageFile(null); setPendingImagePreview(null) }}
          onSubmit={submitForm}
          onClose={() => setFormOpen(false)}
          imageInputRef={imageInputRef}
        />
      )}

      {priceTarget && (
        <FormDialog
          editing={priceTarget}
          form={{ ...EMPTY_FORM, price: newPrice }}
          formError={null}
          submitting={submitting}
          pendingImagePreview={null}
          categories={[]}
          suppliers={[]}
          priceOnly
          onFieldChange={(_key, value) => setNewPrice(value)}
          onImageSelect={() => {}}
          onImageClear={() => {}}
          onSubmit={submitPriceChange}
          onClose={() => setPriceTarget(null)}
          imageInputRef={null}
        />
      )}

      <ConfirmSheet {...confirmState} />

      {preview && (
        <ProductImagePreview
          src={preview.url}
          alt={preview.name}
          isOpen
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}

function FilterInput({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro text-gray3">{label}</span>
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 min-w-44 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
      />
    </label>
  )
}

function FilterSelect({ label, value, onChange, children }: {
  label: string; value: string; onChange: (v: string) => void; children: React.ReactNode
}) {
  return (
    <label className={`flex flex-col gap-1 ${label ? '' : 'justify-end'}`}>
      {label && <span className="text-micro text-gray3">{label}</span>}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-10 min-w-36 rounded-cta border border-border bg-white px-3 text-body"
      >
        {children}
      </select>
    </label>
  )
}

function PaginationBar({ page, totalPages, total, pageSize, onPage }: {
  page: number; totalPages: number; total: number; pageSize: number; onPage: (p: number) => void
}) {
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  return (
    <div className="flex items-center justify-between py-4 text-caption text-gray2">
      <span>第 {start}–{end} 项，共 {total} 项</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="rounded-cta border border-border bg-white px-3 py-1.5 text-button disabled:opacity-40"
        >上一页</button>
        <span className="font-num">{page} / {totalPages}</span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          className="rounded-cta border border-border bg-white px-3 py-1.5 text-button disabled:opacity-40"
        >下一页</button>
      </div>
    </div>
  )
}

function FormDialog({
  editing, form, formError, submitting, pendingImagePreview, categories, suppliers, priceOnly,
  onFieldChange, onImageSelect, onImageClear, onSubmit, onClose, imageInputRef,
}: {
  editing: ProductRow | null
  form: FormState
  formError: string | null
  submitting: boolean
  pendingImagePreview: string | null
  categories: CategoryOption[]
  suppliers: SupplierOption[]
  priceOnly: boolean
  onFieldChange: (key: string, value: string) => void
  onImageSelect: (file: File) => void
  onImageClear: () => void
  onSubmit: () => void
  onClose: () => void
  imageInputRef: React.RefObject<HTMLInputElement> | null
}) {
  const title = priceOnly
    ? `调价「${editing?.name || ''}」`
    : editing ? `编辑「${editing.name}」` : '新增商品'
  const confirmLabel = priceOnly ? '确认调价' : editing ? '保存修改' : '新增'
  const bodyNote = '直接生效并通知总厨'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-card bg-white p-5 shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-h2">{title}</h2>
          <button onClick={onClose} className="text-gray3 text-h2 hover:text-ink">×</button>
        </div>

        <p className="mb-4 text-micro text-gray3">{bodyNote}</p>

        {priceOnly ? (
          <div className="space-y-3">
            <FormField label={formatCostUnitPriceLabel(fourUnitFormFromProduct(editing ?? {}).costUnit)}>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.price}
                onChange={e => onFieldChange('price', e.target.value)}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                autoFocus
              />
            </FormField>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="供应商">
              <select
                value={form.supplierId}
                onChange={e => onFieldChange('supplierId', e.target.value)}
                disabled={Boolean(editing)}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body disabled:bg-bg disabled:text-gray3"
              >
                <option value="">未关联供应商</option>
                {suppliers.map(supplier => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </select>
            </FormField>
            <div className="col-span-2">
              <FormField label="商品图片">
                <div className="flex items-center gap-3">
                  {pendingImagePreview ? (
                    <img src={pendingImagePreview} alt="待上传" className="h-16 w-16 rounded object-cover" />
                  ) : editing?.imageUrl ? (
                    <img src={resolveProductImageUrl(editing.imageUrl) || ''} alt={editing.name} className="h-16 w-16 rounded object-cover" />
                  ) : (
                    <span className="flex h-16 w-16 items-center justify-center rounded bg-bg text-micro text-gray3">无图</span>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => imageInputRef?.current?.click()}
                      className="rounded-cta border border-border bg-white px-3 py-1.5 text-button text-gray2"
                    >选择图片</button>
                    {pendingImagePreview && (
                      <button type="button" onClick={onImageClear} className="rounded-cta border border-border bg-white px-3 py-1.5 text-button text-gray2">移除</button>
                    )}
                  </div>
                  {imageInputRef && (
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) onImageSelect(file)
                        e.target.value = ''
                      }}
                    />
                  )}
                </div>
              </FormField>
            </div>
            <FormField label="名称" required>
              <input
                type="text"
                value={form.name}
                onChange={e => onFieldChange('name', e.target.value)}
                maxLength={80}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                autoFocus
              />
            </FormField>
            <FormField label="编码">
              <input
                type="text"
                value={form.code}
                onChange={e => onFieldChange('code', e.target.value)}
                maxLength={40}
                disabled={Boolean(editing)}
                placeholder="留空自动生成"
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent disabled:bg-bg disabled:text-gray3"
              />
            </FormField>
            <FormField label="分类">
              <input
                type="text"
                value={form.category}
                onChange={e => onFieldChange('category', e.target.value)}
                maxLength={40}
                list="supply-product-categories"
                placeholder="如：蔬菜 / 冻品"
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              />
              <datalist id="supply-product-categories">
                {categories.map(cat => <option key={cat.name} value={cat.name} />)}
              </datalist>
            </FormField>
            <div className="col-span-2">
              <div className="rounded-lg bg-bg p-3">
                <p className="mb-2 text-micro font-medium text-ink">单位换算（四单位可相同）</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="采购单位">
                    <input
                      type="text"
                      value={form.purchaseUnit}
                      onChange={e => onFieldChange('purchaseUnit', e.target.value)}
                      maxLength={16}
                      placeholder="kg / 件 / 瓶"
                      className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                    />
                  </FormField>
                  <FormField label="1 采购单位 = ？库存单位">
                    <input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      value={form.inventoryUnitsPerPurchaseUnit}
                      onChange={e => onFieldChange('inventoryUnitsPerPurchaseUnit', e.target.value)}
                      className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                    />
                  </FormField>
                  <FormField label="订货单位">
                    <input
                      type="text"
                      value={form.orderUnit}
                      onChange={e => onFieldChange('orderUnit', e.target.value)}
                      maxLength={16}
                      placeholder="kg / 件 / 瓶"
                      className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                    />
                  </FormField>
                  <FormField label="1 订货单位 = ？库存单位">
                    <input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      value={form.inventoryUnitsPerOrderUnit}
                      onChange={e => onFieldChange('inventoryUnitsPerOrderUnit', e.target.value)}
                      className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                    />
                  </FormField>
                  <FormField label="库存单位">
                    <input
                      type="text"
                      value={form.inventoryUnit}
                      onChange={e => onFieldChange('inventoryUnit', e.target.value)}
                      maxLength={16}
                      placeholder="kg / 件 / 瓶"
                      className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                    />
                  </FormField>
                  <FormField label="成本单位">
                    <input
                      type="text"
                      value={form.costUnit}
                      onChange={e => onFieldChange('costUnit', e.target.value)}
                      maxLength={16}
                      placeholder="kg / 件 / 瓶"
                      className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                    />
                  </FormField>
                  <FormField label="1 成本单位 = ？库存单位" full>
                    <input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      value={form.inventoryUnitsPerCostUnit}
                      onChange={e => onFieldChange('inventoryUnitsPerCostUnit', e.target.value)}
                      className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                    />
                  </FormField>
                </div>
                <p className="mt-2 text-micro text-gray2">
                  {formatConversionSummary(buildFourUnitValues(form))}
                </p>
              </div>
            </div>
            <FormField label={formatCostUnitPriceLabel(form.costUnit)} required>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.price}
                onChange={e => onFieldChange('price', e.target.value)}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              />
            </FormField>
            <FormField label="保质期（天）">
              <input
                type="number"
                min="0"
                max="3650"
                value={form.shelfDays}
                onChange={e => onFieldChange('shelfDays', e.target.value)}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              />
            </FormField>
            <FormField label="库存（请在库存模块调整）">
              <input
                type="number"
                min="0"
                step="0.001"
                value={form.stock}
                onChange={e => onFieldChange('stock', e.target.value)}
                disabled
                className="h-10 w-full rounded-cta border border-border bg-bg px-3 text-body text-gray2 outline-none"
              />
            </FormField>
            <FormField label={editing ? '安全库存（编辑暂不开放）' : '安全库存'}>
              <input
                type="number"
                min="0"
                step="0.001"
                value={form.minStock}
                onChange={e => onFieldChange('minStock', e.target.value)}
                disabled={Boolean(editing)}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent disabled:bg-bg disabled:text-gray2"
              />
            </FormField>
            <FormField label="起订量">
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={form.minOrderQty}
                onChange={e => onFieldChange('minOrderQty', e.target.value)}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              />
            </FormField>
            <FormField label="步长">
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={form.stepQty}
                onChange={e => onFieldChange('stepQty', e.target.value)}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              />
            </FormField>
            <FormField label="规格" full>
              <input
                type="text"
                value={form.spec}
                onChange={e => onFieldChange('spec', e.target.value)}
                maxLength={80}
                placeholder="如 500g/袋"
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              />
            </FormField>
          </div>
        )}

        {formError && <p className="mt-3 text-caption text-red-fg">{formError}</p>}

        <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
          <button onClick={onClose} disabled={submitting} className="rounded-cta border border-border bg-white px-4 py-2 text-button text-gray2 disabled:opacity-50">取消</button>
          <button onClick={onSubmit} disabled={submitting} className="rounded-cta bg-accent px-4 py-2 text-button text-white disabled:opacity-50">{submitting ? '处理中…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

function FormField({ label, required, full, children }: {
  label: string; required?: boolean; full?: boolean; children: React.ReactNode
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? 'col-span-2' : ''}`}>
      <span className="text-micro text-gray3">{label}{required && <span className="text-red-fg"> *</span>}</span>
      {children}
    </label>
  )
}
