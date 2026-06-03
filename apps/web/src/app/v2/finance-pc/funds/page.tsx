/**
 * 财务 PC Web · 资金 Tab
 *
 * 改进点 (vs Phase 2 旧版):
 *   - 余额来源: 改为 **CMB 实时余额** (各账户 /api/cmb/balance), 不再显示空的本地账本字段
 *     · 本地账本字段以"账面"小字形式附在旁边, 财务可一眼看出差异
 *   - "流水 ›" 按钮 → 接 BankTransactionsDrawer (招行真实流水 + 回单)
 *   - 顶部 "对账" 按钮 → 拉 CMB transactions vs 本地 cash_transactions, 按 yurRef 配对
 *     显示 3 tab: 匹配 / 仅 CMB (银行有本地无) / 仅本地 (本地有银行无)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { BlackHero, Chip, MonthPicker } from '@/components/v2'
import { BankTransactionsDrawer } from '@/components/v2/bank-transactions-drawer'
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
type CmbBal = {
  success: boolean
  resultCode?: string
  resultMsg?: string
  available?: string
  balance?: string     // 含冻结
  held?: string
  cached?: boolean
  cachedAgeMs?: number
  degraded?: boolean
}

const fmtKMoney = (n: number) => n >= 1000 ? `¥${(n / 1000).toFixed(1)}K` : `¥${Math.round(n)}`
const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`
const fmtMoney2 = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FinancePCFundsPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // accountId → CmbBal
  const [cmbBalances, setCmbBalances] = useState<Map<string, CmbBal>>(new Map())
  // 流水 drawer
  const [txDrawer, setTxDrawer] = useState<{ open: boolean; account?: string; label?: string }>({ open: false })
  // 对账 drawer
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [reconcileAccount, setReconcileAccount] = useState<Account | null>(null)

  useEffect(() => {
    Promise.all([
      apiFetch<Summary>('/api/cashbook/summary').catch((e: any) => { throw new Error('资金汇总: ' + (e?.message || e)) }),
      apiFetch<Schedule[]>('/api/schedules?days=7').catch((e: any) => { throw new Error('应付列表: ' + (e?.message || e)) }),
    ])
      .then(([s, sch]) => { setSummary(s); setSchedules(sch || []) })
      .catch(e => setError(e?.message || String(e)))
  }, [])

  // 拉 CMB 实时余额 (每个 cmbBindAccount 并发)
  useEffect(() => {
    if (!summary?.accounts) return
    const cmbAccounts = summary.accounts.filter(a => a.cmbBindAccount)
    if (cmbAccounts.length === 0) return
    Promise.all(
      cmbAccounts.map(async a => {
        try {
          const r = await apiFetch<CmbBal>(`/api/cmb/balance?account=${encodeURIComponent(a.cmbBindAccount!)}`)
          return [a.id, r] as const
        } catch (e: any) {
          return [a.id, { success: false, resultMsg: e?.message || '查询失败' } as CmbBal] as const
        }
      }),
    ).then(rows => {
      const m = new Map<string, CmbBal>()
      rows.forEach(([id, r]) => m.set(id, r))
      setCmbBalances(m)
    })
  }, [summary])

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

  const accounts = summary?.accounts ?? []
  // 实时余额合计 = CMB available 之和 (仅有 cmbBindAccount 的账户), 兜底 0
  const cmbTotalAvail = accounts.reduce((s, a) => {
    const b = cmbBalances.get(a.id)
    return s + (b?.available ? Number(b.available) : 0)
  }, 0)
  const cmbHasAny = Array.from(cmbBalances.values()).some(b => b.success && b.available)
  const cmbAllLoaded = cmbBalances.size > 0 && cmbBalances.size === accounts.filter(a => a.cmbBindAccount).length
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
                ? `${accounts.length} 个账户 · CMB 实时 · ${dayjs().format('MM/DD HH:mm')}`
                : '加载中…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setReconcileAccount(accounts[0] || null); setReconcileOpen(true) }}
              disabled={accounts.length === 0}
              className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2 disabled:opacity-40">
              🔍 对账
            </button>
            <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出对账单</button>
          </div>
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>
        )}

        <BlackHero
          density="desktop"
          label={cmbHasAny ? 'CMB 实时总余额 ● 招行接口' : '总账户余额 (本地账本)'}
          value={cmbAllLoaded ? fmtMoney(cmbTotalAvail) : (summary ? fmtMoney(summary.totalBalance) : '—')}
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
                {cmbAllLoaded ? `${accounts.length} 个 · CMB 实时 ${fmtKMoney(cmbTotalAvail)}` : ''}
              </span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">账户</th>
                  <th className="px-3 py-2 font-normal text-right">实时余额 (CMB)</th>
                  <th className="px-3 py-2 font-normal text-right">账面 (本地)</th>
                  <th className="px-3 py-2 font-normal text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {!summary && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
                )}
                {summary && accounts.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-caption text-gray3">暂无账户</td></tr>
                )}
                {accounts.map(a => {
                  const ledger = Number(a.balance)
                  const cmb = cmbBalances.get(a.id)
                  const cmbAvail = cmb?.available ? Number(cmb.available) : null
                  const cmbFailed = cmb && !cmb.success
                  const cmbLoading = a.cmbBindAccount && !cmb
                  const diff = cmbAvail != null ? cmbAvail - ledger : null
                  const anomaly = cmbAvail != null && cmbAvail < 1000
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
                      <td className="px-3 py-2.5 text-right">
                        {cmbLoading && <span className="text-caption text-gray3">查询中…</span>}
                        {cmbFailed && <span className="text-caption text-red-fg" title={cmb?.resultMsg || ''}>查询失败</span>}
                        {cmbAvail != null && (
                          <div>
                            <div className="font-num text-body">{fmtMoney2(cmbAvail)}</div>
                            {cmb?.held && Number(cmb.held) > 0 && (
                              <div className="text-micro text-gray3">含冻结 {fmtMoney(Number(cmb.held))}</div>
                            )}
                            {cmb?.cached && (
                              <div className="text-micro text-gray3">{Math.round((cmb.cachedAgeMs || 0) / 1000)}s 前</div>
                            )}
                          </div>
                        )}
                        {!a.cmbBindAccount && <span className="text-caption text-gray3">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="font-num text-caption text-gray2">{fmtMoney(ledger)}</div>
                        {diff != null && Math.abs(diff) > 0.01 && (
                          <div className={`text-micro ${Math.abs(diff) > 100 ? 'text-red-fg' : 'text-amber-fg'}`}>
                            差 {diff > 0 ? '+' : ''}{fmtMoney(diff)}
                          </div>
                        )}
                        {diff != null && Math.abs(diff) <= 0.01 && (
                          <div className="text-micro text-green-fg">一致 ✓</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex justify-end gap-1.5">
                          {a.cmbBindAccount && (
                            <button onClick={() => setTxDrawer({ open: true, account: a.cmbBindAccount!, label: a.name })}
                                    className="text-caption text-gray2 hover:text-ink px-2 py-1 rounded hover:bg-bg">
                              流水
                            </button>
                          )}
                          <button onClick={() => { setReconcileAccount(a); setReconcileOpen(true) }}
                                  className="text-caption text-gray2 hover:text-ink px-2 py-1 rounded hover:bg-bg">
                            对账
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="px-4 py-2 bg-bg-warm border-t border-border text-micro text-gray3">
              💡 CMB 余额 = 招行接口实时数据 (30 秒缓存). 本地账面 = cashbook 表累加, 差异为 0 表示数据齐.
            </div>
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

      {/* 招行流水 drawer (同事现成组件) */}
      <BankTransactionsDrawer
        open={txDrawer.open}
        account={txDrawer.account}
        accountLabel={txDrawer.label}
        onClose={() => setTxDrawer({ open: false })}
      />

      {/* 对账 drawer (inline) */}
      <ReconcileDrawer
        open={reconcileOpen}
        account={reconcileAccount}
        allAccounts={accounts.filter(a => a.cmbBindAccount)}
        onChangeAccount={setReconcileAccount}
        onClose={() => setReconcileOpen(false)}
      />
    </div>
  )
}

