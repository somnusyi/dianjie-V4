/**
 * 供应商 App · 账单 (应收账期视角)
 *
 * 主视图: PaymentSchedule (每收一单生成一条 schedule, 按到期日付款)
 * 次视图: 月度统一开票 (报税用, 不影响收款)
 *
 * 接 GET /api/schedules?status=&days=
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { apiFetch, getUser } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Schedule = {
  id: string
  amount: string | number
  status: 'PENDING' | 'NOTIFIED' | 'APPROVED' | 'PROCESSING' | 'PAID' | 'OVERDUE' | 'ON_HOLD' | 'PENDING_APPROVAL' | 'FAILED'
  dueAt: string
  paidAt: string | null
  failReason: string | null
  bankTxNo: string | null
  supplier: { id: string; name: string }
  receipt: {
    id: string; no: string; deliveryDate: string; storeId: string
    store: { name: string }
    invoice: { id: string; invoiceNo: string; status: string } | null
  }
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待付', NOTIFIED: '已通知', APPROVED: '已核准',
  PROCESSING: '付款中', PAID: '已付', OVERDUE: '逾期',
  ON_HOLD: '争议冻结', PENDING_APPROVAL: '财务审中', FAILED: '付款失败',
}
const STATUS_TONE: Record<string, 'orange' | 'green' | 'red' | 'gray' | 'blue'> = {
  PENDING: 'orange', NOTIFIED: 'orange', APPROVED: 'orange',
  PROCESSING: 'blue', PAID: 'green',
  OVERDUE: 'red', ON_HOLD: 'red', PENDING_APPROVAL: 'orange', FAILED: 'red',
}

function fmtMoney(n: number) { return `¥${Math.round(n).toLocaleString()}` }
function diffDays(iso: string) {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400_000)
}
function dueLabel(s: Schedule) {
  if (s.status === 'PAID') return s.paidAt ? `${dayjs(s.paidAt).format('MM/DD')} 到账` : '已付'
  const d = diffDays(s.dueAt)
  if (d < 0) return `已逾期 ${-d} 天`
  if (d === 0) return '今天到期'
  if (d === 1) return '明天到期'
  return `${d} 天后到期`
}

export default function SupplierBillingPage() {
  const [tab] = useState('billing')
  const [items, setItems] = useState<Schedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [supplierName, setSupplierName] = useState('')
  type Filter = 'all' | 'pending' | 'overdue' | 'paid' | 'hold'
  const [filter, setFilter] = useState<Filter>('pending')

  useEffect(() => {
    const u = getUser()
    setSupplierName(u?.supplier?.name || '供应商')
    apiFetch<Schedule[]>('/api/schedules')
      .then(setItems)
      .catch(e => setError(e.message))
  }, [])

  // 集计
  const stats = useMemo(() => {
    const init = {
      arTotal: 0,         // 所有未付清的应收
      paidM: 0,           // 本月已收
      overdueAmt: 0,      // 逾期总额
      due7d: 0,           // 7 天内到期
      onHoldAmt: 0,       // 争议冻结
      counts: { pending: 0, overdue: 0, paid: 0, hold: 0 }
    }
    if (!items) return init
    const now = Date.now()
    const in7d = now + 7 * 86400_000
    const monthStart = dayjs().startOf('month').valueOf()
    for (const s of items) {
      const amt = Number(s.amount)
      const due = new Date(s.dueAt).getTime()
      if (s.status === 'PAID') {
        if (s.paidAt && new Date(s.paidAt).getTime() >= monthStart) init.paidM += amt
        init.counts.paid++
      } else if (s.status === 'ON_HOLD') {
        init.onHoldAmt += amt
        init.counts.hold++
      } else {
        // pending-ish
        init.arTotal += amt
        init.counts.pending++
        if (due < now) {
          init.overdueAmt += amt
          init.counts.overdue++
        } else if (due <= in7d) {
          init.due7d += amt
        }
      }
    }
    return init
  }, [items])

  const visible = useMemo(() => {
    if (!items) return []
    return items.filter(s => {
      if (filter === 'pending') return ['PENDING', 'NOTIFIED', 'APPROVED', 'PROCESSING', 'PENDING_APPROVAL', 'FAILED'].includes(s.status) && new Date(s.dueAt) >= new Date(new Date().setHours(0, 0, 0, 0))
      if (filter === 'overdue') return new Date(s.dueAt) < new Date(new Date().setHours(0, 0, 0, 0)) && s.status !== 'PAID' && s.status !== 'ON_HOLD'
      if (filter === 'paid')    return s.status === 'PAID'
      if (filter === 'hold')    return s.status === 'ON_HOLD'
      return true
    })
  }, [items, filter])

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">账单</h1>
        <p className="text-caption text-gray3">{supplierName} · 应收账期 + 已付明细</p>
      </header>

      {/* Hero — 应收 / 本月已收 / 回款率 */}
      <div className="mt-3">
        <GlanceStrip
          label="应收总额"
          value={items === null ? '加载中…' : fmtMoney(stats.arTotal)}
          meta={
            stats.overdueAmt > 0
              ? `⚠ 逾期 ${fmtMoney(stats.overdueAmt)} · 7天内到 ${fmtMoney(stats.due7d)}`
              : stats.due7d > 0 ? `7 天内到 ${fmtMoney(stats.due7d)}` : '✓ 暂无应收'
          }
          stats={[
            { label: '本月已收', value: fmtMoney(stats.paidM), tone: 'default' as const },
            { label: '逾期金额', value: fmtMoney(stats.overdueAmt), tone: stats.overdueAmt > 0 ? 'red' as const : 'default' as const },
            { label: '冻结', value: fmtMoney(stats.onHoldAmt), tone: stats.onHoldAmt > 0 ? 'red' as const : 'default' as const, delta: stats.onHoldAmt > 0 ? '报损争议中' : undefined },
          ]}
        />
      </div>

      {/* 月度开票次要入口 */}
      <a href="/v2/supplier/invoices" className="block mx-4 mt-3 bg-amber/5 border border-amber/30 rounded-card p-2.5 flex items-center gap-2 text-caption">
        <span className="text-amber-fg">📃</span>
        <span className="flex-1 text-gray2">月度开票 · 关联多笔订单合并 1 张发票</span>
        <span className="text-amber-fg">上传 ›</span>
      </a>

      {/* 筛选 */}
      <div className="px-4 mt-4 flex gap-2 overflow-x-auto">
        {([
          { k: 'pending', label: `待收 ${stats.counts.pending}` },
          { k: 'overdue', label: `逾期 ${stats.counts.overdue}`, tone: 'red' as const },
          { k: 'paid',    label: `已收 ${stats.counts.paid}` },
          { k: 'hold',    label: `争议冻结 ${stats.counts.hold}`, tone: 'red' as const },
          { k: 'all',     label: '全部' },
        ] as Array<{k: Filter; label: string; tone?: 'red'}>).map(f => (
          <button key={f.k} onClick={() => setFilter(f.k)}
            className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${filter === f.k ? 'bg-ink text-white' : `bg-white border border-border ${f.tone === 'red' ? 'text-red-fg' : 'text-gray2'}`}`}>
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <ul className="px-4 mt-3 space-y-2">
        {items === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {items !== null && visible.length === 0 && (
          <li className="text-caption text-gray3 text-center py-12">
            {filter === 'pending' && '✓ 无待收款'}
            {filter === 'overdue' && '✓ 无逾期'}
            {filter === 'paid'    && '本月暂无已收'}
            {filter === 'hold'    && '✓ 无争议冻结'}
            {filter === 'all'     && '暂无账期记录'}
          </li>
        )}
        {visible.map(s => {
          const overdue = s.status !== 'PAID' && s.status !== 'ON_HOLD' && diffDays(s.dueAt) < 0
          return (
            <li key={s.id} className={`bg-white rounded-card border border-border p-3 ${overdue ? 'border-l-4 border-l-red' : ''}`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={STATUS_TONE[s.status] || 'gray'}>{STATUS_LABEL[s.status] || s.status}</Chip>
                <span className="text-caption text-gray3 font-num">{s.receipt?.no}</span>
                <span className={`text-micro ml-auto ${overdue ? 'text-red-fg' : s.status === 'PAID' ? 'text-green-fg' : 'text-gray3'}`}>
                  {dueLabel(s)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-h2 font-num">{fmtMoney(Number(s.amount))}</span>
                {s.receipt?.store?.name && <span className="text-caption text-gray2 truncate ml-2">{s.receipt.store.name}</span>}
              </div>
              <div className="text-micro text-gray3 mt-1 flex flex-wrap gap-x-3">
                <span>到货 {dayjs(s.receipt?.deliveryDate).format('MM/DD')}</span>
                <span>到期 {dayjs(s.dueAt).format('YYYY-MM-DD')}</span>
                {s.receipt?.invoice && (
                  <span className="text-amber-fg">· 已关联发票 #{s.receipt.invoice.invoiceNo}</span>
                )}
              </div>
              {s.status === 'PAID' && s.bankTxNo && (
                <div className="text-micro text-green-fg mt-1">银行流水 {s.bankTxNo}</div>
              )}
              {s.status === 'FAILED' && s.failReason && (
                <div className="text-micro text-red-fg mt-1">付款失败: {s.failReason}</div>
              )}
              {s.status === 'ON_HOLD' && (
                <div className="text-micro text-red-fg mt-1">⚠ 此单有报损争议, 仲裁后才会付款</div>
              )}
            </li>
          )
        })}
      </ul>

      <BottomNav
        tabs={[
          { key: 'home',    label: '首页', icon: '⌂' },
          { key: 'orders',  label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me',      label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')    location.href = '/v2/supplier/home'
          if (k === 'orders')  location.href = '/v2/supplier/orders'
          if (k === 'inventory') location.href = '/v2/supplier/inventory'
          if (k === 'me')      location.href = '/v2/me'
        }}
      />
    </div>
  )
}
