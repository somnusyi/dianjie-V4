/**
 * 财务 · 发票审核
 * GET /api/invoices?status=PENDING (审核中)
 * PATCH /api/invoices/:id/verify { action: APPROVE | REJECT, note? }
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

type Invoice = {
  id: string; invoiceNo: string; invoiceCode?: string | null
  amount: string | number; taxRate?: string | number | null; taxAmount?: string | number | null
  issueDate: string; uploadedAt: string
  fileUrl: string; fileType: string
  note?: string | null
  status: 'PENDING' | 'VERIFIED' | 'REJECTED'
  reviewNote?: string | null
  supplier: { name: string }
  uploadedBy: { name: string }
  receipts: Array<{
    id: string; no: string; totalAmount: string | number; deliveryDate: string
    store?: { name: string } | null
    paymentSchedule?: { amount: string | number; dueAt: string; status: string } | null
  }>
}

const STATUS_LABEL: Record<string, string> = { PENDING: '待审', VERIFIED: '已通过', REJECTED: '已驳回' }
const STATUS_TONE: Record<string, 'orange'|'green'|'red'> = { PENDING: 'orange', VERIFIED: 'green', REJECTED: 'red' }

function fmt(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function FinanceInvoicesPage() {
  const [filter, setFilter] = useState<'PENDING' | 'VERIFIED' | 'REJECTED' | '全部'>('PENDING')
  const [items, setItems] = useState<Invoice[] | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  function load() {
    const url = filter === '全部' ? '/api/invoices' : `/api/invoices?status=${filter}`
    apiFetch<Invoice[]>(url).then(setItems).catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [filter])

  function decide(inv: Invoice, action: 'APPROVE' | 'REJECT') {
    if (submitting) return
    const post = async (note?: string) => {
      setSubmitting(inv.id)
      try {
        await apiFetch(`/api/invoices/${inv.id}/verify`, {
          method: 'PATCH', body: JSON.stringify({ action, note }),
        })
        load()
      } catch (e: any) { alert(e.message || '操作失败'); throw e }
      finally { setSubmitting(null) }
    }
    if (action === 'REJECT') {
      openConfirm({
        title: `驳回发票 #${inv.invoiceNo}`,
        body: '请简述原因，将通知供应商。',
        confirmLabel: '驳回',
        tone: 'danger',
        withInput: true,
        inputRequired: true,
        inputPlaceholder: '例如：发票号与订单号不匹配…',
        onConfirm: (note) => post(note),
      })
    } else {
      openConfirm({
        title: `通过 #${inv.invoiceNo}?`,
        body: `金额 ¥${Number(inv.amount).toLocaleString()} · 通过后关联 ${inv.receipts.length} 单可付款`,
        confirmLabel: '通过',
        tone: 'primary',
        onConfirm: () => post(),
      })
    }
  }

  const counts = items ? items.reduce<any>((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc }, {}) : {}
  const tabs = [
    { key: 'PENDING' as const, label: '待审' },
    { key: 'VERIFIED' as const, label: '已通过' },
    { key: 'REJECTED' as const, label: '已驳回' },
    { key: '全部' as const, label: '全部' },
  ]

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">发票审核</h1>
          <p className="text-caption text-gray3">通过后, 关联账期解锁付款</p>
        </div>
      </header>

      <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setFilter(t.key)}
            className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${filter === t.key ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {t.label}
            {t.key !== '全部' && counts[t.key] > 0 && <span className="ml-1 font-num">{counts[t.key]}</span>}
          </button>
        ))}
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <ul className="px-4 mt-3 space-y-2">
        {items === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {items?.length === 0 && (
          <li className="text-caption text-gray3 text-center py-12">{filter === 'PENDING' ? '暂无待审发票' : '无记录'}</li>
        )}
        {items?.map(inv => (
          <li key={inv.id} className="bg-white rounded-card border border-border p-3">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Chip tone={STATUS_TONE[inv.status]}>{STATUS_LABEL[inv.status]}</Chip>
              <span className="text-caption text-gray3 font-num">#{inv.invoiceNo}</span>
              <span className="text-micro text-gray3 ml-auto">上传 {fmt(inv.uploadedAt)}</span>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-h2">{inv.supplier.name}</span>
              <span className="font-num text-h2">¥{Number(inv.amount).toLocaleString()}</span>
            </div>
            <p className="text-caption text-gray2">
              开票日 {fmt(inv.issueDate)} · 税率 {inv.taxRate ? `${(Number(inv.taxRate)*100).toFixed(0)}%` : '—'} · {inv.uploadedBy.name} 上传
            </p>
            <div className="mt-2 bg-bg/50 rounded-card p-2">
              <div className="text-micro text-gray3 mb-1">关联订单 {inv.receipts.length} 单, 合计 ¥{inv.receipts.reduce((s, x) => s + Number(x.totalAmount), 0).toLocaleString()}</div>
              <ul className="space-y-0.5">
                {inv.receipts.slice(0, 3).map(r => (
                  <li key={r.id} className="text-micro text-gray2 truncate">
                    · {r.no} {r.store?.name ? `(${r.store.name})` : ''} ¥{Number(r.totalAmount).toLocaleString()}
                    {r.paymentSchedule && ` · 应付 ${fmt(r.paymentSchedule.dueAt)}`}
                  </li>
                ))}
                {inv.receipts.length > 3 && <li className="text-micro text-gray3">... 还有 {inv.receipts.length - 3} 单</li>}
              </ul>
            </div>
            <a href={inv.fileUrl} target="_blank" rel="noreferrer" className="text-caption text-amber-fg mt-2 inline-block">查看发票原图 ↗</a>
            {inv.note && <p className="text-micro text-gray3 mt-1">备注: {inv.note}</p>}
            {inv.reviewNote && inv.status === 'REJECTED' && (
              <p className="text-micro text-red-fg mt-1">驳回原因: {inv.reviewNote}</p>
            )}
            {inv.status === 'PENDING' && (
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button onClick={() => decide(inv, 'REJECT')} disabled={submitting === inv.id}
                        className="py-2 border border-red text-red rounded-cta text-button disabled:opacity-40">驳回</button>
                <button onClick={() => decide(inv, 'APPROVE')} disabled={submitting === inv.id}
                        className="py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                  {submitting === inv.id ? '提交中…' : '通过'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
