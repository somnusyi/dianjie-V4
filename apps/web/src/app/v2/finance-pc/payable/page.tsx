/**
 * 财务 PC Web · 应付管理 (按发票分次付款)
 *
 * Phase 3 P1
 * 接 /api/invoice-payments/payable + POST /api/invoice-payments + /api/cmb/balance
 *
 * PC UX:
 *   - 表格 + 银行可用余额对比 hero (实时招行)
 *   - 行内"发起付款"弹 right-side drawer (PC 习惯)
 *   - 单条排序: 逾期 → 即将到期 → 余额大
 *   - 一键看发票图片 (新 tab)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'
import dayjs from 'dayjs'
import FinanceTopNav from '../_topnav'

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
  id: string; invoiceNo: string
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

const fmt = (n: number) => `¥${Math.round(n).toLocaleString()}`
const fmt2 = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const daysTill = (iso: string | null) => iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86400000) : null

export default function FinancePCPayablePage() {
  const [items, setItems] = useState<Invoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<Invoice | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [payNote, setPayNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [bankAvailable, setBankAvailable] = useState<number | null>(null)
  const [search, setSearch] = useState('')

  function load() {
    apiFetch<Invoice[]>('/api/invoice-payments/payable')
      .then(setItems)
      .catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [])

  useEffect(() => {
    apiFetch<{ success: boolean; available?: string }>('/api/cmb/balance')
      .then(r => r.success && r.available != null && setBankAvailable(Number(r.available)))
      .catch(() => {})
  }, [])

  const sorted = useMemo(() => {
    if (!items) return []
    const q = search.trim().toLowerCase()
    let arr = items
    if (q) arr = arr.filter(i =>
      i.invoiceNo?.toLowerCase().includes(q) ||
      i.supplier?.name?.toLowerCase().includes(q)
    )
    return [...arr].sort((a, b) => {
      const da = daysTill(a.earliestDueAt) ?? 999
      const db = daysTill(b.earliestDueAt) ?? 999
      if (da !== db) return da - db
      return b.remainingAmount - a.remainingAmount
    })
  }, [items, search])

  const totals = useMemo(() => {
    if (!items) return { total: 0, paid: 0, remaining: 0, count: 0, overdue: 0 }
    return items.reduce((s, i) => {
      const days = daysTill(i.earliestDueAt)
      return {
        total: s.total + Number(i.amount),
        paid:  s.paid  + Number(i.paidAmount),
        remaining: s.remaining + Number(i.remainingAmount),
        count: s.count + 1,
        overdue: s.overdue + (days != null && days < 0 ? 1 : 0),
      }
    }, { total: 0, paid: 0, remaining: 0, count: 0, overdue: 0 })
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
      alert(`金额超过剩余可付 ${fmt2(target.remainingAmount)}`); return
    }
    setSubmitting(true)
    try {
      await apiFetch('/api/invoice-payments', {
        method: 'POST',
        body: JSON.stringify({ invoiceId: target.id, amount: amt, paymentMethod: 'cmb', note: payNote || null }),
      })
      setTarget(null); setPayAmount(''); setPayNote('')
      load()
    } catch (e: any) { alert(e.message || '付款失败') }
    setSubmitting(false)
  }

  const gap = bankAvailable != null ? bankAvailable - totals.remaining : null
  const shortfall = gap != null && gap < 0

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">应付管理</h1>
            <p className="text-caption text-gray3">按发票分次付款 · 累计 ≤ 开票金额</p>
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索 (供应商 / 发票号)"
            className="px-3 py-2 rounded-cta border border-border bg-white text-button w-72"
          />
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* Hero 4 卡 */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="应付合计" value={fmt(totals.remaining)} unit={`${totals.count} 张`} tone={totals.overdue > 0 ? 'red' : 'default'} />
          <Stat label="逾期" value={String(totals.overdue)} unit="张" tone={totals.overdue > 0 ? 'red' : 'gray'} />
          <Stat label="招行实时可用" value={bankAvailable != null ? fmt(bankAvailable) : '—'} tone="green" />
          <Stat label={shortfall ? '现金缺口' : '可付盈余'}
                value={gap != null ? `${gap < 0 ? '−' : '+'}${fmt(Math.abs(gap))}` : '—'}
                tone={shortfall ? 'red' : gap != null ? 'green' : 'gray'} />
        </div>

        {/* 表格 */}
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-32">发票号</th>
                <th className="px-3 py-2 font-normal">供应商</th>
                <th className="px-3 py-2 font-normal w-24 text-right">开票</th>
                <th className="px-3 py-2 font-normal w-24 text-right">已付</th>
                <th className="px-3 py-2 font-normal w-24 text-right">剩余</th>
                <th className="px-3 py-2 font-normal w-32">付款进度</th>
                <th className="px-3 py-2 font-normal w-28">到期</th>
                <th className="px-3 py-2 font-normal text-right w-36">操作</th>
              </tr>
            </thead>
            <tbody>
              {items === null && <tr><td colSpan={8} className="px-4 py-8 text-center text-caption text-gray3">加载中…</td></tr>}
              {items?.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-caption text-gray3">✓ 暂无待付发票</td></tr>}
              {sorted.map(inv => {
                const dueDays = daysTill(inv.earliestDueAt)
                const overdue = dueDays != null && dueDays < 0
                const urgent = dueDays != null && dueDays >= 0 && dueDays <= 3
                const hasPending = inv.payments.some(p => p.status === 'PENDING')
                return (
                  <tr key={inv.id} className={`border-t border-border hover:bg-[#FAF8F2] ${overdue ? 'bg-red-bg/30' : urgent ? 'bg-orange-bg/30' : ''}`}>
                    <td className="px-3 py-2.5 font-num text-body">{inv.invoiceNo}</td>
                    <td className="px-3 py-2.5">
                      <div className="text-body">{inv.supplier.name}</div>
                      <div className="text-micro text-gray3">关联 {inv.receipts.length} 单</div>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right text-caption">{fmt(Number(inv.amount))}</td>
                    <td className="px-3 py-2.5 font-num text-right text-caption text-green-fg">{fmt(Number(inv.paidAmount))}</td>
                    <td className="px-3 py-2.5 font-num text-right text-body">{fmt(Number(inv.remainingAmount))}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 bg-bg rounded-full overflow-hidden flex-1">
                          <div className="h-full bg-amber" style={{ width: `${inv.paidPct}%` }} />
                        </div>
                        <span className="text-micro font-num text-gray3 w-8 text-right">{Math.round(inv.paidPct)}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-caption">
                      {overdue && <Chip tone="red">逾期 {-dueDays!} 天</Chip>}
                      {urgent && !overdue && <Chip tone="orange">{dueDays} 天</Chip>}
                      {dueDays != null && dueDays > 3 && (
                        <span className="text-gray3 font-num">{dayjs(inv.earliestDueAt).format('MM/DD')}</span>
                      )}
                      {hasPending && <div className="mt-0.5"><Chip tone="amber">付款中</Chip></div>}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <a href={inv.fileUrl} target="_blank" rel="noreferrer"
                         className="px-2 py-1 text-caption text-gray2 hover:text-ink">看发票</a>
                      <button onClick={() => openPay(inv)} disabled={hasPending}
                              className="ml-1 px-3 py-1.5 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                        发起付款
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>

      {/* 发起付款 drawer (右侧滑入, PC 习惯) */}
      {target && (
        <div className="fixed inset-0 z-50" onClick={() => !submitting && setTarget(null)}>
          <div className="absolute inset-0 bg-ink/40" />
          <div className="absolute right-0 top-0 bottom-0 w-[480px] bg-white shadow-xl overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-h2">发起付款</h3>
                <p className="text-caption text-gray3">{target.supplier.name} · #{target.invoiceNo}</p>
              </div>
              <button onClick={() => setTarget(null)} className="text-h2 text-gray3">×</button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="bg-bg-warm rounded-card border border-border p-3 text-caption">
                <div className="flex justify-between"><span className="text-gray2">开票总额</span><span className="font-num">{fmt2(Number(target.amount))}</span></div>
                <div className="flex justify-between mt-1"><span className="text-gray2">已付</span><span className="font-num text-green-fg">{fmt2(Number(target.paidAmount))}</span></div>
                <div className="border-t border-border my-2"></div>
                <div className="flex justify-between text-button"><span className="text-amber-fg">本次可付</span><span className="font-num text-amber-fg">{fmt2(target.remainingAmount)}</span></div>
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">本次付款金额 *</label>
                <div className="bg-bg rounded-chip px-3 py-2 flex items-center gap-2">
                  <span className="text-gray3 font-num">¥</span>
                  <input type="number" inputMode="decimal" min="0.01" step="0.01" max={target.remainingAmount}
                         value={payAmount} onChange={e => setPayAmount(e.target.value)}
                         className="flex-1 font-num text-h2 bg-transparent outline-none" />
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={() => setPayAmount(target.remainingAmount.toFixed(2))} className="px-3 py-1.5 bg-white border border-border rounded-cta text-button text-gray2">全付</button>
                  <button onClick={() => setPayAmount((target.remainingAmount / 2).toFixed(2))} className="px-3 py-1.5 bg-white border border-border rounded-cta text-button text-gray2">50%</button>
                  <button onClick={() => setPayAmount((target.remainingAmount * 0.3).toFixed(2))} className="px-3 py-1.5 bg-white border border-border rounded-cta text-button text-gray2">30%</button>
                </div>
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">备注 (选填)</label>
                <textarea rows={3} value={payNote} onChange={e => setPayNote(e.target.value)}
                          placeholder="本次付款说明: 现金流紧张 / 分批 / ..."
                          className="w-full bg-bg rounded-chip px-3 py-2 outline-none text-body resize-none" />
              </div>
              <div className="bg-orange-bg/30 rounded-card p-3 text-caption text-gray2">
                💡 提交后创建付款单 (PENDING), 招行 cmb 自动转账, 银行确认 SUCCESS 后累加已付金额
              </div>
            </div>
            <div className="border-t border-border px-6 py-3 flex gap-3 sticky bottom-0 bg-white">
              <button onClick={() => setTarget(null)} disabled={submitting} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={submitPay} disabled={submitting} className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                {submitting ? '提交中…' : `付款 · ${fmt(Number(payAmount || 0))}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, unit, tone = 'default' }: { label: string; value: string; unit?: string; tone?: 'default' | 'red' | 'green' | 'gray' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'green' ? 'text-green-fg' : tone === 'gray' ? 'text-gray3' : ''
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
