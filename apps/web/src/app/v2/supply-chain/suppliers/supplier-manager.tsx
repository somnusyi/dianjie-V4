/**
 * 内部供应链 · 总仓上游供应商管理（桌面端）
 *
 * 服务供应链员工，替代面向老板/管理员的通用账号维护页。
 * 只读取 businessScope=WAREHOUSE_UPSTREAM，避免把门店履约方和测试供应商
 * 混入供应链采购档案。不展示银行账号、密钥等敏感字段。
 */
'use client'
import { SearchableSelect } from '@/components/v2/searchable-select'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { EmptyState, FriendlyError, SkeletonList } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'
import { clientRequestId } from '@/lib/client-id'
import { readPendingSupplierCreate, savePendingSupplierCreate, clearPendingSupplierCreate, type PendingSupplierCreate } from '@/lib/supplier-create-pending'
import { buildBindItems, type RelationProduct } from '@/lib/supply-relations'
import {
  applySupplierFilters,
  buildSupplierCreatePayload,
  buildSupplierUpdatePayload,
  DEFAULT_SUPPLY_SUPPLIER_FILTERS,
  EMPTY_SUPPLIER_FORM_VALUES,
  formatCreditDays,
  formatSupplierStatusLabel,
  getSupplierDetailStats,
  hasActiveFilters,
  initializeSupplierFormValues,
  keepFiltersForPage,
  paginateSuppliers,
  resetPageFilters,
  supplierStatusTone,
  SUPPLIER_CREDIT_TYPE_OPTIONS,
  SUPPLY_SUPPLIER_STATUS_OPTIONS,
  validateSupplierForm,
  type SupplySupplier,
  type SupplySupplierFilters,
  type SupplierFormValues,
} from '@/lib/supply-supplier-pc'

export default function InternalSupplyChainSuppliersPage() {
  return <SupplierManager />
}

