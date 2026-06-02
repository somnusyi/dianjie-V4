/**
 * 财务 PC Web · 资金 Tab
 * 接真 API: /api/cashbook/summary + /api/cashbook/accounts + /api/schedules?days=7
 *
 * 2026-06-02 Phase 2 改造: mock 全部清掉, 接真 API
 *   Hero "总账户余额" + 月流入/流出/净 ← cashbook/summary
 *   "账户余额" 表格 ← cashbook/accounts
 *   "本周应付到期" 表格 + 7 day calendar ← /api/schedules?days=7
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BlackHero, Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'
import FinanceTopNav from '../_topnav'

type Account = {
  id: string
  name: string
  type: string
  bankName?: string | null
  accountNo?: string | null
  balance: string | number
  cmbBindAccount?: string | null
  status: string
}
type Summary = {
  totalBalance: number
  monthIncome: number
  monthExpense: number
  monthNet: number
  accounts: Account[]
}
type Schedule = {
  id: string
  amount: string | number
  dueAt: string
  status: string
  supplier?: { name: string; creditType?: string; creditDays?: number }
  receipt?: { id: string; no: string; store?: { name: string }; invoice?: { invoiceNo?: string; status?: string } }
}

const fmtKMoney = (n: number) => n >= 1000 ? `¥${(n / 1000).toFixed(1)}K` : `¥${Math.round(n)}`
const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`

export default function FinancePCFundsPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      apiFetch<Summary>('/api/cashbook/summary').catch((e: any) => { throw new Error('资金汇总: ' + (e?.message || e)) }),
      apiFetch<Schedule[]>('/api/schedules?days=7').catch((e: any) => { throw new Error('应付列表: ' + (e?.message || e)) }),
    ])
      .then(([s, sch]) => { setSummary(s); setSchedules(sch || []) })
      .catch(e => setError(e?.message || String(e)))
  }, [])

  // 7 天日历: 按 dueAt 日期分组合计
  const weekDays = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => dayjs().add(i, 'day'))
    return days.map(d => {
      const ymd = d.format('YYYY-MM-DD')
      const dayAmt = (schedules || [])
        .filter(s => dayjs(s.dueAt).format('YYYY-MM-DD') === ymd && ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status))
        .reduce((sum, s) => sum + Number(s.amount), 0)
      return {
        date: d.format('MM/DD'),
        day: ['日', '一', '二', '三', '四', '五', '六'][d.day()],
        isToday: d.isSame(dayjs(), 'day'),
        amount: dayAmt,
      }
    })
  }, [schedules])

  const totalAcct = summary?.totalBalance ?? 0
  const accounts = summary?.accounts ?? []
  const weekDueSum = weekDays.reduce((s, d) => s + d.amount, 0)
  const weekDueCount = (schedules || []).filter(s => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status)).length

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">资金</h1>
            <p className="text-caption text-gray3">
              {accounts.length > 0
                ? `${accounts.length} 个账户 · ${dayjs().format('MM/DD HH:mm')}`
                : '加载中…'}
            </p>
          </div>
          <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出对账单</button>
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>
        )}

        <BlackHero
          density="desktop"
          label="总账户余额 ● 实时"
          value={summary ? fmtMoney(totalAcct) : '—'}
          delta={summary && summary.monthNet > 0
            ? { text: `本月净 +${fmtKMoney(summary.monthNet)}`, trend: 'up' }
            : summary && summary.monthNet < 0
              ? { text: `本月净 ${fmtKMoney(summary.monthNet)}`, trend: 'down' }
              : undefined}
          stats={summary ? [
            { label: '月流入', value: '+' + fmtKMoney(summary.monthIncome), tone: 'green' },
            { label: '月流出', value: '−' + fmtKMoney(summary.monthExpense), tone: 'red' },
            { label: '月净',   value: (summary.monthNet >= 0 ? '+' : '') + fmtKMoney(summary.monthNet), tone: summary.monthNet >= 0 ? 'green' : 'red' },
          ] : []}
        />

        <div className="grid grid-cols-2 gap-4 mt-4">
          {/* 账户余额 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">账户余额</h2>
              <span className="text-caption text-gray3">
                {accounts.length > 0 ? `${accounts.length} 个 · ${fmtKMoney(totalAcct)}` : ''}
              </span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">账户</th>
                  <th className="px-3 py-2 font-normal text-right">余额</th>
                  <th className="px-3 py-2 font-normal w-[100px]">占比</th>
                  <th className="px-3 py-2 font-normal text-right">类型</th>
                  <th className="px-3 py-2 font-normal text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {!summary && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
                )}
                {summary && accounts.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-caption text-gray3">暂无账户 · 去新建</td></tr>
                )}
                {accounts.map(a => {
                  const bal = Number(a.balance)
                  const pct = totalAcct > 0 ? Math.round((bal / totalAcct) * 100) : 0
                  const anomaly = bal < 1000   // 余额 < ¥1000 标黄
                  return (
                    <tr key={a.id} className={`border-t border-border ${anomaly ? 'bg-orange-bg/30' : ''}`}>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center font-num text-caption">{a.name.slice(0, 1)}</span>
                          <div>
                            <div className="text-body">{a.name}</div>
                            <div className="text-micro text-gray3">
                              {a.bankName ? `${a.bankName} ` : ''}
                              {a.accountNo ? `**** ${a.accountNo.slice(-4)}` : ''}
                              {a.cmbBindAccount && <span className="ml-1 text-amber-fg">CMB</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-num text-right">{fmtMoney(bal)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <div className="h-1.5 bg-bg rounded-full overflow-hidden flex-1">
                            <div className={`h-full ${anomaly ? 'bg-orange' : 'bg-gray2'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-micro font-num text-gray3 w-8 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Chip tone={anomaly ? 'orange' : 'green'}>{a.type === 'BANK' ? '银行' : a.type === 'ALIPAY' ? '支付宝' : a.type === 'WECHAT' ? '微信' : '现金'}</Chip>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <a href={`/v2/finance/funds`} className="text-caption text-gray2 hover:text-ink">流水 ›</a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          {/* 本周应付到期 */}
          <section className="bg-white rounded-card border border-border p-4">
            <header className="flex items-center justify-between mb-3">
              <h2 className="text-h2">本周应付到期</h2>
              <span className="text-caption text-gray3">
                {schedules === null ? '加载中…' : `${weekDueCount} 笔 · ${fmtKMoney(weekDueSum)}`}
              </span>
            </header>
            {/* 7 天日历 */}
            <div className="grid grid-cols-7 gap-1 mb-3">
              {weekDays.map(d => (
                <div key={d.date} className={`flex flex-col items-center text-center py-2 rounded-card ${d.isToday ? 'border border-ink' : d.amount > 0 ? 'bg-bg' : ''}`}>
                  <span className="text-micro text-gray3">{d.day}</span>
                  <span className="text-caption">{d.date}</span>
                  {d.isToday && <span className="text-micro text-gray2 mt-0.5">今日</span>}
                  {d.amount > 0 && <span className="font-num text-button text-ink mt-1">{fmtKMoney(d.amount)}</span>}
                </div>
              ))}
            </div>
            {/* 7 天单子明细 */}
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">供应商</th>
                  <th className="px-3 py-2 font-normal">类型</th>
                  <th className="px-3 py-2 font-normal">到期日</th>
                  <th className="px-3 py-2 font-normal text-right">金额</th>
                  <th className="px-3 py-2 font-normal">发票</th>
                  <th className="px-3 py-2 font-normal text-right">状态</th>
                </tr>
              </thead>
              <tbody>
                {schedules === null && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
                )}
                {schedules !== null && schedules.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-caption text-gray3">本周无应付到期</td></tr>
                )}
                {(schedules || []).slice(0, 10).map(s => {
                  const due = dayjs(s.dueAt)
                  const statusLabel = s.status === 'PENDING' ? '待付'
                                    : s.status === 'APPROVED' ? '已批待付'
                                    : s.status === 'PROCESSING' ? '付款中'
                                    : s.status === 'PAID' ? '已付'
                                    : s.status === 'OVERDUE' ? '逾期'
                                    : s.status === 'PENDING_APPROVAL' ? '待审批'
                                    : s.status
                  const statusTone: 'gray' | 'orange' | 'green' | 'red' =
                    s.status === 'OVERDUE' ? 'red'
                    : s.status === 'PAID' ? 'green'
                    : s.status === 'PROCESSING' ? 'orange'
                    : 'gray'
                  const ct = s.supplier?.creditType
                  const ctLabel = ct === 'FIXED_DAYS' ? `${s.supplier?.creditDays || 0}天`
                                : ct === 'MONTHLY' ? '月结'
                                : ct === 'WEEKLY' ? '周结'
                                : ct === 'ON_DELIVERY' ? '货到'
                                : '账期'
                  return (
                    <tr key={s.id} className="border-t border-border">
                      <td className="px-3 py-2.5 text-body">{s.supplier?.name || '—'}</td>
                      <td className="px-3 py-2.5"><Chip tone="gray">{ctLabel}</Chip></td>
                      <td className="px-3 py-2.5 text-body font-num">{due.format('MM/DD')} 周{['日','一','二','三','四','五','六'][due.day()]}</td>
                      <td className="px-3 py-2.5 font-num text-right">{fmtMoney(Number(s.amount))}</td>
                      <td className="px-3 py-2.5">
                        {s.receipt?.invoice ? <Chip tone="green">已收</Chip> : <Chip tone="gray">未收</Chip>}
                      </td>
                      <td className="px-3 py-2.5 text-right"><Chip tone={statusTone}>{statusLabel}</Chip></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        </div>
      </main>
    </div>
  )
}
