'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { EmptyState, FriendlyError, SkeletonList } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'

type SectionCode = 'QUALIFICATION' | 'FINANCE' | 'INVOICE'
type ArchiveRecord = {
  id: string
  section: SectionCode
  title: string
  note?: string
  validFrom?: string | null
  validUntil?: string | null
  fileName?: string | null
  fileUrl?: string | null
  fileSize?: number | null
  createdByName?: string
  createdAt: string
  archivedAt?: string | null
}
type ContractRecord = {
  id: string
  contractNo: string
  version: number
  title: string
  startsAt: string
  endsAt?: string | null
  status: string
  attachmentCount: number
}
type ArchiveResponse = {
  supplier: {
    id: string
    no: string
    name: string
    category?: string | null
    status: string
    contactName?: string | null
    contactPhone?: string | null
    address?: string | null
    creditType?: string | null
    creditDays?: number | null
    bankName?: string | null
    bankAccount?: string | null
    bankAccountName?: string | null
    bankCode?: string | null
  }
  permissions: {
    canManageGeneral: boolean
    canViewSensitive: boolean
    canManageSensitive: boolean
  }
  sections: {
    qualifications: { restricted: false; count: number; records: ArchiveRecord[] }
    contracts: { restricted: false; count: number; records: ContractRecord[]; source: 'UpstreamSupplierContract' }
    finance: { restricted: boolean; count: number | null; records?: ArchiveRecord[] }
    invoice: { restricted: boolean; count: number | null; records?: ArchiveRecord[] }
  }
}

const SECTION_META = {
  QUALIFICATION: { title: '企业资质', hint: '供应商级长期资质；每次来货检疫证明在到货单独关联，不在这里替代。' },
  FINANCE: { title: '财务信息', hint: '仅财务和管理员可查看及维护完整内容。' },
  INVOICE: { title: '开票资料', hint: '仅财务和管理员可查看及维护完整内容。' },
} as const

function dateLabel(value?: string | null) {
  return value ? value.slice(0, 10) : '—'
}

function requestKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `archive-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export default function SupplierArchivePage() {
  const params = useParams<{ id: string }>()
  const supplierId = String(params.id || '')
  const [data, setData] = useState<ArchiveResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [editorSection, setEditorSection] = useState<SectionCode | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()
  const editorDirty = Boolean(title.trim() || note.trim() || validFrom || validUntil || file)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await apiFetch<ArchiveResponse>(`/api/suppliers/${encodeURIComponent(supplierId)}/archive${includeArchived ? '?includeArchived=1' : ''}`)
      setData(result)
    } catch (reason: any) {
      setError(reason?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [includeArchived, supplierId])

  useEffect(() => { if (supplierId) void load() }, [load, supplierId])
  useEffect(() => {
    if (!editorSection || !editorDirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [editorDirty, editorSection])

  const visibleSections = useMemo(() => {
    if (!data) return []
    return [
      { code: 'QUALIFICATION' as const, ...SECTION_META.QUALIFICATION, area: data.sections.qualifications },
      { code: 'FINANCE' as const, ...SECTION_META.FINANCE, area: data.sections.finance },
      { code: 'INVOICE' as const, ...SECTION_META.INVOICE, area: data.sections.invoice },
    ]
  }, [data])

  function openEditor(section: SectionCode) {
    setEditorSection(section)
    setTitle('')
    setNote('')
    setValidFrom('')
    setValidUntil('')
    setFile(null)
    setEditorError(null)
  }

  function requestCloseEditor() {
    if (saving) return
    if (!editorDirty) {
      setEditorSection(null)
      setEditorError(null)
      return
    }
    openConfirm({
      title: '放弃未保存的档案？',
      body: '已填内容或已选附件将丢失。',
      confirmLabel: '放弃草稿',
      tone: 'danger',
      onConfirm: () => { setEditorSection(null); setEditorError(null) },
    })
  }

  async function saveRecord() {
    if (!editorSection || !title.trim()) {
      setEditorError('请填写档案标题')
      return
    }
    if (validFrom && validUntil && validFrom > validUntil) {
      setEditorError('有效期截止日不能早于开始日')
      return
    }
    setSaving(true)
    setEditorError(null)
    try {
      let attachment: { key: string; name: string; mime: string; size: number } | null = null
      if (file) {
        const form = new FormData()
        form.append('file', file, file.name)
        const category = editorSection === 'QUALIFICATION' ? 'supplier-archive-general' : 'supplier-archive-sensitive'
        attachment = await apiFetch(`/api/upload?category=${category}`, { method: 'POST', body: form })
      }
      await apiFetch(`/api/suppliers/${encodeURIComponent(supplierId)}/archive`, {
        method: 'POST',
        body: JSON.stringify({
          section: editorSection,
          title: title.trim(),
          note: note.trim(),
          validFrom: validFrom || null,
          validUntil: validUntil || null,
          attachment: attachment ? { key: attachment.key, name: attachment.name, mime: attachment.mime, size: attachment.size } : null,
          requestKey: requestKey(),
        }),
      })
      setEditorSection(null)
      setNotice('档案条目已新增；原记录未被覆盖')
      await load()
    } catch (reason: any) {
      setEditorError(reason?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function archive(record: ArchiveRecord) {
    openConfirm({
      title: `归档「${record.title}」？`,
      body: '归档不会删除历史；财务或管理员可在“查看已归档”中追溯。续期资料请新增一条。',
      confirmLabel: '确认归档',
      tone: 'danger',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/suppliers/${encodeURIComponent(supplierId)}/archive/${encodeURIComponent(record.id)}/archive`, { method: 'PATCH' })
          setNotice('条目已归档，历史保留')
          await load()
        } catch (reason: any) {
          setError(reason?.message || '归档失败')
        }
      },
    })
  }

  if (loading && !data) return <div className="min-h-screen bg-bg p-6"><SkeletonList count={6} /></div>

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto max-w-[1440px] border-b border-border pb-5">
        <a href="/v2/supply-chain/suppliers" className="text-button text-accent">← 返回上游供应商</a>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><Chip tone="green">集中档案</Chip><span className="text-caption text-gray3">{data?.supplier.no}</span></div>
            <h1 className="mt-2 text-h1">{data?.supplier.name || '供应商档案'}</h1>
            <p className="mt-1 text-caption text-gray2">基础资料、企业资质、现有合同、财务与开票资料集中查看</p>
          </div>
          {data?.permissions.canViewSensitive && (
            <label className="flex items-center gap-2 text-caption text-gray2">
              <input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />
              查看已归档历史
            </label>
          )}
          <a href={`/v2/supply-chain/suppliers/${encodeURIComponent(supplierId)}/evidence`} className="rounded-cta bg-accent px-3 py-2 text-button text-white">来货证照与证明 →</a>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] space-y-5 py-5">
        {notice && <div className="rounded-card border border-green-fg/20 bg-green-bg px-4 py-3 text-caption text-green-fg">{notice}</div>}
        {error && <FriendlyError message={error} onRetry={load} />}

        {data && (
          <section className="grid gap-3 rounded-card border border-border bg-white p-4 md:grid-cols-2 lg:grid-cols-4">
            <Info label="联系人" value={data.supplier.contactName || '—'} />
            <Info label="联系电话" value={data.supplier.contactPhone || '—'} />
            <Info label="联系地址" value={data.supplier.address || '—'} />
            <Info label="结算方式" value={data.supplier.creditType === 'FIXED_DAYS' ? `${data.supplier.creditDays ?? 0} 天` : '按协议'} />
          </section>
        )}

        {data && (
          <section className="rounded-card border border-border bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="text-h2">供应商合同</h2><p className="mt-1 text-caption text-gray2">直接复用采购中的合同真相，不重复建第二套合同。</p></div>
              <a href="/v2/supply-chain/procurement?tab=contracts" className="rounded-cta border border-accent px-3 py-2 text-button text-accent">进入合同管理（全部合同） →</a>
            </div>
            {data.sections.contracts.records.length === 0 ? <EmptyState icon="📄" title="暂无合同" hint="请从采购合同管理创建，创建后会自动出现在这里" /> : (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {data.sections.contracts.records.map(contract => (
                  <article key={contract.id} className="rounded-card border border-border p-4">
                    <div className="flex items-center justify-between gap-2"><b>{contract.title}</b><Chip tone={contract.status === 'ACTIVE' ? 'green' : 'gray'}>{contract.status}</Chip></div>
                    <div className="mt-2 text-caption text-gray2">{contract.contractNo} · 版本 {contract.version}</div>
                    <div className="mt-1 text-caption text-gray3">{dateLabel(contract.startsAt)} 至 {dateLabel(contract.endsAt)} · {contract.attachmentCount} 个附件</div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {visibleSections.map(section => {
          const canManage = section.code === 'QUALIFICATION' ? data?.permissions.canManageGeneral : data?.permissions.canManageSensitive
          return (
            <section key={section.code} className="rounded-card border border-border bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h2 className="text-h2">{section.title}</h2><p className="mt-1 text-caption text-gray2">{section.hint}</p></div>
                {canManage && <button onClick={() => openEditor(section.code)} className="rounded-cta bg-accent px-3 py-2 text-button text-white">+新增条目</button>}
              </div>
              {section.area.restricted ? (
                <div className="mt-4 rounded-card border border-dashed border-border bg-bg p-5 text-caption text-gray2">🔒 内容已受保护，仅财务或管理员可查看完整资料。</div>
              ) : !(section.area.records?.length) ? (
                <EmptyState icon="🗂️" title={`暂无${section.title}`} hint="新增后保留原记录，续期不覆盖历史" />
              ) : (
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {section.area.records?.map(record => (
                    <article key={record.id} className={`rounded-card border p-4 ${record.archivedAt ? 'border-border bg-bg opacity-70' : 'border-border'}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div><b>{record.title}</b>{record.archivedAt && <span className="ml-2 text-micro text-gray3">已归档</span>}</div>
                        {!record.archivedAt && canManage && <button onClick={() => archive(record)} className="text-button text-red-fg">归档</button>}
                      </div>
                      {record.note && <p className="mt-2 whitespace-pre-wrap text-caption text-gray2">{record.note}</p>}
                      <div className="mt-2 text-micro text-gray3">有效期：{dateLabel(record.validFrom)} 至 {dateLabel(record.validUntil)}</div>
                      <div className="mt-1 text-micro text-gray3">建档：{record.createdByName || '—'} · {dateLabel(record.createdAt)}</div>
                      {record.fileUrl && <a href={record.fileUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-button text-accent">查看附件：{record.fileName || '未命名'} ↗</a>}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </main>

      {editorSection && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/60 p-0 md:items-center md:p-6" onClick={requestCloseEditor}>
          <div className="w-full max-w-2xl rounded-t-card bg-white p-5 shadow-xl md:rounded-card" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between"><h2 className="text-h2">新增{SECTION_META[editorSection].title}</h2><button onClick={requestCloseEditor} disabled={saving} aria-label="关闭" className="text-2xl text-gray3 disabled:opacity-40">×</button></div>
            <p className="mt-1 text-caption text-gray2">只新增版本，不覆盖旧档案。</p>
            {editorError && <div className="mt-3 rounded-card border border-red-fg/20 bg-red-bg px-4 py-3 text-caption text-red-fg">{editorError}</div>}
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="标题" required><input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} className="h-10 w-full rounded-cta border border-border px-3" /></Field>
              <Field label="附件（图片或 PDF，最大 10MB）"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" onChange={event => setFile(event.target.files?.[0] || null)} className="block w-full text-caption" /></Field>
              <Field label="有效期开始"><input type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} className="h-10 w-full rounded-cta border border-border px-3" /></Field>
              <Field label="有效期截止"><input type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} className="h-10 w-full rounded-cta border border-border px-3" /></Field>
              <div className="md:col-span-2"><Field label="说明"><textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000} rows={4} className="w-full rounded-cta border border-border p-3" /></Field></div>
            </div>
            <div className="mt-5 flex justify-end gap-3"><button onClick={requestCloseEditor} disabled={saving} className="rounded-cta border border-border px-4 py-2 text-button disabled:opacity-40">取消</button><button onClick={() => void saveRecord()} disabled={saving} className="rounded-cta bg-accent px-4 py-2 text-button text-white disabled:opacity-40">{saving ? '保存中…' : '保存'}</button></div>
          </div>
        </div>
      )}
      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-micro text-gray3">{label}</div><div className="mt-1 text-body text-gray2">{value}</div></div>
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return <label className="block"><span className="mb-1 block text-micro text-gray3">{label}{required && <span className="text-red-fg"> *</span>}</span>{children}</label>
}
