'use client'
import { WarehouseDocumentEditor, type WarehouseDocumentAction } from './warehouse-document-editor'
import { ResponsiveDataTable } from '@/components/v2/responsive-data-table'
import { DocumentQualityImageButton } from '@/components/v2/document-quality-image'

import { useCallback, useEffect, useState } from 'react'
import { DateRangeCalendar } from '@/components/v2/date-range-calendar'
import { ReportActions, collectReportPages } from '@/components/v2/report-actions'
import { WarehouseToolTabs } from '@/components/v2/warehouse-tool-tabs'
import { apiFetch, getUser } from '@/lib/v2-auth'
import type { TableReport } from '@/lib/table-report'
import { readWarehouseViewState, useWarehouseScrollRestoration, writeWarehouseViewState } from '@/lib/warehouse-view-state'

// ── 类型 ──────────────────────────────────────────────
type DocRow = {
  id: string
  docNo: string
  type: 'MANUAL_INBOUND' | 'MANUAL_OUTBOUND'
  supplierId: string | null
  supplierName: string | null
  reason: string | null
  note: string | null
  effectiveAt: string
  status: 'POSTED' | 'CONFIRMED'
  reviewStatus: 'UNREVIEWED' | 'REVIEWED'
  lineCount: number
  totalAmount: number
  createdAt: string
  confirmedAt: string | null
  unauditedAt: string | null
  unauditReason: string | null
  attachmentCount: number
}

type DocAttachment = { name: string; mime: string; size: number; url: string }

type DocLine = {
  id: string
  lineNo: number
  productId: string
  productName: string
  quantity: number
  unit: string
  unitPrice: number | null
  amount: number
  inventoryQuantity: number
  inventoryUnit: string
  note: string | null
  batchNo: string | null
  manufactureDate: string | null
  expiryDate: string | null
}

type DocLog = {
  id: string
  action: 'CREATE' | 'CONFIRM' | 'UNCONFIRM' | 'EDIT' | 'REVIEW' | 'UNREVIEW'
  actorName: string | null
  reason: string | null
  detail: any
  createdAt: string
}

type DocDetail = DocRow & { lines: DocLine[]; logs: DocLog[]; attachments: DocAttachment[] }

type SupplierOption = { id: string; name: string; no?: string }

// ── 权限：与后端 warehouseDocs 路由一致 ────────────────
const EDIT_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'PURCHASER', 'SUPPLY_CHAIN'])

const LOG_ACTION_LABEL: Record<DocLog['action'], string> = {
  REVIEW: '复审',
  UNREVIEW: '取消复审',
  CREATE: '制单',
  CONFIRM: '审核',
  UNCONFIRM: '反审核',
  EDIT: '修改',
}

function money(value: number | null | undefined) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtQty(value: number | null | undefined) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

function fmtTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function fmtDay(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const csv = '\uFEFF' + rows.map(row => row.map(value => {
    const raw = String(value ?? '')
    const text = typeof value === 'string' && /^[=+\-@\t]/.test(raw) ? `'${raw}` : raw
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function StatusBadge({ status }: { status: DocRow['status'] }) {
  if (status === 'CONFIRMED') {
    return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-caption text-emerald-700">已审核</span>
  }
  return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-caption text-amber-fg">待审核</span>
}

// ── 主页面 ────────────────────────────────────────────
export default function WarehouseDocsPage() {
  const user = getUser()
  const canAudit = user?.role === 'SUPPLY_CHAIN'
  const canReview = user?.role === 'SUPPLY_CHAIN'
  const canEdit = EDIT_ROLES.has(user?.role || '')

  const [type, setType] = useState<'MANUAL_INBOUND' | 'MANUAL_OUTBOUND'>('MANUAL_INBOUND')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [supplierQ, setSupplierQ] = useState('')
  const [restored, setRestored] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20

  const [items, setItems] = useState<DocRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailAction, setDetailAction] = useState<WarehouseDocumentAction | undefined>()
  const [detailAttempt, setDetailAttempt] = useState(0)
  function openDoc(id: string, action?: WarehouseDocumentAction) { setDetailAttempt(n => n + 1); setDetailAction(action); setDetailId(id) }

  // 从入库记录页「改单」跳转进来时直接打开对应单据（?doc=<id>）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const docIdFromUrl = params.get('doc')
    if (docIdFromUrl) setDetailId(docIdFromUrl)
    const saved = readWarehouseViewState('warehouse-docs-view', { type: 'MANUAL_INBOUND', status: '', q: '', supplierQ: '', from: '', to: '', page: 1 })
    setType(saved.type as 'MANUAL_INBOUND' | 'MANUAL_OUTBOUND'); setStatus(saved.status); setQ(saved.q); setSupplierQ(saved.supplierQ); setFrom(saved.from); setTo(saved.to); setPage(saved.page)
    setRestored(true)
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    params.set('type', type)
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    if (status) params.set('status', status)
    if (type === 'MANUAL_INBOUND' && supplierQ.trim()) params.set('supplierQ', supplierQ.trim())
    if (q.trim()) params.set('q', q.trim())
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    apiFetch<{ items: DocRow[]; total: number }>(`/api/warehouse-docs?${params.toString()}`)
      .then(data => {
        setItems(data.items || [])
        setTotal(data.total || 0)
      })
      .catch(reason => setError(String(reason?.message || reason)))
      .finally(() => setLoading(false))
  }, [type, status, q, supplierQ, from, to, page])

  useEffect(() => { if (restored) load() }, [load, restored])
  useEffect(() => { if (restored) writeWarehouseViewState('warehouse-docs-view', { type, status, q, supplierQ, from, to, page }) }, [type, status, q, supplierQ, from, to, page, restored])
  useWarehouseScrollRestoration('warehouse-docs-view')

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  function docParams(pageNo: number, size: number) {
    const params = new URLSearchParams({ type, page: String(pageNo), pageSize: String(size) })
    if (status) params.set('status', status)
    if (type === 'MANUAL_INBOUND' && supplierQ.trim()) params.set('supplierQ', supplierQ.trim())
    if (q.trim()) params.set('q', q.trim())
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    return params
  }

  async function exportDocs() {
    setExporting(true)
    setError(null)
    try {
      const all: DocRow[] = []
      let pageNo = 1
      let totalRows = 0
      do {
        const response = await apiFetch<{ items: DocRow[]; total: number }>(`/api/warehouse-docs?${docParams(pageNo, 200)}`)
        const rows = response.items || []
        all.push(...rows)
        totalRows = response.total
        if (rows.length === 0) break
        pageNo += 1
      } while (all.length < totalRows)
      downloadCsv(`${type === 'MANUAL_INBOUND' ? '入库单据审核' : '出库单据审核'}_${from || '全部'}_${to || '全部'}.csv`, [
        ['单据编号', '单据日期', type === 'MANUAL_INBOUND' ? '供应商' : '去向/原因', '总金额', '商品行数', type === 'MANUAL_INBOUND' ? '随货单据数' : '现场证据数', '审核状态', '复审状态', '反审核时间', '退回原因', '创建时间', '备注'],
        ...all.map(doc => [doc.docNo, fmtDay(doc.effectiveAt), type === 'MANUAL_INBOUND' ? doc.supplierName : doc.reason, doc.totalAmount, doc.lineCount, doc.attachmentCount, doc.status === 'CONFIRMED' ? '已审核' : '待审核', doc.reviewStatus === 'REVIEWED' ? '已复审' : '未复审', fmtTime(doc.unauditedAt), doc.unauditReason, fmtTime(doc.createdAt), doc.note]),
      ])
    } catch (reason: any) {
      setError(String(reason?.message || '导出失败'))
    } finally {
      setExporting(false)
    }
  }

  async function loadPrintReport(): Promise<TableReport> {
    const rows = await collectReportPages<DocRow>((pageNo, size) => apiFetch<{ items: DocRow[]; total: number }>(`/api/warehouse-docs?${docParams(pageNo, size)}`))
    return {
      title: type === 'MANUAL_INBOUND' ? '入库单据审核' : '出库单据审核',
      subtitle: '当前筛选结果（全部页）',
      headers: ['单据编号', '单据日期', type === 'MANUAL_INBOUND' ? '供应商' : '去向/原因', '总金额', '商品行数', type === 'MANUAL_INBOUND' ? '随货单据数' : '现场证据数', '审核状态', '复审状态', '反审核时间', '退回原因', '创建时间', '备注'],
      rows: rows.map(doc => [doc.docNo, fmtDay(doc.effectiveAt), type === 'MANUAL_INBOUND' ? doc.supplierName : doc.reason, doc.totalAmount, doc.lineCount, doc.attachmentCount, doc.status === 'CONFIRMED' ? '已审核' : '待审核', doc.reviewStatus === 'REVIEWED' ? '已复审' : '未复审', fmtTime(doc.unauditedAt), doc.unauditReason, fmtTime(doc.createdAt), doc.note]),
    }
  }

  function resetFilters() {
    setStatus('')
    setQ('')
    setSupplierQ('')
    setFrom('')
    setTo('')
    setPage(1)
  }

  return (
    <div className="min-h-screen space-y-4 bg-bg px-4 py-5 pb-24 lg:px-8 lg:py-7">
      <WarehouseToolTabs />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold">单据审核</h1>
          <p className="text-caption text-gray2">入库/出库单据：新入库草稿不记库存，入库人员提交审核后入库，供应链再复审；历史单据保留原记录</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && <a href="/v2/supply-chain/docs/new" className="rounded-cta border border-border bg-white px-4 py-2 text-button">新增入库单</a>}
          {canEdit && <a href="/v2/supply-chain/docs/new-outbound" className="rounded-cta border border-border bg-white px-4 py-2 text-button">新增出库单</a>}
          <button type="button" onClick={() => void exportDocs()} disabled={loading || exporting || total === 0} className="rounded-cta bg-ink px-4 py-2 text-button text-white disabled:opacity-40">{exporting ? '导出中…' : '导出当前筛选'}</button>
          <ReportActions printOnly loadReport={loadPrintReport} disabled={loading || total === 0} />
        </div>
      </header>

      {notice && <div className="rounded-card border border-emerald-200 bg-emerald-50 px-4 py-2 text-body text-emerald-700">{notice}</div>}
      {error && <div className="rounded-card border border-red-200 bg-red-50 px-4 py-2 text-body text-red-600">{error}</div>}

      <section className="rounded-card border border-border bg-white p-4">
        <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(120px,0.55fr)_minmax(120px,0.55fr)_224px_minmax(190px,0.85fr)_minmax(180px,0.75fr)_auto]">
          <label>
            <span className="mb-1 block text-micro text-gray3">单据类型</span>
            <select value={type} onChange={event => { setType(event.target.value as typeof type); setPage(1) }} className="h-11 w-full rounded-cta border border-border bg-white px-3 text-body">
              <option value="MANUAL_INBOUND">入库单</option>
              <option value="MANUAL_OUTBOUND">出库单</option>
            </select>
          </label>
          <label>
            <span className="mb-1 block text-micro text-gray3">审核状态</span>
            <select value={status} onChange={event => { setStatus(event.target.value); setPage(1) }} className="h-11 w-full rounded-cta border border-border bg-white px-3 text-body">
              <option value="">全部状态</option>
              <option value="POSTED">待审核</option>
              <option value="CONFIRMED">已审核</option>
            </select>
          </label>
          <DateRangeCalendar value={{ from, to }} onChange={range => { setFrom(range.from); setTo(range.to); setPage(1) }} label="单据日期" />
          <label>
            <span className="mb-1 block text-micro text-gray3">单据 / 商品</span>
            <input
              value={q}
              onChange={event => { setQ(event.target.value); setPage(1) }}
              placeholder="单据编号 / 商品名称 / 编码"
              className="h-11 w-full rounded-cta border border-border bg-white px-3 text-body"
            />
          </label>
          <label>
            <span className="mb-1 block text-micro text-gray3">供应商</span>
            <input
              value={supplierQ}
              disabled={type !== 'MANUAL_INBOUND'}
              onChange={event => { setSupplierQ(event.target.value); setPage(1) }}
              placeholder={type === 'MANUAL_INBOUND' ? '输入供应商名称' : '仅入库单可筛选'}
              className="h-11 w-full rounded-cta border border-border bg-white px-3 text-body disabled:bg-bg disabled:text-gray3"
            />
          </label>
          <button type="button" onClick={resetFilters} className="h-11 rounded-cta border border-border bg-white px-4 text-button text-gray2">重置</button>
        </div>
      </section>

      <div className="overflow-x-auto rounded-card border border-border bg-white">
        <ResponsiveDataTable><table className="w-full min-w-[1150px] text-body">
          <thead>
            <tr className="border-b border-border text-left text-caption text-gray2">
              <th className="w-48 px-4 py-3">单据编号</th>
              <th className="w-44 px-4 py-3">日期</th>
              <th className="min-w-56 px-4 py-3">{type === 'MANUAL_INBOUND' ? '供应商' : '去向/原因'}</th>
              <th className="w-36 px-4 py-3 text-right">总金额</th>
              <th className="w-28 px-4 py-3 text-center">{type === 'MANUAL_INBOUND' ? '随货单据' : '现场证据'}</th>
              <th className="px-4 py-3">审核状态</th>
              <th className="px-4 py-3">复审状态</th>
              <th className="sticky right-0 min-w-[370px] bg-white px-4 py-3 text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map(doc => (
              <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-bg/50">
                <td className="whitespace-nowrap px-4 py-3 font-num">{doc.docNo}</td>
                <td className="px-4 py-3"><span className="whitespace-nowrap">{fmtDay(doc.effectiveAt)}</span><div className="mt-0.5 whitespace-nowrap text-micro text-gray3">制单 {fmtTime(doc.createdAt)}</div></td>
                <td className="px-4 py-3">{type === 'MANUAL_INBOUND' ? (doc.supplierName || '—') : (doc.reason || '—')}</td>
                <td className="px-4 py-3 text-right font-num"><b>{money(doc.totalAmount)}</b><div className="mt-0.5 text-micro text-gray3">{doc.lineCount} 行商品</div></td>
                <td className="px-4 py-3 text-center">{`${doc.attachmentCount || 0} 份`}</td>
                <td className="px-4 py-3"><div className="flex flex-wrap items-center gap-2"><StatusBadge status={doc.status} />{doc.unauditedAt && <span className="rounded-full bg-red-50 px-2 py-0.5 text-caption text-red-700">已退回</span>}</div></td>
                <td className="px-4 py-3">{doc.reviewStatus === 'REVIEWED' ? '已复审' : '未复审'}</td>
                <td className="sticky right-0 bg-white px-4 py-3 text-left">
                  <div className="flex items-center gap-2 whitespace-nowrap text-accent">
                    {doc.status === 'POSTED' ? <>
                      {canEdit && <a href={`/v2/supply-chain/docs/${encodeURIComponent(doc.id)}/edit`} className="hover:underline">编辑</a>}
                      {canAudit && <button onClick={() => openDoc(doc.id, 'audit')}>审核</button>}
                    </> : doc.reviewStatus === 'REVIEWED'
                      ? null
                      : <>{canAudit && <button onClick={() => openDoc(doc.id, 'unconfirm')}>反审核</button>}{canReview && <button onClick={() => openDoc(doc.id, 'review')}>复审</button>}</>}
                    <span aria-hidden="true" className="text-gray3">｜</span>
                    <button onClick={() => openDoc(doc.id, 'print')}>打印</button>
                    {doc.status === 'POSTED' && canEdit
                      ? <a href={`/v2/supply-chain/docs/${encodeURIComponent(doc.id)}/edit`} title="进入编辑页保存单据修改">保存</a>
                      : <button disabled title="当前单据锁定，不能保存修改" className="text-gray3">保存</button>}
                    <DocumentQualityImageButton kind="WAREHOUSE" sourceId={doc.id} />
                    <button onClick={() => openDoc(doc.id)} className="text-gray2">查看</button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray2"><p>暂无单据</p><a href="/v2/supply-chain/inventory" className="mt-2 inline-block text-button text-accent hover:underline">去总仓库存制单</a></td></tr>
            )}
            {loading && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray2">加载中…</td></tr>
            )}
          </tbody>
        </table></ResponsiveDataTable>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between py-2 text-caption text-gray2">
          <span>第 {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} 项，共 {total} 项</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(page - 1)} disabled={page <= 1}
              className="rounded-cta border border-border bg-white px-3 py-1.5 text-button disabled:opacity-40"
            >上一页</button>
            <span className="font-num">{page} / {totalPages}</span>
            <button
              onClick={() => setPage(page + 1)} disabled={page >= totalPages}
              className="rounded-cta border border-border bg-white px-3 py-1.5 text-button disabled:opacity-40"
            >下一页</button>
          </div>
        </div>
      )}

      {detailId && (
        <WarehouseDocumentEditor
          key={`${detailId}:${detailAction || 'view'}:${detailAttempt}`}
          docId={detailId}
          initialAction={detailAction}
          canAudit={canAudit}
          canEdit={canEdit}
          canReview={canReview}
          onClose={() => setDetailId(null)}
          onChanged={message => {
            setNotice(message)
            load()
          }}
        />
      )}
    </div>
  )
}
