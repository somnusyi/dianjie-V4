/**
 * 财务 PC · 备用金管理 (P1-3)
 *
 * 真实业务: 店长申请 → 财务批 + 发 → 店长报账 → 财务归档 (财务基本业务清单 #2 B2B/快驴备用金核对)
 *
 * UX:
 *   - 表格: 月份 / 门店 / 申请额 / 批准额 / 已花 / 退余 / 状态 / 操作
 *   - 状态机操作按钮: 批准 / 关账 / 取消
 *   - 行可点开 → 详情 + 开支明细
 *   - 顶部 '+ 新建备用金' (财务也可代店长申请)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type Item = {
  id: string
  storeId: string
  month: string
  requestedAmount: string | number
  approvedAmount?: string | number | null
  spentAmount?: string | number | null
  returnedAmount?: string | number | null
  paymentMethod?: string | null
  bankTxNo?: string | null
  requestNote?: string | null
  reconcileNote?: string | null
  paidAt?: string | null
  approvedAt?: string | null
  reconciledAt?: string | null
  status: 'REQUESTED' | 'APPROVED' | 'PAID' | 'RECONCILING' | 'CLOSED' | 'CANCELED'
  store: { id: string; name: string }
  _count: { expenses: number }
}

type Store = { id: string; name: string }

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: '待批准', APPROVED: '已批待发', PAID: '已发放使用中',
  RECONCILING: '待财务关账', CLOSED: '已归档', CANCELED: '已取消',
}
const STATUS_TONE: Record<string, 'amber' | 'green' | 'red' | 'gray' | 'orange'> = {
  REQUESTED: 'amber', APPROVED: 'amber', PAID: 'orange',
  RECONCILING: 'orange', CLOSED: 'green', CANCELED: 'gray',
}

const fmtMoney = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FinancePCPettyCashPage() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [stores, setStores] = useState<Store[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showApprove, setShowApprove] = useState<Item | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expenses, setExpenses] = useState<Record<string, any[]>>({})

  async function load() {
    setItems(null); setError(null)
    try {
      const [it, st] = await Promise.all([
        apiFetch<Item[]>('/api/petty-cash'),
        apiFetch<Store[]>('/api/stores'),
      ])
      setItems(it); setStores(st)
    } catch (e: any) { setError(e?.message || String(e)) }
  }
  useEffect(() => { void load() }, [])

  async function expand(it: Item) {
    if (expandedId === it.id) { setExpandedId(null); return }
    setExpandedId(it.id)
    if (!expenses[it.id]) {
      try {
        const d = await apiFetch<{ expenses: any[] }>(`/api/petty-cash/${it.id}`)
        setExpenses(e => ({ ...e, [it.id]: d.expenses || [] }))
      } catch {}
    }
  }

  async function doClose(it: Item) {
    if (!confirm(`确定将 ${it.store.name} ${it.month} 备用金归档?`)) return
    try {
      await apiFetch(`/api/petty-cash/${it.id}/close`, { method: 'PATCH' })
      await load()
    } catch (e: any) { alert(e?.message || '失败') }
  }
  async function doCancel(it: Item) {
    if (!confirm('确定取消申请?')) return
    try {
      await apiFetch(`/api/petty-cash/${it.id}/cancel`, { method: 'PATCH' })
      await load()
    } catch (e: any) { alert(e?.message || '失败') }
  }
  async function doPay(it: Item) {
    const method = prompt(`发放方式 (现金/转账/招行):`, '现金')
    if (!method) return
    try {
      await apiFetch(`/api/petty-cash/${it.id}/pay`, {
        method: 'PATCH',
        body: JSON.stringify({ paymentMethod: method }),
      })
      await load()
    } catch (e: any) { alert(e?.message || '失败') }
  }

  const summary = useMemo(() => {
    if (!items) return null
    return {
      requested: items.filter(i => i.status === 'REQUESTED').length,
      paid: items.filter(i => i.status === 'PAID').length,
      reconciling: items.filter(i => i.status === 'RECONCILING').length,
      totalOutstanding: items.filter(i => ['PAID', 'RECONCILING'].includes(i.status))
        .reduce((s, i) => s + Number(i.approvedAmount || 0), 0),
    }
  }, [items])

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">备用金管理</h1>
            <p className="text-caption text-gray3">店长申请 → 财务批 → 店长用 → 月底报账 → 财务归档</p>
          </div>
          <button onClick={() => setShowNew(true)}
                  className="px-4 py-2 bg-amber text-white rounded-cta text-button">+ 新建备用金</button>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* 汇总卡 */}
        {summary && (
          <div className="grid grid-cols-4 gap-3 mb-4">
            <Stat label="待批准" value={summary.requested} tone={summary.requested > 0 ? 'amber' : 'gray'} />
            <Stat label="已发使用中" value={summary.paid} tone={summary.paid > 0 ? 'orange' : 'gray'} />
            <Stat label="待财务关账" value={summary.reconciling} tone={summary.reconciling > 0 ? 'red' : 'gray'} />
            <Stat label="未归档余额" value={fmtMoney(summary.totalOutstanding)} tone="amber" />
          </div>
        )}

        {/* 列表 */}
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-24">月份</th>
                <th className="px-3 py-2 font-normal">门店 / 申请人</th>
                <th className="px-3 py-2 font-normal text-right w-28">申请额</th>
                <th className="px-3 py-2 font-normal text-right w-28">批准/已花/退余</th>
                <th className="px-3 py-2 font-normal w-32">状态</th>
                <th className="px-3 py-2 font-normal text-right w-44">操作</th>
              </tr>
            </thead>
            <tbody>
              {items === null && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {items !== null && items.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-caption text-gray3">暂无备用金记录, 去新建</td></tr>
              )}
              {items?.map(it => {
                const isExpanded = expandedId === it.id
                return (
                  <>
                    <tr key={it.id} className="border-t border-border hover:bg-bg/40">
                      <td className="px-3 py-2.5 font-num text-caption">{it.month}</td>
                      <td className="px-3 py-2.5">
                        <div className="text-body">{it.store.name}</div>
                        {it._count.expenses > 0 && <div className="text-micro text-gray3">{it._count.expenses} 笔开支</div>}
                      </td>
                      <td className="px-3 py-2.5 font-num text-right">{fmtMoney(Number(it.requestedAmount))}</td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="font-num text-caption">{it.approvedAmount != null ? fmtMoney(Number(it.approvedAmount)) : '—'}</div>
                        {it.spentAmount != null && (
                          <div className="text-micro text-gray3">
                            花 {fmtMoney(Number(it.spentAmount))} / 退 {fmtMoney(Number(it.returnedAmount || 0))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <Chip tone={STATUS_TONE[it.status]}>{STATUS_LABEL[it.status]}</Chip>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex justify-end gap-1.5 flex-wrap">
                          {it.status === 'REQUESTED' && (
                            <>
                              <button onClick={() => setShowApprove(it)}
                                      className="px-2.5 py-1 bg-ink text-white rounded text-caption">批准</button>
                              <button onClick={() => doCancel(it)}
                                      className="px-2 py-1 text-caption text-red-fg">取消</button>
                            </>
                          )}
                          {it.status === 'APPROVED' && (
                            <button onClick={() => doPay(it)}
                                    className="px-2.5 py-1 bg-amber text-white rounded text-caption">发放</button>
                          )}
                          {it.status === 'RECONCILING' && (
                            <button onClick={() => doClose(it)}
                                    className="px-2.5 py-1 bg-ink text-white rounded text-caption">关账归档</button>
                          )}
                          <button onClick={() => expand(it)}
                                  className="px-2.5 py-1 bg-white border border-border rounded text-caption text-gray2">
                            {isExpanded ? '收起' : '详情'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-bg/40">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1 text-caption">
                              <div><b>申请备注</b>: {it.requestNote || '—'}</div>
                              {it.paidAt && <div><b>发放</b>: {dayjs(it.paidAt).format('YYYY-MM-DD HH:mm')} · {it.paymentMethod}</div>}
                              {it.bankTxNo && <div><b>流水号</b>: <span className="font-num">{it.bankTxNo}</span></div>}
                              {it.reconciledAt && <div><b>报账</b>: {dayjs(it.reconciledAt).format('YYYY-MM-DD HH:mm')}</div>}
                              {it.reconcileNote && <div><b>报账备注</b>: {it.reconcileNote}</div>}
                            </div>
                            <div>
                              <div className="text-button mb-1">开支明细 ({expenses[it.id]?.length || 0})</div>
                              {!expenses[it.id] && <div className="text-caption text-gray3">加载中…</div>}
                              {expenses[it.id] && expenses[it.id].length === 0 && (
                                <div className="text-caption text-gray3">无开支记录</div>
                              )}
                              {expenses[it.id] && expenses[it.id].length > 0 && (
                                <ul className="space-y-0.5 text-micro">
                                  {expenses[it.id].map((e: any) => (
                                    <li key={e.id} className="flex justify-between">
                                      <span>{dayjs(e.date).format('MM/DD')} · {e.category}</span>
                                      <span className="font-num">{fmtMoney(Number(e.amount))}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 新建申请 modal */}
        {showNew && <NewModal stores={stores} onClose={() => setShowNew(false)} onCreated={load} />}
        {/* 批准 modal */}
        {showApprove && <ApproveModal item={showApprove} onClose={() => setShowApprove(null)} onApproved={load} />}
      </main>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone: 'amber' | 'green' | 'red' | 'gray' | 'orange' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'green' ? 'text-green-fg' : tone === 'amber' ? 'text-amber-fg' : tone === 'orange' ? 'text-orange-fg' : 'text-gray3'
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>{value}</div>
    </div>
  )
}

function NewModal({ stores, onClose, onCreated }: { stores: Store[]; onClose: () => void; onCreated: () => void }) {
  const [storeId, setStoreId] = useState(stores[0]?.id || '')
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    const amt = Number(amount)
    if (!storeId || !amt || amt <= 0) { alert('请填门店和金额'); return }
    setBusy(true)
    try {
      await apiFetch('/api/petty-cash', {
        method: 'POST',
        body: JSON.stringify({ storeId, month, requestedAmount: amt, requestNote: note || undefined }),
      })
      onCreated(); onClose()
    } catch (e: any) { alert(e?.message || '失败'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-card max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-h2">新建备用金申请</h3>
          <button onClick={onClose} className="text-gray3 text-h2">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-micro text-gray3 block mb-1">门店</label>
            <select value={storeId} onChange={e => setStoreId(e.target.value)}
                    className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button">
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">月份</label>
            <MonthPicker value={month} onChange={setMonth} />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">申请金额</label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
                   placeholder="如 5000" className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num" />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">备注 (可选)</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                      placeholder="如 美菜+快驴 月度采购"
                      className="w-full px-3 py-2 rounded-cta border border-border bg-white text-caption" />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
          <button onClick={submit} disabled={busy}
                  className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {busy ? '提交中…' : '提交申请'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ApproveModal({ item, onClose, onApproved }: { item: Item; onClose: () => void; onApproved: () => void }) {
  const [amount, setAmount] = useState(String(item.requestedAmount))
  const [busy, setBusy] = useState(false)

  async function submit() {
    const amt = Number(amount)
    if (!amt || amt <= 0) { alert('金额不对'); return }
    setBusy(true)
    try {
      await apiFetch(`/api/petty-cash/${item.id}/approve`, {
        method: 'PATCH',
        body: JSON.stringify({ approvedAmount: amt }),
      })
      onApproved(); onClose()
    } catch (e: any) { alert(e?.message || '失败'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-card max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-h2">批准 {item.store.name} {item.month}</h3>
          <button onClick={onClose} className="text-gray3 text-h2">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-bg-warm rounded-card p-3 text-caption">
            申请金额: <span className="font-num">¥{Number(item.requestedAmount).toLocaleString()}</span>
            {item.requestNote && <div className="text-gray3 mt-1">备注: {item.requestNote}</div>}
            <div className="text-amber-fg mt-2">💡 批准后不立即扣款, 还需点 "发放" 才扣 + 生凭证</div>
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">批准金额</label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
                   className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num" />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
          <button onClick={submit} disabled={busy}
                  className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {busy ? '处理中…' : '确认批准'}
          </button>
        </div>
      </div>
    </div>
  )
}
