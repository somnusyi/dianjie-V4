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
import { ProductToolTabs } from '@/components/v2/product-tool-tabs'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { EmptyState, FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { ProductImagePreview } from '@/components/v2/product-image-preview'
import { apiDownload, apiFetch } from '@/lib/v2-auth'
import { filterSupplierCategories } from '@/lib/supplier-category-filter'
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
  buildProductCountQuery,
  buildProductQuery,
  buildStatusChangeBody,
  countProductsByCategory,
  DEFAULT_SUPPLY_PRODUCT_FILTERS,
  formatCostUnitPriceLabel,
  formatMoney,
  formatPriceChangeConfirmBody,
  formatProductStatusLabel,
  hasActiveFilters,
  isNewCategoryName,
  keepFiltersForPage,
  mergeCategoryOptions,
  orderCategoriesByMasterSort,
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
  isSimpleFourUnitContract,
  parseSpecConversion,
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
  upstreamSources?: ProductUpstreamSource[]
}

type UpstreamSupplierOption = SupplierOption & { no?: string }

type ProductUpstreamSource = {
  id?: string
  supplierId: string
  isPrimary: boolean
  isActive?: boolean
  supplierSku?: string | null
  purchaseUnit: string
  inventoryUnitsPerPurchaseUnit: number | string
  quotedUnitPrice?: number | string | null
  minOrderQty: number | string
  leadTimeDays: number
  note?: string | null
  supplier: UpstreamSupplierOption
}

