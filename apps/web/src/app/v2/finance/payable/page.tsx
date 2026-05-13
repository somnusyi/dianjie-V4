/**
 * 财务 · 应付管理 (按发票分次付款)
 *
 * 流程:
 *   1. 列出 status=VERIFIED 且未付清的发票
 *   2. 财务点"发起付款" → 输入金额 (≤ remaining)
 *   3. POST /api/invoice-payments → 创建 PENDING
 *   4. 银行回调或手工确认 → 累加 paidAmount → 全付清后 fullyPaidAt
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'

type Receipt = {
  id: string; no: string; totalAmount: string | number; deliveryDate: string
  store?: { name: string } | null
  paymentSchedule?: { dueAt: string; status: string } | null
}
type Payment = {
  id: string; amount: string | number; status: 'PENDING'|'SUCCESS'|'FAILED'|'CANCELED'
  paidAt?: string | null; createdAt: string
}
type Invoice = {
  id: string
  invoiceNo: string
  amount: string | number
  paidAmount: string | number
  remainingAmount: number
  paidPct: number
  fileUrl: string
  issueDate: string
  earliestDueAt: string | null
  supplier: { name: string }
  receipts: Receipt[]
  payments: Payment[]
}

function fmt(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}
function daysTill(iso: string | null) {
  if (!iso) return null
  return Math.round((new Date(iso).getTime() - Date.now()) / 86400000)
}

export default function FinancePayablePage() {
  const [items, setItems] = useState<Invoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<Invoice | null>(null)   // 发起付款抽屉
  const [payAmount, setPayAmount] = useState('')
  const [payNote, setPayNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function load() {
    apiFetch<Invoice[]>('/api/invoice-payments/payable')
      .then(setItems)
      .catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [])

  // 排序: 逾期 > 即将到期 > 余额大 > 余额小
  const sorted = useMemo(() => {
    if (!items) return []
    return [...items].sort((a, b) => {
      const da = daysTill(a.earliestDueAt) ?? 999
      const db = daysTill(b.earliestDueAt) ?? 999
      if (da !== db) return da - db
      return b.remainingAmount - a.remainingAmount
    })
  }, [items])

  const totals = useMemo(() => {
    if (!items) return { total: 0, paid: 0, remaining: 0, count: 0 }
    return items.reduce((s, i) => ({
      total: s.total + Number(i.amount),
      paid:  s.paid  + Number(i.paidAmount),
      remaining: s.remaining + Number(i.remainingAmount),
      count: s.count + 1,
    }), { total: 0, paid: 0, remaining: 0, count: 0 })
  }, [items])

  function openPay(inv: Invoice) {
    setTarget(inv)
    setPayAmount(inv.remainingAmount.toFixed(2))
    setPayNote('')
  }

  async function submitPay() {
    if (!target) return
    const amt = Number(payAmount)
    if (!amt || amt <= 0) { alert('付款金额必须 > 0'); return }
    if (amt > target.remainingAmount + 0.01) {
      alert(`金额超过剩余可付 ¥${target.remainingAmount.toLocaleString()}`); return
    }
    setSubmitting(true)
    try {
      await apiFetch('/api/invoice-payments', {
        method: 'POST',
        body: JSON.stringify({
          invoiceId: target.id, amount: amt,
          paymentMethod: 'cmb', note: payNote || null,
        }),
      })
      setTarget(null); setPayAmount(''); setPayNote('')
      load()
    } catch (e: any) { alert(e.message || '付款失败') }
    setSubmitting(false)
  }

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">应付管理</h1>
          <p className="text-caption text-gray3">按发票分次付款 · 累计 ≤ 开票金额</p>
        </div>
      </header>

      {/* 总览 */}
      <div className="mx-4 mt-3 bg-ink text-white rounded-card p-4">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-caption text-white/70">应付合计</span>
          <span className="font-num text-h1">¥{totals.remaining.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-3 mt-2 text-caption">
          <div className="flex-1">
            <div className="text-micro text-white/60">{totals.count} 张未付清</div>
            <div className="font-num text-button">总开票 ¥{totals.total.toLocaleString()}</div>
          </div>
          <div className="flex-1">
            <div className="text-micro text-white/60">已付</div>
            <div className="font-num text-button text-green-fg">¥{totals.paid.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <ul className="px-4 mt-4 space-y-2">
        {items === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {items?.length === 0 && (
          <li className="text-caption text-gray3 text-center py-12">暂无待付发票</li>
        )}
        {sorted.map(inv => {
          const dueDays = daysTill(inv.earliestDueAt)
          const overdue = dueDays != null && dueDays < 0
          const urgent = dueDays != null && dueDays >= 0 && dueDays <= 3
          const hasPending = inv.payments.some(p => p.status === 'PENDING')
          return (
            <li key={inv.id} className={`bg-white rounded-card border border-border p-3 ${overdue ? 'bg-red-bg/40' : ''}`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {overdue && <Chip tone="red">逾期 {-dueDays!} 天</Chip>}
                {urgent && !overdue && <Chip tone="orange">{dueDays} 天到期</Chip>}
                {hasPending && <Chip tone="amber">付款中</Chip>}
                <span className="text-caption text-gray3 font-num">#{inv.invoiceNo}</span>
                <span className="text-micro text-gray3 ml-auto">应付 {inv.earliestDueAt ? fmt(inv.earliestDueAt) : '—'}</span>
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-h2">{inv.supplier.name}</span>
                <span className="font-num text-h2">¥{Number(inv.remainingAmount).toLocaleString()}</span>
              </div>
              <p className="text-caption text-gray2 mb-2">
                关联 {inv.receipts.length} 单 · 开票 ¥{Number(inv.amount).toLocaleString()}
                {Number(inv.paidAmount) > 0 && <span> · 已付 ¥{Number(inv.paidAmount).toLocaleString()}</span>}
              </p>
              {/* 进度条 */}
              <div className="h-1.5 bg-bg rounded-full overflow-hidden mb-2">
                <div className="h-full bg-amber transition-all" style={{ width: `${inv.paidPct}%` }} />
              </div>
              {/* 历史付款 */}
              {inv.payments.length > 0 && (
                <ul className="text-micro text-gray3 space-y-0.5 mb-2 pl-2 border-l-2 border-border">
                  {inv.payments.map(p => (
                    <li key={p.id} className="flex items-center gap-2">
                      <span>{p.status === 'SUCCESS' ? '✓' : p.status === 'PENDING' ? '⏳' : '✗'}</span>
                      <span className="font-num">¥{Number(p.amount).toLocaleString()}</span>
                      <span>{p.status === 'SUCCESS' ? '已到账' : p.status === 'PENDING' ? '处理中' : '失败'}</span>
                      <span className="ml-auto">{fmt(p.paidAt || p.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid grid-cols-2 gap-2">
                <a href={inv.fileUrl} target="_blank" rel="noreferrer"
                   className="py-2 border border-border rounded-cta text-button text-gray2 text-center">看发票</a>
                <button onClick={() => openPay(inv)}
                        disabled={hasPending}
                        className="py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                  发起付款
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {/* 付款抽屉 */}
      {target && (
        <div className="fixed inset-0 z-50" onClick={() => !submitting && setTarget(null)}>
          <div className="absolute inset-0 bg-ink/60" />
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
            <div className="px-4 pt-3 pb-2">
              <h3 className="text-h2">发起付款</h3>
              <p className="text-caption text-gray3">{target.supplier.name} · #{target.invoiceNo}</p>
            </div>

            <div className="px-4 pb-3 space-y-3">
              <div className="bg-bg-warm rounded-card border border-border p-3">
                <div className="flex justify-between text-caption">
                  <span className="text-gray2">开票总额</span>
                  <span className="font-num">¥{Number(target.amount).toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-caption mt-1">
                  <span className="text-gray2">已付</span>
                  <span className="font-num text-green-fg">¥{Number(target.paidAmount).toLocaleString()}</span>
                </div>
                <div className="border-t border-border my-2"></div>
                <div className="flex justify-between text-button">
                  <span className="text-amber-fg">本次可付</span>
                  <span className="font-num text-amber-fg">¥{target.remainingAmount.toLocaleString()}</span>
                </div>
              </div>

              <div>
                <label className="text-micro text-gray3 block mb-1">本次付款金额 *</label>
                <div className="bg-bg rounded-chip px-3 py-2 flex items-center gap-2">
                  <span className="text-gray3 font-num">¥</span>
                  <input
                    type="number" inputMode="decimal" min="0.01" step="0.01"
                    max={target.remainingAmount}
                    value={payAmount}
                    onChange={e => setPayAmount(e.target.value)}
                    className="flex-1 font-num text-h2 bg-transparent outline-none"
                  />
                </div>
                <div className="flex gap-2 mt-2">
                  <Quick label="全付" onClick={() => setPayAmount(target.remainingAmount.toFixed(2))} />
                  <Quick label="50%" onClick={() => setPayAmount((target.remainingAmount / 2).toFixed(2))} />
                  <Quick label="30%" onClick={() => setPayAmount((target.remainingAmount * 0.3).toFixed(2))} />
                </div>
              </div>

              <div>
                <label className="text-micro text-gray3 block mb-1">备注(可选)</label>
                <textarea rows={2} value={payNote} onChange={e => setPayNote(e.target.value)}
                          placeholder="本次付款说明: 现金流紧张/分批/...."
                          className="w-full bg-bg rounded-chip px-3 py-2 outline-none text-body resize-none" />
              </div>

              <div className="bg-orange-bg/30 rounded-card p-2 text-micro text-gray2">
                💡 提交后将创建付款单 (PENDING), 招行 cmb 自动发起转账, 银行确认后状态变 SUCCESS, 累加到已付金额
              </div>
            </div>

            <div className="border-t border-border p-3 flex gap-3">
              <button onClick={() => setTarget(null)} disabled={submitting}
                      className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={submitPay} disabled={submitting}
                      className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                {submitting ? '提交中…' : `付款 · ¥${Number(payAmount || 0).toLocaleString()}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Quick({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} type="button"
            className="px-3 py-1.5 bg-white border border-border rounded-cta text-button text-gray2">
      {label}
    </button>
  )
}
