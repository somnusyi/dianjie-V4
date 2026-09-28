'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { Chip } from '@/components/v2'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'
import { EmptyState, FriendlyError, SkeletonList } from '@/components/v2/skeleton'
import { clientRequestId } from '@/lib/client-id'
import { confirmDialog, promptDialog } from '@/lib/ui-dialogs'
import { apiFetch } from '@/lib/v2-auth'

type EvidenceType = 'BUSINESS_LICENSE' | 'QUARANTINE_CERTIFICATE' | 'INSPECTION_REPORT' | 'SLAUGHTER_CERTIFICATE' | 'PRODUCTION_INSPECTION_REPORT' | 'THIRD_PARTY_TEST_REPORT' | 'PESTICIDE_RESIDUE_REPORT' | 'OTHER_PRODUCT_EVIDENCE'
type EvidenceRequirement = 'PENDING' | 'REQUIRED' | 'NOT_REQUIRED'
type Product = { id: string; code: string; name: string; spec?: string | null; evidenceRequirement?: EvidenceRequirement; requiredEvidenceTypes?: EvidenceType[]; evidenceRequirementVersion?: number }
type RequirementDraft = { status: EvidenceRequirement; requiredTypes: EvidenceType[] }
type Evidence = {
  id: string
  type: EvidenceType
  version: number
  title: string
  note?: string
  validFrom?: string | null
  validUntil?: string | null
  expired: boolean
  archived: boolean
  archivedAt?: string | null
  fileName: string
  fileUrl?: string | null
  productIds: string[]
  products?: Product[]
  createdAt: string
}
type EvidenceResponse = {
  supplier: { id: string; no: string; name: string }
  permissions: { canManage: boolean }
  items: Evidence[]
}
type ReceiptEvidence = {
  receipt: { id: string; no: string; status: string; arrivedAt?: string | null; supplier: { id: string; name: string }; postedCompleteness?: EvidenceCompleteness | null }
  completeness: EvidenceCompleteness
  lines: Array<{
    id: string
    product: Product
    arrivedQty: string | number
    acceptedQty: string | number
    purchaseUnit: string
    documents: Array<Evidence & { linkId: string; linkedAt: string; linkedAfterPosted: boolean; backfillReason?: string | null }>
    voidedLinks: Array<{ id: string; voidedAt: string; voidReason: string }>
  }>
}
type EvidenceCompleteness = {
  businessLicense: { status: 'COMPLETE' | 'MISSING' }
  lines: Array<{ receiptLineId: string; productName: string; requirement: EvidenceRequirement; status: 'PENDING_CONFIGURATION' | 'NOT_REQUIRED' | 'COMPLETE' | 'MISSING'; evidenceCount: number; requiredTypes: EvidenceType[]; providedTypes: EvidenceType[]; missingTypes: EvidenceType[] }>
  missingCount: number
  pendingConfigurationCount: number
  blocksPosting: false
}

const TYPE_LABEL: Record<EvidenceType, string> = {
  BUSINESS_LICENSE: '营业执照',
  QUARANTINE_CERTIFICATE: '检疫证明',
  INSPECTION_REPORT: '检验检测报告',
  SLAUGHTER_CERTIFICATE: '屠宰证',
  PRODUCTION_INSPECTION_REPORT: '生产检验报告',
  THIRD_PARTY_TEST_REPORT: '第三方检测报告',
  PESTICIDE_RESIDUE_REPORT: '蔬菜农残报告',
  OTHER_PRODUCT_EVIDENCE: '其他产品随货资料',
}

const REQUIREMENT_LABEL: Record<EvidenceRequirement, string> = {
  PENDING: '待配置',
  REQUIRED: '必须提供',
  NOT_REQUIRED: '不需要',
}

function dateLabel(value?: string | null) {
  return value ? value.slice(0, 10) : '—'
}

