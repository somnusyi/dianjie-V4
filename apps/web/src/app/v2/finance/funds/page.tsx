/**
 * 财务 App · 资金 Tab  PDF: finance_funds_tab  Tab 3/4
 * 接真数据:
 *   /api/cashbook/summary       总余额 + 月流入流出
 *   /api/cashbook/accounts      账户列表
 *   /api/schedules?status=&days  本周应付到期
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BlackHero, BottomNav, Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type CashbookSummary = {
  totalBalance: number | string
  monthIncome: number | string
  monthExpense: number | string
  monthNet: number | string
  accounts: Array<{ id: string; name: string; type: string; balance: number | string }>
}
type Account = {
  id: string; name: string; type: string
  bankName?: string; accountNo?: string
  balance: string | number; status: string
}
type Schedule = {
  id: string; amount: string | number; dueAt: string; status: string
  supplier?: { name: string } | null
  receipt?: {
    no: string; store?: { name: string } | null
    invoice?: { id: string; invoiceNo: string; status: string } | null
  } | null
}

function fmtDate(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}
function dayLabel(iso: string) {
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(iso).getDay()]
}

export default function FinanceFundsPage() {
  const [tab] = useState('funds')
  const [summary, setSummary] = useState<CashbookSummary | null>(null)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      apiFetch<CashbookSummary>('/api/cashbook/summary').catch(e => { setError(e.message); return null }),
      apiFetch<Account[]>('/api/cashbook/accounts').catch(() => []),
      apiFetch<Schedule[]>('/api/schedules?days=7').catch(() => []),
    ]).then(([s, a, sch]) => {
      setSummary(s); setAccounts(a || []); setSchedules(sch || [])
    })
  }, [])

  const totalBalance = Number(summary?.totalBalance || 0)
  const monthIncome  = Number(summary?.monthIncome  || 0)
  const monthExpense = Number(summary?.monthExpense || 0)
  const monthNet     = Number(summary?.monthNet     || 0)

  const accountsView = useMemo(() => {
    if (!accounts) return []
    const total = accounts.reduce((s, a) => s + Number(a.balance), 0) || 1
    return accounts.map(a => ({
      ...a,
      amount: Number(a.balance),
      pct: Math.round((Number(a.balance) / total) * 100),
      anomaly: Number(a.balance) <= 0,
    }))
  }, [accounts])

  // 7 天日历, 按 schedule.dueAt 聚合
  const week = useMemo(() => {
    const days: Array<{ date: Date; iso: string; dayLabel: string; mmdd: string; isToday: boolean; amount: number }> = []
    const today = new Date(); today.setHours(0, 0, 0, 0)
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() + i * 86400000)
      const iso = d.toISOString().slice(0, 10)
      days.push({
        date: d, iso, dayLabel: ['日','一','二','三','四','五','六'][d.getDay()],
        mmdd: fmtDate(iso), isToday: i === 0, amount: 0,
      })
    }
    if (schedules) {
      schedules.forEach(s => {
        if (s.status === 'PAID' || s.status === 'REJECTED') return
        const iso = new Date(s.dueAt).toISOString().slice(0, 10)
        const day = days.find(d => d.iso === iso)
        if (day) day.amount += Number(s.amount)
      })
    }
    return days
  }, [schedules])

  const upcoming = (schedules || [])
    .filter(s => s.status !== 'PAID' && s.status !== 'REJECTED')
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    .slice(0, 8)
  const upcomingTotal = upcoming.reduce((s, x) => s + Number(x.amount), 0)

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">资金</h1>
          <p className="text-caption text-gray3">集团 · {accounts?.length ?? '—'} 个账户</p>
        </div>
      </header>

      <div className="px-4 mt-2">
        <BlackHero
          label="总账户余额 ● 实时"
          value={summary === null ? '加载中…' : `¥${(totalBalance/1000).toFixed(1)}K`}
          delta={monthNet !== 0
            ? { text: `${monthNet > 0 ? '↑' : '↓'} ¥${Math.abs(monthNet/1000).toFixed(1)}K 本月净`, trend: monthNet > 0 ? 'up' : 'down' }
            : undefined}
          meta={summary ? `本月流入 ¥${(monthIncome/1000).toFixed(1)}K · 流出 ¥${(monthExpense/1000).toFixed(1)}K` : ''}
          stats={summary ? [
            { label: '月流入', value: `+¥${(monthIncome/1000).toFixed(1)}K`, tone: 'green' },
            { label: '月流出', value: `−¥${(monthExpense/1000).toFixed(1)}K`, tone: 'red' as any },
            { label: '月净',   value: `${monthNet >= 0 ? '+' : '−'}¥${(Math.abs(monthNet)/1000).toFixed(1)}K`, tone: monthNet >= 0 ? 'green' : 'red' as any },
          ] : []}
        />
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">加载失败: {error}</div>}

      <Section title="账户余额" right={accountsView.length ? `${accountsView.length} 个 · ¥${totalBalance.toLocaleString()}` : ''}>
        {accounts === null && <p className="text-caption text-gray3 text-center py-6">加载中…</p>}
        {accounts !== null && accountsView.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无资金账户</p>
            <p className="text-micro text-gray4 mt-1">在管理后台添加银行/微信/支付宝商户后会显示</p>
          </div>
        )}
        {accountsView.length > 0 && (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {accountsView.map(a => (
              <li key={a.id} className="px-3 py-3">
                <div className="flex items-center gap-3 mb-2">
                  <span className="w-9 h-9 rounded-md bg-bg flex items-center justify-center font-num">{a.name?.[0] || '$'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-h2 truncate">{a.name}</span>
                      {a.anomaly && <Chip tone="red">余额 0</Chip>}
                    </div>
                    <p className="text-micro text-gray3">
                      {a.bankName || a.type}
                      {a.accountNo ? ` · 尾号 ${String(a.accountNo).slice(-4)}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="font-num text-h2">¥{a.amount.toLocaleString()}</div>
                    <div className="text-micro text-gray3 font-num">{a.pct}%</div>
                  </div>
                </div>
                <div className="h-1 bg-bg rounded-full overflow-hidden">
                  <div className={`h-full ${a.anomaly ? 'bg-red' : 'bg-gray2'}`} style={{ width: `${Math.max(2, a.pct)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="本周应付到期" right={upcoming.length ? `${upcoming.length} 笔 · ¥${upcomingTotal.toLocaleString()}` : ''}>
        <div className="bg-white rounded-card border border-border p-4">
          <div className="grid grid-cols-7 gap-1 mb-3">
            {week.map((d) => (
              <div key={d.iso} className={`flex flex-col items-center text-center py-2 rounded-card ${d.isToday ? 'border border-ink' : d.amount > 0 ? 'bg-bg' : ''}`}>
                <span className="text-micro text-gray3">{d.dayLabel}</span>
                <span className="text-caption">{d.mmdd}</span>
                {d.isToday && <span className="text-micro text-gray2 mt-0.5">今日</span>}
                {d.amount > 0 && <span className="font-num text-button text-ink mt-1">¥{(d.amount/1000).toFixed(1)}K</span>}
              </div>
            ))}
          </div>
          {schedules === null ? (
            <p className="text-caption text-gray3 text-center py-2">加载中…</p>
          ) : upcoming.length === 0 ? (
            <p className="text-caption text-gray3 text-center py-2">未来 7 天暂无应付</p>
          ) : (
            <ul className="divide-y divide-border">
              {upcoming.map(p => {
                const inv = p.receipt?.invoice
                const noInvoice = !inv
                const invPending = inv?.status === 'PENDING'
                const invVerified = inv?.status === 'VERIFIED'
                return (
                  <li key={p.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${noInvoice ? 'bg-orange' : invPending ? 'bg-amber' : 'bg-ink'}`}></span>
                      <span className="flex-1 text-body truncate">
                        {p.supplier?.name || '—'}
                        <span className="text-caption text-gray3 ml-2">{p.receipt?.no || '—'}</span>
                      </span>
                      <span className="font-num text-body">¥{Number(p.amount).toLocaleString()}</span>
                      <span className="text-micro text-gray3">{fmtDate(p.dueAt)}</span>
                    </div>
                    {noInvoice  && <span className="text-micro text-orange-fg ml-3.5">⚠ 待开票, 不能付款</span>}
                    {invPending && <span className="text-micro text-amber-fg ml-3.5">📃 发票待审 #{inv.invoiceNo}</span>}
                    {invVerified && <span className="text-micro text-green-fg ml-3.5">✓ 发票已通过 · 可付款</span>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </Section>

      <BottomNav
        tabs={[
          { key: 'home',   label: '工作台', icon: '⌂' },
          { key: 'review', label: '初审',   icon: '✓' },
          { key: 'funds',  label: '资金',   icon: '⛁' },
          { key: 'stores', label: '各店',   icon: '↗' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')   location.href = '/v2/finance/home'
          if (k === 'review') location.href = '/v2/finance/review'
          if (k === 'stores') location.href = '/v2/finance/stores'
        }}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'orange' | 'red'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'orange' ? 'text-orange-fg' : rightTone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
