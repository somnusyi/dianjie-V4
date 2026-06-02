/**
 * 财务 PC Web · 工作台
 * 2026-06-02 Phase 2 改造: 接真 API
 *
 * Hero "待我初审 N" + 月现金流净 ← payment-requests count + cashbook/summary
 * 主区"财务待办" ← payment-requests?status=PENDING (前 10 条) + schedules?days=3 (本周到期)
 * 副区"资金概览" ← cashbook/summary
 * 副区"账户健康" ← cashbook/accounts (单店暂仅 1 个 tenant)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BlackHero, Chip, MetricTile } from '@/components/v2'
import { apiFetch, getUser } from '@/lib/v2-auth'
import dayjs from 'dayjs'
import FinanceTopNav from '../_topnav'

type Doc = {
  id: string; no: string; type: string; title: string
  amount?: string | number | null
  status: string; createdAt: string
  initiator?: { name: string } | null
  store?: { name: string } | null
}
type Account = { id: string; name: string; balance: string | number; type: string }
type Summary = {
  totalBalance: number
  monthIncome: number
  monthExpense: number
  monthNet: number
  accounts: Account[]
}
type Schedule = {
  id: string; amount: string | number; dueAt: string; status: string
  supplier?: { name: string }
  receipt?: { no: string; store?: { name: string } }
}

const fmtKMoney = (n: number) => Math.abs(n) >= 1000 ? `¥${(n / 1000).toFixed(1)}K` : `¥${Math.round(n)}`
const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`

// 距离到期天数
const daysUntil = (iso: string) => {
  const d = dayjs(iso).startOf('day')
  const today = dayjs().startOf('day')
  return d.diff(today, 'day')
}

export default function FinancePCHomePage() {
  const [pending, setPending] = useState<{ items: Doc[]; total: number } | null>(null)
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [user, setUser] = useState<{ name?: string } | null>(null)

  useEffect(() => {
    setUser(getUser())
    Promise.all([
      apiFetch<{ items: Doc[]; total: number }>('/api/payment-requests?status=PENDING&pageSize=10').catch(() => ({ items: [], total: 0 })),
      apiFetch<Schedule[]>('/api/schedules?days=7').catch(() => []),
      apiFetch<Summary>('/api/cashbook/summary').catch(() => null),
    ])
      .then(([pr, sch, sm]) => {
        setPending(pr)
        setSchedules(sch || [])
        setSummary(sm)
      })
      .catch(e => setError(String(e?.message || e)))
  }, [])

  // 待办合并: payment-requests (待初审) + schedules (3 天内到期 — 紧急)
  const todos = useMemo(() => {
    const list: Array<{ id: string; tone: 'red' | 'orange' | 'gray'; type: string; tag: string; title: string; sub: string; amount: number; href: string }> = []
    // 1. payment-requests
    for (const d of (pending?.items || []).slice(0, 6)) {
      list.push({
        id: 'pr-' + d.id,
        tone: 'orange',
        type: '付款申请',
        tag: dayjs(d.createdAt).format('MM/DD HH:mm'),
        title: d.title,
        sub: `${d.store?.name || '集团'} · ${d.initiator?.name || '—'} 发起`,
        amount: Number(d.amount || 0),
        href: `/v2/finance/payment-requests/${d.id}`,
      })
    }
    // 2. 紧急到期 (3 天内 PENDING/APPROVED) — 红色
    for (const s of (schedules || []).filter(s => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status))) {
      const dDays = daysUntil(s.dueAt)
      if (dDays > 3) continue
      list.push({
        id: 'sc-' + s.id,
        tone: dDays <= 0 ? 'red' : dDays <= 1 ? 'red' : 'orange',
        type: '应付到期',
        tag: dDays <= 0 ? '今日到期' : `${dDays} 天后`,
        title: `${s.supplier?.name || '供应商'} · ${s.receipt?.no || ''}`,
        sub: `${s.receipt?.store?.name || ''} · ${dayjs(s.dueAt).format('MM/DD')} 到期`,
        amount: Number(s.amount),
        href: `/v2/finance/funds`,
      })
    }
    return list.slice(0, 10)
  }, [pending, schedules])

  const todoCount = (pending?.total || 0) + ((schedules || []).filter(s => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status) && daysUntil(s.dueAt) <= 3).length)
  const todoAmt = todos.reduce((s, t) => s + t.amount, 0)

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-caption text-gray2">{dayjs().hour() < 12 ? '早上好' : dayjs().hour() < 18 ? '下午好' : '晚上好'}, {user?.name || ''}</p>
            <h1 className="text-h1">合肥瑶海店 · {dayjs().format('dddd MM/DD · HH:mm')}</h1>
          </div>
          <a href="/v2/finance-pc/review" className="px-4 py-2 bg-ink text-white rounded-cta text-button">去初审 →</a>
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>
        )}

        <BlackHero
          density="desktop"
          label="待我处理 ●"
          value={String(todoCount)}
          delta={todoCount > 0 ? { text: `单 · 累计 ${fmtKMoney(todoAmt)}`, trend: 'flat' } : undefined}
          stats={summary ? [
            { label: '月现金流净', value: (summary.monthNet >= 0 ? '+' : '') + fmtKMoney(summary.monthNet), tone: summary.monthNet >= 0 ? 'green' : 'red' },
            { label: '月流入',     value: '+' + fmtKMoney(summary.monthIncome), tone: 'green' },
            { label: '月流出',     value: '−' + fmtKMoney(summary.monthExpense), tone: 'red' },
          ] : []}
        />

        <div className="grid grid-cols-[2.2fr_1fr] gap-4 mt-4">
          {/* 财务待办 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">财务待办</h2>
              <span className="text-caption text-gray3">
                {pending === null ? '加载中…' : `${todos.length} 项`}
              </span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">详情</th>
                  <th className="px-3 py-2 font-normal text-right w-28">金额</th>
                  <th className="px-3 py-2 font-normal text-right w-24">操作</th>
                </tr>
              </thead>
              <tbody>
                {pending === null && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
                )}
                {pending !== null && todos.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-caption text-gray3">✓ 暂无待办, 一切正常</td></tr>
                )}
                {todos.map(t => (
                  <tr key={t.id} className={`border-t border-border ${t.tone === 'red' ? 'bg-red-bg/30' : t.tone === 'orange' ? 'bg-orange-bg/30' : ''}`}>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Chip tone={t.tone}>{t.type}</Chip>
                        <span className="text-micro text-gray3">{t.tag}</span>
                      </div>
                      <div className="text-h2">{t.title}</div>
                      <p className="text-caption text-gray2 mt-0.5">{t.sub}</p>
                    </td>
                    <td className="px-3 py-3 font-num text-h2 text-right align-top">{fmtMoney(t.amount)}</td>
                    <td className="px-3 py-3 text-right align-top">
                      <a href={t.href} className="inline-block px-3 py-1.5 bg-ink text-white rounded-cta text-button">去处理 ›</a>
                    </td>
                  </tr>
                ))}
                {pending && pending.total > todos.length && (
                  <tr className="border-t border-border">
                    <td colSpan={3} className="px-4 py-3 text-center text-caption text-gray2">
                      <a href="/v2/finance-pc/review">查看全部 {pending.total} 项 ›</a>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          {/* 右侧 资金概览 + 账户告警 */}
          <div className="space-y-4">
            <section className="bg-white rounded-card border border-border p-4">
              <header className="flex items-center justify-between mb-3">
                <h2 className="text-h2">资金概览</h2>
                <span className="text-caption text-gray3">实时</span>
              </header>
              <div className="grid grid-cols-2 gap-2">
                <MetricTile
                  label="总账户余额"
                  value={summary ? fmtKMoney(summary.totalBalance) : '—'}
                  delta={summary ? `${summary.accounts.length} 个账户` : ''}
                />
                <MetricTile
                  label="本周应付"
                  value={schedules === null ? '—' : fmtKMoney((schedules || []).filter(s => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status)).reduce((sum, s) => sum + Number(s.amount), 0))}
                  delta={schedules === null ? '' : `${(schedules || []).filter(s => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status)).length} 笔`}
                  tone="orange"
                />
                <MetricTile
                  label="月流入"
                  value={summary ? '+' + fmtKMoney(summary.monthIncome) : '—'}
                  tone="green"
                />
                <MetricTile
                  label="月流出"
                  value={summary ? '−' + fmtKMoney(summary.monthExpense) : '—'}
                  tone="red"
                />
              </div>
              {/* 低余额账户告警 (低于 1k) */}
              {summary && summary.accounts.filter(a => Number(a.balance) < 1000).map(a => (
                <div key={a.id} className="mt-3 bg-orange-bg rounded-card p-2.5 text-caption text-orange-fg flex items-center gap-2">
                  <span>余额低</span>
                  <span className="font-num text-h2 ml-auto">{a.name} {fmtMoney(Number(a.balance))}</span>
                </div>
              ))}
            </section>

            {/* 账户列表 */}
            <section className="bg-white rounded-card border border-border overflow-hidden">
              <header className="px-4 py-3 border-b border-border">
                <h2 className="text-h2">账户</h2>
              </header>
              <ul className="divide-y divide-border">
                {summary === null && <li className="px-4 py-3 text-caption text-gray3">加载中…</li>}
                {summary && summary.accounts.length === 0 && <li className="px-4 py-3 text-caption text-gray3">暂无账户</li>}
                {summary && summary.accounts.map(a => {
                  const bal = Number(a.balance)
                  const low = bal < 1000
                  return (
                    <li key={a.id} className={`px-4 py-2.5 flex items-center gap-3 ${low ? 'bg-orange-bg/30' : ''}`}>
                      <span className="w-9 h-9 rounded-md bg-bg flex items-center justify-center font-num">{a.name.slice(0, 1)}</span>
                      <div className="flex-1">
                        <div className="text-body flex items-center gap-2">
                          {a.name}
                          {low && <Chip tone="orange">告警</Chip>}
                        </div>
                        <p className="text-micro text-gray3">{a.type === 'BANK' ? '银行账户' : a.type}</p>
                      </div>
                      <span className="font-num text-button">{fmtMoney(bal)}</span>
                    </li>
                  )
                })}
              </ul>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
