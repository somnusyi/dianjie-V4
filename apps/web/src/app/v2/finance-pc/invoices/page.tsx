/**
 * 财务 PC Web · 发票审核
 *
 * Phase 3 P1
 * 接 /api/invoices?status= + PATCH /api/invoices/:id/verify
 *
 * PC UX:
 *   - 状态 tabs
 *   - Hero 4 卡: 待审 / 已通过 / 已驳回 / 待审金额
 *   - 双栏: 左 列表 (sticky) / 右 详情 + 操作
 *   - 在右侧点 通过 / 驳回
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'
import FinanceTopNav from '../_topnav'

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

const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`
const fmtMoney2 = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtMd = (iso: string) => dayjs(iso).format('MM/DD')

export default function FinancePCInvoicesPage() {
  const [filter, setFilter] = useState<'PENDING' | 'VERIFIED' | 'REJECTED' | 'ALL'>('PENDING')
  const [items, setItems] = useState<Invoice[] | null>(null)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [rejectNote, setRejectNote] = useState('')
  const [showReject, setShowReject] = useState(false)

  function load() {
    const url = filter === 'ALL' ? '/api/invoices' : `/api/invoices?status=${filter}`
    setItems(null); setError(null)
    apiFetch<Invoice[]>(url).then(d => {
      setItems(d)
      if (d.length > 0 && !d.find(x => x.id === pickedId)) setPickedId(d[0].id)
      if (d.length === 0) setPickedId(null)
    }).catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [filter])

  const picked = items?.find(i => i.id === pickedId) || null

  const filtered = useMemo(() => {
    if (!items) return []
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(i =>
      i.invoiceNo?.toLowerCase().includes(q) ||
      i.supplier?.name?.toLowerCase().includes(q) ||
      i.uploadedBy?.name?.toLowerCase().includes(q)
    )
  }, [items, search])

  const stats = useMemo(() => {
    if (!items) return { pending: 0, verified: 0, rejected: 0, pendingAmt: 0 }
    let pending = 0, verified = 0, rejected = 0, pendingAmt = 0
    items.forEach(i => {
      if (i.status === 'PENDING') { pending++; pendingAmt += Number(i.amount) }
      else if (i.status === 'VERIFIED') verified++
      else if (i.status === 'REJECTED') rejected++
    })
    return { pending, verified, rejected, pendingAmt }
  }, [items])

  async function decide(action: 'APPROVE' | 'REJECT', note?: string) {
    if (!picked || submitting) return
    if (action === 'REJECT' && !note?.trim()) { alert('请填写驳回原因'); return }
    setSubmitting(true)
    try {
      await apiFetch(`/api/invoices/${picked.id}/verify`, {
        method: 'PATCH', body: JSON.stringify({ action, note: note || null }),
      })
      setShowReject(false); setRejectNote('')
      load()
    } catch (e: any) { alert(e.message || '操作失败') }
    finally { setSubmitting(false) }
  }

  const tabs = [
    { key: 'PENDING' as const,  label: `待审 ${stats.pending}` },
    { key: 'VERIFIED' as const, label: `已通过 ${stats.verified}` },
    { key: 'REJECTED' as const, label: `已驳回 ${stats.rejected}` },
    { key: 'ALL' as const,      label: '全部' },
  ]

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">发票审核</h1>
            <p className="text-caption text-gray3">通过后, 关联账期解锁付款</p>
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索 (发票号 / 供应商 / 上传人)"
            className="px-3 py-2 rounded-cta border border-border bg-white text-button w-72"
          />
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* Hero 4 卡 */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="待审" value={String(stats.pending)} unit="张" tone={stats.pending > 0 ? 'amber' : 'gray'} />
          <Stat label="已通过" value={String(stats.verified)} unit="张" tone="green" />
          <Stat label="已驳回" value={String(stats.rejected)} unit="张" tone={stats.rejected > 0 ? 'red' : 'gray'} />
          <Stat label="待审金额" value={fmtMoney(stats.pendingAmt)} tone="amber" />
        </div>

        {/* tabs */}
        <div className="flex gap-2 mb-3 flex-wrap">
          {tabs.map(t => (
            <button key={t.key} onClick={() => setFilter(t.key)}
              className={`px-3 py-1.5 rounded-cta text-button ${filter === t.key ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* 双栏 列表 + 详情 */}
        <div className="grid grid-cols-[400px_1fr] gap-4">
          {/* 列表 */}
          <div className="bg-white rounded-card border border-border max-h-[calc(100vh-280px)] overflow-auto">
            {items === null && <div className="p-8 text-center text-caption text-gray3">加载中…</div>}
            {items !== null && filtered.length === 0 && (
              <div className="p-8 text-center text-caption text-gray3">{search ? '无匹配' : '暂无发票'}</div>
            )}
            <ul>
              {filtered.map(inv => (
                <li key={inv.id} onClick={() => setPickedId(inv.id)}
                    className={`border-b border-border p-3 cursor-pointer hover:bg-[#FAF8F2] ${pickedId === inv.id ? 'bg-amber/5 border-l-4 border-l-amber' : ''}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Chip tone={STATUS_TONE[inv.status]}>{STATUS_LABEL[inv.status]}</Chip>
                    <span className="text-micro text-gray3 font-num">#{inv.invoiceNo}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-body truncate">{inv.supplier.name}</span>
                    <span className="font-num text-body">{fmtMoney(Number(inv.amount))}</span>
                  </div>
                  <div className="text-micro text-gray3 mt-0.5">
                    关联 {inv.receipts.length} 单 · {inv.uploadedBy.name} 上传 {fmtMd(inv.uploadedAt)}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* 详情 */}
          {!picked && (
            <div className="bg-white rounded-card border border-border p-8 text-center text-caption text-gray3">
              ← 从左侧选一张发票
            </div>
          )}
          {picked && (
            <section className="bg-white rounded-card border border-border overflow-hidden">
              <header className="px-5 py-4 border-b border-border flex items-center gap-3 flex-wrap">
                <Chip tone={STATUS_TONE[picked.status]}>{STATUS_LABEL[picked.status]}</Chip>
                <span className="text-h2 font-num">#{picked.invoiceNo}</span>
                {picked.invoiceCode && <span className="text-caption text-gray3 font-num">代码 {picked.invoiceCode}</span>}
                <a href={picked.fileUrl} target="_blank" rel="noreferrer"
                   className="ml-auto px-3 py-1.5 bg-white border border-border rounded-cta text-button text-gray2">看发票原图 ↗</a>
              </header>

              <div className="px-5 py-4 grid grid-cols-2 gap-x-6 gap-y-3 border-b border-border">
                <Field label="供应商" value={picked.supplier.name} />
                <Field label="金额" value={fmtMoney2(Number(picked.amount))} valueCls="font-num text-h2" />
                <Field label="开票日" value={dayjs(picked.issueDate).format('YYYY-MM-DD')} />
                <Field label="税率" value={picked.taxRate ? `${(Number(picked.taxRate) * 100).toFixed(0)}%` : '—'} />
                <Field label="税额" value={picked.taxAmount ? fmtMoney2(Number(picked.taxAmount)) : '—'} />
                <Field label="上传" value={`${picked.uploadedBy.name} · ${dayjs(picked.uploadedAt).format('MM-DD HH:mm')}`} />
              </div>

              {/* 关联订单 */}
              <div className="px-5 py-4 border-b border-border">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-h2">关联订单 ({picked.receipts.length})</h3>
                  <span className="text-caption text-gray3">合计 <b className="font-num">{fmtMoney(picked.receipts.reduce((s, r) => s + Number(r.totalAmount), 0))}</b></span>
                </div>
                <table className="w-full">
                  <thead className="bg-bg/40">
                    <tr className="text-micro text-gray3 text-left">
                      <th className="px-2 py-2 font-normal">单号</th>
                      <th className="px-2 py-2 font-normal">门店</th>
                      <th className="px-2 py-2 font-normal w-24">到货</th>
                      <th className="px-2 py-2 font-normal text-right w-24">金额</th>
                      <th className="px-2 py-2 font-normal w-32">账期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {picked.receipts.map(r => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-2 py-2 font-num text-caption">{r.no}</td>
                        <td className="px-2 py-2 text-caption">{r.store?.name || '—'}</td>
                        <td className="px-2 py-2 text-caption text-gray2 font-num">{fmtMd(r.deliveryDate)}</td>
                        <td className="px-2 py-2 font-num text-caption text-right">{fmtMoney(Number(r.totalAmount))}</td>
                        <td className="px-2 py-2 text-caption text-gray3">
                          {r.paymentSchedule ? `${fmtMd(r.paymentSchedule.dueAt)} (${r.paymentSchedule.status})` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {picked.note && (
                <div className="px-5 py-3 border-b border-border text-caption">
                  <span className="text-gray3">上传备注: </span><span className="text-gray2">{picked.note}</span>
                </div>
              )}
              {picked.reviewNote && picked.status === 'REJECTED' && (
                <div className="px-5 py-3 border-b border-border bg-red-bg/30 text-caption text-red-fg">
                  驳回原因: {picked.reviewNote}
                </div>
              )}

              {/* 操作栏 */}
              {picked.status === 'PENDING' && !showReject && (
                <div className="px-5 py-4 flex gap-3">
                  <button onClick={() => setShowReject(true)} disabled={submitting}
                          className="px-5 py-3 border border-red text-red-fg rounded-cta text-button disabled:opacity-40">驳回</button>
                  <button onClick={() => decide('APPROVE')} disabled={submitting}
                          className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                    {submitting ? '提交中…' : '✓ 通过 → 关联账期解锁付款'}
                  </button>
                </div>
              )}
              {picked.status === 'PENDING' && showReject && (
                <div className="px-5 py-4 space-y-3">
                  <div>
                    <label className="text-micro text-gray3 block mb-1">驳回原因 *</label>
                    <textarea rows={3} value={rejectNote} onChange={e => setRejectNote(e.target.value)}
                              placeholder="例如: 发票号与订单号不匹配 / 金额对不上 / 发票模糊看不清"
                              className="w-full bg-bg rounded-chip px-3 py-2 outline-none text-body resize-none" />
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => { setShowReject(false); setRejectNote('') }} disabled={submitting}
                            className="px-5 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
                    <button onClick={() => decide('REJECT', rejectNote)} disabled={submitting || !rejectNote.trim()}
                            className="flex-1 py-3 bg-red text-white rounded-cta text-button disabled:opacity-40">
                      {submitting ? '提交中…' : '确认驳回'}
                    </button>
                  </div>
                </div>
              )}
              {picked.status !== 'PENDING' && (
                <div className="px-5 py-3 text-caption text-gray3 text-center">已审核 · {STATUS_LABEL[picked.status]}</div>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

function Field({ label, value, valueCls = 'text-body' }: { label: string; value: string; valueCls?: string }) {
  return (
    <div>
      <div className="text-micro text-gray3">{label}</div>
      <div className={`mt-0.5 ${valueCls}`}>{value}</div>
    </div>
  )
}

function Stat({ label, value, unit, tone = 'default' }: { label: string; value: string; unit?: string; tone?: 'default' | 'red' | 'green' | 'gray' | 'amber' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'green' ? 'text-green-fg' : tone === 'amber' ? 'text-amber-fg' : tone === 'gray' ? 'text-gray3' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>
        {value}
        {unit && <span className="text-caption text-gray3 ml-1">{unit}</span>}
      </div>
    </div>
  )
}
