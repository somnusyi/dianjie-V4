'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'

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
}

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
  action: 'CREATE' | 'CONFIRM' | 'UNCONFIRM' | 'EDIT'
  actorName: string | null
  reason: string | null
  detail: any
  createdAt: string
}

type DocDetail = DocRow & { lines: DocLine[]; logs: DocLog[] }

type SupplierOption = { id: string; name: string; no?: string }

// ── 权限：与后端 warehouseDocs 路由一致 ────────────────
const AUDIT_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPLY_CHAIN'])
const EDIT_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'PURCHASER', 'SUPPLY_CHAIN'])

const LOG_ACTION_LABEL: Record<DocLog['action'], string> = {
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
  return new Date(value).toLocaleDateString('zh-CN')
}

function StatusBadge({ status }: { status: DocRow['status'] }) {
  if (status === 'CONFIRMED') {
    return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-caption text-emerald-700">已审核</span>
  }
  return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-caption text-amber-fg">未审核</span>
}

// ── 主页面 ────────────────────────────────────────────
export default function WarehouseDocsPage() {
  const user = getUser()
  const canAudit = AUDIT_ROLES.has(user?.role || '')
  const canEdit = EDIT_ROLES.has(user?.role || '')

  const [type, setType] = useState<'MANUAL_INBOUND' | 'MANUAL_OUTBOUND'>('MANUAL_INBOUND')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20

  const [items, setItems] = useState<DocRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [detailId, setDetailId] = useState<string | null>(null)

  // 从入库记录页「改单」跳转进来时直接打开对应单据（?doc=<id>）
  useEffect(() => {
    const docIdFromUrl = new URLSearchParams(window.location.search).get('doc')
    if (docIdFromUrl) setDetailId(docIdFromUrl)
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    params.set('type', type)
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    if (status) params.set('status', status)
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
  }, [type, status, q, from, to, page])

  useEffect(() => { load() }, [load])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold">单据审核</h1>
          <p className="text-caption text-gray2">入库/出库单据：仓库制单即过账，会计审核锁定；改单需会计反审核，全程留痕</p>
        </div>
      </header>

      {notice && <div className="rounded-card border border-emerald-200 bg-emerald-50 px-4 py-2 text-body text-emerald-700">{notice}</div>}
      {error && <div className="rounded-card border border-red-200 bg-red-50 px-4 py-2 text-body text-red-600">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-cta border border-border bg-white p-0.5">
          {([['MANUAL_INBOUND', '入库单'], ['MANUAL_OUTBOUND', '出库单']] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => { setType(value); setPage(1) }}
              className={`rounded-cta px-4 py-1.5 text-button ${type === value ? 'bg-primary text-white' : 'text-gray2'}`}
            >{label}</button>
          ))}
        </div>
        <select
          value={status}
          onChange={event => { setStatus(event.target.value); setPage(1) }}
          className="h-10 rounded-cta border border-border bg-white px-3 text-body"
        >
          <option value="">全部状态</option>
          <option value="POSTED">未审核</option>
          <option value="CONFIRMED">已审核</option>
        </select>
        <input
          type="date" value={from} onChange={event => { setFrom(event.target.value); setPage(1) }}
          className="h-10 rounded-cta border border-border bg-white px-3 text-body"
        />
        <span className="text-gray2">至</span>
        <input
          type="date" value={to} onChange={event => { setTo(event.target.value); setPage(1) }}
          className="h-10 rounded-cta border border-border bg-white px-3 text-body"
        />
        <input
          value={q}
          onChange={event => { setQ(event.target.value); setPage(1) }}
          placeholder="单据编号"
          className="h-10 rounded-cta border border-border bg-white px-3 text-body"
        />
        <button onClick={load} className="h-10 rounded-cta bg-primary px-4 text-button text-white">查询</button>
      </div>

      <div className="overflow-x-auto rounded-card border border-border bg-white">
        <table className="w-full min-w-[760px] text-body">
          <thead>
            <tr className="border-b border-border text-left text-caption text-gray2">
              <th className="px-4 py-3">单据编号</th>
              <th className="px-4 py-3">单据日期</th>
              <th className="px-4 py-3">{type === 'MANUAL_INBOUND' ? '供应商' : '去向/原因'}</th>
              <th className="px-4 py-3 text-right">行数</th>
              <th className="px-4 py-3 text-right">总金额</th>
              <th className="px-4 py-3">审核状态</th>
              <th className="px-4 py-3">制单时间</th>
              <th className="px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map(doc => (
              <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-bg/50">
                <td className="px-4 py-3 font-num">{doc.docNo}</td>
                <td className="px-4 py-3">{fmtDay(doc.effectiveAt)}</td>
                <td className="px-4 py-3">{type === 'MANUAL_INBOUND' ? (doc.supplierName || '—') : (doc.reason || '—')}</td>
                <td className="px-4 py-3 text-right font-num">{doc.lineCount}</td>
                <td className="px-4 py-3 text-right font-num">{money(doc.totalAmount)}</td>
                <td className="px-4 py-3"><StatusBadge status={doc.status} /></td>
                <td className="px-4 py-3 text-caption text-gray2">{fmtTime(doc.createdAt)}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => setDetailId(doc.id)}
                    className="text-primary hover:underline"
                  >查看{doc.status === 'POSTED' && canEdit ? '/改单' : ''}</button>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray2">暂无单据</td></tr>
            )}
            {loading && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray2">加载中…</td></tr>
            )}
          </tbody>
        </table>
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
        <DocDetailDialog
          docId={detailId}
          canAudit={canAudit}
          canEdit={canEdit}
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

