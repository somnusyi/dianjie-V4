/**
 * 财务 PC Web · 资本支出审批 + 付款
 *
 * Phase 3 P1
 * 接 /api/capital/projects + /api/capital/projects/:id (拉 expenses)
 *      PATCH /api/capital/expenses/:id/approve
 *      PATCH /api/capital/expenses/:id/pay
 *
 * PC UX:
 *   - Hero 4 卡: 待审批 / 待付款 / 已付款 / 待付金额
 *   - 状态 tabs + 类别筛选 + 项目筛选
 *   - 表格视图; 行内 批准 / 驳回 / 付款
 *   - 驳回时弹 prompt 输入原因
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type Project = {
  id: string; name: string
  store?: { id: string; name: string; no: string } | null
  expenses: Expense[]
}
type Expense = {
  id: string; vendor: string; category: string
  amount: string | number; requestedAt: string
  status: 'PENDING_APPROVAL'|'APPROVED'|'PAID'|'REJECTED'|'CANCELED'|'FAILED'
  rejectReason?: string | null; approvalNote?: string | null
  paidAt?: string | null; bankTxNo?: string | null
  fileUrl?: string | null; note?: string | null
  contract?: { vendor: string; category: string } | null
  projectId?: string
  projectName?: string
  storeName?: string
}
type CashAccount = {
  id: string; name: string; type: 'BANK' | 'CASH' | 'ALIPAY' | 'WECHAT'
  balance: string | number; cmbBindAccount?: string | null
}

const CATEGORY_LABEL: Record<string, string> = {
  RENT: '租金', DECORATION: '装修', EQUIPMENT: '设备',
  PAYROLL: '人员', LEGAL: '证照', MARKETING: '营销', OTHER: '其他',
}
const STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: '待审批', APPROVED: '待付款', PAID: '已付款',
  REJECTED: '已驳回', CANCELED: '已撤回', FAILED: '付款失败',
}
const STATUS_TONE: Record<string, 'orange'|'green'|'red'|'gray'> = {
  PENDING_APPROVAL: 'orange', APPROVED: 'orange', PAID: 'green',
  REJECTED: 'red', CANCELED: 'gray', FAILED: 'red',
}

const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`
const fmtMoney2 = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtMd = (iso: string) => dayjs(iso).format('MM/DD HH:mm')

export default function FinancePCCapitalReviewPage() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'PENDING_APPROVAL'|'APPROVED'|'PAID'|'REJECTED'|'ALL'>('PENDING_APPROVAL')
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL')
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [rejectFor, setRejectFor] = useState<Expense | null>(null)
  const [payFor, setPayFor] = useState<Expense | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  function load() {
    setError(null)
    apiFetch<Project[]>('/api/capital/projects')
      .then(async list => {
        const detailed = await Promise.all(
          list.map(p => apiFetch<Project>(`/api/capital/projects/${p.id}`).catch(() => null))
        )
        setProjects(detailed.filter(Boolean) as Project[])
      })
      .catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [])

  const allExpenses: Expense[] = useMemo(() => {
    if (!projects) return []
    const flat: Expense[] = []
    projects.forEach(p => {
      (p.expenses || []).forEach(e => {
        flat.push({
          ...e, projectId: p.id, projectName: p.name,
          storeName: p.store?.name || '未关联店',
        })
      })
    })
    return flat.sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())
  }, [projects])

  const filtered = useMemo(() => {
    let res = allExpenses
    if (filter !== 'ALL') res = res.filter(e => e.status === filter)
    if (categoryFilter !== 'ALL') res = res.filter(e => e.category === categoryFilter)
    return res
  }, [allExpenses, filter, categoryFilter])

  const stats = useMemo(() => {
    let pending = 0, approved = 0, paid = 0, pendingAmt = 0, approvedAmt = 0
    allExpenses.forEach(e => {
      const a = Number(e.amount)
      if (e.status === 'PENDING_APPROVAL') { pending++; pendingAmt += a }
      else if (e.status === 'APPROVED')    { approved++; approvedAmt += a }
      else if (e.status === 'PAID')        { paid++ }
    })
    return { pending, approved, paid, pendingAmt, approvedAmt }
  }, [allExpenses])

  async function approve(e: Expense, decision: 'APPROVE' | 'REJECT', note?: string) {
    if (submitting) return
    if (decision === 'APPROVE' && !confirm(`批准付款 ¥${Number(e.amount).toLocaleString()} → ${e.vendor}?`)) return
    setSubmitting(e.id)
    try {
      await apiFetch(`/api/capital/expenses/${e.id}/approve`, {
        method: 'PATCH', body: JSON.stringify({ decision, note: note || null }),
      })
      setRejectFor(null); setRejectNote('')
      load()
    } catch (err: any) { alert(err.message) }
    finally { setSubmitting(null) }
  }

  const tabs = [
    { k: 'PENDING_APPROVAL', l: `待审批 ${stats.pending}` },
    { k: 'APPROVED',         l: `待付款 ${stats.approved}` },
    { k: 'PAID',             l: `已付款 ${stats.paid}` },
    { k: 'REJECTED',         l: '已驳回' },
    { k: 'ALL',              l: '全部' },
  ] as const

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">资本支出审批</h1>
            <p className="text-caption text-gray3">店长申请 → 老板/财务批 → 财务付款</p>
          </div>
          <a href="/v2/finance/capital-review"
             className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2">手机端 →</a>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* Hero 4 卡 */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="待审批" value={String(stats.pending)} unit="笔" tone={stats.pending > 0 ? 'red' : 'gray'} />
          <Stat label="待付款" value={String(stats.approved)} unit="笔" tone={stats.approved > 0 ? 'amber' : 'gray'} />
          <Stat label="已付款" value={String(stats.paid)} unit="笔" tone="green" />
          <Stat label="待付金额" value={fmtMoney(stats.pendingAmt + stats.approvedAmt)} tone="amber" />
        </div>

        {/* tabs */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {tabs.map(t => (
            <button key={t.k} onClick={() => setFilter(t.k)}
              className={`px-3 py-1.5 rounded-cta text-button ${filter === t.k ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {t.l}
            </button>
          ))}
          <div className="flex-1" />
          <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
                  className="px-3 py-1.5 rounded-cta border border-border bg-white text-button">
            <option value="ALL">全部类别</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>

        {/* 表格 */}
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-24">申请时间</th>
                <th className="px-3 py-2 font-normal">供应商 / 项目 / 类别</th>
                <th className="px-3 py-2 font-normal w-24">门店</th>
                <th className="px-3 py-2 font-normal text-right w-28">金额</th>
                <th className="px-3 py-2 font-normal w-32">状态</th>
                <th className="px-3 py-2 font-normal text-right w-56">操作</th>
              </tr>
            </thead>
            <tbody>
              {projects === null && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {projects !== null && filtered.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">无记录</td></tr>
              )}
              {filtered.map(e => (
                <tr key={e.id} className={`border-t border-border hover:bg-[#FAF8F2] ${e.status === 'PENDING_APPROVAL' ? 'bg-red-bg/20' : e.status === 'APPROVED' ? 'bg-amber/5' : ''}`}>
                  <td className="px-3 py-2.5 text-micro text-gray3 font-num">{fmtMd(e.requestedAt)}</td>
                  <td className="px-3 py-2.5">
                    <div className="text-body truncate">{e.vendor}</div>
                    <div className="text-micro text-gray3 truncate">
                      {e.projectName} · <span className="text-gray2">{CATEGORY_LABEL[e.category] || e.category}</span>
                      {e.contract && ` · 合同 ${e.contract.vendor}`}
                    </div>
                    {e.note && <div className="text-micro text-gray3 mt-0.5 truncate">{e.note}</div>}
                    {e.status === 'REJECTED' && e.rejectReason && <div className="text-micro text-red-fg mt-0.5">驳回: {e.rejectReason}</div>}
                    {e.status === 'PAID' && e.bankTxNo && <div className="text-micro text-green-fg mt-0.5 font-num">流水 {e.bankTxNo}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-caption">{e.storeName}</td>
                  <td className="px-3 py-2.5 font-num text-right text-body">{fmtMoney2(Number(e.amount))}</td>
                  <td className="px-3 py-2.5">
                    <Chip tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Chip>
                    {e.fileUrl && (
                      <a href={e.fileUrl} target="_blank" rel="noreferrer"
                         className="block text-micro text-amber-fg mt-0.5">凭证 ↗</a>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    {e.status === 'PENDING_APPROVAL' && (
                      <>
                        <button onClick={() => setRejectFor(e)} disabled={submitting === e.id}
                                className="px-3 py-1.5 border border-red text-red-fg rounded-cta text-button disabled:opacity-40">驳回</button>
                        <button onClick={() => approve(e, 'APPROVE')} disabled={submitting === e.id}
                                className="ml-2 px-3 py-1.5 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                          {submitting === e.id ? '处理中…' : '批准'}
                        </button>
                      </>
                    )}
                    {e.status === 'APPROVED' && (
                      <button onClick={() => setPayFor(e)} disabled={submitting === e.id}
                              className="px-4 py-1.5 bg-amber text-white rounded-cta text-button disabled:opacity-40">
                        {submitting === e.id ? '处理中…' : '付款'}
                      </button>
                    )}
                    {e.status === 'PAID' && e.paidAt && (
                      <span className="text-micro text-gray3 font-num">{fmtMd(e.paidAt)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      {/* 驳回 drawer */}
      {rejectFor && (
        <div className="fixed inset-0 z-50" onClick={() => !submitting && setRejectFor(null)}>
          <div className="absolute inset-0 bg-ink/40" />
          <div className="absolute right-0 top-0 bottom-0 w-[420px] bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-h2">驳回申请</h3>
                <p className="text-caption text-gray3">{rejectFor.vendor} · {fmtMoney2(Number(rejectFor.amount))}</p>
              </div>
              <button onClick={() => setRejectFor(null)} className="text-h2 text-gray3">×</button>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div>
                <label className="text-micro text-gray3 block mb-1">驳回原因 *</label>
                <textarea rows={4} value={rejectNote} onChange={e => setRejectNote(e.target.value)}
                          placeholder="例如: 预算超额 / 缺合同 / 等待报价单"
                          className="w-full bg-bg rounded-chip px-3 py-2 outline-none text-body resize-none" />
              </div>
            </div>
            <div className="border-t border-border px-6 py-3 flex gap-3">
              <button onClick={() => setRejectFor(null)} disabled={!!submitting}
                      className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={() => approve(rejectFor, 'REJECT', rejectNote)}
                      disabled={!!submitting || !rejectNote.trim()}
                      className="flex-1 py-3 bg-red text-white rounded-cta text-button disabled:opacity-40">
                {submitting ? '提交中…' : '确认驳回'}
              </button>
            </div>
          </div>
        </div>
      )}
      {payFor && (
        <CapitalPayModal
          expense={payFor}
          onClose={() => setPayFor(null)}
          onDone={() => { setPayFor(null); load() }}
        />
      )}
    </div>
  )
}

function CapitalPayModal({ expense, onClose, onDone }: { expense: Expense; onClose: () => void; onDone: () => void }) {
  const [paymentMethod, setPaymentMethod] = useState<'cmb' | 'bank' | 'cash'>('bank')
  const [accounts, setAccounts] = useState<CashAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [accountError, setAccountError] = useState('')
  const [bankTxNo, setBankTxNo] = useState('')
  const [paidAt, setPaidAt] = useState(dayjs().format('YYYY-MM-DD'))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiFetch<CashAccount[]>('/api/cashbook/accounts').then(setAccounts).catch(e => setAccountError(e?.message || '账户加载失败'))
  }, [])
  const eligible = accounts.filter(account => {
    if (paymentMethod === 'cash') return account.type === 'CASH'
    if (paymentMethod === 'cmb') return account.type === 'BANK' && !!account.cmbBindAccount
    return account.type === 'BANK'
  })
  useEffect(() => {
    if (!eligible.some(account => account.id === accountId)) setAccountId(eligible[0]?.id || '')
  }, [accounts, accountId, paymentMethod])

  async function submit() {
    if (!accountId) return
    setBusy(true)
    try {
      const result = await apiFetch<any>(`/api/capital/expenses/${expense.id}/pay`, {
        method: 'PATCH', body: JSON.stringify({
          paymentMethod, accountId, bankTxNo: bankTxNo || undefined, paidAt,
        }),
      })
      if (result?.voucherWarning) alert(result.voucherWarning)
      onDone()
    } catch (e: any) { alert(e?.message || '付款失败'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/40" />
      <div className="absolute right-0 top-0 bottom-0 w-[420px] bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div><h3 className="text-h2">确认资本支出付款</h3><p className="text-caption text-gray3">{expense.vendor} · {fmtMoney2(Number(expense.amount))}</p></div>
          <button onClick={onClose} className="text-h2 text-gray3">×</button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="text-micro text-gray3 block mb-1">付款方式</label>
            <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as any)} className="w-full px-3 py-2 rounded-cta border border-border bg-white">
              <option value="bank">银行转账</option><option value="cmb">招行 APP</option><option value="cash">库存现金</option>
            </select>
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">实际扣款账户</label>
            <select value={accountId} onChange={e => setAccountId(e.target.value)} className="w-full px-3 py-2 rounded-cta border border-border bg-white">
              {eligible.length === 0 && <option value="">— 没有符合条件的活动账户 —</option>}
              {eligible.map(account => <option key={account.id} value={account.id}>{account.name} · 余额 {fmtMoney2(Number(account.balance))}</option>)}
            </select>
            {accountError && <p className="text-micro text-red-fg mt-1">{accountError}</p>}
          </div>
          <div><label className="text-micro text-gray3 block mb-1">付款日期</label><input type="date" value={paidAt} onChange={e => setPaidAt(e.target.value)} className="w-full px-3 py-2 rounded-cta border border-border font-num" /></div>
          <div><label className="text-micro text-gray3 block mb-1">银行流水号（可选）</label><input value={bankTxNo} onChange={e => setBankTxNo(e.target.value)} className="w-full px-3 py-2 rounded-cta border border-border font-num" /></div>
          <div className="bg-amber-bg text-amber-fg rounded-card p-3 text-caption">付款将同步扣减资金账户、累计项目/合同已付，并生成“其他应收款—总部代付”凭证。</div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 border-t border-border px-6 py-3 flex gap-3">
          <button onClick={onClose} className="px-4 py-3 border border-border rounded-cta">取消</button>
          <button onClick={submit} disabled={busy || !accountId} className="flex-1 py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">{busy ? '付款中…' : `确认付款 · ${fmtMoney2(Number(expense.amount))}`}</button>
        </div>
      </div>
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