export function SupplierManager({ editSupplierId }: { editSupplierId?: string } = {}) {
  const [allSuppliers, setAllSuppliers] = useState<SupplySupplier[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<SupplySupplierFilters>(DEFAULT_SUPPLY_SUPPLIER_FILTERS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [drawerMode, setDrawerMode] = useState<'create' | 'edit' | null>(null)
  const [formValues, setFormValues] = useState<SupplierFormValues>(EMPTY_SUPPLIER_FORM_VALUES)
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof SupplierFormValues, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingCreate, setPendingCreate] = useState<PendingSupplierCreate | null>(null)
  const submitRef = useRef(false)
  const autoNumberRef = useRef(false)
  const [catalog, setCatalog] = useState<RelationProduct[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])

  const [confirmState, openConfirm] = useConfirmSheet()
  const abortRef = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)

  const filtered = useMemo(() => applySupplierFilters(allSuppliers ?? [], filters), [allSuppliers, filters])
  const paged = useMemo(() => paginateSuppliers(filtered, filters.page, filters.pageSize), [filtered, filters.page, filters.pageSize])
  const totalPages = Math.max(1, Math.ceil(filtered.length / filters.pageSize))
  const selected = useMemo(() => allSuppliers?.find(s => s.id === selectedId) || null, [allSuppliers, selectedId])

  function load(preferredSelectedId = selectedId) {
    const sequence = ++requestSequence.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    apiFetch<SupplySupplier[]>('/api/suppliers?businessScope=WAREHOUSE_UPSTREAM', { signal: controller.signal })
      .then(data => {
        if (sequence !== requestSequence.current) return
        const list = Array.isArray(data) ? data : []
        setAllSuppliers(list)
        if (preferredSelectedId) {
          setSelectedId(list.some(s => s.id === preferredSelectedId) ? preferredSelectedId : null)
        }
      })
      .catch(reason => {
        if (sequence !== requestSequence.current) return
        if (reason?.name === 'AbortError') return
        setError(String(reason?.message || reason))
      })
      .finally(() => {
        if (sequence === requestSequence.current) setLoading(false)
      })
  }

  useEffect(() => {
    load()
    return () => { abortRef.current?.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!allSuppliers) return
    const editId = editSupplierId
    if (!editId) return
    const supplier = allSuppliers.find(item => item.id === editId)
    if (supplier) openEditDrawer(supplier)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSuppliers, editSupplierId])

  function updateFilters(changes: Partial<SupplySupplierFilters>) {
    setFilters(current => resetPageFilters(current, changes))
  }

  function clearFilters() {
    setFilters({ ...DEFAULT_SUPPLY_SUPPLIER_FILTERS })
  }

  function toggleStatus(supplier: SupplySupplier) {
    const next = supplier.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    const isDisable = next === 'DISABLED'
    openConfirm({
      title: isDisable ? `停用供应商「${supplier.name}」？` : `启用供应商「${supplier.name}」？`,
      body: isDisable
        ? '停用后总仓采购、入库来源和商品关联等场景将不再显示该供应商。'
        : '启用后该供应商将重新出现在总仓采购候选中。',
      confirmLabel: isDisable ? '确认停用' : '确认启用',
      tone: isDisable ? 'danger' : 'primary',
      onConfirm: async () => {
        setTogglingId(supplier.id)
        try {
          await apiFetch<{ status: string }>(`/api/suppliers/${supplier.id}/toggle`, { method: 'PATCH' })
          setNotice(`${supplier.name} 已${isDisable ? '停用' : '启用'}`)
          setAllSuppliers(prev =>
            prev
              ? prev.map(s => (s.id === supplier.id ? { ...s, status: next } : s))
              : prev,
          )
        } catch (reason: any) {
          setError(reason?.message || '操作失败')
        } finally {
          setTogglingId(null)
        }
      },
    })
  }

  function openCreateDrawer() {
    setFormValues(EMPTY_SUPPLIER_FORM_VALUES)
    setFormErrors({})
    setFormError(null)
    setSelectedProductIds([])
    setDrawerMode('create')
    autoNumberRef.current = false
    let recovered: PendingSupplierCreate | null = null
    try {
      const pending = readPendingSupplierCreate()
      recovered = pending
      setPendingCreate(pending)
      if (pending) {
        setFormValues(pending.formValues)
        setSelectedProductIds(pending.items.map(item => item.productId))
        setFormError('上次创建结果待确认，保存将重试原请求；不能更改内容')
      }
    } catch (reason: any) { setFormError(reason.message); setDrawerMode(null); setError(reason.message); return }
    if (!recovered) {
      apiFetch<{ no: string }>('/api/suppliers/next-number')
        .then(result => {
          if (typeof result.no !== 'string') return
          setFormValues(current => {
            if (current.no) return current
            autoNumberRef.current = true
            return { ...current, no: result.no }
          })
        })
        .catch(() => setFormError('自动编号读取失败，可手工填写编号或关闭后重试'))
    }
    setCatalogLoading(true)
    apiFetch<RelationProduct[]>('/api/products')
      .then(rows => setCatalog((Array.isArray(rows) ? rows : []).filter(product => product.status === 'ENABLED').map(product => {
        const saved = recovered?.items.find(item => item.productId === product.id)
        return saved ? { ...product, purchaseUnit: saved.purchaseUnit, inventoryUnitsPerPurchaseUnit: saved.inventoryUnitsPerPurchaseUnit } : product
      })))
      .catch(reason => setFormError(`供货商品读取失败：${reason?.message || reason}`))
      .finally(() => setCatalogLoading(false))
  }

  function openEditDrawer(supplier: SupplySupplier) {
    setSelectedId(supplier.id)
    setFormValues(initializeSupplierFormValues(supplier))
    setFormErrors({})
    setFormError(null)
    setDrawerMode('edit')
  }

  function closeDrawer() {
    setDrawerMode(null)
  }

  function handleFormChange(field: keyof SupplierFormValues, value: string) {
    if (saving || (drawerMode === 'create' && pendingCreate)) return
    if (field === 'no') autoNumberRef.current = false
    setFormValues(prev => ({ ...prev, [field]: value }))
    setFormErrors(prev => {
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  async function handleFormSubmit() {
    if (submitRef.current) return
    const errors = validateSupplierForm(formValues)
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    if (drawerMode === 'create' && !pendingCreate) {
      if (selectedProductIds.length === 0) {
        setFormError('新建供应商必须至少选择一个供货商品')
        return
      }
      const selectedProducts = catalog.filter(product => selectedProductIds.includes(product.id))
      if (selectedProducts.length !== selectedProductIds.length) {
        setFormError('所选商品资料不完整，请重新加载商品后再保存；供应商尚未创建')
        return
      }
      const { missingConversion } = buildBindItems(selectedProducts)
      missingConversion.push(...selectedProducts.filter(product => !product.purchaseUnit?.trim()).map(product => product.id))
      if (missingConversion.length > 0) {
        const names = selectedProducts.filter(product => missingConversion.includes(product.id)).map(product => product.name).join('、')
        setFormError(`请先补齐 ${names} 的采购单位换算；供应商尚未创建，表单和选择已保留`)
        return
      }
    }
    submitRef.current = true
    setSaving(true)
    setFormError(null)
    try {
      if (drawerMode === 'create') {
        const request = pendingCreate || {
          requestKey: clientRequestId(), numberMode: autoNumberRef.current ? 'AUTO' as const : 'MANUAL' as const, supplier: buildSupplierCreatePayload(formValues),
          items: buildBindItems(catalog.filter(product => selectedProductIds.includes(product.id))).items,
          formValues: { ...formValues },
        }
        // Persist before sending; reload/network uncertainty must replay the identical request.
        savePendingSupplierCreate(request)
        setPendingCreate(request)
        const created = await apiFetch<SupplySupplier>('/api/suppliers/create-with-products', {
          method: 'POST', body: JSON.stringify({ requestKey: request.requestKey, numberMode: request.numberMode || 'MANUAL', supplier: request.supplier, items: request.items }),
        })
        clearPendingSupplierCreate()
        setPendingCreate(null)
        setNotice(`上游供应商新增成功，已绑定 ${request.items.length} 个供货商品`)
        closeDrawer()
        // 全量列表按创建时间升序分页；新记录通常落在最后一页。
        // 保存后直接按新编号定位，避免用户误以为创建结果“消失”。
        setFilters(current => resetPageFilters(current, { q: created.no, status: '' }))
        load(created.id)
      } else if (drawerMode === 'edit' && selected) {
        const updated = await apiFetch<SupplySupplier>(`/api/suppliers/${selected.id}`, {
          method: 'PATCH',
          body: JSON.stringify(buildSupplierUpdatePayload(formValues)),
        })
        setNotice(`${selected.name} 档案已更新`)
        if (!editSupplierId) closeDrawer()
        load(updated.id)
      }
    } catch (reason: any) {
      if (drawerMode === 'create' && [400, 403, 404, 409].includes(reason?.status)) {
        clearPendingSupplierCreate()
        setPendingCreate(null)
      }
      setFormError(reason?.message || '保存结果待确认，请重试原请求')
    } finally {
      submitRef.current = false
      setSaving(false)
    }
  }

  const filterActive = hasActiveFilters(filters)

  if (editSupplierId) {
    return <div className="min-h-screen bg-bg px-4 py-6 lg:px-8">
      {notice && <div role="status" className="mx-auto mb-4 max-w-[1100px] rounded-lg border border-green-fg/20 bg-green-bg px-4 py-3 text-caption text-green-fg">{notice}</div>}
      {error && <div className="mx-auto max-w-[1100px]"><FriendlyError message={error} onRetry={load} /></div>}
      {!selected && loading && <div className="mx-auto max-w-[1100px]"><SkeletonList count={4} /></div>}
      {!selected && !loading && <div className="mx-auto max-w-[1100px]"><EmptyState title="未找到供应商" hint="返回供应商总览重新选择" /></div>}
      <SupplierEditorDrawer
        mode={selected ? 'edit' : null}
        presentation="page"
        supplierId={selected?.id}
        values={formValues} errors={formErrors} error={formError} saving={saving} locked={false}
        onChange={handleFormChange} onSubmit={handleFormSubmit}
        onClose={() => { window.location.href = `/v2/supply-chain/suppliers/${encodeURIComponent(editSupplierId)}` }}
        catalog={catalog} catalogLoading={catalogLoading} selectedProductIds={selectedProductIds}
        onSelectedProductIdsChange={setSelectedProductIds}
        onProductConversionChange={(id, field, value) => setCatalog(rows => rows.map(row => row.id === id ? { ...row, [field]: value } : row))}
      />
    </div>
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-h1">上游供应商</h1>
          <p className="mt-1 text-caption text-gray2">
            {allSuppliers ? `${allSuppliers.length} 家上游供应商` : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openCreateDrawer}
            className="rounded-cta bg-accent px-4 py-2.5 text-button text-white"
          >
            新增上游供应商
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px]">
        <section>
          <div className="flex flex-wrap items-end gap-3 py-4">
            <FilterInput
              label="关键字"
              value={filters.q}
              onChange={value => updateFilters({ q: value })}
              placeholder="名称 / 编号"
            />
            <FilterSelect label="状态" value={filters.status} onChange={value => updateFilters({ status: value })}>
              <option value="">全部状态</option>
              {SUPPLY_SUPPLIER_STATUS_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </FilterSelect>
            <button
              onClick={clearFilters}
              disabled={!filterActive}
              className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2 disabled:opacity-40"
            >清空</button>
          </div>

          {notice && (
            <div className="mb-4 flex items-center justify-between rounded-card border border-green-fg/20 bg-green-bg px-4 py-3 text-caption text-green-fg">
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} className="text-button">关闭</button>
            </div>
          )}

          {error && (
            <div className="mb-4">
              <FriendlyError message={error} onRetry={load} />
            </div>
          )}

          {loading && !allSuppliers && <SkeletonList count={5} />}

          {!loading && allSuppliers && filtered.length === 0 && (
            <EmptyState
              icon="🏭"
              title={filterActive ? '没有匹配的上游供应商' : '暂无总仓上游供应商'}
              hint={filterActive ? '尝试调整筛选条件' : '请录入实际向总仓供货的合作方；门店履约方不会显示在这里'}
            />
          )}

          {allSuppliers && filtered.length > 0 && (
            <div className="overflow-hidden rounded-card border border-border bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-caption">
                  <thead className="bg-bg text-gray3">
                    <tr>
                      <th className="px-4 py-3">编号</th>
                      <th className="px-4 py-3">名称</th>
                      <th className="px-4 py-3">状态</th>
                      <th className="px-4 py-3">联系人</th>
                      <th className="px-4 py-3">联系电话</th>
                      <th className="px-4 py-3">账期</th>
                      <th className="px-4 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {paged.map(supplier => (
                      <tr key={supplier.id} className="hover:bg-bg/50">
                        <td className="px-4 py-3 font-num text-gray2">{supplier.no}</td>
                        <td className="px-4 py-3">
                          <a href={`/v2/supply-chain/suppliers/${encodeURIComponent(supplier.id)}`} className="font-medium text-accent hover:underline">{supplier.name}</a>
                          {supplier.category && <span className="ml-2 text-micro text-gray3">{supplier.category}</span>}
                        </td>
                        <td className="px-4 py-3">
                          <Chip tone={supplierStatusTone(supplier.status)}>{formatSupplierStatusLabel(supplier.status)}</Chip>
                        </td>
                        <td className="px-4 py-3 text-gray2">{supplier.contactName || '—'}</td>
                        <td className="px-4 py-3 font-num text-gray2">{supplier.contactPhone || '—'}</td>
                        <td className="px-4 py-3 text-gray2">{formatCreditDays(supplier)}</td>
                        <td className="px-4 py-3 text-right">
                          <a href={`/v2/supply-chain/suppliers/${encodeURIComponent(supplier.id)}`} className="mr-3 text-button text-accent">查看详情</a>
                          <a href={`/v2/supply-chain/suppliers/${encodeURIComponent(supplier.id)}/edit`} className="mr-3 text-button text-accent">编辑档案</a>
                          <button
                            onClick={e => { e.stopPropagation(); toggleStatus(supplier) }}
                            disabled={togglingId === supplier.id}
                            className={`text-button ${supplier.status === 'ENABLED' ? 'text-red-fg' : 'text-green-fg'}`}
                          >
                            {supplier.status === 'ENABLED' ? '停用' : '启用'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {filtered.length > 0 && (
                <PaginationBar
                  page={filters.page}
                  totalPages={totalPages}
                  pageSize={filters.pageSize}
                  total={filtered.length}
                  onPage={page => setFilters(current => keepFiltersForPage(current, page))}
                />
              )}
            </div>
          )}
        </section>


      </main>

      <ConfirmSheet {...confirmState} />

      <SupplierEditorDrawer
        mode={drawerMode}
        supplierId={drawerMode === 'edit' ? selected?.id : undefined}
        values={formValues}
        errors={formErrors}
        error={formError}
        saving={saving}
        locked={drawerMode === 'create' && !!pendingCreate}
        onChange={handleFormChange}
        onSubmit={handleFormSubmit}
        onClose={closeDrawer}
        catalog={catalog}
        catalogLoading={catalogLoading}
        selectedProductIds={selectedProductIds}
        onSelectedProductIdsChange={ids => { if (!saving && !pendingCreate) setSelectedProductIds(ids) }}
        onProductConversionChange={(id, field, value) => {
          if (saving || pendingCreate) return
          setCatalog(rows => rows.map(row => row.id === id ? { ...row, [field]: value } : row))
        }}
      />
    </div>
  )
}

function SupplierEditorDrawer({
  mode,
  presentation = 'modal',
  supplierId,
  values,
  errors,
  error,
  saving,
  locked,
  onChange,
  onSubmit,
  onClose,
  catalog,
  catalogLoading,
  selectedProductIds,
  onSelectedProductIdsChange,
  onProductConversionChange,
}: {
  mode: 'create' | 'edit' | null
  presentation?: 'modal' | 'page'
  supplierId?: string
  values: SupplierFormValues
  errors: Partial<Record<keyof SupplierFormValues, string>>
  error: string | null
  saving: boolean
  locked: boolean
  onChange: (field: keyof SupplierFormValues, value: string) => void
  onSubmit: () => void
  onClose: () => void
  catalog: RelationProduct[]
  catalogLoading: boolean
  selectedProductIds: string[]
  onSelectedProductIdsChange: (ids: string[]) => void
  onProductConversionChange: (id: string, field: 'purchaseUnit' | 'inventoryUnitsPerPurchaseUnit', value: string | number | null) => void
}) {
  const [mounted, setMounted] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [archiveCounts, setArchiveCounts] = useState<{ contracts: number; qualifications: number; finance: number | null; invoice: number | null } | null>(null)
  const [contractNo, setContractNo] = useState('')
  const [contractTitle, setContractTitle] = useState('')
  const [contractStart, setContractStart] = useState('')
  const [contractFiles, setContractFiles] = useState<File[]>([])
  const [qualificationTitle, setQualificationTitle] = useState('')
  const [qualificationFile, setQualificationFile] = useState<File | null>(null)
  const [archiveSaving, setArchiveSaving] = useState<'contract' | 'qualification' | null>(null)
  const [archiveError, setArchiveError] = useState('')
  const [archiveNotice, setArchiveNotice] = useState('')
  const [fileResetKey, setFileResetKey] = useState(0)
  const contractPending = useRef<string | null>(null)
  const qualificationPending = useRef<string | null>(null)
  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    if (mode !== 'edit' || !supplierId) { setArchiveCounts(null); return }
    let active = true
    void apiFetch<{ sections: { contracts: { count: number }; qualifications: { count: number }; finance: { count: number | null }; invoice: { count: number | null } } }>(`/api/suppliers/${encodeURIComponent(supplierId)}/archive`)
      .then(result => { if (active) setArchiveCounts({ contracts: result.sections.contracts.count, qualifications: result.sections.qualifications.count, finance: result.sections.finance.count, invoice: result.sections.invoice.count }) })
      .catch(() => { if (active) setArchiveCounts(null) })
    return () => { active = false }
  }, [mode, supplierId])

  async function uploadArchiveFile(file: File) {
    const form = new FormData()
    form.append('file', file, file.name)
    return apiFetch<{ key: string; name: string; mime: string; size: number }>('/api/upload?category=supplier-archive-general', { method: 'POST', body: form })
  }

  async function saveContractAttachment() {
    if (!supplierId || archiveSaving) return
    if (!contractPending.current && (!contractNo.trim() || !contractTitle.trim() || !contractStart || !contractFiles.length)) {
      setArchiveError('请填写合同编号、名称、生效日并选择图片或 PDF')
      return
    }
    setArchiveSaving('contract')
    setArchiveError('')
    setArchiveNotice('')
    try {
      if (!contractPending.current) {
        const attachments = []
        for (const file of contractFiles.slice(0, 20)) attachments.push(await uploadArchiveFile(file))
        contractPending.current = JSON.stringify({
          supplierId, contractNo: contractNo.trim(), title: contractTitle.trim(), startsAt: contractStart,
          settlementCycle: 'MONTHLY', settlementDays: 0, taxInclusive: true, currency: 'CNY',
          idempotencyKey: clientRequestId(), attachments, lines: [],
        })
      }
      await apiFetch('/api/upstream/contracts', { method: 'POST', body: contractPending.current })
      contractPending.current = null
      setContractNo(''); setContractTitle(''); setContractStart(''); setContractFiles([])
      setFileResetKey(value => value + 1)
      setArchiveCounts(current => current ? { ...current, contracts: current.contracts + 1 } : current)
      setArchiveNotice('合同草稿已保存到该供应商档案')
    } catch (reason: any) {
      if (reason?.status >= 400 && reason.status < 500 && reason.status !== 408 && reason.status !== 429) contractPending.current = null
      setArchiveError(contractPending.current ? '结果待确认，请重试原请求，不要新建另一份合同' : reason?.message || '合同保存失败')
    } finally { setArchiveSaving(null) }
  }

  async function saveQualificationAttachment() {
    if (!supplierId || archiveSaving) return
    if (!qualificationPending.current && (!qualificationTitle.trim() || !qualificationFile)) {
      setArchiveError('请填写资质名称并选择图片或 PDF')
      return
    }
    setArchiveSaving('qualification')
    setArchiveError('')
    setArchiveNotice('')
    try {
      if (!qualificationPending.current) {
        const attachment = await uploadArchiveFile(qualificationFile!)
        qualificationPending.current = JSON.stringify({ section: 'QUALIFICATION', title: qualificationTitle.trim(), note: '', validFrom: null, validUntil: null, attachment, requestKey: clientRequestId() })
      }
      await apiFetch(`/api/suppliers/${encodeURIComponent(supplierId)}/archive`, { method: 'POST', body: qualificationPending.current })
      qualificationPending.current = null
      setQualificationTitle(''); setQualificationFile(null)
      setFileResetKey(value => value + 1)
      setArchiveCounts(current => current ? { ...current, qualifications: current.qualifications + 1 } : current)
      setArchiveNotice('资质图片已保存到该供应商档案')
    } catch (reason: any) {
      if (reason?.status >= 400 && reason.status < 500 && reason.status !== 408 && reason.status !== 429) qualificationPending.current = null
      setArchiveError(qualificationPending.current ? '结果待确认，请重试原请求，不要重复添加资质' : reason?.message || '资质保存失败')
    } finally { setArchiveSaving(null) }
  }

  if (!mode || !mounted) return null

  const title = mode === 'create' ? '新增上游供应商' : '编辑上游供应商档案'
  const isPage = presentation === 'page'
  const noReadOnly = mode === 'edit'
  function requestClose() {
    if (saving || archiveSaving) return
    if (contractPending.current || qualificationPending.current) {
      setArchiveError('附件保存结果待确认，请先重试原请求')
      return
    }
    onClose()
  }

  const sheet = (
    <div
      role={isPage ? 'region' : 'dialog'}
      aria-modal={isPage ? undefined : true}
      aria-label={title}
      className={isPage ? 'mx-auto max-w-[1100px]' : 'fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6'}
      onClick={isPage ? undefined : requestClose}
    >
      {!isPage && <div className="absolute inset-0 bg-ink/60" />}
      <div
        className={isPage ? 'w-full rounded-xl border border-border bg-white' : 'relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[1160px] flex-col overflow-hidden rounded-xl bg-white shadow-xl md:max-h-[calc(100dvh-3rem)]'}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-h2">{title}</h2>
          <button
            onClick={requestClose}
            disabled={saving || Boolean(archiveSaving)}
            className="text-2xl leading-none text-gray3 disabled:opacity-40"
            aria-label={isPage ? '返回供应商详情' : '关闭'}
          >
            {isPage ? '返回详情' : '×'}
          </button>
        </div>

        <div className={isPage ? 'p-6' : 'flex-1 overflow-auto p-6'}><div className={mode === 'edit' ? 'space-y-8' : ''}>
        <fieldset disabled={saving || locked} className="max-w-[850px] space-y-4">
          {error && (
            <div className="rounded-card border border-red-fg/20 bg-red-bg px-4 py-3 text-caption text-red-fg">
              {error}
            </div>
          )}

          <DrawerField label="编号" error={errors.no} required>
            <input
              value={values.no}
              onChange={e => onChange('no', e.target.value)}
              readOnly={noReadOnly}
              maxLength={40}
              className={`h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent ${noReadOnly ? 'cursor-not-allowed bg-bg' : ''}`}
              placeholder="如 SUP001"
            />
          </DrawerField>
          {mode === 'create' && <p className="text-micro text-gray3">建议编号不占号，保存时确认；手工修改后按填写编号创建。</p>}

          <DrawerField label="名称" error={errors.name} required>
            <input
              value={values.name}
              onChange={e => onChange('name', e.target.value)}
              maxLength={80}
              className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              placeholder="供应商全称"
            />
          </DrawerField>

          <div className="grid grid-cols-2 gap-4">
            <DrawerField label="联系人" error={errors.contactName}>
              <input
                value={values.contactName}
                onChange={e => onChange('contactName', e.target.value)}
                maxLength={40}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                placeholder="姓名"
              />
            </DrawerField>
            <DrawerField label="联系电话" error={errors.contactPhone}>
              <input
                value={values.contactPhone}
                onChange={e => onChange('contactPhone', e.target.value)}
                maxLength={20}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                placeholder="电话"
              />
            </DrawerField>
          </div>

          <DrawerField label="类目" error={errors.category}>
            <input
              value={values.category}
              onChange={e => onChange('category', e.target.value)}
              maxLength={40}
              className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              placeholder="如 蔬菜、水产"
            />
          </DrawerField>

          <DrawerField label="联系地址" error={errors.address}>
            <input
              value={values.address}
              onChange={e => onChange('address', e.target.value)}
              maxLength={300}
              className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
              placeholder="供应商公司地址"
            />
          </DrawerField>

          <DrawerField label="账期类型" error={errors.creditType} required>
            <SearchableSelect searchWhenLong searchLabel="搜索账期类型"
              value={values.creditType}
              onChange={e => onChange('creditType', e.target.value)}
              className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body"
            >
              {SUPPLIER_CREDIT_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </SearchableSelect>
          </DrawerField>

          {values.creditType === 'FIXED_DAYS' && (
            <DrawerField label="账期天数" error={errors.creditDays} required>
              <input
                value={values.creditDays}
                onChange={e => onChange('creditDays', e.target.value.replace(/\D/g, '').slice(0, 3))}
                inputMode="numeric"
                maxLength={3}
                className="h-10 w-full rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
                placeholder="0–365"
              />
            </DrawerField>
          )}

          {mode === 'create' && <section className="rounded-card border border-border p-4">
            <div className="flex items-start justify-between gap-3"><div><h3 className="text-body font-medium">供货商品</h3><p className="mt-1 text-micro text-gray3">至少选择一个商品。</p></div><span className="whitespace-nowrap text-caption text-accent">已选 {selectedProductIds.length} 项</span></div>
            <input type="search" value={productQuery} onChange={event => setProductQuery(event.target.value)} placeholder="搜索商品名称 / 编码" className="mt-3 h-10 w-full rounded-cta border border-border px-3 text-body" />
            {catalogLoading ? <p className="py-5 text-center text-caption text-gray3">商品加载中…</p> : <div className="mt-3 max-h-64 space-y-3 overflow-auto">{Array.from(new Set(catalog.map(product => product.category || '未分类'))).map(category => { const rows = catalog.filter(product => (product.category || '未分类') === category && `${product.code} ${product.name}`.toLowerCase().includes(productQuery.trim().toLowerCase())); if (!rows.length) return null; const allSelected = rows.every(product => selectedProductIds.includes(product.id)); return <div key={category} className="rounded-lg bg-bg p-2"><label className="flex items-center gap-2 text-caption font-medium"><input type="checkbox" checked={allSelected} onChange={event => onSelectedProductIdsChange(event.target.checked ? Array.from(new Set([...selectedProductIds, ...rows.map(product => product.id)])) : selectedProductIds.filter(id => !rows.some(product => product.id === id)))} />全选分类：{category}（{rows.length}）</label><div className="mt-2 grid gap-2 sm:grid-cols-2">{rows.map(product => <label key={product.id} className="flex items-start gap-2 text-caption"><input type="checkbox" checked={selectedProductIds.includes(product.id)} onChange={event => onSelectedProductIdsChange(event.target.checked ? [...selectedProductIds, product.id] : selectedProductIds.filter(id => id !== product.id))} /><span><b>{product.name}</b><span className="block text-micro text-gray3">{product.code} · 1 {product.purchaseUnit || product.unit} = {product.inventoryUnitsPerPurchaseUnit || '未维护'} {product.inventoryUnit || product.unit}</span></span></label>)}</div></div> })}{catalog.length === 0 && <p className="py-5 text-center text-caption text-gray3">暂无可绑定商品</p>}</div>}
            {catalog.filter(product => selectedProductIds.includes(product.id)).map(product => <div key={`conversion-${product.id}`} className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-micro text-gray3">{product.name}采购单位<input aria-label={`${product.name}采购单位`} value={product.purchaseUnit || ''} onChange={event => onProductConversionChange(product.id, 'purchaseUnit', event.target.value)} className="mt-1 h-10 w-full rounded-cta border border-border px-3 text-body" /></label>
              <label className="text-micro text-gray3">1采购单位对应库存数量<input aria-label={`${product.name}采购到库存换算`} type="number" min="0.000001" step="any" value={product.inventoryUnitsPerPurchaseUnit ?? ''} onChange={event => onProductConversionChange(product.id, 'inventoryUnitsPerPurchaseUnit', event.target.value === '' ? null : Number(event.target.value))} className="mt-1 h-10 w-full rounded-cta border border-border px-3 text-body" /></label>
            </div>)}
          </section>}
        </fieldset>
        {mode === 'edit' && supplierId && <section className="max-w-[850px] space-y-4 border-t border-border pt-6">
          {archiveError && <div role="alert" className="rounded-lg border border-red-fg/20 bg-red-bg p-3 text-caption text-red-fg">{archiveError}</div>}
          {archiveNotice && <div role="status" className="rounded-lg border border-green-fg/20 bg-green-bg p-3 text-caption text-green-fg">{archiveNotice}</div>}
          <section className="rounded-lg border border-border bg-bg/40 p-4">
            <div className="flex items-center justify-between"><h3 className="text-body font-medium">合同档案</h3><span className="text-caption text-gray3">{archiveCounts?.contracts ?? '—'} 份</span></div>
            <div className="mt-3 space-y-2">
              <input aria-label="合同编号" value={contractNo} onChange={event => setContractNo(event.target.value)} disabled={Boolean(contractPending.current) || Boolean(archiveSaving)} placeholder="合同编号" className="h-10 w-full rounded-md border border-border bg-white px-3 text-caption" />
              <input aria-label="合同名称" value={contractTitle} onChange={event => setContractTitle(event.target.value)} disabled={Boolean(contractPending.current) || Boolean(archiveSaving)} placeholder="合同名称" className="h-10 w-full rounded-md border border-border bg-white px-3 text-caption" />
              <label className="block text-caption text-gray2">生效日<input aria-label="合同生效日" type="date" value={contractStart} onChange={event => setContractStart(event.target.value)} disabled={Boolean(contractPending.current) || Boolean(archiveSaving)} className="mt-1 h-10 w-full rounded-md border border-border bg-white px-3" /></label>
              <label className="block text-caption text-gray2">合同图片 / PDF<input key={`contract-${fileResetKey}`} aria-label="合同图片或PDF" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" onChange={event => setContractFiles(Array.from(event.target.files || []).slice(0, 20))} disabled={Boolean(contractPending.current) || Boolean(archiveSaving)} className="mt-1 block w-full text-caption" /></label>
              <button type="button" onClick={() => void saveContractAttachment()} disabled={Boolean(archiveSaving)} className="w-full rounded-md bg-accent px-3 py-2 text-button text-white disabled:opacity-40">{archiveSaving === 'contract' ? '保存中…' : contractPending.current ? '重试原请求' : '保存合同草稿'}</button>
            </div>
            <a href={`/v2/supply-chain/suppliers/contracts?supplierId=${encodeURIComponent(supplierId)}`} target="_blank" rel="noreferrer" className="mt-3 block text-center text-button text-accent">查看已有合同</a>
          </section>
          <section className="rounded-lg border border-border bg-bg/40 p-4">
            <div className="flex items-center justify-between"><h3 className="text-body font-medium">企业资质</h3><span className="text-caption text-gray3">{archiveCounts?.qualifications ?? '—'} 项</span></div>
            <div className="mt-3 space-y-2">
              <input aria-label="资质名称" value={qualificationTitle} onChange={event => setQualificationTitle(event.target.value)} disabled={Boolean(qualificationPending.current) || Boolean(archiveSaving)} placeholder="资质名称" className="h-10 w-full rounded-md border border-border bg-white px-3 text-caption" />
              <label className="block text-caption text-gray2">资质图片 / PDF<input key={`qualification-${fileResetKey}`} aria-label="资质图片或PDF" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" onChange={event => setQualificationFile(event.target.files?.[0] || null)} disabled={Boolean(qualificationPending.current) || Boolean(archiveSaving)} className="mt-1 block w-full text-caption" /></label>
              <button type="button" onClick={() => void saveQualificationAttachment()} disabled={Boolean(archiveSaving)} className="w-full rounded-md border border-accent bg-white px-3 py-2 text-button text-accent disabled:opacity-40">{archiveSaving === 'qualification' ? '保存中…' : qualificationPending.current ? '重试原请求' : '添加资质'}</button>
            </div>
            <a href={`/v2/supply-chain/suppliers/${encodeURIComponent(supplierId)}/archive`} target="_blank" rel="noreferrer" className="mt-3 block text-center text-button text-accent">查看已有资质</a>
          </section>
          <section className="rounded-lg border border-border bg-bg/40 p-4">
            <h3 className="text-body font-medium">其他资料</h3>
            <div className="mt-3 flex flex-wrap gap-3 text-button text-accent">
              <a href={`/v2/supply-chain/suppliers/${encodeURIComponent(supplierId)}/archive?add=FINANCE`} target="_blank" rel="noreferrer">财务资料{archiveCounts?.finance != null ? `（${archiveCounts.finance}）` : ''}</a>
              <a href={`/v2/supply-chain/suppliers/${encodeURIComponent(supplierId)}/archive?add=INVOICE`} target="_blank" rel="noreferrer">开票资料{archiveCounts?.invoice != null ? `（${archiveCounts.invoice}）` : ''}</a>
            </div>
          </section>
        </section>}
        </div></div>

        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            onClick={requestClose}
            disabled={saving || Boolean(archiveSaving)}
            className="rounded-cta border border-border bg-white px-5 py-2.5 text-button text-gray2 disabled:opacity-40"
          >
            取消
          </button>
          <button
            onClick={onSubmit}
            disabled={saving || Boolean(archiveSaving)}
            className="rounded-cta bg-accent px-5 py-2.5 text-button text-white disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )

  return isPage ? sheet : createPortal(sheet, document.body)
}

function DrawerField({ label, error, required, children }: {
  label: string
  error?: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-micro text-gray3">
        {label}
        {required && <span className="text-red-fg">*</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-micro text-red-fg">{error}</span>}
    </label>
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
    <label className="flex flex-col gap-1">
      <span className="text-micro text-gray3">{label}</span>
      <SearchableSelect searchWhenLong searchLabel={`搜索${label}`}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-10 min-w-36 rounded-cta border border-border bg-white px-3 text-body"
      >
        {children}
      </SearchableSelect>
    </label>
  )
}

function PaginationBar({ page, totalPages, pageSize, total, onPage }: {
  page: number; totalPages: number; total: number; pageSize: number; onPage: (p: number) => void
}) {
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-3 text-caption text-gray2">
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