// ── 单据详情 / 改单 / 审核 ─────────────────────────────
function DocDetailDialog({ docId, canAudit, canEdit, onClose, onChanged }: {
  docId: string
  canAudit: boolean
  canEdit: boolean
  onClose: () => void
  onChanged: (message: string) => void
}) {
  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])

  // 编辑态
  const [editReason, setEditReason] = useState('')
  const [lineEdits, setLineEdits] = useState<Record<string, { amount?: string; quantity?: string; note?: string }>>({})
  const [supplierId, setSupplierId] = useState('')
  const [unauditReason, setUnauditReason] = useState('')
  const [unauditOpen, setUnauditOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    apiFetch<DocDetail>(`/api/warehouse-docs/${docId}`)
      .then(data => {
        setDoc(data)
        setSupplierId(data.supplierId || '')
        setLineEdits({})
        setEditReason('')
      })
      .catch(reason => setError(String(reason?.message || reason)))
      .finally(() => setLoading(false))
  }, [docId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (doc?.type !== 'MANUAL_INBOUND' || !canEdit) return
    apiFetch<SupplierOption[]>('/api/suppliers?status=ENABLED&businessScope=WAREHOUSE_UPSTREAM')
      .then(list => setSuppliers(Array.isArray(list) ? list : []))
      .catch(() => {})
  }, [doc?.type, canEdit])

  if (!doc && loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
        <div className="rounded-card bg-white p-10 text-gray2" onClick={event => event.stopPropagation()}>加载中…</div>
      </div>
    )
  }
  if (!doc) return null

  const editable = doc.status === 'POSTED' && canEdit
  const inbound = doc.type === 'MANUAL_INBOUND'

  function lineEdit(lineId: string) {
    return lineEdits[lineId] || {}
  }

  function setLineEdit(lineId: string, field: 'amount' | 'quantity' | 'note', value: string) {
    setLineEdits(current => ({ ...current, [lineId]: { ...current[lineId], [field]: value } }))
  }

  function hasEdits() {
    if (supplierId && doc && supplierId !== doc.supplierId) return true
    return Object.entries(lineEdits).some(([lineId, edit]) => {
      const line = doc?.lines.find(row => row.id === lineId)
      if (!line) return false
      if (edit.amount !== undefined && edit.amount !== '' && Math.abs(Number(edit.amount) - line.amount) > 0.0001) return true
      if (edit.quantity !== undefined && edit.quantity !== '' && Math.abs(Number(edit.quantity) - line.quantity) > 0.000001) return true
      if (edit.note !== undefined && edit.note !== (line.note || '')) return true
      return false
    })
  }

  async function saveEdit() {
    if (!doc) return
    if (editReason.trim().length < 2) { setError('请填写修改原因'); return }
    setBusy(true)
    setError(null)
    try {
      const lines = Object.entries(lineEdits).map(([lineId, edit]) => {
        const line = doc.lines.find(row => row.id === lineId)!
        return {
          lineId,
          amount: edit.amount !== undefined && edit.amount !== '' && Math.abs(Number(edit.amount) - line.amount) > 0.0001 ? Number(edit.amount) : undefined,
          quantity: edit.quantity !== undefined && edit.quantity !== '' && Math.abs(Number(edit.quantity) - line.quantity) > 0.000001 ? Number(edit.quantity) : undefined,
          note: edit.note !== undefined && edit.note !== (line.note || '') ? edit.note : undefined,
        }
      }).filter(row => row.amount !== undefined || row.quantity !== undefined || row.note !== undefined)
      const result = await apiFetch<{ ok: boolean; changed: boolean }>(`/api/warehouse-docs/${doc.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          editReason: editReason.trim(),
          supplierId: supplierId !== doc.supplierId ? supplierId : undefined,
          lines,
        }),
      })
      onChanged(result.changed ? `单据 ${doc.docNo} 已修改，金额变化已同步库存台账` : `单据 ${doc.docNo} 无实质修改`)
      load()
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!doc) return
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/warehouse-docs/${doc.id}/confirm`, { method: 'POST', body: JSON.stringify({}) })
      onChanged(`单据 ${doc.docNo} 已审核锁定`)
      load()
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setBusy(false)
    }
  }

  async function unconfirm() {
    if (!doc) return
    if (unauditReason.trim().length < 2) { setError('请填写退回原因'); return }
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/warehouse-docs/${doc.id}/unconfirm`, {
        method: 'POST',
        body: JSON.stringify({ reason: unauditReason.trim() }),
      })
      onChanged(`单据 ${doc.docNo} 已退回，仓库可修改`)
      setUnauditOpen(false)
      load()
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-card bg-white p-6"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-title font-semibold font-num">{doc.docNo}</h2>
              <StatusBadge status={doc.status} />
              <span className="text-caption text-gray2">{inbound ? '入库单' : '出库单'}</span>
            </div>
            <p className="mt-1 text-caption text-gray2">
              单据日期 {fmtDay(doc.effectiveAt)} · 制单 {fmtTime(doc.createdAt)}
              {doc.confirmedAt ? ` · 审核 ${fmtTime(doc.confirmedAt)}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="rounded-cta border border-border px-3 py-1.5 text-button text-gray2">关闭</button>
        </div>

        {doc.unauditReason && doc.status === 'POSTED' && (
          <div className="mb-3 rounded-card border border-amber-200 bg-amber-50 px-4 py-2 text-body text-amber-fg">
            会计退回：{doc.unauditReason}（{fmtTime(doc.unauditedAt)}）—— 请修改后通知会计重新审核
          </div>
        )}
        {error && <div className="mb-3 rounded-card border border-red-200 bg-red-50 px-4 py-2 text-body text-red-600">{error}</div>}

        {/* 表头 */}
        <div className="mb-4 grid grid-cols-1 gap-3 rounded-card border border-border p-4 sm:grid-cols-2">
          {inbound ? (
            <label className="space-y-1 text-caption text-gray2">
              供应商
              {editable ? (
                <select
                  value={supplierId}
                  onChange={event => setSupplierId(event.target.value)}
                  className="h-9 w-full rounded-cta border border-border bg-white px-2 text-body text-ink"
                >
                  {!supplierId && <option value="">未指定</option>}
                  {suppliers.map(supplier => (
                    <option key={supplier.id} value={supplier.id}>{supplier.no ? `${supplier.no} ` : ''}{supplier.name}</option>
                  ))}
                </select>
              ) : (
                <div className="text-body text-ink">{doc.supplierName || '—'}</div>
              )}
            </label>
          ) : (
            <div className="space-y-1 text-caption text-gray2">
              去向/原因
              <div className="text-body text-ink">{doc.reason || '—'}</div>
            </div>
          )}
          <div className="space-y-1 text-caption text-gray2">
            备注
            <div className="text-body text-ink">{doc.note || '—'}</div>
          </div>
        </div>

        {/* 行明细 */}
        <table className="mb-4 w-full min-w-[640px] text-body">
          <thead>
            <tr className="border-b border-border text-left text-caption text-gray2">
              <th className="py-2 pr-2">#</th>
              <th className="py-2 pr-2">商品</th>
              <th className="py-2 pr-2 text-right">数量</th>
              <th className="py-2 pr-2">单位</th>
              <th className="py-2 pr-2 text-right">单价</th>
              <th className="py-2 pr-2 text-right">金额{inbound ? '（价税合计）' : '（成本）'}</th>
              <th className="py-2 pr-2">批次/效期</th>
              <th className="py-2">备注</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map(line => {
              const edit = lineEdit(line.id)
              return (
                <tr key={line.id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-2 font-num text-gray2">{line.lineNo}</td>
                  <td className="py-2 pr-2">{line.productName}</td>
                  <td className="py-2 pr-2 text-right font-num">
                    {editable && inbound ? (
                      <input
                        value={edit.quantity ?? String(line.quantity)}
                        onChange={event => setLineEdit(line.id, 'quantity', event.target.value)}
                        className="h-8 w-24 rounded-cta border border-border px-2 text-right font-num"
                      />
                    ) : fmtQty(line.quantity)}
                  </td>
                  <td className="py-2 pr-2">{line.unit}</td>
                  <td className="py-2 pr-2 text-right font-num">{line.unitPrice === null ? '—' : money(line.unitPrice)}</td>
                  <td className="py-2 pr-2 text-right font-num">
                    {editable ? (
                      <input
                        value={edit.amount ?? String(line.amount)}
                        onChange={event => setLineEdit(line.id, 'amount', event.target.value)}
                        className="h-8 w-28 rounded-cta border border-border px-2 text-right font-num"
                      />
                    ) : money(line.amount)}
                  </td>
                  <td className="py-2 pr-2 text-caption text-gray2">
                    {line.batchNo || '—'}{line.expiryDate ? ` / ${fmtDay(line.expiryDate)}` : ''}
                  </td>
                  <td className="py-2">
                    {editable ? (
                      <input
                        value={edit.note ?? (line.note || '')}
                        onChange={event => setLineEdit(line.id, 'note', event.target.value)}
                        className="h-8 w-32 rounded-cta border border-border px-2"
                      />
                    ) : (line.note || '—')}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="text-body font-semibold">
              <td colSpan={5} className="py-2 text-right text-gray2">合计</td>
              <td className="py-2 text-right font-num">{money(doc.totalAmount)}</td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>

        {/* 改单操作区 */}
        {editable && (
          <div className="mb-4 space-y-2 rounded-card border border-border p-4">
            <p className="text-caption text-gray2">
              可改：金额/单价、{inbound ? '数量（批次未被消耗时）、供应商、' : ''}备注。金额变化自动生成差额调整流水；数量变化自动冲销重记。出库单数量不能改（数量差错请走实盘/报损）。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={editReason}
                onChange={event => setEditReason(event.target.value)}
                placeholder="修改原因（必填，如：供应商后补运费）"
                className="h-9 min-w-64 flex-1 rounded-cta border border-border px-3 text-body"
              />
              <button
                onClick={saveEdit}
                disabled={busy || !hasEdits()}
                className="h-9 rounded-cta bg-primary px-4 text-button text-white disabled:opacity-40"
              >{busy ? '保存中…' : '保存修改'}</button>
            </div>
          </div>
        )}

        {/* 审核操作区 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {doc.status === 'POSTED' && canAudit && (
            <button
              onClick={confirm}
              disabled={busy}
              className="h-9 rounded-cta bg-emerald-600 px-4 text-button text-white disabled:opacity-40"
            >{busy ? '处理中…' : '审核（锁定单据）'}</button>
          )}
          {doc.status === 'CONFIRMED' && canAudit && !unauditOpen && (
            <button
              onClick={() => setUnauditOpen(true)}
              disabled={busy}
              className="h-9 rounded-cta border border-amber-300 bg-amber-50 px-4 text-button text-amber-fg disabled:opacity-40"
            >反审核（退回仓库修改）</button>
          )}
          {unauditOpen && (
            <div className="flex w-full flex-wrap items-center gap-2 rounded-card border border-amber-200 bg-amber-50 p-3">
              <input
                value={unauditReason}
                onChange={event => setUnauditReason(event.target.value)}
                placeholder="退回原因（必填，仓库人员会看到）"
                className="h-9 min-w-64 flex-1 rounded-cta border border-border bg-white px-3 text-body"
              />
              <button
                onClick={unconfirm}
                disabled={busy}
                className="h-9 rounded-cta bg-amber-600 px-4 text-button text-white disabled:opacity-40"
              >确认退回</button>
              <button onClick={() => setUnauditOpen(false)} className="h-9 rounded-cta border border-border bg-white px-3 text-button text-gray2">取消</button>
            </div>
          )}
          {!canAudit && (
            <span className="text-caption text-gray2">审核/反审核仅会计与管理员可操作</span>
          )}
        </div>

        {/* 操作日志 */}
        <div className="rounded-card border border-border p-4">
          <h3 className="mb-2 text-body font-semibold">操作记录</h3>
          <ul className="space-y-1 text-caption text-gray2">
            {doc.logs.map(log => (
              <li key={log.id} className="flex flex-wrap gap-2">
                <span className="font-num">{fmtTime(log.createdAt)}</span>
                <span className="text-ink">{LOG_ACTION_LABEL[log.action]}</span>
                <span>{log.actorName || '系统'}</span>
                {log.reason && <span className="text-amber-fg">{log.reason}</span>}
                {log.action === 'EDIT' && log.detail?.lines?.length > 0 && (
                  <span>
                    {log.detail.lines.map((line: any) =>
                      `第${line.lineNo}行${line.productName}${line.amount ? ` 金额${line.amount.from}→${line.amount.to}` : ''}${line.quantity ? ` 数量${line.quantity.from}→${line.quantity.to}` : ''}`
                    ).join('；')}
                  </span>
                )}
                {log.action === 'EDIT' && log.detail?.header?.supplier && (
                  <span>供应商 {log.detail.header.supplier.from || '—'} → {log.detail.header.supplier.to}</span>
                )}
              </li>
            ))}
            {doc.logs.length === 0 && <li>暂无记录</li>}
          </ul>
        </div>
      </div>
    </div>
  )
}