export default function SupplierEvidencePage() {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const supplierId = String(params.id || '')
  const [data, setData] = useState<EvidenceResponse | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [requirementDrafts, setRequirementDrafts] = useState<Record<string, RequirementDraft>>({})
  const [requirementErrors, setRequirementErrors] = useState<Record<string, string>>({})
  const [includeArchived, setIncludeArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [type, setType] = useState<EvidenceType>('BUSINESS_LICENSE')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [selectedProducts, setSelectedProducts] = useState<string[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const receiptId = searchParams.get('receiptId') || ''
  const [receipt, setReceipt] = useState<ReceiptEvidence | null>(null)
  const [receiptLoading, setReceiptLoading] = useState(false)
  const [selectedLinks, setSelectedLinks] = useState<Record<string, string[]>>({})
  const [backfillReason, setBackfillReason] = useState('')
  const requirementDirty = products.some(product => {
    const draft = requirementDrafts[product.id]
    return draft && (draft.status !== (product.evidenceRequirement || 'PENDING')
      || JSON.stringify([...draft.requiredTypes].sort()) !== JSON.stringify([...(product.requiredEvidenceTypes || [])].sort()))
  })
  const editorDirty = Boolean(title.trim() || note.trim() || validFrom || validUntil || selectedProducts.length || file || backfillReason.trim() || Object.values(selectedLinks).some(ids => ids.length > 0) || saving || requirementDirty)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [evidence, sourceRows] = await Promise.all([
        apiFetch<EvidenceResponse>(`/api/suppliers/${encodeURIComponent(supplierId)}/evidence-documents${includeArchived ? '?includeArchived=1' : ''}`),
        apiFetch<{ items: Array<{ product: Product | null }> }>(`/api/suppliers/${encodeURIComponent(supplierId)}/upstream-products`),
      ])
      setData(evidence)
      const nextProducts = sourceRows.items.map(row => row.product).filter((product): product is Product => Boolean(product))
      setProducts(nextProducts)
      setRequirementDrafts(current => {
        const next = { ...current }
        for (const product of nextProducts) if (!next[product.id]) next[product.id] = {
          status: product.evidenceRequirement || 'PENDING',
          requiredTypes: product.requiredEvidenceTypes || [],
        }
        return next
      })
    } catch (reason: any) {
      setError(reason?.message || '加载来货证照失败')
    } finally {
      setLoading(false)
    }
  }, [includeArchived, supplierId])

  useEffect(() => { if (supplierId) void load() }, [load, supplierId])
  useEffect(() => { if (receiptId) void loadReceipt() }, [receiptId])
  useEffect(() => {
    if (!editorDirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const warnInternalNavigation = (event: Event) => {
      event.preventDefault()
      if (saving) return
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed
      void confirmDialog('当前有尚未提交的证明或到货关联内容，确定离开吗？')
        .then(confirmed => { if (confirmed) proceed?.() })
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, warnInternalNavigation)
    return () => {
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, warnInternalNavigation)
    }
  }, [editorDirty, saving])

  useEffect(() => {
    if (type === 'BUSINESS_LICENSE') setSelectedProducts([])
  }, [type])

  const activeDocuments = useMemo(() => (data?.items || []).filter(item => !item.archived), [data])

  async function saveDocument() {
    if (!title.trim()) return setFormError('请填写证明标题')
    if (!file) return setFormError('请选择证明附件')
    if (validFrom && validUntil && validFrom > validUntil) return setFormError('有效期截止日不能早于开始日')
    if (type !== 'BUSINESS_LICENSE' && selectedProducts.length === 0) return setFormError('产品随货资料至少选择一个供货商品')
    setSaving(true)
    setFormError(null)
    try {
      const form = new FormData()
      form.append('file', file, file.name)
      const uploaded = await apiFetch<{ key: string; name: string; mime: string; size: number }>('/api/upload?category=supplier-evidence-documents', { method: 'POST', body: form })
      await apiFetch(`/api/suppliers/${encodeURIComponent(supplierId)}/evidence-documents`, {
        method: 'POST',
        body: JSON.stringify({
          type,
          title: title.trim(),
          note: note.trim(),
          validFrom: validFrom || null,
          validUntil: validUntil || null,
          productIds: type === 'BUSINESS_LICENSE' ? [] : selectedProducts,
          attachment: uploaded,
          requestKey: clientRequestId(),
        }),
      })
      setTitle(''); setNote(''); setValidFrom(''); setValidUntil(''); setSelectedProducts([]); setFile(null)
      setNotice('证明新版本已保存，原版本未被覆盖')
      await load()
    } catch (reason: any) {
      setFormError(reason?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function setRequirementStatus(product: Product, status: EvidenceRequirement) {
    setRequirementDrafts(current => ({ ...current, [product.id]: {
      status,
      requiredTypes: status === 'REQUIRED' ? (current[product.id]?.requiredTypes || []) : [],
    } }))
    setRequirementErrors(current => ({ ...current, [product.id]: '' }))
  }

  function toggleRequiredType(product: Product, evidenceType: EvidenceType) {
    if (evidenceType === 'BUSINESS_LICENSE') return
    setRequirementDrafts(current => {
      const draft = current[product.id] || { status: product.evidenceRequirement || 'PENDING', requiredTypes: product.requiredEvidenceTypes || [] }
      const requiredTypes = draft.requiredTypes.includes(evidenceType)
        ? draft.requiredTypes.filter(item => item !== evidenceType)
        : [...draft.requiredTypes, evidenceType]
      return { ...current, [product.id]: { status: draft.status, requiredTypes } }
    })
    setRequirementErrors(current => ({ ...current, [product.id]: '' }))
  }

  async function saveRequirement(product: Product) {
    const draft = requirementDrafts[product.id] || { status: product.evidenceRequirement || 'PENDING', requiredTypes: product.requiredEvidenceTypes || [] }
    const currentTypes = [...(product.requiredEvidenceTypes || [])].sort()
    const nextTypes = [...new Set(draft.status === 'REQUIRED' ? draft.requiredTypes : [])].sort()
    if (draft.status === 'REQUIRED' && nextTypes.length === 0) {
      setRequirementErrors(current => ({ ...current, [product.id]: '请至少勾选一种所需随货资料' }))
      return
    }
    if (draft.status === (product.evidenceRequirement || 'PENDING') && JSON.stringify(currentTypes) === JSON.stringify(nextTypes)) return
    if (!(await confirmDialog(`该规则是商品全局规则，修改后会影响「${product.name}」的所有上游供应商来货验收。确认继续？`))) return
    const reason = await promptDialog(`请填写将「${product.name}」随货资料规则改为「${REQUIREMENT_LABEL[draft.status]}」的依据（该规则适用于此商品的所有上游供应商）`)
    if (!reason?.trim()) return
    try {
      await apiFetch(`/api/suppliers/${encodeURIComponent(supplierId)}/evidence-requirements/${encodeURIComponent(product.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedStatus: product.evidenceRequirement || 'PENDING',
          expectedRequiredTypes: currentTypes,
          expectedVersion: product.evidenceRequirementVersion || 0,
          status: draft.status,
          requiredTypes: nextTypes,
          reason: reason.trim(),
          requestKey: clientRequestId(),
        }),
      })
      setProducts(current => current.map(item => item.id === product.id ? { ...item, evidenceRequirement: draft.status, requiredEvidenceTypes: nextTypes, evidenceRequirementVersion: (product.evidenceRequirementVersion || 0) + 1 } : item))
      setRequirementDrafts(current => ({ ...current, [product.id]: { status: draft.status, requiredTypes: nextTypes } }))
      setRequirementErrors(current => ({ ...current, [product.id]: '' }))
      setNotice(`「${product.name}」已设为${REQUIREMENT_LABEL[draft.status]}${draft.status === 'REQUIRED' ? `，需${nextTypes.map(item => TYPE_LABEL[item]).join('、')}` : ''}；该商品全部上游供应商共用此规则`)
      if (receiptId) await loadReceipt()
    } catch (reason: any) {
      setError(reason?.message || '配置随货资料规则失败')
    }
  }

  async function archiveDocument(document: Evidence) {
    if (!(await confirmDialog(`归档「${document.title}」？历史到货和门店追溯仍会保留当时证明。`))) return
    try {
      await apiFetch(`/api/suppliers/${encodeURIComponent(supplierId)}/evidence-documents/${encodeURIComponent(document.id)}/archive`, { method: 'PATCH' })
      setNotice('证明已归档；历史关联未被删除')
      await load()
    } catch (reason: any) {
      setError(reason?.message || '归档失败')
    }
  }

  async function loadReceipt() {
    if (!receiptId.trim()) return
    setReceiptLoading(true)
    setError(null)
    try {
      const result = await apiFetch<ReceiptEvidence>(`/api/upstream/receipts/${encodeURIComponent(receiptId.trim())}/evidence-documents`)
      if (result.receipt.supplier.id !== supplierId) throw new Error('该到货单不属于当前供应商')
      setReceipt(result)
      setSelectedLinks({})
    } catch (reason: any) {
      setReceipt(null)
      setError(reason?.message || '到货单加载失败')
    } finally {
      setReceiptLoading(false)
    }
  }

  function availableForLine(line: ReceiptEvidence['lines'][number]) {
    const businessAt = receipt?.receipt.arrivedAt ? new Date(receipt.receipt.arrivedAt).getTime() : Date.now()
    return activeDocuments.filter(document => {
      const validFrom = document.validFrom ? new Date(document.validFrom).getTime() : Number.NEGATIVE_INFINITY
      const validUntil = document.validUntil ? new Date(`${document.validUntil.slice(0, 10)}T23:59:59.999Z`).getTime() : Number.POSITIVE_INFINITY
      return document.type !== 'BUSINESS_LICENSE'
        && validFrom <= businessAt && validUntil >= businessAt
        && document.productIds.includes(line.product.id)
    })
  }

  function toggleLink(lineId: string, documentId: string) {
    setSelectedLinks(current => {
      const ids = current[lineId] || []
      return { ...current, [lineId]: ids.includes(documentId) ? ids.filter(id => id !== documentId) : [...ids, documentId] }
    })
  }

  async function linkDocuments() {
    if (!receipt) return
    const links = Object.entries(selectedLinks).filter(([, documentIds]) => documentIds.length).map(([receiptLineId, documentIds]) => ({ receiptLineId, documentIds }))
    if (links.length === 0) return setError('请至少选择一项证明关联')
    if (receipt.receipt.status === 'POSTED' && !backfillReason.trim()) return setError('已过账单据补录资料必须填写原因')
    try {
      await apiFetch(`/api/upstream/receipts/${encodeURIComponent(receipt.receipt.id)}/evidence-links`, {
        method: 'POST',
        body: JSON.stringify({ links, requestKey: clientRequestId(), ...(receipt.receipt.status === 'POSTED' ? { backfillReason: backfillReason.trim() } : {}) }),
      })
      setNotice('证明已关联到实际到货行')
      setBackfillReason('')
      await loadReceipt()
    } catch (reason: any) {
      setError(reason?.message || '关联失败')
    }
  }

  async function voidLink(linkId: string) {
    if (!receipt) return
    const reason = await promptDialog('请填写作废这条事后补录的原因（原始随货关联不可作废）')
    if (!reason?.trim()) return
    try {
      await apiFetch(`/api/upstream/receipts/${encodeURIComponent(receipt.receipt.id)}/evidence-links/${encodeURIComponent(linkId)}/void`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: reason.trim(), requestKey: clientRequestId() }),
      })
      setNotice('事后补录已作废，原记录仍保留审计')
      await loadReceipt()
    } catch (reason: any) {
      setError(reason?.message || '作废补录失败')
    }
  }

  if (loading && !data) return <div className="min-h-screen bg-bg p-6"><SkeletonList count={6} /></div>

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto max-w-[1440px] border-b border-border pb-5">
        <a href={`/v2/supply-chain/suppliers/${encodeURIComponent(supplierId)}/archive`} className="text-button text-accent">← 返回集中档案</a>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div><div className="flex items-center gap-2"><Chip tone="green">来货资质</Chip><span className="text-caption text-gray3">{data?.supplier.no}</span></div><h1 className="mt-2 text-h1">{data?.supplier.name || '供应商'} · 证照与证明</h1><p className="mt-1 text-caption text-gray2">营业执照是供应商级证照；产品随货资料按商品维护，再绑定到实际到货行。</p></div>
          <label className="flex items-center gap-2 text-caption text-gray2"><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />查看已归档</label>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] space-y-5 py-5">
        {notice && <div className="rounded-card border border-green-fg/20 bg-green-bg px-4 py-3 text-caption text-green-fg">{notice}</div>}
        {error && <FriendlyError message={error} onRetry={load} />}

        {data?.permissions.canManage && (
          <section className="rounded-card border border-border bg-white p-5">
            <h2 className="text-h2">商品随货资料规则</h2>
            <p className="mt-1 text-caption text-gray2">以商品为维度明确配置，适用于该商品的所有上游供应商；不按名称猜测食品与非食品。</p>
            <div className="mt-4 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {products.map(product => {
                const draft = requirementDrafts[product.id] || { status: product.evidenceRequirement || 'PENDING', requiredTypes: product.requiredEvidenceTypes || [] }
                const dirty = draft.status !== (product.evidenceRequirement || 'PENDING') || JSON.stringify([...draft.requiredTypes].sort()) !== JSON.stringify([...(product.requiredEvidenceTypes || [])].sort())
                return <div key={product.id} className="rounded-card border border-border p-3 text-caption"><span className="block font-medium">{product.name}</span><span className="mb-2 block text-micro text-gray3">{product.code} · 当前 {REQUIREMENT_LABEL[product.evidenceRequirement || 'PENDING']}</span><select aria-label={`${product.name}资料规则`} value={draft.status} onChange={event => setRequirementStatus(product, event.target.value as EvidenceRequirement)} className="h-9 w-full rounded-cta border border-border px-2"><option value="PENDING">待配置</option><option value="REQUIRED">必须提供</option><option value="NOT_REQUIRED">不需要（如非食品）</option></select><fieldset disabled={draft.status !== 'REQUIRED'} className="mt-3 disabled:opacity-50"><legend className="text-micro text-gray3">所需资料类型（可多选）</legend><div className="mt-2 grid gap-1">{(Object.entries(TYPE_LABEL) as Array<[EvidenceType, string]>).filter(([value]) => value !== 'BUSINESS_LICENSE').map(([value, label]) => <label key={value} className="flex items-center gap-2 text-micro"><input aria-label={`${product.name}-${label}`} type="checkbox" checked={draft.requiredTypes.includes(value)} onChange={() => toggleRequiredType(product, value)} />{label}</label>)}</div></fieldset>{requirementErrors[product.id] && <div className="mt-2 text-micro text-red-fg">{requirementErrors[product.id]}</div>}<button type="button" disabled={!dirty} onClick={() => void saveRequirement(product)} className="mt-3 rounded-cta bg-accent px-3 py-2 text-button text-white disabled:opacity-40">保存规则</button></div>
              })}
            </div>
          </section>
        )}

        {data?.permissions.canManage && (
          <section className="rounded-card border border-border bg-white p-5">
            <h2 className="text-h2">新增证明版本</h2><p className="mt-1 text-caption text-gray2">只新增，不覆盖旧版本；检测报告、屠宰证、生产检验、农残报告等产品随货资料都必须选择覆盖商品。</p>
            {formError && <div className="mt-3 rounded-card border border-red-fg/20 bg-red-bg px-4 py-3 text-caption text-red-fg">{formError}</div>}
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label><span className="mb-1 block text-micro text-gray3">类型 *</span><select value={type} onChange={event => setType(event.target.value as EvidenceType)} className="h-10 w-full rounded-cta border border-border px-3">{Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span className="mb-1 block text-micro text-gray3">标题 *</span><input value={title} onChange={event => setTitle(event.target.value)} className="h-10 w-full rounded-cta border border-border px-3" /></label>
              <label><span className="mb-1 block text-micro text-gray3">有效期开始</span><input type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} className="h-10 w-full rounded-cta border border-border px-3" /></label>
              <label><span className="mb-1 block text-micro text-gray3">有效期截止</span><input type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} className="h-10 w-full rounded-cta border border-border px-3" /></label>
              <label className="md:col-span-2"><span className="mb-1 block text-micro text-gray3">附件（图片或 PDF，最大 10MB）*</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" onChange={event => setFile(event.target.files?.[0] || null)} /></label>
              {type !== 'BUSINESS_LICENSE' && <fieldset className="md:col-span-2"><legend className="text-micro text-gray3">覆盖商品 *</legend><div className="mt-2 grid max-h-52 gap-2 overflow-auto rounded-card border border-border p-3 md:grid-cols-2 lg:grid-cols-3">{products.map(product => <label key={product.id} className="flex items-start gap-2 text-caption"><input type="checkbox" checked={selectedProducts.includes(product.id)} onChange={() => setSelectedProducts(current => current.includes(product.id) ? current.filter(id => id !== product.id) : [...current, product.id])} /><span><b>{product.name}</b><span className="block text-micro text-gray3">{product.code} · {product.spec || '无规格'}</span></span></label>)}</div></fieldset>}
              <label className="md:col-span-2"><span className="mb-1 block text-micro text-gray3">说明</span><textarea value={note} onChange={event => setNote(event.target.value)} rows={3} className="w-full rounded-cta border border-border p-3" /></label>
            </div>
            <div className="mt-4 flex justify-end"><button disabled={saving} onClick={() => void saveDocument()} className="rounded-cta bg-accent px-4 py-2 text-button text-white disabled:opacity-40">{saving ? '保存中…' : '保存新版本'}</button></div>
          </section>
        )}

        <section className="rounded-card border border-border bg-white p-5">
          <h2 className="text-h2">证照版本库</h2>
          {!data?.items.length ? <EmptyState icon="📎" title="暂无证照与证明" hint="先上传营业执照或产品随货资料" /> : <div className="mt-4 grid gap-3 md:grid-cols-2">{data.items.map(document => <article key={document.id} className={`rounded-card border border-border p-4 ${document.archived ? 'bg-bg opacity-75' : ''}`}><div className="flex items-start justify-between gap-2"><div><b>{document.title}</b><div className="mt-1 text-micro text-gray3">{TYPE_LABEL[document.type]} · 版本 {document.version}</div></div><div className="flex gap-2">{document.expired && <Chip tone="red">已过期</Chip>}{document.archived && <Chip tone="gray">已归档</Chip>}</div></div><div className="mt-2 text-caption text-gray2">有效期：{dateLabel(document.validFrom)} 至 {dateLabel(document.validUntil)}</div>{document.type !== 'BUSINESS_LICENSE' && <div className="mt-2 text-caption text-gray2">覆盖：{document.products?.map(product => product.name).join('、') || `${document.productIds.length} 个商品`}</div>}{document.note && <p className="mt-2 text-caption text-gray2">{document.note}</p>}<div className="mt-3 flex items-center justify-between gap-3"><a href={document.fileUrl || '#'} target="_blank" rel="noreferrer" className="text-button text-accent">查看附件：{document.fileName} ↗</a>{!document.archived && data.permissions.canManage && <button onClick={() => void archiveDocument(document)} className="text-button text-red-fg">归档</button>}</div></article>)}</div>}
        </section>

        <section className="rounded-card border border-border bg-white p-5">
          <h2 className="text-h2">关联实际到货行</h2>
          <p className="mt-1 text-caption text-gray2">从“上游采购 → 到货验收”的具体单据进入。缺件只提示不阻断过账；过账后补录必须记录原因，并与原始随货资料分开标识。</p>
          {!receiptId && <div className="mt-4 rounded-card border border-dashed border-border bg-bg p-4 text-caption text-gray2">当前未选择到货单。<a href="/v2/supply-chain/procurement?tab=receipts" className="ml-1 text-button text-accent">前往到货验收选择单据 →</a></div>}
          {receiptLoading && <div className="mt-4 text-caption text-gray3">正在加载到货单…</div>}
          {receipt && <div className="mt-4 space-y-3">
            <div className="rounded-card bg-bg p-3 text-caption text-gray2">{receipt.receipt.no} · {receipt.receipt.status} · {receipt.receipt.supplier.name}{receipt.receipt.status === 'POSTED' && <span className="ml-2 text-amber-fg">已过账，新增内容将标记为事后补录</span>}</div>
            <div className={`rounded-card border p-3 text-caption ${receipt.completeness.missingCount || receipt.completeness.pendingConfigurationCount ? 'border-amber/30 bg-amber/10' : 'border-green-fg/20 bg-green-bg'}`}>
              <b>当前资料完整性：</b>营业执照 {receipt.completeness.businessLicense.status === 'COMPLETE' ? '已有' : '缺失'} · 必须资料缺 {receipt.completeness.missingCount} 项 · 商品规则待配置 {receipt.completeness.pendingConfigurationCount} 项。<span className="ml-1">仅提示，不阻断收货。</span>
              {receipt.receipt.postedCompleteness && <div className="mt-1 text-micro text-gray3">过账时快照：缺 {receipt.receipt.postedCompleteness.missingCount} 项，待配置 {receipt.receipt.postedCompleteness.pendingConfigurationCount} 项；快照不随后续补录改写。</div>}
            </div>
            {receipt.lines.map(line => {
              const lineStatus = receipt.completeness.lines.find(item => item.receiptLineId === line.id)
              return <article key={line.id} className="rounded-card border border-border p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><b>{line.product.name}</b><div className="text-micro text-gray3">{line.product.code} · 实到 {String(line.arrivedQty)} · 合格 {String(line.acceptedQty)} {line.purchaseUnit}</div><div className="mt-1 text-micro text-gray3">规则：{REQUIREMENT_LABEL[lineStatus?.requirement || 'PENDING']} · 状态：{lineStatus?.status === 'COMPLETE' ? '所需类型已齐全' : lineStatus?.status === 'MISSING' ? '缺件' : lineStatus?.status === 'NOT_REQUIRED' ? '不需要' : '待配置'}</div>{lineStatus?.requiredTypes?.length ? <div className="mt-1 text-micro text-gray3">所需：{lineStatus.requiredTypes.map(item => TYPE_LABEL[item]).join('、')}{lineStatus.missingTypes.length ? `；尚缺：${lineStatus.missingTypes.map(item => TYPE_LABEL[item]).join('、')}` : ''}</div> : null}</div><span className="text-micro text-gray3">已关联 {line.documents.length} 项</span></div>
                {line.documents.length > 0 && <div className="mt-3 space-y-2">{line.documents.map(document => <div key={document.linkId} className="flex flex-wrap items-center gap-2"><Chip tone={document.linkedAfterPosted ? 'amber' : 'green'}>{TYPE_LABEL[document.type]}：{document.title}{document.linkedAfterPosted ? '（事后补录）' : ''}</Chip>{document.linkedAfterPosted && <span className="text-micro text-amber-fg">原因：{document.backfillReason || '未记录'}</span>}{document.linkedAfterPosted && <button type="button" onClick={() => void voidLink(document.linkId)} className="text-micro text-red-fg">作废错误补录</button>}</div>)}</div>}
                {receipt.receipt.status !== 'REVERSED' && <fieldset className="mt-3"><legend className="text-micro text-gray3">新增关联（仅显示本次到货业务日有效且覆盖本商品的产品资料）</legend><div className="mt-2 grid gap-2 md:grid-cols-2">{availableForLine(line).map(document => <label key={document.id} className="flex items-start gap-2 rounded-lg border border-border p-2 text-caption"><input type="checkbox" checked={(selectedLinks[line.id] || []).includes(document.id)} onChange={() => toggleLink(line.id, document.id)} /><span>{document.title}<span className="block text-micro text-gray3">{TYPE_LABEL[document.type]} · v{document.version}</span></span></label>)}</div></fieldset>}
              </article>
            })}
            {receipt.receipt.status !== 'REVERSED' && <div className="flex flex-col items-end gap-2">{receipt.receipt.status === 'POSTED' && <label className="w-full max-w-xl"><span className="mb-1 block text-micro text-amber-fg">事后补录原因 *</span><textarea value={backfillReason} onChange={event => setBackfillReason(event.target.value)} className="w-full rounded-cta border border-amber/40 p-3" rows={2} /></label>}<button onClick={() => void linkDocuments()} className="rounded-cta bg-accent px-4 py-2 text-button text-white">{receipt.receipt.status === 'POSTED' ? '保存事后补录' : '保存到货关联'}</button></div>}
          </div>}
        </section>
      </main>
    </div>
  )
}
