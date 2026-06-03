/**
 * 财务 PC · 工资管理 (P2-1)
 *
 * 流程: 上传 Excel 工资单 → 财务审 → 发放 → 自动生成凭证
 *
 * UX:
 *   - 列表: 月份 / 门店 / 实发合计 / 状态 / 操作
 *   - 顶部 "+ 新建工资单" → 跳上传页 /payroll/new
 *   - 行展开看明细
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type Item = {
  id: string; month: string
  totalGross?: string | number | null
  totalNet: string | number
  totalSocialSec?: string | number | null
  totalTax?: string | number | null
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'VOIDED'
  payDate?: string | null
  payMethod?: string | null
  voucherId?: string | null
  note?: string | null
  store: { id: string; name: string }
  _count: { items: number }
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿', APPROVED: '已批待发', PAID: '已发放', VOIDED: '已作废',
}
const STATUS_TONE: Record<string, 'amber' | 'green' | 'red' | 'gray'> = {
  DRAFT: 'amber', APPROVED: 'amber', PAID: 'green', VOIDED: 'gray',
}

const fmtMoney = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FinancePCPayrollPage() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filterMonth, setFilterMonth] = useState('')
  const [showMarkPaid, setShowMarkPaid] = useState<Item | null>(null)

  async function load() {
    setItems(null); setError(null)
    try {
      const url = `/api/payroll${filterMonth ? `?month=${filterMonth}` : ''}`
      const d = await apiFetch<Item[]>(url)
      setItems(d)
    } catch (e: any) { setError(e?.message || String(e)) }
  }
  useEffect(() => { void load() }, [filterMonth])

  async function doApprove(it: Item) {
    if (!confirm(`确认审批 ${it.month} 工资单? (${it._count.items} 人, 实发 ${fmtMoney(Number(it.totalNet))})`)) return
    try {
      await apiFetch(`/api/payroll/${it.id}/approve`, { method: 'PATCH' })
      await load()
    } catch (e: any) { alert(e?.message || '失败') }
  }
  async function doVoid(it: Item) {
    if (!confirm('确认作废? 已发放的需要先反审凭证 + 红冲')) return
    try {
      await apiFetch(`/api/payroll/${it.id}/void`, { method: 'PATCH' })
      await load()
    } catch (e: any) { alert(e?.message || '失败') }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">工资管理</h1>
            <p className="text-caption text-gray3">Excel 上传 → 审批 → 发放 → 自动凭证 (借管理费用 / 贷银行)</p>
          </div>
          <div className="flex items-center gap-2">
            <MonthPicker value={filterMonth || dayjs().format('YYYY-MM')} onChange={setFilterMonth} />
            {filterMonth && (
              <button onClick={() => setFilterMonth('')} className="text-caption text-gray3">清</button>
            )}
            <a href="/v2/finance-pc/payroll/new"
               className="px-4 py-2 bg-amber text-white rounded-cta text-button">+ 上传工资单</a>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-24">月份</th>
                <th className="px-3 py-2 font-normal">门店</th>
                <th className="px-3 py-2 font-normal text-right w-20">人数</th>
                <th className="px-3 py-2 font-normal text-right w-32">应发</th>
                <th className="px-3 py-2 font-normal text-right w-32">实发</th>
                <th className="px-3 py-2 font-normal w-24">状态</th>
                <th className="px-3 py-2 font-normal w-32">发放</th>
                <th className="px-3 py-2 font-normal text-right w-44">操作</th>
              </tr>
            </thead>
            <tbody>
              {items === null && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {items !== null && items.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-caption text-gray3">暂无工资单, 去上传</td></tr>
              )}
              {items?.map(it => (
                <tr key={it.id} className="border-t border-border hover:bg-bg/40">
                  <td className="px-3 py-2.5 font-num text-caption">{it.month}</td>
                  <td className="px-3 py-2.5">
                    <div className="text-body">{it.store.name}</div>
                    {it.note && <div className="text-micro text-gray3 truncate max-w-[200px]">{it.note}</div>}
                  </td>
                  <td className="px-3 py-2.5 font-num text-right">{it._count.items}</td>
                  <td className="px-3 py-2.5 font-num text-right text-caption">
                    {it.totalGross != null ? fmtMoney(Number(it.totalGross)) : '—'}
                  </td>
                  <td className="px-3 py-2.5 font-num text-right text-button">
                    {fmtMoney(Number(it.totalNet))}
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={STATUS_TONE[it.status]}>{STATUS_LABEL[it.status]}</Chip>
                  </td>
                  <td className="px-3 py-2.5 text-caption">
                    {it.payDate ? dayjs(it.payDate).format('MM/DD') : '—'}
                    {it.payMethod && <div className="text-micro text-gray3">{it.payMethod}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex justify-end gap-1.5 flex-wrap">
                      {it.status === 'DRAFT' && (
                        <button onClick={() => doApprove(it)}
                                className="px-2.5 py-1 bg-ink text-white rounded text-caption">审批</button>
                      )}
                      {it.status === 'APPROVED' && (
                        <button onClick={() => setShowMarkPaid(it)}
                                className="px-2.5 py-1 bg-amber text-white rounded text-caption">发放</button>
                      )}
                      {it.voucherId && (
                        <a href={`/v2/finance-pc/vouchers/${it.voucherId}`}
                           className="px-2.5 py-1 bg-white border border-border rounded text-caption text-gray2">凭证 ›</a>
                      )}
                      <a href={`/v2/finance-pc/payroll/${it.id}`}
                         className="px-2.5 py-1 bg-white border border-border rounded text-caption text-gray2">明细 ›</a>
                      {['DRAFT', 'APPROVED'].includes(it.status) && (
                        <button onClick={() => doVoid(it)}
                                className="px-2 py-1 text-caption text-red-fg">作废</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {showMarkPaid && <MarkPaidModal item={showMarkPaid} onClose={() => setShowMarkPaid(null)} onDone={load} />}
      </main>
    </div>
  )
}

function MarkPaidModal({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => void }) {
  const [payMethod, setPayMethod] = useState('转账')
  const [bankTxNo, setBankTxNo] = useState('')
  const [payDate, setPayDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      const r = await apiFetch<any>(`/api/payroll/${item.id}/mark-paid`, {
        method: 'PATCH',
        body: JSON.stringify({ payMethod, bankTxNo: bankTxNo || undefined, payDate }),
      })
      if (r?.voucherWarning) alert(r.voucherWarning)
      onDone(); onClose()
    } catch (e: any) { alert(e?.message || '失败'); setBusy(false) }
  }

  const fmt = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-card max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-h2">发放 {item.month} 工资</h3>
          <button onClick={onClose} className="text-gray3 text-h2">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-bg-warm rounded-card p-3 text-caption space-y-1">
            <div>实发合计: <b className="font-num">{fmt(Number(item.totalNet))}</b></div>
            <div>{item._count.items} 人 · {item.store.name}</div>
            {item.totalSocialSec && Number(item.totalSocialSec) > 0 && (
              <div className="text-gray3">代扣社保: {fmt(Number(item.totalSocialSec))}</div>
            )}
            {item.totalTax && Number(item.totalTax) > 0 && (
              <div className="text-gray3">代扣个税: {fmt(Number(item.totalTax))}</div>
            )}
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">发放方式</label>
            <select value={payMethod} onChange={e => setPayMethod(e.target.value)}
                    className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button">
              <option value="转账">银行转账 (借 5602 / 贷 1002)</option>
              <option value="现金">现金 (借 5602 / 贷 1001)</option>
              <option value="招行">招行 APP</option>
            </select>
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">发放日期</label>
            <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
                   className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num" />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">流水号 (可选)</label>
            <input value={bankTxNo} onChange={e => setBankTxNo(e.target.value)}
                   className="w-full px-3 py-2 rounded-cta border border-border bg-white text-caption font-num" />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
          <button onClick={submit} disabled={busy}
                  className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {busy ? '处理中…' : '确认发放 + 生成凭证'}
          </button>
        </div>
      </div>
    </div>
  )
}
