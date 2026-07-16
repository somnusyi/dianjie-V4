'use client'

import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { UserMenu } from '@/components/v2/user-menu'
import { apiFetch } from '@/lib/v2-auth'

type Expense = {
  id: string
  date: string
  category: string
  amount: string | number
  note?: string | null
}

type Item = {
  id: string
  month: string
  requestedAmount: string | number
  approvedAmount?: string | number | null
  spentAmount?: string | number | null
  returnedAmount?: string | number | null
  requestNote?: string | null
  reconcileNote?: string | null
  status: 'REQUESTED' | 'APPROVED' | 'PAID' | 'RECONCILING' | 'CLOSED' | 'CANCELED'
  store: { id: string; name: string }
  _count?: { expenses: number }
  expenses?: Expense[]
}

const STATUS_LABEL: Record<Item['status'], string> = {
  REQUESTED: '待财务批准', APPROVED: '已批待发放', PAID: '使用中',
  RECONCILING: '待财务关账', CLOSED: '已归档', CANCELED: '已取消',
}
const STATUS_TONE: Record<Item['status'], 'amber' | 'green' | 'red' | 'gray' | 'orange'> = {
  REQUESTED: 'amber', APPROVED: 'amber', PAID: 'orange',
  RECONCILING: 'orange', CLOSED: 'green', CANCELED: 'gray',
}
const money = (value: string | number | null | undefined) =>
  `¥${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function ManagerPettyCashPage() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [details, setDetails] = useState<Record<string, Item>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expenseTarget, setExpenseTarget] = useState<Item | null>(null)
  const [error, setError] = useState('')

  async function load() {
    setError('')
    try {
      setItems(await apiFetch<Item[]>('/api/petty-cash'))
    } catch (e: any) {
      setError(e?.message || '备用金加载失败')
      setItems([])
    }
  }
  useEffect(() => { void load() }, [])

  async function loadDetail(id: string) {
    const detail = await apiFetch<Item>(`/api/petty-cash/${id}`)
    setDetails(current => ({ ...current, [id]: detail }))
    return detail
  }

  async function expand(item: Item) {
    if (expandedId === item.id) { setExpandedId(null); return }
    setExpandedId(item.id)
    if (!details[item.id]) {
      try { await loadDetail(item.id) } catch (e: any) { setError(e?.message || '明细加载失败') }
    }
  }

  async function removeExpense(item: Item, expense: Expense) {
    if (!confirm(`删除 ${expense.category} ${money(expense.amount)}？`)) return
    try {
      await apiFetch(`/api/petty-cash/${item.id}/expenses/${expense.id}`, { method: 'DELETE' })
      await loadDetail(item.id)
      await load()
    } catch (e: any) { setError(e?.message || '删除失败') }
  }

  async function reconcile(item: Item) {
    try {
      const detail = details[item.id] || await loadDetail(item.id)
      const spent = (detail.expenses || []).reduce((total, expense) => total + Number(expense.amount), 0)
      const approved = Number(detail.approvedAmount || 0)
      const returned = Math.round((approved - spent) * 100) / 100
      if (returned < 0) throw new Error('开支已超过批准额，请先检查明细')
      if (!confirm(`确认提交报账？\n已录开支 ${money(spent)}\n应退余款 ${money(returned)}\n提交后不能再修改开支。`)) return
      await apiFetch(`/api/petty-cash/${item.id}/reconcile`, {
        method: 'PATCH', body: JSON.stringify({ spentAmount: spent, returnedAmount: returned }),
      })
      await load()
      await loadDetail(item.id)
    } catch (e: any) { setError(e?.message || '提交报账失败') }
  }

  const activeCount = useMemo(() => (items || []).filter(item =>
    ['REQUESTED', 'APPROVED', 'PAID', 'RECONCILING'].includes(item.status),
  ).length, [items])

  return (
    <div className="min-h-screen bg-bg pb-10">
      <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <a href="/v2/manager/home" aria-label="返回工作台"
           className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center text-h2">‹</a>
        <div className="flex-1">
          <h1 className="text-h1">备用金管理</h1>
          <p className="text-micro text-gray3">申请 · 录开支 · 月末报账</p>
        </div>
        <UserMenu />
      </header>

      <main className="px-4 py-4 space-y-3">
        <div className="bg-bg-warm rounded-card border border-border p-4 flex items-center justify-between">
          <div>
            <div className="text-caption text-gray2">进行中的备用金</div>
            <div className="text-hero font-num mt-1">{items === null ? '—' : activeCount}</div>
          </div>
          <a href="/v2/manager/initiate?type=PETTY_CASH"
             className="px-4 py-2.5 bg-ink text-white rounded-cta text-button">+ 申请备用金</a>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
        {items === null && <div className="bg-white rounded-card p-5 text-center text-caption text-gray3">加载中…</div>}
        {items?.length === 0 && <div className="bg-white rounded-card p-5 text-center text-caption text-gray3">暂无备用金记录</div>}

        {items?.map(item => {
          const detail = details[item.id]
          const expenses = detail?.expenses || []
          const spent = expenses.reduce((total, expense) => total + Number(expense.amount), 0)
          return (
            <section key={item.id} className="bg-white rounded-card border border-border overflow-hidden">
              <button onClick={() => expand(item)} className="w-full p-4 text-left">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-h2 font-num">{item.month}</div>
                    <div className="text-caption text-gray2 mt-1">申请 {money(item.requestedAmount)} · {item.store.name}</div>
                  </div>
                  <Chip tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Chip>
                </div>
                {item.approvedAmount != null && (
                  <div className="mt-3 pt-3 border-t border-border grid grid-cols-3 gap-2 text-center">
                    <MiniStat label="批准" value={money(item.approvedAmount)} />
                    <MiniStat label="已花" value={money(item.spentAmount ?? spent)} />
                    <MiniStat label="退余" value={item.returnedAmount == null ? '待计算' : money(item.returnedAmount)} />
                  </div>
                )}
              </button>

              {expandedId === item.id && (
                <div className="border-t border-border bg-bg/40 p-3 space-y-3">
                  {!detail && <div className="text-caption text-gray3">明细加载中…</div>}
                  {detail && (
                    <>
                      {detail.requestNote && <div className="text-caption text-gray2">用途：{detail.requestNote}</div>}
                      <div className="flex items-center justify-between">
                        <div className="text-button">开支明细 ({expenses.length})</div>
                        {item.status === 'PAID' && (
                          <button onClick={() => setExpenseTarget(item)}
                                  className="px-3 py-1.5 bg-amber text-white rounded text-caption">+ 录开支</button>
                        )}
                      </div>
                      {expenses.length === 0 && <div className="text-caption text-gray3">尚未录入开支</div>}
                      {expenses.map(expense => (
                        <div key={expense.id} className="bg-white rounded-card border border-border p-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-button">{expense.category}</div>
                            <div className="text-micro text-gray3">{dayjs(expense.date).format('MM/DD')} {expense.note || ''}</div>
                          </div>
                          <div className="font-num text-button">{money(expense.amount)}</div>
                          {item.status === 'PAID' && (
                            <button onClick={() => removeExpense(item, expense)} className="text-red-fg text-caption">删除</button>
                          )}
                        </div>
                      ))}
                      {item.status === 'PAID' && (
                        <button onClick={() => reconcile(item)}
                                className="w-full py-3 bg-ink text-white rounded-cta text-button">
                          提交报账 · 已花 {money(spent)} · 预计退 {money(Number(item.approvedAmount || 0) - spent)}
                        </button>
                      )}
                      {item.status === 'RECONCILING' && (
                        <div className="bg-amber-bg text-amber-fg rounded-card p-3 text-caption">已提交财务，等待核对退余款并关账。</div>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </main>

      {expenseTarget && (
        <ExpenseModal
          item={expenseTarget}
          onClose={() => setExpenseTarget(null)}
          onDone={async () => { await loadDetail(expenseTarget.id); await load() }}
        />
      )}
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return <div><div className="text-micro text-gray3">{label}</div><div className="text-caption font-num mt-0.5">{value}</div></div>
}

function ExpenseModal({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => Promise<void> }) {
  const [date, setDate] = useState(`${item.month}-${item.month === dayjs().format('YYYY-MM') ? dayjs().format('DD') : '01'}`)
  const [category, setCategory] = useState('零星采购')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    const value = Number(amount)
    if (!value || value <= 0) return
    setBusy(true)
    try {
      await apiFetch(`/api/petty-cash/${item.id}/expenses`, {
        method: 'POST', body: JSON.stringify({ date, category, amount: value, note: note || undefined }),
      })
      await onDone(); onClose()
    } catch (e: any) { alert(e?.message || '开支保存失败'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end" onClick={onClose}>
      <div className="bg-white rounded-t-card w-full p-4 space-y-3" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between"><h2 className="text-h2">录入备用金开支</h2><button onClick={onClose}>×</button></div>
        <input type="date" value={date} onChange={event => setDate(event.target.value)}
               className="w-full px-3 py-2.5 rounded-cta border border-border font-num" />
        <input value={category} onChange={event => setCategory(event.target.value)} placeholder="开支类别"
               className="w-full px-3 py-2.5 rounded-cta border border-border" />
        <input type="number" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} placeholder="金额"
               className="w-full px-3 py-2.5 rounded-cta border border-border font-num" />
        <textarea value={note} onChange={event => setNote(event.target.value)} placeholder="备注（可选）" rows={2}
                  className="w-full px-3 py-2.5 rounded-cta border border-border resize-none" />
        <button onClick={submit} disabled={busy || Number(amount) <= 0 || !category.trim()}
                className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {busy ? '保存中…' : `保存开支${Number(amount) > 0 ? ` · ${money(amount)}` : ''}`}
        </button>
      </div>
    </div>
  )
}
