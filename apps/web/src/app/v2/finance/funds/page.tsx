/**
 * 财务 App · 资金 Tab
 *
 * 接真数据:
 *   /api/cashbook/summary       总余额 + 月流入流出
 *   /api/cashbook/accounts      账户列表 (POST 创建)
 *   /api/schedules?days=7       本周应付到期
 *   /api/schedules?status=FAILED 失败付款
 *
 * 改进:
 *   - 单位规范 (¥0 / 万 切换, 不再 ¥0.0K)
 *   - 「+ 新建账户」可在 app 直接加, 不再让用户去"管理后台"
 *   - 失败付款列表 (CMB 服务挂了 / 余额不足 等场景, 财务可见)
 *   - 7 天日历点击 → 弹出当日应付明细
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { BottomNav, Chip } from '@/components/v2'
import { BankAccountList, type BankAccountConfig } from '@/components/v2/bank-account-card'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

// 招行实时账户列表
// 数组化设计 - 同一个 UID (U061858575) 下绑多个账户, 前端传 account 参数后端按账户查
// account 留空 = 后端 env CMB_ACCOUNT 默认 (=125925235910001 南京云洱之境餐饮有限公司)
const BANK_ACCOUNTS: BankAccountConfig[] = [
  {
    label: '母公司·主账户',
    accountName: '南京云洱之境餐饮有限公司',
    bankName: '招商银行南京城东支行',
    accountType: '一般户',
    // account 留空 → 后端用 env 默认值
  },
  {
    label: '子公司·合肥分店',
    account: '125925610910001',
    accountName: '合肥云岳之境餐饮有限公司',
    bankName: '招商银行南京城东支行',
    accountType: '一般户',
  },
]

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
  failReason?: string | null
  retryCount?: number
  supplier?: { name: string } | null
  receipt?: {
    no: string; store?: { name: string } | null
    invoice?: { id: string; invoiceNo: string; status: string } | null
  } | null
}

// 智能金额格式化: <1万 显示 ¥XXX, ≥1万 显示 ¥X.XX万
function fmtMoney(n: number) {
  if (!Number.isFinite(n)) return '¥0'
  const v = Math.round(n)
  if (Math.abs(v) >= 10000) return `¥${(v / 10000).toFixed(2)}万`
  return `¥${v.toLocaleString()}`
}
function fmtDate(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function FinanceFundsPage() {
  const [tab] = useState('funds')
  const [summary, setSummary] = useState<CashbookSummary | null>(null)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [failedSch, setFailedSch] = useState<Schedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 新建账户 modal
  const [openNew, setOpenNew] = useState(false)
  const [draft, setDraft] = useState({ name: '', type: 'BANK', bankName: '', accountNo: '', note: '' })
  const [saving, setSaving] = useState(false)
  // 当日明细 弹层
  const [pickDay, setPickDay] = useState<string | null>(null)

  function load() {
    Promise.all([
      apiFetch<CashbookSummary>('/api/cashbook/summary').catch(e => { setError(e.message); return null }),
      apiFetch<Account[]>('/api/cashbook/accounts').catch(() => []),
      apiFetch<Schedule[]>('/api/schedules?days=7').catch(() => []),
      apiFetch<Schedule[]>('/api/schedules?status=FAILED').catch(() => []),
    ]).then(([s, a, sch, f]) => {
      setSummary(s); setAccounts(a || []); setSchedules(sch || [])
      setFailedSch(f || [])
    })
  }
  useEffect(() => { load() }, [])

  async function createAccount() {
    if (!draft.name.trim()) { alert('账户名称必填'); return }
    setSaving(true)
    try {
      await apiFetch('/api/cashbook/accounts', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name.trim(),
          type: draft.type,
          bankName: draft.bankName.trim() || undefined,
          accountNo: draft.accountNo.trim() || undefined,
          note: draft.note.trim() || undefined,
        }),
      })
      setOpenNew(false)
      setDraft({ name: '', type: 'BANK', bankName: '', accountNo: '', note: '' })
      load()
    } catch (e: any) {
      alert(e.message || '创建失败')
    } finally { setSaving(false) }
  }

  const totalBalance = Number(summary?.totalBalance || 0)
  const monthIncome  = Number(summary?.monthIncome  || 0)
  const monthExpense = Number(summary?.monthExpense || 0)
  const monthNet     = Number(summary?.monthNet     || 0)

  // 7 天日历
  const week = useMemo(() => {
    const days: Array<{ iso: string; dayLabel: string; mmdd: string; isToday: boolean; amount: number; count: number }> = []
    const today = new Date(); today.setHours(0, 0, 0, 0)
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() + i * 86400000)
      const iso = d.toISOString().slice(0, 10)
      days.push({
        iso, dayLabel: ['日','一','二','三','四','五','六'][d.getDay()],
        mmdd: fmtDate(iso), isToday: i === 0, amount: 0, count: 0,
      })
    }
    if (schedules) {
      schedules.forEach(s => {
        if (s.status === 'PAID' || s.status === 'REJECTED') return
        const iso = new Date(s.dueAt).toISOString().slice(0, 10)
        const day = days.find(d => d.iso === iso)
        if (day) { day.amount += Number(s.amount); day.count++ }
      })
    }
    return days
  }, [schedules])

  const upcoming = (schedules || [])
    .filter(s => s.status !== 'PAID' && s.status !== 'REJECTED')
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
  const upcomingTotal = upcoming.reduce((s, x) => s + Number(x.amount), 0)
  const dayDetail = pickDay ? upcoming.filter(s => new Date(s.dueAt).toISOString().slice(0, 10) === pickDay) : []

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">资金</h1>
          <p className="text-caption text-gray3">集团 · {accounts?.length ?? '—'} 个账户</p>
        </div>
        <button onClick={() => setOpenNew(true)}
                className="px-3 py-2 bg-ink text-white rounded-cta text-button">+ 新建账户</button>
      </header>

      <div className="mt-2">
        <GlanceStrip
          label="总账户余额"
          value={summary === null ? '加载中…' : fmtMoney(totalBalance)}
          meta={summary ? `本月流入 ${fmtMoney(monthIncome)} · 流出 ${fmtMoney(monthExpense)}` : ''}
          stats={summary ? [
            { label: '月流入', value: `+${fmtMoney(monthIncome)}`, tone: 'green' as const },
            { label: '月流出', value: `−${fmtMoney(monthExpense)}`, tone: 'red' as const },
            { label: '月净',   value: `${monthNet >= 0 ? '+' : '−'}${fmtMoney(Math.abs(monthNet))}`, tone: monthNet >= 0 ? 'green' as const : 'red' as const },
          ] : []}
        />
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">加载失败: {error}</div>}

      {/* 招行实时账户 — 母公司 (cmb 接入) */}
      <Section title="招行实时账户" right={`${BANK_ACCOUNTS.length} 个 · 实时`}>
        <BankAccountList accounts={BANK_ACCOUNTS} />
      </Section>

      {/* 失败付款 — P0 重要 */}
      {failedSch !== null && failedSch.length > 0 && (
        <Section title="付款失败 / 重试" right={`${failedSch.length} 笔`} rightTone="red">
          <ul className="bg-red-bg/30 rounded-card border border-red/30 divide-y divide-red/20">
            {failedSch.slice(0, 5).map(s => (
              <li key={s.id} className="px-3 py-2.5">
                <div className="flex items-center gap-2 mb-0.5">
                  <Chip tone="red">{s.status === 'OVERDUE' ? '逾期' : '失败'}</Chip>
                  {(s.retryCount || 0) > 0 && <span className="text-micro text-red-fg">已重试 {s.retryCount} 次</span>}
                  <span className="ml-auto font-num text-h2">{fmtMoney(Number(s.amount))}</span>

                </div>
                <div className="text-body truncate">{s.supplier?.name || '—'}</div>
                <p className="text-micro text-gray2 truncate">{s.receipt?.store?.name} · #{s.receipt?.no}</p>
                {s.failReason && <p className="text-micro text-red-fg mt-1">原因: {s.failReason}</p>}
              </li>
            ))}
          </ul>
          <a href="/v2/finance/payable" className="block text-center mt-2 py-2 text-caption text-amber-fg">去应付页人工处理 ›</a>
        </Section>
      )}

      <Section title="账户余额" right={accounts && accounts.length > 0 ? `${accounts.length} 个 · ${fmtMoney(totalBalance)}` : ''}>
        {accounts === null && <p className="text-caption text-gray3 text-center py-6">加载中…</p>}
        {accounts !== null && accounts.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无资金账户</p>
            <p className="text-micro text-gray3 mt-1">点击右上角「+ 新建账户」添加银行 / 微信 / 支付宝</p>
            <button onClick={() => setOpenNew(true)} className="mt-3 px-4 py-2 bg-ink text-white rounded-cta text-button">+ 新建账户</button>
          </div>
        )}
        {accounts && accounts.length > 0 && (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {accounts.map(a => {
              const amt = Number(a.balance)
              const pct = totalBalance > 0 ? Math.round(amt / totalBalance * 100) : 0
              const anomaly = amt <= 0
              return (
                <li key={a.id} className="px-3 py-3">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="w-9 h-9 rounded-md bg-bg flex items-center justify-center font-num">{a.name?.[0] || '$'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-h2 truncate">{a.name}</span>
                        {anomaly && <Chip tone="red">余额 0</Chip>}
                      </div>
                      <p className="text-micro text-gray3">
                        {a.bankName || a.type}
                        {a.accountNo ? ` · 尾号 ${String(a.accountNo).slice(-4)}` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="font-num text-h2">{fmtMoney(amt)}</div>
                      <div className="text-micro text-gray3 font-num">{pct}%</div>
                    </div>
                  </div>
                  <div className="h-1 bg-bg rounded-full overflow-hidden">
                    <div className={`h-full ${anomaly ? 'bg-red' : 'bg-gray2'}`} style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section title="本周应付到期" right={upcoming.length ? `${upcoming.length} 笔 · ${fmtMoney(upcomingTotal)}` : ''}>
        <div className="bg-white rounded-card border border-border p-3">
          <div className="grid grid-cols-7 gap-1 mb-1">
            {week.map((d) => (
              <button key={d.iso} onClick={() => d.amount > 0 && setPickDay(d.iso)}
                      className={`flex flex-col items-center text-center py-2 rounded-card ${d.isToday ? 'border border-ink' : d.amount > 0 ? 'bg-amber/10 hover:bg-amber/20' : 'bg-bg'} ${d.amount > 0 ? 'cursor-pointer' : 'cursor-default'}`}>
                <span className="text-micro text-gray3">{d.dayLabel}</span>
                <span className="text-caption">{d.mmdd}</span>
                {d.isToday && <span className="text-micro text-gray2 mt-0.5">今日</span>}
                {d.amount > 0 && (
                  <>
                    <span className="font-num text-button text-amber-fg mt-1">{fmtMoney(d.amount)}</span>
                    <span className="text-micro text-gray3">{d.count} 笔</span>
                  </>
                )}
              </button>
            ))}
          </div>
          {schedules === null ? (
            <p className="text-caption text-gray3 text-center py-2">加载中…</p>
          ) : upcoming.length === 0 ? (
            <p className="text-caption text-gray3 text-center py-3">未来 7 天暂无应付</p>
          ) : (
            <p className="text-micro text-gray3 text-center mt-1">点日期格查看当日明细 ›</p>
          )}
        </div>
      </Section>

      {/* 新建账户 modal */}
      {openNew && (
        <div className="fixed inset-0 z-50 bg-ink/60 flex items-end justify-center"
             onClick={() => setOpenNew(false)}>
          <div className="bg-white rounded-t-card w-full max-w-md p-4"
               onClick={e => e.stopPropagation()}
               style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-3" />
            <h3 className="text-h2">新建资金账户</h3>
            <p className="text-caption text-gray3 mt-1">添加后在「资金」可见, 系统按此账户记账</p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="text-micro text-gray3 block mb-1">账户名称 *</label>
                <input value={draft.name} onChange={e => setDraft({...draft, name: e.target.value})}
                       placeholder="如 招商银行 主账户"
                       className="w-full bg-bg rounded-cta px-3 py-2 text-body outline-none" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">类型</label>
                <select value={draft.type} onChange={e => setDraft({...draft, type: e.target.value})}
                        className="w-full bg-bg rounded-cta px-3 py-2 text-body outline-none">
                  <option value="BANK">银行账户</option>
                  <option value="WECHAT">微信商户</option>
                  <option value="ALIPAY">支付宝商户</option>
                  <option value="CASH">现金</option>
                  <option value="OTHER">其他</option>
                </select>
              </div>
              {draft.type === 'BANK' && (
                <>
                  <div>
                    <label className="text-micro text-gray3 block mb-1">开户行</label>
                    <input value={draft.bankName} onChange={e => setDraft({...draft, bankName: e.target.value})}
                           placeholder="如 招商银行 杭州西湖支行"
                           className="w-full bg-bg rounded-cta px-3 py-2 text-body outline-none" />
                  </div>
                  <div>
                    <label className="text-micro text-gray3 block mb-1">账号 (后 4 位会显示)</label>
                    <input value={draft.accountNo} onChange={e => setDraft({...draft, accountNo: e.target.value})}
                           placeholder="如 6225 8888 8888 8888"
                           className="w-full bg-bg rounded-cta px-3 py-2 text-body font-num outline-none" />
                  </div>
                </>
              )}
              <div>
                <label className="text-micro text-gray3 block mb-1">备注 (可选)</label>
                <input value={draft.note} onChange={e => setDraft({...draft, note: e.target.value})}
                       className="w-full bg-bg rounded-cta px-3 py-2 text-body outline-none" />
              </div>
            </div>

            <div className="flex gap-2 mt-5">
              <button onClick={() => setOpenNew(false)}
                      className="px-4 py-2 border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={createAccount} disabled={saving}
                      className="flex-1 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                {saving ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 当日应付明细 弹层 */}
      {pickDay && (
        <div className="fixed inset-0 z-50 bg-ink/60 flex items-end justify-center"
             onClick={() => setPickDay(null)}>
          <div className="bg-white rounded-t-card w-full max-w-md max-h-[80vh] flex flex-col"
               onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-border rounded-full mx-auto mt-2" />
            <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
              <h3 className="text-h2">{pickDay} 应付</h3>
              <span className="text-caption text-gray3">{dayDetail.length} 笔 · {fmtMoney(dayDetail.reduce((s,x) => s + Number(x.amount), 0))}</span>
            </div>
            <ul className="overflow-auto flex-1 divide-y divide-border">
              {dayDetail.map(s => {
                const inv = s.receipt?.invoice
                return (
                  <li key={s.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-h2 truncate flex-1">{s.supplier?.name || '—'}</span>
                      <span className="font-num text-h2">{fmtMoney(Number(s.amount))}</span>
                    </div>
                    <p className="text-caption text-gray2">{s.receipt?.store?.name} · #{s.receipt?.no}</p>
                    {!inv && <p className="text-micro text-orange-fg mt-1">⚠ 未关联发票, 不能付款</p>}
                    {inv?.status === 'PENDING' && <p className="text-micro text-amber-fg mt-1">📃 发票待审 #{inv.invoiceNo}</p>}
                    {inv?.status === 'VERIFIED' && <p className="text-micro text-green-fg mt-1">✓ 发票已通过 · 可付款</p>}
                  </li>
                )
              })}
            </ul>
            <div className="border-t border-border p-3 flex gap-2">
              <button onClick={() => setPickDay(null)}
                      className="px-4 py-2 border border-border rounded-cta text-button text-gray2">关闭</button>
              <a href="/v2/finance/payable" className="flex-1 text-center py-2 bg-ink text-white rounded-cta text-button">去应付页操作 ›</a>
            </div>
          </div>
        </div>
      )}

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
