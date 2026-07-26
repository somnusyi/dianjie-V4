'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type Schedule = {
  id: string
  amount: number | string
  status: string
  dueAt: string
  paidAt?: string | null
  supplier?: { name: string }
  receipt?: { no: string; deliveryDate: string; store?: { name: string } }
}
type Reconciliation = {
  id: string
  no: string
  totalAmount: number | string
  status: string
  periodStart: string
  periodEnd: string
  supplier?: { name: string; no: string }
}
type Invoice = {
  id: string
  invoiceNo: string
  amount: number | string
  status: string
  issueDate: string
  supplier?: { name: string }
  receipts?: Array<{ id: string }>
}

function money(value: unknown) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

export default function InternalSupplyChainBillingPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'schedule' | 'reconciliation' | 'invoice'>('schedule')

  useEffect(() => {
    Promise.all([
      apiFetch<Schedule[]>('/api/schedules'),
      apiFetch<Reconciliation[]>('/api/reconciliations'),
      apiFetch<Invoice[]>('/api/invoices'),
    ])
      .then(([scheduleRows, reconciliationRows, invoiceRows]) => {
        setSchedules(scheduleRows || [])
        setReconciliations(reconciliationRows || [])
        setInvoices(invoiceRows || [])
      })
      .catch(reason => setError(String(reason?.message || reason)))
      .finally(() => setLoading(false))
  }, [])

  const stats = useMemo(() => {
    const open = schedules.filter(item => item.status !== 'PAID' && item.status !== 'CANCELLED')
    const overdue = open.filter(item => new Date(item.dueAt).getTime() < Date.now())
    const paidThisMonth = schedules.filter(item => item.status === 'PAID'
      && item.paidAt
      && new Date(item.paidAt).getMonth() === new Date().getMonth())
    return {
      open: open.reduce((sum, item) => sum + Number(item.amount), 0),
      overdue: overdue.reduce((sum, item) => sum + Number(item.amount), 0),
      paid: paidThisMonth.reduce((sum, item) => sum + Number(item.amount), 0),
      pendingInvoices: invoices.filter(item => item.status === 'PENDING').length,
    }
  }, [schedules, invoices])

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="border-b border-border pb-5">
        <div className="mb-2 flex items-center gap-2">
          <Chip tone="green">内部只读</Chip>
          <span className="text-caption text-gray3">付款与审核仍由财务执行</span>
        </div>
        <h1 className="text-h1">账务查询</h1>
        <p className="mt-1 text-caption text-gray2">查看全部供应商的账期、对账单与发票，不提供付款、审核或银行操作。</p>
      </header>

      {error && <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      <section className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="未付账期" value={money(stats.open)} />
        <Metric label="其中逾期" value={money(stats.overdue)} tone="red" />
        <Metric label="本月已付" value={money(stats.paid)} />
        <Metric label="待审发票" value={`${stats.pendingInvoices} 张`} />
      </section>

      <div className="mb-4 flex gap-2">
        <Tab active={tab === 'schedule'} onClick={() => setTab('schedule')}>账期 {schedules.length}</Tab>
        <Tab active={tab === 'reconciliation'} onClick={() => setTab('reconciliation')}>对账单 {reconciliations.length}</Tab>
        <Tab active={tab === 'invoice'} onClick={() => setTab('invoice')}>发票 {invoices.length}</Tab>
      </div>

      <div className="overflow-hidden rounded-card border border-border bg-white">
        {loading && <div className="py-16 text-center text-caption text-gray3">加载中…</div>}
        {!loading && tab === 'schedule' && (
          <table className="w-full text-left text-caption">
            <thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">供应商 / 入库单</th><th className="px-4 py-3">门店</th><th className="px-4 py-3">到期日</th><th className="px-4 py-3">状态</th><th className="px-4 py-3 text-right">金额</th></tr></thead>
            <tbody className="divide-y divide-border">
              {schedules.map(item => (
                <tr key={item.id}>
                  <td className="px-4 py-3"><b>{item.supplier?.name || '—'}</b><div className="font-num text-micro text-gray3">{item.receipt?.no || '—'}</div></td>
                  <td className="px-4 py-3 text-gray2">{item.receipt?.store?.name || '—'}</td>
                  <td className="px-4 py-3 font-num">{item.dueAt?.slice(0, 10)}</td>
                  <td className="px-4 py-3"><Chip tone={item.status === 'PAID' ? 'green' : new Date(item.dueAt).getTime() < Date.now() ? 'red' : 'orange'}>{item.status}</Chip></td>
                  <td className="px-4 py-3 text-right font-num">{money(item.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && tab === 'reconciliation' && (
          <table className="w-full text-left text-caption">
            <thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">对账单</th><th className="px-4 py-3">供应商</th><th className="px-4 py-3">期间</th><th className="px-4 py-3">状态</th><th className="px-4 py-3 text-right">金额</th></tr></thead>
            <tbody className="divide-y divide-border">
              {reconciliations.map(item => (
                <tr key={item.id}>
                  <td className="px-4 py-3 font-num"><b>{item.no}</b></td>
                  <td className="px-4 py-3">{item.supplier?.name || '—'}</td>
                  <td className="px-4 py-3 font-num text-gray2">{item.periodStart?.slice(0, 10)} 至 {item.periodEnd?.slice(0, 10)}</td>
                  <td className="px-4 py-3"><Chip tone="gray">{item.status}</Chip></td>
                  <td className="px-4 py-3 text-right font-num">{money(item.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && tab === 'invoice' && (
          <table className="w-full text-left text-caption">
            <thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">发票号码</th><th className="px-4 py-3">供应商</th><th className="px-4 py-3">开票日</th><th className="px-4 py-3">关联入库</th><th className="px-4 py-3">状态</th><th className="px-4 py-3 text-right">金额</th></tr></thead>
            <tbody className="divide-y divide-border">
              {invoices.map(item => (
                <tr key={item.id}>
                  <td className="px-4 py-3 font-num"><b>{item.invoiceNo}</b></td>
                  <td className="px-4 py-3">{item.supplier?.name || '—'}</td>
                  <td className="px-4 py-3 font-num text-gray2">{item.issueDate?.slice(0, 10)}</td>
                  <td className="px-4 py-3 font-num">{item.receipts?.length || 0} 单</td>
                  <td className="px-4 py-3"><Chip tone={item.status === 'VERIFIED' ? 'green' : item.status === 'REJECTED' ? 'red' : 'orange'}>{item.status}</Chip></td>
                  <td className="px-4 py-3 text-right font-num">{money(item.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && ((tab === 'schedule' && schedules.length === 0)
          || (tab === 'reconciliation' && reconciliations.length === 0)
          || (tab === 'invoice' && invoices.length === 0)) && (
          <div className="py-16 text-center text-caption text-gray3">暂无记录</div>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'red' }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className={`mt-1 font-num text-h1 ${tone === 'red' ? 'text-red-fg' : ''}`}>{value}</div></div>
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`rounded-cta px-4 py-2 text-button ${active ? 'bg-ink text-white' : 'border border-border bg-white text-gray2'}`}>{children}</button>
}