type SourceFormRow = {
  supplierId: string
  isPrimary: boolean
  supplierSku: string
  purchaseUnit: string
  inventoryUnitsPerPurchaseUnit: string
  quotedUnitPrice: string
  minOrderQty: string
  leadTimeDays: string
  note: string
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
  const [catalogTotal, setCatalogTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<SupplyProductFilters>({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS, status: 'ENABLED' })
  const [categories, setCategories] = useState<CategoryOption[]>([])
  // 按当前筛选（状态/供应商/关键字）聚合出的分类计数，用于让左侧计数与列表口径一致；
  // null 表示尚未算出，先回退到服务端分类主数据自带的全状态计数。
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number> | null>(null)
  const [bulkCategories, setBulkCategories] = useState<CategoryOption[]>([])
  // 编辑/新增弹窗按表单所选供应商单独取分类，沿用分类管理页同一接口与 sortOrder 顺序，
  // 使下拉顺序与分类管理页一致；null 表示尚未取到，先回退到全局分类列表。
  const [formCategories, setFormCategories] = useState<CategoryOption[] | null>(null)
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [upstreamSuppliers, setUpstreamSuppliers] = useState<UpstreamSupplierOption[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProductRow | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [creatingCategory, setCreatingCategory] = useState(false)
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null)
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null)
  const [pendingImagePreview, setPendingImagePreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const [priceTarget, setPriceTarget] = useState<ProductRow | null>(null)
  const [newPrice, setNewPrice] = useState('')

  const [sourceProduct, setSourceProduct] = useState<ProductRow | null>(null)
  const [sourceRows, setSourceRows] = useState<SourceFormRow[]>([])
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceSaving, setSourceSaving] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)

  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()
  const imageInputRef = useRef<HTMLInputElement>(null)
  const requestSequence = useRef(0)
  const countSequence = useRef(0)

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
  // 分类计数与列表共用同一批筛选（状态/供应商/关键字），但不带分类与分页：
  // 请求全量匹配列表后在前端按分类聚合，使左侧计数与顶部分类(N)随右侧筛选联动。
  useEffect(() => {
    const sequence = ++countSequence.current
    apiFetch<Array<{ category: string | null }>>(`/api/products${buildProductCountQuery(filters)}`)
      .then(data => {
        if (sequence !== countSequence.current) return
        setCategoryCounts(countProductsByCategory(Array.isArray(data) ? data : []))
      })
      .catch(() => {
        // 统计失败不阻断主列表；保留服务端全状态计数作为兜底。
      })
  }, [filters.q, filters.status, filters.supplierId])
  useEffect(() => {
    setSelectedIds(clearRowSelection())
    setBulkCategory('')
  }, [filters.q, filters.category, filters.status, filters.supplierId, filters.pageSize])

  useEffect(() => {
    let active = true
    Promise.all([
      apiFetch<CategoryOption[]>('/api/products/categories').catch(() => [] as CategoryOption[]),
      // 商品 supplierId 表示面向门店的履约主体，不是总仓采购来源。
      // 显式限定业务范围，避免把“上游供应商管理”中的采购合作方混入商品筛选。
      apiFetch<SupplierOption[]>('/api/suppliers?status=ENABLED&businessScope=STORE_FULFILLER').catch(() => [] as SupplierOption[]),
      apiFetch<UpstreamSupplierOption[]>('/api/suppliers?status=ENABLED&businessScope=WAREHOUSE_UPSTREAM').catch(() => [] as UpstreamSupplierOption[]),
      apiFetch<{ total?: number }>('/api/products?page=1&pageSize=1').catch(() => ({ total: undefined })),
    ])
      .then(async ([baseCategories, supplierList, upstreamSupplierList, catalog]) => {
        const base = Array.isArray(baseCategories) ? baseCategories : []
        const list = Array.isArray(supplierList) ? supplierList : []
        const supplierOptions = list.map((s: any) => ({ id: s.id, name: s.name }))
        if (!active) return
        setSuppliers(supplierOptions)
        setUpstreamSuppliers(Array.isArray(upstreamSupplierList)
          ? upstreamSupplierList.map((supplier: any) => ({ id: supplier.id, name: supplier.name, no: supplier.no }))
          : [])
        setCatalogTotal(typeof catalog?.total === 'number' ? catalog.total : null)
        // 先按聚合接口快速渲染左侧分类树，随后用主数据补全。
        setCategories(filterSupplierCategories(base))
        // 聚合接口（不带 supplierId）只返回已有商品的分类，分类管理页新建的 0 SKU 分类
        // 不会出现；逐供应商补取分类主数据（同分类管理页接口）并合并后新建分类才可见。
        const masterLists = await Promise.all(
          supplierOptions.map((supplier: SupplierOption) =>
            apiFetch<Array<CategoryOption & { isActive?: boolean; sortOrder?: number }>>(
              `/api/products/categories?supplierId=${encodeURIComponent(supplier.id)}`,
            ).catch(() => [] as Array<CategoryOption & { isActive?: boolean; sortOrder?: number }>),
          ),
        )
        if (!active) return
        // 聚合接口只按名称排序；合并主数据后按分类管理页保存的 sortOrder 重排，
        // 使侧边栏顺序与「分类管理」页调整的顺序一致。
        setCategories(filterSupplierCategories(
          orderCategoriesByMasterSort(mergeCategoryOptions(base, masterLists), masterLists),
        ))
      })
      .catch(() => {})
    return () => { active = false }
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
          filterSupplierCategories(
            (Array.isArray(data) ? data : []).filter(category => category.isActive !== false),
          ),
        )
      })
      .catch(() => {
        if (active) setBulkCategories([])
      })
    return () => { active = false }
  }, [filters.supplierId])

  // 弹窗打开且选定供应商时，按该供应商取分类（与分类管理页同接口、同 sortOrder 顺序），
  // 仅保留启用项，供编辑/新增时下拉选择；未选供应商则回退到全局列表。
  useEffect(() => {
    if (!formOpen || !form.supplierId) {
      setFormCategories(null)
      return
    }
    let active = true
    apiFetch<Array<CategoryOption & { isActive?: boolean }>>(
      `/api/products/categories?supplierId=${encodeURIComponent(form.supplierId)}`,
    )
      .then(data => {
        if (!active) return
        setFormCategories(
          filterSupplierCategories(
            (Array.isArray(data) ? data : []).filter(category => category.isActive !== false),
          ),
        )
      })
      .catch(() => {
        if (active) setFormCategories(null)
      })
    return () => { active = false }
  }, [formOpen, form.supplierId])

  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize))

  function updateFilters(changes: Partial<SupplyProductFilters>) {
    setFilters(current => resetPageFilters(current, changes))
  }

  function clearFilters() {
    setFilters({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS, status: 'ENABLED' })
  }

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY_FORM, supplierId: filters.supplierId || (suppliers.length === 1 ? suppliers[0].id : '') })
    setFormError(null)
    setCategoryNotice(null)
    setPendingImageFile(null)
    setPendingImagePreview(null)
    setFormOpen(true)
  }

  function sourceFormFromRecord(source: ProductUpstreamSource): SourceFormRow {
    return {
      supplierId: source.supplierId,
      isPrimary: Boolean(source.isPrimary),
      supplierSku: source.supplierSku || '',
      purchaseUnit: source.purchaseUnit || '',
      inventoryUnitsPerPurchaseUnit: String(source.inventoryUnitsPerPurchaseUnit ?? 1),
      quotedUnitPrice: source.quotedUnitPrice == null ? '' : String(source.quotedUnitPrice),
      minOrderQty: String(source.minOrderQty ?? 1),
      leadTimeDays: String(source.leadTimeDays ?? 0),
      note: source.note || '',
    }
  }

  async function openSources(product: ProductRow) {
    setSourceProduct(product)
    setSourceRows((product.upstreamSources || []).map(sourceFormFromRecord))
    setSourceError(null)
    setSourceLoading(true)
    try {
      const data = await apiFetch<{ sources?: ProductUpstreamSource[] }>(`/api/product-upstream-sources/${product.id}`)
      setSourceRows((data.sources || []).map(sourceFormFromRecord))
    } catch (reason: any) {
      setSourceError(reason?.message || '采购来源读取失败')
    } finally {
      setSourceLoading(false)
    }
  }

  function addSourceRow() {
    if (!sourceProduct) return
    const used = new Set(sourceRows.map(row => row.supplierId))
    const supplier = upstreamSuppliers.find(option => !used.has(option.id))
    if (!supplier) {
      setSourceError(upstreamSuppliers.length === 0 ? '请先在「上游供应商管理」建立供应商档案' : '全部上游供应商均已添加')
      return
    }
    setSourceError(null)
    setSourceRows(current => [...current, {
      supplierId: supplier.id,
      isPrimary: current.length === 0,
      supplierSku: '',
      purchaseUnit: sourceProduct.purchaseUnit || sourceProduct.inventoryUnit || sourceProduct.unit || '件',
      inventoryUnitsPerPurchaseUnit: String(sourceProduct.inventoryUnitsPerPurchaseUnit ?? 1),
      quotedUnitPrice: '',
      minOrderQty: String(sourceProduct.minOrderQty ?? 1),
      leadTimeDays: '0',
      note: '',
    }])
  }

  function updateSourceRow(index: number, changes: Partial<SourceFormRow>) {
    setSourceRows(current => current.map((row, rowIndex) => {
      if (rowIndex !== index) return changes.isPrimary ? { ...row, isPrimary: false } : row
      return { ...row, ...changes }
    }))
    setSourceError(null)
  }

  function removeSourceRow(index: number) {
    setSourceRows(current => {
      const removedPrimary = current[index]?.isPrimary
      const next = current.filter((_, rowIndex) => rowIndex !== index)
      if (removedPrimary && next.length > 0) next[0] = { ...next[0], isPrimary: true }
      return next
    })
    setSourceError(null)
  }

  async function saveSources() {
    if (!sourceProduct) return
    if (sourceRows.length > 0 && sourceRows.filter(row => row.isPrimary).length !== 1) {
      setSourceError('请且仅请选择一个主供应商')
      return
    }
    const invalid = sourceRows.find(row => (
      !row.supplierId || !row.purchaseUnit.trim()
      || !Number.isFinite(Number(row.inventoryUnitsPerPurchaseUnit)) || Number(row.inventoryUnitsPerPurchaseUnit) <= 0
      || !Number.isFinite(Number(row.minOrderQty)) || Number(row.minOrderQty) <= 0
      || !Number.isInteger(Number(row.leadTimeDays)) || Number(row.leadTimeDays) < 0
      || (row.quotedUnitPrice !== '' && (!Number.isFinite(Number(row.quotedUnitPrice)) || Number(row.quotedUnitPrice) < 0))
    ))
    if (invalid) {
      setSourceError('请检查采购单位、换算、报价、起订量和交期')
      return
    }
    setSourceSaving(true)
    setSourceError(null)
    try {
      await apiFetch(`/api/product-upstream-sources/${sourceProduct.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          sources: sourceRows.map(row => ({
            supplierId: row.supplierId,
            isPrimary: row.isPrimary,
            supplierSku: row.supplierSku.trim() || null,
            purchaseUnit: row.purchaseUnit.trim(),
            inventoryUnitsPerPurchaseUnit: Number(row.inventoryUnitsPerPurchaseUnit),
            quotedUnitPrice: row.quotedUnitPrice === '' ? null : Number(row.quotedUnitPrice),
            minOrderQty: Number(row.minOrderQty),
            leadTimeDays: Number(row.leadTimeDays),
            note: row.note.trim() || null,
          })),
        }),
      })
      setSourceProduct(null)
      setNotice(`「${sourceProduct.name}」采购来源已更新`)
      load()
    } catch (reason: any) {
      setSourceError(reason?.message || '采购来源保存失败')
    } finally {
      setSourceSaving(false)
    }
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
      // 编辑保留建档时的四单位口径（含 costUnit≠库存单位的历史档案）：
      // 曾在此 lockCostUnitToMinimum「保存即纠正」，但编辑模式不提交价格，
      // 归一后单位成本必然变化，被 unitContractGuard 全数拦下——96 个档案因此无法编辑。
      // 现在原样加载；只有用户主动改动单位区时才走严格校验 + 护栏折算价格。
      ...fourUnitFormFromProduct(product),
      stock: String(product.stock ?? 0),
      minStock: String(product.minStock ?? 0),
      minOrderQty: String(product.minOrderQty ?? 1),
      stepQty: String(product.stepQty ?? 1),
    })
    setFormError(null)
    setCategoryNotice(null)
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
    // 编辑且四单位区块完全未动：允许 costUnit≠库存单位的历史口径原样保留。
    // 一旦用户改动单位区任一字段，回到严格规则（成本单位=库存单位），
    // 由后端 unitContractGuard 继续兜底成本不变式。
    const fourUnitsUnchanged = Boolean(editing)
      && JSON.stringify(buildFourUnitValues(form))
        === JSON.stringify(buildFourUnitValues(fourUnitFormFromProduct(editing ?? {})))
    const validationError = validateNewProductForm(form)
      || validateFourUnitForm(form, { allowLegacyCostUnit: fourUnitsUnchanged })
      || validateProductQuantities(form, { editableOnly: Boolean(editing) })
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

  function handleFieldChange(key: string, value: string) {
    setForm(current => {
      const next = { ...current, [key]: value }
      // 成本单位锁定为最小单位：库存单位变化时同步成本单位并固定换算因子为 1。
      if (key === 'inventoryUnit') {
        next.costUnit = value
        next.inventoryUnitsPerCostUnit = '1'
      }
      // 简化口径联动：订货单位原本跟随采购单位（简化界面只暴露采购侧），
      // 采购侧改动时保持跟随；历史档案两者本就不同时不动（高级模式自管）。
      if (key === 'purchaseUnit' && current.orderUnit === current.purchaseUnit) {
        next.orderUnit = value
      }
      if (key === 'inventoryUnitsPerPurchaseUnit'
        && current.inventoryUnitsPerOrderUnit === current.inventoryUnitsPerPurchaseUnit) {
        next.inventoryUnitsPerOrderUnit = value
      }
      return next
    })
    if (key === 'category') setCategoryNotice(null)
  }

  // 规格解析一键填充等多字段批量修改入口（简化界面的「按规格自动填」）。
  function handleBatchFieldChange(changes: Partial<FormState>) {
    setForm(current => {
      let next = { ...current }
      for (const [key, value] of Object.entries(changes)) {
        const typedKey = key as keyof FormState
        const typedValue = value as string
        next = { ...next, [typedKey]: typedValue }
        if (typedKey === 'inventoryUnit') {
          next.costUnit = typedValue
          next.inventoryUnitsPerCostUnit = '1'
        }
        if (typedKey === 'purchaseUnit' && current.orderUnit === current.purchaseUnit) {
          next.orderUnit = typedValue
        }
        if (typedKey === 'inventoryUnitsPerPurchaseUnit'
          && current.inventoryUnitsPerOrderUnit === current.inventoryUnitsPerPurchaseUnit) {
          next.inventoryUnitsPerOrderUnit = typedValue
        }
      }
      return next
    })
  }

  async function createCategory() {
    const name = form.category.trim()
    const supplierId = editing ? (editing.supplier?.id || '') : form.supplierId
    if (!name || !supplierId || creatingCategory) return
    setCreatingCategory(true)
    setFormError(null)
    try {
      const created = await apiFetch<CategoryOption>(
        `/api/products/categories?supplierId=${encodeURIComponent(supplierId)}`,
        { method: 'POST', body: JSON.stringify({ name }) },
      )
      const createdName = created?.name?.trim() || name
      setCategories(current =>
        current.some(category => category.name === createdName)
          ? current
          : [...current, { name: createdName, count: created?.count ?? 0 }],
      )
      setFormCategories(current =>
        current === null || current.some(category => category.name === createdName)
          ? current
          : [...current, { name: createdName, count: created?.count ?? 0 }],
      )
      setForm(current => ({ ...current, category: createdName }))
      setCategoryNotice(null)
    } catch (reason: any) {
      if (reason?.status === 409) {
        setCategories(current =>
          current.some(category => category.name === name)
            ? current
            : [...current, { name, count: 0 }],
        )
        setFormCategories(current =>
          current === null || current.some(category => category.name === name)
            ? current
            : [...current, { name, count: 0 }],
        )
        setForm(current => ({ ...current, category: name }))
        setCategoryNotice('分类已存在，已为你选用')
      } else {
        setFormError(reason?.message || '创建分类失败')
      }
    } finally {
      setCreatingCategory(false)
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

  // 分类名仍取服务端主数据（保证下拉/侧栏选项完整），计数替换为随筛选联动的聚合值；
  // categoryCounts 尚未算出时回退到服务端全状态计数。
  const displayCategories = categoryCounts
    ? categories.map(cat => ({ ...cat, count: categoryCounts[cat.name] ?? 0 }))
    : categories
  const totalCategoryCount = displayCategories.reduce((sum, cat) => sum + Number(cat.count ?? 0), 0)

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
            {products
              ? `商品档案 ${catalogTotal ?? total} 个 · 当前筛选 ${total} 个`
              : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/v2/supply-chain/home" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button text-gray2">← 返回工作台</a>
          <button onClick={openCreate} className="rounded-cta bg-accent px-4 py-2.5 text-button text-white">＋ 新增商品</button>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px]">
        <ProductToolTabs />
        <div className="flex items-start gap-4">
          <aside className="mt-4 hidden w-56 shrink-0 overflow-hidden rounded-card border border-border bg-white lg:block">
            <div className="flex items-center justify-between border-b border-border bg-bg px-4 py-3">
              <b className="text-button">分类管理</b>
              <span className="font-num text-micro text-gray3">{categories.length} 个</span>
            </div>
            <nav className="flex flex-col gap-1 p-2" aria-label="按分类筛选商品">
              <button
                onClick={() => updateFilters({ category: '' })}
                aria-pressed={!filters.category}
                className={`flex items-center justify-between gap-2 rounded-cta px-3 py-2 text-left text-caption transition-colors ${filters.category ? 'text-gray2 hover:bg-bg' : 'bg-accent/10 font-bold text-accent'}`}
              >
                <span>全部分类</span>
                <span className={`font-num text-micro ${filters.category ? 'text-gray3' : 'text-accent'}`}>
                  {totalCategoryCount}
                </span>
              </button>
              {displayCategories.map(cat => {
                const active = filters.category === cat.name
                return (
                  <button
                    key={cat.name}
                    onClick={() => updateFilters({ category: active ? '' : cat.name })}
                    aria-pressed={active}
                    title={cat.name}
                    className={`flex items-center justify-between gap-2 rounded-cta px-3 py-2 text-left text-caption transition-colors ${active ? 'bg-accent/10 font-bold text-accent' : 'text-gray2 hover:bg-bg'}`}
                  >
                    <span className="truncate">{cat.name}</span>
                    <span className={`font-num text-micro ${active ? 'text-accent' : 'text-gray3'}`}>{cat.count ?? 0}</span>
                  </button>
                )
              })}
              {categories.length === 0 && (
                <p className="px-3 py-4 text-center text-micro text-gray3">暂无分类，可在新增商品时创建</p>
              )}
            </nav>
            <p className="border-t border-border px-4 py-2.5 text-micro text-gray3">内联新建分类入口在「新增商品」弹窗中</p>
          </aside>
          <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-end gap-3 py-4">
          <FilterInput label="关键字" value={filters.q} onChange={value => updateFilters({ q: value })} placeholder="名称 / 编码 / 规格" />
          <FilterSelect label="分类" value={filters.category} onChange={value => updateFilters({ category: value })}>
            <option value="">全部分类</option>
            {displayCategories.map(cat => <option key={cat.name} value={cat.name}>{cat.name} ({cat.count})</option>)}
          </FilterSelect>
          <FilterSelect label="状态" value={filters.status} onChange={value => updateFilters({ status: value })}>
            <option value="">全部状态</option>
            {SUPPLY_PRODUCT_STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
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
              <table className="w-full table-fixed text-left text-caption">
                <thead className="bg-bg text-gray3">
                  <tr>
                    <th className="w-9 px-3 py-3">
                      <input
                        type="checkbox"
                        checked={currentPageSelected}
                        onChange={e => selectCurrentPage(e.target.checked)}
                        aria-label="从表头选择当前页全部商品"
                      />
                    </th>
                    <th className="w-[245px] px-3 py-3">商品</th>
                    <th className="w-[76px] px-3 py-3">分类</th>
                    <th className="w-[190px] px-3 py-3">采购来源</th>
                    <th className="w-[110px] px-3 py-3 text-right">库存 / 安全线</th>
                    <th className="w-[96px] px-3 py-3 text-right">最小下单量</th>
                    <th className="w-[120px] px-3 py-3 text-right">采购价</th>
                    <th className="w-[94px] px-3 py-3">状态</th>
                    <th className="w-[132px] px-3 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {products.map(product => {
                    const imageUrl = resolveProductImageUrl(product.imageUrl)
                    const selected = selectedIds.has(product.id)
                    const unitValues = buildFourUnitValues(fourUnitFormFromProduct(product))
                    const orderUnitHint = formatOrderUnitPriceHint(Number(product.price), product)
                    return (
                      <tr key={product.id} className={`hover:bg-bg/50 ${selected ? 'bg-accent/5' : ''}`}>
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelected(product.id)}
                            aria-label={`选择 ${product.name}`}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 items-center gap-3">
                            {imageUrl ? (
                              <button onClick={() => setPreview({ url: imageUrl, name: product.name })} className="shrink-0">
                                <img src={imageUrl} alt={productImageAlt(product.name, product.code)} className="h-10 w-10 rounded object-cover" />
                              </button>
                            ) : (
                              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-bg text-micro text-gray3">—</span>
                            )}
                            <div className="min-w-0">
                              <b className="block truncate" title={product.name}>{product.name}</b>
                              <div className="mt-0.5 truncate font-num text-micro text-gray3" title={`${product.code || '无编码'} · ${product.spec || '无规格'}`}>
                                {product.code || '无编码'} · {product.spec || '无规格'}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-gray2">
                          <span className="block truncate" title={product.category || '未分类'}>{product.category || '未分类'}</span>
                        </td>
                        <td className="px-3 py-3">
                          {product.upstreamSources?.length ? (
                            <>
                              <span className="block truncate text-gray2" title={product.upstreamSources.find(source => source.isPrimary)?.supplier.name || product.upstreamSources[0].supplier.name}>
                                {product.upstreamSources.find(source => source.isPrimary)?.supplier.name || product.upstreamSources[0].supplier.name}
                                {product.upstreamSources.some(source => source.isPrimary) ? '（主供）' : ''}
                              </span>
                              <span className="mt-0.5 block text-micro text-gray3">
                                {product.upstreamSources.length > 1 ? `共 ${product.upstreamSources.length} 家 · ` : ''}
                                <button onClick={() => openSources(product)} className="text-accent">维护</button>
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="block text-micro text-amber-fg">尚未维护</span>
                              <button onClick={() => openSources(product)} className="mt-0.5 text-button text-accent">添加来源</button>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right font-num">
                          <b>{formatProductQuantity(product.stock)}</b>
                          <span className="mt-0.5 block text-micro text-gray3">安全 {formatProductQuantity(product.minStock)}</span>
                        </td>
                        <td className="px-3 py-3 text-right font-num">
                          <b>{formatProductQuantity(product.minOrderQty)}</b>
                          <span className="mt-0.5 block text-micro text-gray3">{unitValues.orderUnit}</span>
                        </td>
                        <td className="px-3 py-3 text-right font-num">
                          <>
                            {formatMoney(product.price)}
                            <span className="block text-micro text-gray2">
                              元 / {unitValues.costUnit}
                            </span>
                            {orderUnitHint && (
                              <span className="block text-micro text-gray2">{orderUnitHint}</span>
                            )}
                          </>
                        </td>
                        <td className="px-3 py-3"><span className="whitespace-nowrap"><Chip tone={productStatusTone(product.status)}>{formatProductStatusLabel(product.status)}</Chip></span></td>
                        <td className="px-3 py-3">
                          <div className="flex items-center justify-end gap-2 whitespace-nowrap">
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
                                  : '启用'}
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
          </div>
        </div>
      </main>

      {formOpen && (
        <FormDialog
          editing={editing}
          form={form}
          formError={formError}
          submitting={submitting || uploading}
          pendingImagePreview={pendingImagePreview}
          categories={formCategories ?? categories}
          suppliers={suppliers}
          priceOnly={false}
          creatingCategory={creatingCategory}
          categoryNotice={categoryNotice}
          canCreateCategory={editing ? Boolean(editing.supplier?.id) : Boolean(form.supplierId)}
          onFieldChange={handleFieldChange}
          onBatchFieldChange={handleBatchFieldChange}
          onCreateCategory={createCategory}
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
          creatingCategory={false}
          categoryNotice={null}
          canCreateCategory={false}
          onFieldChange={(_key, value) => setNewPrice(value)}
          onCreateCategory={() => {}}
          onImageSelect={() => {}}
          onImageClear={() => {}}
          onSubmit={submitPriceChange}
          onClose={() => setPriceTarget(null)}
          imageInputRef={null}
        />
      )}

      {sourceProduct && (
        <SourceDialog
          product={sourceProduct}
          rows={sourceRows}
          suppliers={upstreamSuppliers}
          loading={sourceLoading}
          saving={sourceSaving}
          error={sourceError}
          onAdd={addSourceRow}
          onChange={updateSourceRow}
          onRemove={removeSourceRow}
          onSave={saveSources}
          onClose={() => setSourceProduct(null)}
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

function SourceDialog({
  product, rows, suppliers, loading, saving, error,
  onAdd, onChange, onRemove, onSave, onClose,
}: {
  product: ProductRow
  rows: SourceFormRow[]
  suppliers: UpstreamSupplierOption[]
  loading: boolean
  saving: boolean
  error: string | null
  onAdd: () => void
  onChange: (index: number, changes: Partial<SourceFormRow>) => void
  onRemove: (index: number) => void
  onSave: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[calc(100vh-2rem)] w-full max-w-5xl overflow-y-auto rounded-card bg-white p-5 shadow-lg"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <h2 className="text-h2">采购来源 · {product.name}</h2>
            <p className="mt-1 text-caption text-gray3">
              维护总仓向谁采购；这里不改变该商品面向门店的内部履约关系。
            </p>
          </div>
          <button onClick={onClose} className="text-h2 text-gray3 hover:text-ink">×</button>
        </div>

        {loading ? (
          <div className="py-10 text-center text-caption text-gray3">正在读取采购来源…</div>
        ) : (
          <div className="mt-4 space-y-3">
            {rows.map((row, index) => (
              <div key={`${row.supplierId}-${index}`} className="rounded-card border border-border bg-bg p-4">
                <div className="grid gap-3 md:grid-cols-12">
                  <label className="flex flex-col gap-1 md:col-span-4">
                    <span className="text-micro text-gray3">上游供应商 *</span>
                    <select
                      value={row.supplierId}
                      onChange={event => onChange(index, { supplierId: event.target.value })}
                      className="h-10 rounded-cta border border-border bg-white px-3 text-body"
                    >
                      {suppliers.map(supplier => (
                        <option
                          key={supplier.id}
                          value={supplier.id}
                          disabled={rows.some((item, rowIndex) => rowIndex !== index && item.supplierId === supplier.id)}
                        >
                          {supplier.no ? `${supplier.no} · ` : ''}{supplier.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 md:col-span-3">
                    <span className="text-micro text-gray3">供应商商品编码</span>
                    <input
                      value={row.supplierSku}
                      onChange={event => onChange(index, { supplierSku: event.target.value })}
                      className="h-10 rounded-cta border border-border bg-white px-3 text-body"
                      placeholder="可选"
                    />
                  </label>
                  <label className="flex items-center gap-2 self-end pb-2 text-caption text-gray2 md:col-span-3">
                    <input
                      type="radio"
                      name="primary-upstream-source"
                      checked={row.isPrimary}
                      onChange={() => onChange(index, { isPrimary: true })}
                    />
                    主供应商
                  </label>
                  <div className="flex items-end justify-end md:col-span-2">
                    <button onClick={() => onRemove(index)} className="h-10 px-2 text-button text-red-fg">移除</button>
                  </div>

                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-micro text-gray3">采购单位 *</span>
                    <input
                      value={row.purchaseUnit}
                      onChange={event => onChange(index, { purchaseUnit: event.target.value })}
                      className="h-10 rounded-cta border border-border bg-white px-3 text-body"
                      placeholder="箱 / 件 / kg"
                    />
                  </label>
                  <label className="flex flex-col gap-1 md:col-span-3">
                    <span className="text-micro text-gray3">1 采购单位 = 库存单位 *</span>
                    <input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      value={row.inventoryUnitsPerPurchaseUnit}
                      onChange={event => onChange(index, { inventoryUnitsPerPurchaseUnit: event.target.value })}
                      className="h-10 rounded-cta border border-border bg-white px-3 font-num text-body"
                    />
                  </label>
                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-micro text-gray3">最新含税报价</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.quotedUnitPrice}
                      onChange={event => onChange(index, { quotedUnitPrice: event.target.value })}
                      className="h-10 rounded-cta border border-border bg-white px-3 font-num text-body"
                      placeholder="可选"
                    />
                  </label>
                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-micro text-gray3">起订量 *</span>
                    <input
                      type="number"
                      min="0.000001"
                      step="0.001"
                      value={row.minOrderQty}
                      onChange={event => onChange(index, { minOrderQty: event.target.value })}
                      className="h-10 rounded-cta border border-border bg-white px-3 font-num text-body"
                    />
                  </label>
                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-micro text-gray3">交期（天）*</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={row.leadTimeDays}
                      onChange={event => onChange(index, { leadTimeDays: event.target.value })}
                      className="h-10 rounded-cta border border-border bg-white px-3 font-num text-body"
                    />
                  </label>
                  <label className="flex flex-col gap-1 md:col-span-1">
                    <span className="text-micro text-gray3">库存单位</span>
                    <span className="flex h-10 items-center text-caption text-gray2">{product.inventoryUnit || product.unit || '件'}</span>
                  </label>
                  <label className="flex flex-col gap-1 md:col-span-12">
                    <span className="text-micro text-gray3">备注</span>
                    <input
                      value={row.note}
                      onChange={event => onChange(index, { note: event.target.value })}
                      className="h-10 rounded-cta border border-border bg-white px-3 text-body"
                      placeholder="账期、联系人、特殊约定等，可选"
                    />
                  </label>
                </div>
              </div>
            ))}

            {rows.length === 0 && (
              <div className="rounded-card border border-dashed border-border px-4 py-8 text-center">
                <p className="text-caption text-gray2">尚未维护采购来源</p>
                <p className="mt-1 text-micro text-gray3">请从“上游供应商管理”中选择真实供货方。</p>
              </div>
            )}

            <button
              onClick={onAdd}
              disabled={rows.length >= suppliers.length}
              className="rounded-cta border border-accent/30 bg-accent/5 px-4 py-2 text-button text-accent disabled:opacity-40"
            >＋ 添加采购来源</button>
          </div>
        )}

        {error && <p className="mt-3 rounded-cta bg-red-bg px-3 py-2 text-caption text-red-fg">{error}</p>}

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-micro text-gray3">同一商品可有多家来源，但只能有一家主供应商。</p>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving} className="rounded-cta border border-border bg-white px-4 py-2 text-button text-gray2 disabled:opacity-40">取消</button>
            <button onClick={onSave} disabled={loading || saving} className="rounded-cta bg-accent px-4 py-2 text-button text-white disabled:opacity-40">
              {saving ? '保存中…' : '保存采购来源'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FormDialog({
  editing, form, formError, submitting, pendingImagePreview, categories, suppliers, priceOnly,
  creatingCategory, categoryNotice, canCreateCategory,
  onFieldChange, onBatchFieldChange, onCreateCategory, onImageSelect, onImageClear, onSubmit, onClose, imageInputRef,
}: {
  editing: ProductRow | null
  form: FormState
  formError: string | null
  submitting: boolean
  pendingImagePreview: string | null
  categories: CategoryOption[]
  suppliers: SupplierOption[]
  priceOnly: boolean
  creatingCategory: boolean
  categoryNotice: string | null
  canCreateCategory: boolean
  onFieldChange: (key: string, value: string) => void
  onBatchFieldChange?: (changes: Partial<FormState>) => void
  onCreateCategory: () => void
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
  const bodyNote = editing && !priceOnly
    ? '只修改商品档案；价格使用列表「调价」，库存使用「仓库库存」。保存后直接生效并通知总厨。'
    : '直接生效并通知总厨'
  const fourUnitValues = buildFourUnitValues(form)
  const unitSummary = formatConversionSummary(fourUnitValues)
  // 简化口径：订货跟随采购、成本跟随库存。简化界面只问两个单位和一个换算，
  // 不再平铺八个格子；历史档案（成本单位≠库存单位等）直接进高级模式原样展示。
  const simpleUnitContract = isSimpleFourUnitContract(fourUnitValues)
  const [unitAdvancedOpen, setUnitAdvancedOpen] = useState(!simpleUnitContract)
  // 规格自动解析：规格写了净含量（如 箱/150g*50包）就能推出换算，免手填。
  const specConversion = parseSpecConversion(form.spec)
  const specApplies = Boolean(specConversion)
    && (specConversion!.inventoryUnit !== form.inventoryUnit.trim()
      || specConversion!.factor !== Number(form.inventoryUnitsPerPurchaseUnit))
  // datalist 的原生下拉箭头在部分浏览器点击无响应，这里提供一个可点击的候选列表作为可靠入口
  const [categoryListOpen, setCategoryListOpen] = useState(false)

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
            {!editing && suppliers.length > 1 && (
              <FormField label="内部履约主体">
                <select
                  value={form.supplierId}
                  onChange={e => onFieldChange('supplierId', e.target.value)}
                  className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body"
                >
                  <option value="">请选择内部履约主体</option>
                  {suppliers.map(supplier => (
                    <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                  ))}
                </select>
              </FormField>
            )}
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
            <FormField label="名称" required full={Boolean(editing)}>
              <input
                type="text"
                value={form.name}
                onChange={e => onFieldChange('name', e.target.value)}
                maxLength={80}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                autoFocus
              />
            </FormField>
            {!editing && (
              <FormField label="编码">
                <input
                  type="text"
                  value={form.code}
                  onChange={e => onFieldChange('code', e.target.value)}
                  maxLength={40}
                  placeholder="留空自动生成"
                  className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                />
              </FormField>
            )}
            <FormField label="分类" full={Boolean(editing)}>
              <div className="relative">
                <input
                  type="text"
                  value={form.category}
                  onChange={e => { onFieldChange('category', e.target.value); setCategoryListOpen(false) }}
                  maxLength={40}
                  list="supply-product-category-options"
                  placeholder="选择已有分类或输入新分类名"
                  className="h-10 w-full rounded-cta border border-border bg-white pl-3 pr-9 text-body outline-none focus:border-accent"
                />
                <button
                  type="button"
                  aria-label="展开分类列表"
                  aria-expanded={categoryListOpen}
                  onClick={() => setCategoryListOpen(open => !open)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-gray3 hover:text-ink"
                >▾</button>
                {categoryListOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setCategoryListOpen(false)} />
                    <div className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-cta border border-border bg-white shadow-lg">
                      {categories.length === 0 ? (
                        <p className="px-3 py-2 text-micro text-gray3">暂无分类，可输入新分类名</p>
                      ) : (
                        categories.map(cat => (
                          <button
                            key={cat.name}
                            type="button"
                            onClick={() => { onFieldChange('category', cat.name); setCategoryListOpen(false) }}
                            className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-caption hover:bg-bg ${form.category === cat.name ? 'font-bold text-accent' : 'text-gray2'}`}
                          >
                            <span className="truncate">{cat.name}</span>
                            <span className="font-num text-micro text-gray3">{cat.count ?? 0}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
              <datalist id="supply-product-category-options">
                {categories.map(cat => <option key={cat.name} value={cat.name} />)}
              </datalist>
              {canCreateCategory && isNewCategoryName(form.category, categories) && (
                <button
                  type="button"
                  onClick={onCreateCategory}
                  disabled={creatingCategory || submitting}
                  className="mt-1 self-start rounded-cta border border-accent/30 bg-accent/5 px-3 py-1.5 text-button text-accent disabled:opacity-40"
                >
                  {creatingCategory ? '创建中…' : `创建并选用「${form.category.trim()}」`}
                </button>
              )}
              {categoryNotice && (
                <span className="mt-1 text-micro text-green-fg">{categoryNotice}</span>
              )}
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
            <div className="col-span-2 rounded-cta border border-border bg-bg px-3 py-2">
              <div className="text-caption text-gray2">
                单位换算
                <span className="ml-2 text-micro text-gray3">{unitSummary}</span>
              </div>
              {!unitAdvancedOpen ? (
                <div className="mt-3 rounded-lg bg-white p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <FormField label="采购单位（向供应商下单、门店要货）">
                      <input
                        type="text"
                        value={form.purchaseUnit}
                        onChange={e => onFieldChange('purchaseUnit', e.target.value)}
                        maxLength={16}
                        placeholder="箱 / 件 / 瓶"
                        className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                      />
                    </FormField>
                    <FormField label="库存最小单位（仓库和成本按它记）">
                      <input
                        type="text"
                        value={form.inventoryUnit}
                        onChange={e => onFieldChange('inventoryUnit', e.target.value)}
                        maxLength={16}
                        placeholder="g / ml / 个"
                        className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                      />
                    </FormField>
                    <FormField label={`1 ${form.purchaseUnit.trim() || '采购单位'} = ？${form.inventoryUnit.trim() || '库存单位'}`} full>
                      <input
                        type="number"
                        min="0.000001"
                        step="0.000001"
                        value={form.inventoryUnitsPerPurchaseUnit}
                        onChange={e => onFieldChange('inventoryUnitsPerPurchaseUnit', e.target.value)}
                        className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                      />
                    </FormField>
                  </div>
                  {specConversion && specApplies && (
                    <button
                      type="button"
                      onClick={() => onBatchFieldChange?.({
                        inventoryUnit: specConversion.inventoryUnit,
                        inventoryUnitsPerPurchaseUnit: String(specConversion.factor),
                      })}
                      className="mt-1 rounded-cta border border-accent/30 bg-accent/5 px-3 py-1.5 text-button text-accent"
                    >
                      按规格「{form.spec}」自动填：1 {form.purchaseUnit.trim() || '采购单位'} = {specConversion.factor} {specConversion.inventoryUnit}
                    </button>
                  )}
                  <p className="mt-2 text-micro leading-5 text-gray3">
                    订货单位自动跟随采购单位，成本按库存最小单位计算，都不用填。
                    <button
                      type="button"
                      onClick={() => setUnitAdvancedOpen(true)}
                      className="ml-2 text-accent underline"
                    >
                      订货或成本单位不同？展开高级设置
                    </button>
                  </p>
                </div>
              ) : (
                <div className="mt-3 rounded-lg bg-white p-3">
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
                  <FormField label={editing ? '成本单位（建档口径）' : '成本单位（=库存单位）'}>
                    <input
                      type="text"
                      value={form.costUnit}
                      readOnly
                      className="h-10 w-full cursor-not-allowed rounded-cta border border-border bg-bg px-3 text-body text-gray3 outline-none"
                    />
                  </FormField>
                  <FormField label="1 成本单位 = ？库存单位" full>
                    <input
                      type="number"
                      value={form.inventoryUnitsPerCostUnit}
                      readOnly
                      className="h-10 w-full cursor-not-allowed rounded-cta border border-border bg-bg px-3 text-body text-gray3 outline-none"
                    />
                  </FormField>
                  <p className="col-span-2 text-micro leading-5 text-gray3">
                    {editing
                      ? '编辑保留建档时的单位口径与成本价；调价请用列表「调价」入口。如需调整成本单位本身，请联系管理员按折算价一并处理。'
                      : '成本单位固定为库存单位（最小单位），换算因子为 1，与美团口径一致；如需调整请改库存单位。'}
                  </p>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-micro text-gray2">
                    {formatConversionSummary(buildFourUnitValues(form))}
                  </p>
                  {simpleUnitContract && (
                    <button
                      type="button"
                      onClick={() => setUnitAdvancedOpen(false)}
                      className="text-micro text-accent underline"
                    >
                      返回简化填写
                    </button>
                  )}
                </div>
                </div>
              )}
            </div>
            {!editing && (
              <>
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
              </>
            )}
            <FormField label="最小下单量">
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={form.minOrderQty}
                onChange={e => onFieldChange('minOrderQty', e.target.value)}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              />
            </FormField>
            <details className="col-span-2 rounded-cta border border-border bg-bg px-3 py-2">
              <summary className="cursor-pointer text-caption text-gray2">更多设置</summary>
              <div className="mt-3 grid grid-cols-2 items-end gap-3">
                {editing && (
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
                )}
                <FormField label="下单增量">
                  <input
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={form.stepQty}
                    onChange={e => onFieldChange('stepQty', e.target.value)}
                    className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                  />
                </FormField>
                <p className="col-span-2 text-micro leading-5 text-gray3">
                  超过最小下单量后，每次可以增加的数量。例如最小 2、增量 0.5，可下单 2、2.5、3。
                </p>
              </div>
            </details>
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