// ════════════════════════════════════════════════════
// 对账 drawer
//   CMB 实际流水 vs 本地 cashbook, 按 yurRef 配对
//   显示 3 tab: 匹配 / 仅 CMB / 仅本地
// ════════════════════════════════════════════════════

type CmbTx = {
  date: string; time: string; sequence: string; direction: 'D' | 'C' | string
  amount: string; counterName: string; counterAcct: string; remark: string; yurRef: string
}
type LocalTx = {
  id: string; direction: 1 | -1; category: string; amount: string
  balanceAfter: string; note?: string | null; txDate: string
  refType: string; refId: string
  account?: { id: string; name: string }
  createdBy?: { name: string }
}

function ReconcileDrawer({
  open, account, allAccounts, onChangeAccount, onClose,
}: {
  open: boolean
  account: Account | null
  allAccounts: Account[]
  onChangeAccount: (a: Account) => void
  onClose: () => void
}) {
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [cmbTxs, setCmbTxs] = useState<CmbTx[] | null>(null)
  const [localTxs, setLocalTxs] = useState<LocalTx[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<'matched' | 'cmbOnly' | 'localOnly'>('cmbOnly')

  useEffect(() => {
    if (!open || !account?.cmbBindAccount) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id, month])

  async function load() {
    setCmbTxs(null); setLocalTxs(null); setErr(null); setLoading(true)
    const start = dayjs(month + '-01').startOf('month')
    const end = dayjs(month + '-01').endOf('month')
    try {
      const [cmbR, localR] = await Promise.all([
        apiFetch<{ success: boolean; transactions?: CmbTx[]; resultMsg?: string; resultCode?: string; hasMore?: boolean }>(
          '/api/cmb/transactions',
          {
            method: 'POST',
            body: JSON.stringify({
              account: account!.cmbBindAccount,
              beginDate: start.format('YYYYMMDD'),
              endDate: end.format('YYYYMMDD'),
            }),
          },
        ),
        apiFetch<{ items: LocalTx[]; total: number }>(
          `/api/cashbook/transactions?accountId=${account!.id}&month=${month}&pageSize=100`,
        ),
      ])
      if (!cmbR.success) throw new Error('CMB 流水查询失败: ' + (cmbR.resultMsg || cmbR.resultCode || ''))
      setCmbTxs(cmbR.transactions || [])
      setLocalTxs(localR.items || [])
      if (cmbR.hasMore) setErr('⚠ CMB 流水超过当月返回上限, 仅显示部分; 月底流水多请缩小日期')
    } catch (e: any) {
      setErr(e?.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }

  // 配对
  const matched = useMemo(() => {
    if (!cmbTxs || !localTxs) return []
    return cmbTxs
      .filter(c => c.yurRef)
      .map(c => {
        const local = localTxs.find(l => l.refId === c.yurRef)
        return local ? { cmb: c, local } : null
      })
      .filter(Boolean) as Array<{ cmb: CmbTx; local: LocalTx }>
  }, [cmbTxs, localTxs])

  const cmbOnly = useMemo(() => {
    if (!cmbTxs || !localTxs) return []
    return cmbTxs.filter(c => {
      if (!c.yurRef) return true   // 入账无 yurRef 算 "未配对" (本地通常也没记)
      return !localTxs.some(l => l.refId === c.yurRef)
    })
  }, [cmbTxs, localTxs])

  const localOnly = useMemo(() => {
    if (!cmbTxs || !localTxs) return []
    return localTxs.filter(l => !cmbTxs.some(c => c.yurRef === l.refId))
  }, [cmbTxs, localTxs])

  if (!open) return null

  const sheet = (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/40" />
      <div className="absolute right-0 top-0 bottom-0 w-[720px] bg-white shadow-xl overflow-auto" onClick={e => e.stopPropagation()}>
        <header className="sticky top-0 bg-white border-b border-border px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-h2">招行对账</h3>
            <p className="text-micro text-gray3 mt-0.5">CMB 实际流水 vs 本地账本, 按 yurRef 配对</p>
          </div>
          <button onClick={onClose} className="text-h2 text-gray3 hover:text-ink">×</button>
        </header>

        <div className="px-6 py-4 space-y-4">
          {/* 选账户 + 月份 */}
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={account?.id || ''}
              onChange={e => {
                const next = allAccounts.find(a => a.id === e.target.value)
                if (next) onChangeAccount(next)
              }}
              className="px-3 py-2 rounded-cta border border-border bg-white text-button">
              {allAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.name} (尾号 {a.accountNo?.slice(-4) || '—'})</option>
              ))}
            </select>
            <MonthPicker value={month} onChange={setMonth} />
            <button onClick={load} disabled={loading} className="px-3 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              {loading ? '查询中…' : '刷新'}
            </button>
          </div>

          {err && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{err}</div>}

          {/* 汇总卡 */}
          {cmbTxs && localTxs && (
            <div className="grid grid-cols-3 gap-3">
              <SummaryCard label="已配对" count={matched.length} tone="green" />
              <SummaryCard label="仅 CMB (银行有本地无)" count={cmbOnly.length} tone={cmbOnly.length > 0 ? 'amber' : 'gray'} />
              <SummaryCard label="仅本地 (本地有银行无)" count={localOnly.length} tone={localOnly.length > 0 ? 'red' : 'gray'} />
            </div>
          )}

          {/* tabs */}
          {cmbTxs && localTxs && (
            <>
              <div className="flex gap-2 border-b border-border">
                {[
                  { k: 'cmbOnly', label: `仅 CMB ${cmbOnly.length}` },
                  { k: 'localOnly', label: `仅本地 ${localOnly.length}` },
                  { k: 'matched', label: `已配对 ${matched.length}` },
                ].map(t => (
                  <button key={t.k} onClick={() => setTab(t.k as any)}
                    className={`px-4 py-2 text-button transition border-b-2 -mb-px ${tab === t.k ? 'border-ink text-ink' : 'border-transparent text-gray2 hover:text-ink'}`}>
                    {t.label}
                  </button>
                ))}
              </div>

              {tab === 'cmbOnly' && (
                <CmbList items={cmbOnly} hint="银行已记账但本地账本没有 — 通常因: 入账(老板/客户转账, 招行不给 yurRef), 或我们 sink 漏写. 财务核对后可手工补登记到 cashbook." />
              )}
              {tab === 'localOnly' && (
                <LocalList items={localOnly} hint="本地账本记了但银行流水查不到 — 可能: 银行延迟, 或我们误写. 财务再次查 CMB 确认." />
              )}
              {tab === 'matched' && (
                <MatchedList items={matched} />
              )}
            </>
          )}

          {!cmbTxs && !err && loading && <div className="py-12 text-center text-caption text-gray3">加载中…</div>}
        </div>
      </div>
    </div>
  )
  return createPortal(sheet, document.body)
}

