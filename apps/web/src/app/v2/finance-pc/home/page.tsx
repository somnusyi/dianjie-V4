/**
 * 财务 PC Web · 工作台
 *
 * 真实业务流程对齐 (财务基本业务清单):
 *   月度对账 6 节点 → 主区 "本月月结进度" 卡片
 *     1. 报销/付款审批 (payment-requests PENDING)
 *     2. 待开票跟踪 (已付款没开发票 — 真实痛点 #7)
 *     3. 银行流水 (CMB sync + 本地账本)
 *     4. 入库对账 (本月 receipt 数, 后续加三方核对)
 *     5. 利润表完成度 (本月数据完整度)
 *     6. 关账状态 (AccountingPeriod)
 *
 *   紧急待办 (≤3 天到期 / 30 天未开票 / 待审报销) → 右侧
 *   资金概览 → 缩略卡 (详情在 /v2/finance-pc/funds)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BlackHero, Chip } from '@/components/v2'
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
type Account = { id: string; name: string; balance: string | number; type: string; cmbBindAccount?: string | null }
type Summary = { totalBalance: number; monthIncome: number; monthExpense: number; monthNet: number; accounts: Account[] }
type Schedule = {
  id: string; amount: string | number; dueAt: string; status: string
  supplier?: { name: string }
  receipt?: { no: string; store?: { name: string } }
}
type CmbBal = { success: boolean; available?: string; balance?: string; cached?: boolean }
type PendingInvoice = { summary: { paidCount: number; paidAmount: number; pendingCount: number; oldestPaidDays: number } }
type Period = { month: string; status: string }

const fmtKMoney = (n: number) => Math.abs(n) >= 1000 ? `¥${(n / 1000).toFixed(1)}K` : `¥${Math.round(n)}`
const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`

const daysUntil = (iso: string) => {
  const d = dayjs(iso).startOf('day')
  const today = dayjs().startOf('day')
  return d.diff(today, 'day')
}

export default function FinancePCHomePage() {
  const [pending, setPending] = useState<{ items: Doc[]; total: number } | null>(null)
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [cmbBalances, setCmbBalances] = useState<Map<string, CmbBal>>(new Map())
  const [pendingInv, setPendingInv] = useState<PendingInvoice | null>(null)
  const [monthVouchers, setMonthVouchers] = useState<{ items: any[] } | null>(null)
  const [period, setPeriod] = useState<Period | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [user, setUser] = useState<{ name?: string } | null>(null)

  const currentMonth = dayjs().format('YYYY-MM')

  useEffect(() => {
    setUser(getUser())
    const monthFrom = `${currentMonth}-01`
    const monthTo = dayjs().endOf('month').format('YYYY-MM-DD')
    Promise.all([
      apiFetch<{ items: Doc[]; total: number }>('/api/payment-requests?status=PENDING&pageSize=10').catch(() => ({ items: [], total: 0 })),
      apiFetch<Schedule[]>('/api/schedules?days=7').catch(() => []),
      apiFetch<Summary>('/api/cashbook/summary').catch(() => null),
      apiFetch<PendingInvoice>('/api/invoices/pending-from-finance').catch(() => ({ summary: { paidCount: 0, paidAmount: 0, pendingCount: 0, oldestPaidDays: 0 } } as any)),
      apiFetch<{ items: any[]; total: number }>(`/api/vouchers?from=${monthFrom}&to=${monthTo}&pageSize=200`).catch(() => ({ items: [], total: 0 })),
      apiFetch<Period[]>('/api/vouchers/periods').catch(() => []),
    ])
      .then(([pr, sch, sm, pInv, vou, pers]) => {
        setPending(pr); setSchedules(sch || []); setSummary(sm)
        setPendingInv(pInv); setMonthVouchers(vou)
        const cur = Array.isArray(pers) ? pers.find(p => p.month === currentMonth) : null
        setPeriod(cur || { month: currentMonth, status: 'OPEN' })
      })
      .catch(e => setError(String(e?.message || e)))
  }, [currentMonth])

  useEffect(() => {
    if (!summary?.accounts) return
    const cmbAccounts = summary.accounts.filter(a => a.cmbBindAccount)
    if (cmbAccounts.length === 0) return
    Promise.all(
      cmbAccounts.map(async a => {
        try {
          const r = await apiFetch<CmbBal>(`/api/cmb/balance?account=${encodeURIComponent(a.cmbBindAccount!)}`)
          return [a.id, r] as const
        } catch {
          return [a.id, { success: false } as CmbBal] as const
        }
      }),
    ).then(rows => {
      const m = new Map<string, CmbBal>()
      rows.forEach(([id, r]) => m.set(id, r))
      setCmbBalances(m)
    })
  }, [summary])

  // 紧急待办 (≤3 天到期 + 待审报销前 6 条 + 已付 30 天未开票最久 3 张)
  const urgentList = useMemo(() => {
    const list: Array<{ id: string; tone: 'red' | 'orange' | 'gray'; type: string; tag: string; title: string; sub: string; amount?: number; href: string }> = []
    for (const d of (pending?.items || []).slice(0, 4)) {
      list.push({
        id: 'pr-' + d.id, tone: 'orange', type: '付款审批',
        tag: dayjs(d.createdAt).format('MM/DD HH:mm'),
        title: d.title,
        sub: `${d.store?.name || '集团'} · ${d.initiator?.name || '—'} 发起`,
        amount: Number(d.amount || 0),
        href: `/v2/finance-pc/payment-requests/${d.id}`,
      })
    }
    for (const s of (schedules || []).filter(s => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status))) {
      const dDays = daysUntil(s.dueAt)
      if (dDays > 3) continue
      list.push({
        id: 'sc-' + s.id, tone: dDays <= 1 ? 'red' : 'orange',
        type: '应付到期',
        tag: dDays <= 0 ? '今日' : `${dDays} 天后`,
        title: `${s.supplier?.name || '供应商'} · ${s.receipt?.no || ''}`,
        sub: `${s.receipt?.store?.name || ''} · ${dayjs(s.dueAt).format('MM/DD')} 到期`,
        amount: Number(s.amount),
        href: `/v2/finance-pc/funds`,
      })
    }
    return list.slice(0, 8)
  }, [pending, schedules])

  // 月结进度 6 节点
  const checklist = useMemo(() => {
    const reviewCount = pending?.total || 0
    const pendingInvoiceCount = pendingInv?.summary?.paidCount || 0
    const monthVoucherCount = monthVouchers?.items?.length || 0
    const monthPostedCount = (monthVouchers?.items || []).filter((v: any) => v.status === 'POSTED').length
    const monthVoidedCount = (monthVouchers?.items || []).filter((v: any) => v.status === 'VOIDED').length
    const monthDraftCount = monthVoucherCount - monthPostedCount - monthVoidedCount
    const closed = period?.status === 'CLOSED'
    return [
      {
        key: 'review',
        title: '报销 / 付款审批',
        value: reviewCount, unit: '待审',
        done: reviewCount === 0,
        progress: 0, // 没办法精确算"进度", 用 待审数 表示
        sub: reviewCount === 0 ? '全部已审, 干净' : `${reviewCount} 笔等你处理`,
        href: '/v2/finance-pc/payment-requests',
        tone: reviewCount === 0 ? 'green' : reviewCount > 5 ? 'red' : 'orange',
      },
      {
        key: 'pendingInvoice',
        title: '待开票跟踪',
        value: pendingInvoiceCount, unit: '张未开',
        done: pendingInvoiceCount === 0,
        sub: pendingInvoiceCount === 0
          ? '所有付款都收到发票了'
          : `最久 ${pendingInv?.summary?.oldestPaidDays || 0} 天, 累计 ${fmtKMoney(pendingInv?.summary?.paidAmount || 0)}`,
        href: '/v2/finance-pc/invoices-pending',
        tone: pendingInvoiceCount === 0 ? 'green' : (pendingInv?.summary?.oldestPaidDays || 0) > 30 ? 'red' : 'orange',
      },
      {
        key: 'voucher',
        title: '本月凭证',
        value: monthDraftCount, unit: '张草稿',
        done: monthDraftCount === 0 && monthPostedCount > 0,
        sub: monthVoucherCount === 0
          ? '尚未生成 (是否在等业务发生?)'
          : `${monthPostedCount} 已审 / ${monthDraftCount} 草稿${monthVoidedCount > 0 ? ' / ' + monthVoidedCount + ' 作废' : ''}`,
        href: '/v2/finance-pc/vouchers',
        tone: monthDraftCount === 0 && monthPostedCount > 0 ? 'green' : monthDraftCount > 10 ? 'orange' : 'gray',
      },
      {
        key: 'reconcile',
        title: '银行流水对账',
        value: '查',
        sub: '招行流水自动同步, 可手动对账 yurRef 匹配',
        href: '/v2/finance-pc/funds',
        tone: 'gray' as const,
      },
      {
        key: 'profit',
        title: '本月利润表',
        value: '查',
        sub: '收入 / 成本 / 净利 实时计算',
        href: `/v2/finance-pc/reports/profit?month=${currentMonth}`,
        tone: 'gray' as const,
      },
      {
        key: 'close',
        title: closed ? '本月已关账 ✓' : '本月关账',
        value: closed ? '✓' : '待',
        sub: closed
          ? '凭证已锁, 反锁请到月结页'
          : '完成上面 5 项后可关账',
        href: '/v2/finance-pc/period-close',
        tone: closed ? 'green' : 'gray' as const,
      },
    ]
  }, [pending, pendingInv, monthVouchers, period, currentMonth])

  const cmbTotal = useMemo(() => {
    if (!summary?.accounts) return 0
    return summary.accounts.reduce((acc, a) => {
      const b = cmbBalances.get(a.id)
      return acc + (b?.available ? Number(b.available) : 0)
    }, 0)
  }, [summary, cmbBalances])
  const cmbReady = summary && summary.accounts.length > 0 && cmbBalances.size === summary.accounts.filter(a => a.cmbBindAccount).length && cmbBalances.size > 0
  const todoCount = (pending?.total || 0) + ((schedules || []).filter(s => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status) && daysUntil(s.dueAt) <= 3).length)

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-caption text-gray2">
              {dayjs().hour() < 12 ? '早上好' : dayjs().hour() < 18 ? '下午好' : '晚上好'}, {user?.name || ''}
            </p>
            <h1 className="text-h1">合肥瑶海店 · {dayjs().format('dddd MM/DD · HH:mm')}</h1>
          </div>
          <div className="flex items-center gap-2">
            <a href="/v2/finance-pc/payment-requests" className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">付款申请</a>
            <a href="/v2/finance-pc/review" className="px-4 py-2 bg-ink text-white rounded-cta text-button">去初审 →</a>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        <BlackHero
          density="desktop"
          label={`${currentMonth} 月结进度`}
          value={String(todoCount)}
          delta={todoCount > 0 ? { text: `待处理紧急事项`, trend: 'flat' } : undefined}
          stats={[
            { label: 'CMB 余额', value: cmbReady ? fmtKMoney(cmbTotal) : '—', tone: 'green' },
            { label: '月流入',   value: summary ? '+' + fmtKMoney(summary.monthIncome) : '—', tone: 'green' },
            { label: '月流出',   value: summary ? '−' + fmtKMoney(summary.monthExpense) : '—', tone: 'red' },
          ]}
        />

        <div className="grid grid-cols-[2fr_1fr] gap-4 mt-4">
          {/* 主区: 本月月结进度 6 节点 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">本月月结清单</h2>
              <span className="text-caption text-gray3">按真实流程顺序 (点卡片进对应页)</span>
            </header>
            <div className="grid grid-cols-2 gap-px bg-border">
              {checklist.map(c => (
                <a key={c.key} href={c.href}
                   className={`p-4 bg-white hover:bg-bg/40 transition flex items-start gap-3 ${c.done ? 'bg-green-bg/30' : ''}`}>
                  <span className={`w-8 h-8 rounded-full flex items-center justify-center text-button shrink-0 ${
                    c.tone === 'green' ? 'bg-green-bg text-green-fg'
                    : c.tone === 'red' ? 'bg-red-bg text-red-fg'
                    : c.tone === 'orange' ? 'bg-orange-bg text-orange-fg'
                    : 'bg-bg text-gray2'
                  }`}>{c.done ? '✓' : '·'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-button text-ink">{c.title}</div>
                      <div className="text-h2 font-num shrink-0">
                        {typeof c.value === 'number' ? c.value : c.value}
                        {c.unit && <span className="text-caption text-gray3 ml-1">{c.unit}</span>}
                      </div>
                    </div>
                    <p className="text-micro text-gray3 mt-0.5">{c.sub}</p>
                  </div>
                </a>
              ))}
            </div>
          </section>

          {/* 右侧: 紧急待办 + 资金缩略 */}
          <div className="space-y-4">
            <section className="bg-white rounded-card border border-border overflow-hidden">
              <header className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h2 className="text-h2">紧急待办</h2>
                <span className="text-caption text-gray3">
                  {urgentList.length === 0 ? '无' : `${urgentList.length} 项`}
                </span>
              </header>
              {urgentList.length === 0 && (
                <div className="px-4 py-8 text-center text-caption text-gray3">✓ 暂无紧急事项</div>
              )}
              <ul className="divide-y divide-border">
                {urgentList.map(t => (
                  <li key={t.id} className={`px-4 py-2.5 ${t.tone === 'red' ? 'bg-red-bg/30' : t.tone === 'orange' ? 'bg-orange-bg/30' : ''}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <Chip tone={t.tone}>{t.type}</Chip>
                      <span className="text-micro text-gray3">{t.tag}</span>
                    </div>
                    <div className="flex items-end justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-button truncate">{t.title}</div>
                        <p className="text-micro text-gray3 truncate">{t.sub}</p>
                      </div>
                      <div className="text-right shrink-0">
                        {t.amount != null && <div className="font-num text-button">{fmtMoney(t.amount)}</div>}
                        <a href={t.href} className="text-micro text-amber-fg">去处理 ›</a>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="bg-white rounded-card border border-border p-4">
              <header className="flex items-center justify-between mb-3">
                <h2 className="text-h2">资金</h2>
                <a href="/v2/finance-pc/funds" className="text-caption text-amber-fg">详情 ›</a>
              </header>
              <div className="space-y-2">
                {summary === null && <div className="text-caption text-gray3">加载中…</div>}
                {summary && summary.accounts.length === 0 && <div className="text-caption text-gray3">暂无账户</div>}
                {summary && summary.accounts.map(a => {
                  const cmb = cmbBalances.get(a.id)
                  const bal = cmb?.available != null ? Number(cmb.available) : Number(a.balance)
                  const isReal = cmb?.success && cmb.available != null
                  return (
                    <div key={a.id} className="flex items-center gap-2 text-caption">
                      <span className="w-6 h-6 rounded bg-bg flex items-center justify-center text-micro font-num">{a.name.slice(0, 1)}</span>
                      <span className="flex-1 truncate">{a.name}</span>
                      {isReal && <Chip tone="green">实时</Chip>}
                      <span className="font-num">{fmtMoney(bal)}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
