/**
 * 供应商 · 发票管理 + 上传
 *
 * 流程:
 *   1. 列出待开票账期 (从 /api/invoices/pending-payable)
 *   2. 选 1+ 笔 → 填发票信息 → 上传图片/PDF
 *   3. POST /api/invoices (multipart)
 *   4. 历史: /api/invoices 列表 (含审核状态)
 *
 * 财务审核通过 → 关联账期解锁付款 → 财务可发起转账
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch, getToken } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'

type Receipt = {
  id: string; no: string; totalAmount: string | number; deliveryDate: string
  store?: { name: string } | null
  paymentSchedule?: { amount: string | number; dueAt: string; status: string } | null
}
type Invoice = {
  id: string; invoiceNo: string; amount: string | number
  issueDate: string; uploadedAt: string
  status: 'PENDING' | 'VERIFIED' | 'REJECTED'
  reviewNote?: string | null
  fileUrl: string; fileType: string
  receipts?: Array<{ id: string; no: string; totalAmount: string | number; store?: { name: string } | null }>
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待审核', VERIFIED: '已通过', REJECTED: '已驳回',
}
const STATUS_TONE: Record<string, 'orange'|'green'|'red'> = {
  PENDING: 'orange', VERIFIED: 'green', REJECTED: 'red',
}

function fmt(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function SupplierInvoicesPage() {
  const [pending, setPending] = useState<Receipt[] | null>(null)
  const [history, setHistory] = useState<Invoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [form, setForm] = useState({
    invoiceNo: '', invoiceCode: '', amount: '', taxRate: '0.06',
    issueDate: new Date().toISOString().slice(0, 10), note: '',
  })
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function load() {
    Promise.all([
      apiFetch<Receipt[]>('/api/invoices/pending-payable').catch(() => []),
      apiFetch<Invoice[]>('/api/invoices').catch(() => []),
    ]).then(([p, h]) => {
      setPending(p || []); setHistory(h || [])
    })
  }
  useEffect(() => { load() }, [])

  const totalSelected = useMemo(() => {
    if (!pending) return 0
    return pending.filter(r => selectedIds.has(r.id)).reduce((s, x) => s + Number(x.totalAmount), 0)
  }, [pending, selectedIds])

  function toggle(id: string) {
    setSelectedIds(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  async function submit() {
    setError(null)
    if (selectedIds.size === 0) { setError('请勾选至少 1 笔订单'); return }
    if (!form.invoiceNo.trim()) { setError('请填发票号码'); return }
    if (!file) { setError('请上传发票文件'); return }
    if (!form.amount || Number(form.amount) <= 0) { setError('请填开票金额'); return }
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('invoiceNo', form.invoiceNo)
      if (form.invoiceCode) fd.append('invoiceCode', form.invoiceCode)
      fd.append('amount', form.amount)
      fd.append('issueDate', form.issueDate)
      if (form.taxRate) fd.append('taxRate', form.taxRate)
      if (form.note) fd.append('note', form.note)
      fd.append('receiptIds', JSON.stringify([...selectedIds]))
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken() || ''}` },
        body: fd,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || '上传失败')
      }
      // reset
      setShowForm(false); setSelectedIds(new Set()); setFile(null)
      setForm({ invoiceNo: '', invoiceCode: '', amount: '', taxRate: '0.06',
                issueDate: new Date().toISOString().slice(0, 10), note: '' })
      load()
    } catch (e: any) { setError(e.message || '上传失败') }
    setSubmitting(false)
  }

  const statusCount = (history || []).reduce((acc: any, h) => {
    acc[h.status] = (acc[h.status] || 0) + 1; return acc
  }, {})

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => window.history.length > 1 ? window.history.back() : (location.href = '/v2/supplier/billing')} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">发票管理</h1>
          <p className="text-caption text-gray3">财务审核通过后, 关联账期可付款</p>
        </div>
      </header>

      {/* 统计 */}
      <div className="mx-4 mt-3 grid grid-cols-3 gap-2">
        <Stat label="待开票订单" value={pending?.length ?? '—'} amount={pending ? `¥${pending.reduce((s, x) => s + Number(x.totalAmount), 0).toLocaleString()}` : ''} tone="orange" />
        <Stat label="待审核" value={statusCount.PENDING ?? '—'} tone="orange" />
        <Stat label="已通过" value={statusCount.VERIFIED ?? '—'} tone="green" />
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {/* 待开票订单 */}
      <Section title="待开票订单" right={pending ? `${pending.length} 单` : ''}>
        {pending === null && <p className="text-caption text-gray3 text-center py-6">加载中…</p>}
        {pending?.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无待开票订单</p>
            <p className="text-micro text-gray4 mt-1">订单确认入库后会出现在这里, 可批量勾选合并开票</p>
          </div>
        )}
        {pending && pending.length > 0 && (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {pending.map(r => {
              const checked = selectedIds.has(r.id)
              const sched = r.paymentSchedule
              return (
                <li key={r.id} onClick={() => toggle(r.id)} className={`px-3 py-3 cursor-pointer flex items-start gap-3 ${checked ? 'bg-amber/5' : ''}`}>
                  <div className={`w-5 h-5 rounded border-2 mt-0.5 shrink-0 flex items-center justify-center ${checked ? 'bg-amber border-amber text-white' : 'border-gray4 bg-white'}`}>
                    {checked && <span className="text-[10px] leading-none">✓</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-num text-gray3 text-caption">{r.no}</span>
                      <span className="font-num text-h2">¥{Number(r.totalAmount).toLocaleString()}</span>
                    </div>
                    <p className="text-micro text-gray3 truncate">
                      {r.store?.name || '门店'} · 入库 {fmt(r.deliveryDate)}
                      {sched && ` · 应付 ${fmt(sched.dueAt)}`}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {/* 历史发票 */}
      <Section title="发票历史" right={history ? `${history.length} 张` : ''}>
        {history?.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无上传的发票</p>
          </div>
        )}
        {history && history.length > 0 && (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {history.map(h => (
              <li key={h.id} className="px-3 py-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-caption text-gray3 font-num">#{h.invoiceNo}</span>
                  <Chip tone={STATUS_TONE[h.status]}>{STATUS_LABEL[h.status]}</Chip>
                  <span className="text-micro text-gray3 ml-auto">{fmt(h.uploadedAt)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-h2 font-num">¥{Number(h.amount).toLocaleString()}</span>
                  <span className="text-caption text-gray3">关联 {h.receipts?.length || 0} 单</span>
                </div>
                {h.status === 'REJECTED' && h.reviewNote && (
                  <p className="text-micro text-red-fg mt-1">驳回原因: {h.reviewNote}</p>
                )}
                <a href={h.fileUrl} target="_blank" rel="noreferrer" className="text-micro text-amber-fg mt-0.5 inline-block">查看原图 ↗</a>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 上传按钮(浮动) */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3">
        <button onClick={() => setShowForm(true)}
                disabled={selectedIds.size === 0}
                className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {selectedIds.size > 0 ? `上传发票 · ${selectedIds.size} 单 ¥${totalSelected.toLocaleString()}` : '请先勾选订单'}
        </button>
      </div>

      {/* 上传表单 抽屉 */}
      {showForm && (
        <div className="fixed inset-0 z-50" onClick={() => !submitting && setShowForm(false)}>
          <div className="absolute inset-0 bg-ink/60" />
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
            <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
              <h3 className="text-h2">填写发票信息</h3>
              <span className="text-caption text-gray3">{selectedIds.size} 单 · ¥{totalSelected.toLocaleString()}</span>
            </div>

            <div className="px-4 pb-3 space-y-3">
              <Field label="发票号码 *">
                <input value={form.invoiceNo} onChange={e => setForm(s => ({...s, invoiceNo: e.target.value}))}
                       placeholder="12 位" className={IN + ' font-num'} />
              </Field>
              <Field label="发票代码(电子票留空)">
                <input value={form.invoiceCode} onChange={e => setForm(s => ({...s, invoiceCode: e.target.value}))}
                       placeholder="10/12 位" className={IN + ' font-num'} />
              </Field>
              <Field label="价税合计金额 *">
                <input type="number" step="0.01" value={form.amount} onChange={e => setForm(s => ({...s, amount: e.target.value}))}
                       placeholder={`建议 ¥${totalSelected.toFixed(2)}`} className={IN + ' font-num'} />
              </Field>
              <Field label="税率">
                <select value={form.taxRate} onChange={e => setForm(s => ({...s, taxRate: e.target.value}))} className={IN}>
                  <option value="0.13">13%</option>
                  <option value="0.09">9%</option>
                  <option value="0.06">6%</option>
                  <option value="0.03">3%</option>
                  <option value="0">0% (免税)</option>
                </select>
              </Field>
              <Field label="开票日期 *">
                <input type="date" value={form.issueDate} max={new Date().toISOString().slice(0, 10)}
                       onChange={e => setForm(s => ({...s, issueDate: e.target.value}))} className={IN} />
              </Field>
              <Field label="发票图片 / PDF *">
                <input type="file" accept="image/*,.pdf"
                       onChange={e => setFile(e.target.files?.[0] || null)} className="text-caption" />
                {file && <p className="text-micro text-gray3 mt-1">{file.name} · {Math.round(file.size/1024)} KB</p>}
              </Field>
              <Field label="备注(可选)">
                <textarea rows={2} value={form.note} onChange={e => setForm(s => ({...s, note: e.target.value}))}
                          placeholder="特别说明" className={IN + ' resize-none'} />
              </Field>
            </div>

            <div className="border-t border-border p-3 flex gap-3">
              <button onClick={() => setShowForm(false)} disabled={submitting}
                      className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={submit} disabled={submitting}
                      className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                {submitting ? '上传中…' : `提交 · 关联 ${selectedIds.size} 单`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const IN = 'w-full text-body bg-bg rounded-chip px-3 py-2 outline-none'

function Stat({ label, value, amount, tone }: { label: string; value: any; amount?: string; tone?: 'orange'|'green' }) {
  const cls = tone === 'orange' ? 'text-orange-fg' : tone === 'green' ? 'text-green-fg' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`font-num text-h2 ${cls}`}>{value}</div>
      {amount && <div className="text-micro text-gray3 font-num">{amount}</div>}
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className="text-caption text-gray3">{right}</span>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-micro text-gray3 block mb-1">{label}</label>
      {children}
    </div>
  )
}