function SummaryCard({ label, count, tone }: { label: string; count: number; tone: 'green' | 'amber' | 'red' | 'gray' }) {
  const cls = tone === 'green' ? 'text-green-fg' : tone === 'amber' ? 'text-amber-fg' : tone === 'red' ? 'text-red-fg' : 'text-gray3'
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>{count}<span className="text-caption text-gray3 ml-1">笔</span></div>
    </div>
  )
}

function CmbList({ items, hint }: { items: CmbTx[]; hint: string }) {
  if (items.length === 0) return <div className="bg-green-bg/30 text-green-fg rounded-card p-3 text-caption">✓ 全部 CMB 流水都已登记到本地账本</div>
  return (
    <div className="space-y-2">
      <div className="bg-bg-warm rounded-card p-3 text-caption text-gray2">{hint}</div>
      <table className="w-full">
        <thead className="bg-bg/40">
          <tr className="text-micro text-gray3 text-left">
            <th className="px-2 py-1.5 font-normal">日期</th>
            <th className="px-2 py-1.5 font-normal">方向</th>
            <th className="px-2 py-1.5 font-normal">对方</th>
            <th className="px-2 py-1.5 font-normal text-right">金额</th>
            <th className="px-2 py-1.5 font-normal">yurRef / 备注</th>
          </tr>
        </thead>
        <tbody>
          {items.map(c => (
            <tr key={c.sequence} className="border-t border-border">
              <td className="px-2 py-1.5 text-caption font-num">{c.date.slice(4, 6)}/{c.date.slice(6, 8)} {c.time.slice(0, 2)}:{c.time.slice(2, 4)}</td>
              <td className="px-2 py-1.5">
                <Chip tone={c.direction === 'C' ? 'green' : 'amber'}>{c.direction === 'C' ? '入账' : '出账'}</Chip>
              </td>
              <td className="px-2 py-1.5 text-caption truncate max-w-[140px]" title={c.counterName}>{c.counterName || '—'}</td>
              <td className="px-2 py-1.5 text-caption font-num text-right">{fmtMoney2(Number(c.amount))}</td>
              <td className="px-2 py-1.5 text-micro text-gray3 truncate max-w-[200px]" title={c.remark}>
                {c.yurRef || <span className="text-amber-fg">无 yurRef (入账)</span>}
                {c.remark && <div className="text-gray3">{c.remark}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LocalList({ items, hint }: { items: LocalTx[]; hint: string }) {
  if (items.length === 0) return <div className="bg-green-bg/30 text-green-fg rounded-card p-3 text-caption">✓ 本地账本所有交易都能在 CMB 流水里找到</div>
  return (
    <div className="space-y-2">
      <div className="bg-bg-warm rounded-card p-3 text-caption text-gray2">{hint}</div>
      <table className="w-full">
        <thead className="bg-bg/40">
          <tr className="text-micro text-gray3 text-left">
            <th className="px-2 py-1.5 font-normal">日期</th>
            <th className="px-2 py-1.5 font-normal">方向</th>
            <th className="px-2 py-1.5 font-normal">类目</th>
            <th className="px-2 py-1.5 font-normal text-right">金额</th>
            <th className="px-2 py-1.5 font-normal">业务参考</th>
          </tr>
        </thead>
        <tbody>
          {items.map(l => (
            <tr key={l.id} className="border-t border-border">
              <td className="px-2 py-1.5 text-caption font-num">{dayjs(l.txDate).format('MM/DD HH:mm')}</td>
              <td className="px-2 py-1.5">
                <Chip tone={l.direction === 1 ? 'green' : 'amber'}>{l.direction === 1 ? '收' : '支'}</Chip>
              </td>
              <td className="px-2 py-1.5 text-caption">{l.category}</td>
              <td className="px-2 py-1.5 text-caption font-num text-right">{fmtMoney2(Number(l.amount))}</td>
              <td className="px-2 py-1.5 text-micro text-gray3 truncate max-w-[200px]">
                <div>{l.refType}</div>
                <div className="font-num text-gray3">{l.refId}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MatchedList({ items }: { items: Array<{ cmb: CmbTx; local: LocalTx }> }) {
  if (items.length === 0) return <div className="bg-bg-warm rounded-card p-3 text-caption text-gray3">本月暂无可配对的流水</div>
  return (
    <div className="space-y-2">
      <div className="bg-green-bg/20 text-green-fg rounded-card p-3 text-caption">
        ✓ {items.length} 笔流水已配对 (按 yurRef = cashbook.refId 匹配)
      </div>
      <table className="w-full">
        <thead className="bg-bg/40">
          <tr className="text-micro text-gray3 text-left">
            <th className="px-2 py-1.5 font-normal">CMB 日期</th>
            <th className="px-2 py-1.5 font-normal">对方</th>
            <th className="px-2 py-1.5 font-normal text-right">CMB 金额</th>
            <th className="px-2 py-1.5 font-normal text-right">本地金额</th>
            <th className="px-2 py-1.5 font-normal text-center">一致?</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ cmb, local }) => {
            const cmbAmt = Number(cmb.amount)
            const localAmt = Number(local.amount)
            const equal = Math.abs(cmbAmt - localAmt) < 0.01
            return (
              <tr key={cmb.sequence} className="border-t border-border">
                <td className="px-2 py-1.5 text-caption font-num">{cmb.date.slice(4, 6)}/{cmb.date.slice(6, 8)}</td>
                <td className="px-2 py-1.5 text-caption truncate max-w-[140px]">{cmb.counterName || '—'}</td>
                <td className="px-2 py-1.5 text-caption font-num text-right">{fmtMoney2(cmbAmt)}</td>
                <td className="px-2 py-1.5 text-caption font-num text-right">{fmtMoney2(localAmt)}</td>
                <td className="px-2 py-1.5 text-center">
                  {equal ? <span className="text-green-fg">✓</span> : <span className="text-red-fg" title={`差 ${fmtMoney(cmbAmt - localAmt)}`}>✗</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
