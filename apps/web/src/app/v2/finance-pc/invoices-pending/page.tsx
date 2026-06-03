/**
 * 财务 PC · 待开票跟踪
 *
 * 真实业务痛点 (财务基本业务清单 #7):
 *   "跟进未开票事项, 成本/店长报销等开票事项, 商场未开票事项需让店长问商场要"
 *   = 已付款给供应商但供应商一直没把发票寄来 → 财务要催
 *
 * UX:
 *   - 默认 tab: 已付款未开票 (主要催办对象), 按 daysSincePaid 倒序
 *   - 二级 tab: 未付款未开票 (信息备查, 不催)
 *   - 行内有 "催发票" 按钮 (mailto / 一键复制供应商联系方式 / 未来接 wecom 群通知)
 *   - daysSincePaid > 30 红色, > 15 橙色
 *   - 顶部 Hero: 张数 / 金额 / 最久 N 天
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { BlackHero, Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type Receipt = {
  id: string; no: string
  totalAmount: string | number
  deliveryDate: string
  daysSincePaid?: number | null
  supplier: { id: string; name: string; contactName?: string | null; contactPhone?: string | null }
  store: { id: string; name: string; managerName?: string | null; phone?: string | null }
  paymentSchedule?: {
    paidAt?: string | null
    dueAt?: string
    amount?: string | number
    status: string
  } | null
}
type Data = {
  paid: Receipt[]
  pending: Receipt[]
  summary: {
    paidCount: number
    paidAmount: number
    pendingCount: number
    pendingAmount: number
    oldestPaidDays: number
  }
}

const fmtMoney = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtKMoney = (n: number) => n >= 1000 ? `¥${(n / 1000).toFixed(1)}K` : `¥${Math.round(n)}`

export default function FinancePCInvoicesPendingPage() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'paid' | 'pending'>('paid')
  const [search, setSearch] = useState('')

  useEffect(() => {
    apiFetch<Data>('/api/invoices/pending-from-finance')
      .then(setData)
      .catch(e => setError(e?.message || String(e)))
  }, [])

  const list = (data ? (tab === 'paid' ? data.paid : data.pending) : []).filter(r => {
    if (!search) return true
    const q = search.trim().toLowerCase()
    return r.no.toLowerCase().includes(q)
      || r.supplier.name.toLowerCase().includes(q)
      || r.store.name.toLowerCase().includes(q)
  })

  function copyContact(r: Receipt) {
    const supplier = `${r.supplier.name} ${r.supplier.contactName || ''} ${r.supplier.contactPhone || ''}`.trim()
    const msg = `催发票: 入库单 ${r.no} (${r.store.name}) ¥${Number(r.totalAmount).toFixed(2)} 已付款 ${r.daysSincePaid || 0} 天 — ${supplier}`
    navigator.clipboard?.writeText(msg).then(() => alert('已复制催办文案 (可粘贴到企微 / 微信群)')).catch(() => alert(msg))
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">待开票跟踪</h1>
            <p className="text-caption text-gray3">已付款但供应商没开发票 → 财务催办主战场</p>
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索 (入库单号 / 供应商 / 门店)"
            className="px-3 py-2 rounded-cta border border-border bg-white text-button w-80"
          />
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        <BlackHero
          density="desktop"
          label="已付款未开票 ●"
          value={data ? String(data.summary.paidCount) : '—'}
          delta={data && data.summary.paidCount > 0
            ? { text: `张 · 累计 ${fmtKMoney(data.summary.paidAmount)} · 最久 ${data.summary.oldestPaidDays} 天`, trend: data.summary.oldestPaidDays > 30 ? 'down' : 'flat' }
            : undefined}
          stats={data ? [
            { label: '已付未开张数',   value: String(data.summary.paidCount),    tone: data.summary.paidCount > 0 ? 'red' : 'green' },
            { label: '未付未开张数',   value: String(data.summary.pendingCount), tone: 'gray' },
            { label: '已付未开金额',   value: fmtKMoney(data.summary.paidAmount), tone: 'red' },
          ] : []}
        />

        {/* tabs */}
        <div className="flex gap-2 mt-4 mb-3">
          {[
            { k: 'paid' as const,    label: `已付款未开票 ${data?.summary.paidCount ?? '—'}` },
            { k: 'pending' as const, label: `未付款未开票 ${data?.summary.pendingCount ?? '—'}` },
          ].map(t => (
            <button key={t.k} onClick={() => setTab(t.k)}
              className={`px-4 py-2 rounded-cta text-button ${tab === t.k ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* 列表 */}
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-40">入库单</th>
                <th className="px-3 py-2 font-normal">供应商 / 联系人</th>
                <th className="px-3 py-2 font-normal w-32">门店</th>
                <th className="px-3 py-2 font-normal text-right w-32">金额</th>
                <th className="px-3 py-2 font-normal w-32">{tab === 'paid' ? '已付款于' : '到期日'}</th>
                <th className="px-3 py-2 font-normal w-24">距今</th>
                <th className="px-3 py-2 font-normal text-right w-32">操作</th>
              </tr>
            </thead>
            <tbody>
              {data === null && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {data !== null && list.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-caption text-gray3">
                  {tab === 'paid' ? '✓ 没有已付款未开票的单子' : '没有未付款未开票的单子'}
                </td></tr>
              )}
              {list.map(r => {
                const days = r.daysSincePaid ?? null
                const stale = days != null && days > 30
                const warn = days != null && days > 15
                return (
                  <tr key={r.id}
                    className={`border-t border-border hover:bg-[#FAF8F2] ${stale ? 'bg-red-bg/30' : warn ? 'bg-orange-bg/30' : ''}`}>
                    <td className="px-3 py-2.5">
                      <a href={`/v2/finance-pc/payable`}
                        className="text-body font-num hover:text-ink">{r.no}</a>
                      <div className="text-micro text-gray3 mt-0.5">入库 {dayjs(r.deliveryDate).format('MM/DD')}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-body">{r.supplier.name}</div>
                      <div className="text-micro text-gray3">
                        {r.supplier.contactName || '—'}
                        {r.supplier.contactPhone && ` · ${r.supplier.contactPhone}`}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-caption">{r.store.name}</td>
                    <td className="px-3 py-2.5 font-num text-right">{fmtMoney(Number(r.totalAmount))}</td>
                    <td className="px-3 py-2.5 text-caption font-num">
                      {tab === 'paid'
                        ? (r.paymentSchedule?.paidAt ? dayjs(r.paymentSchedule.paidAt).format('YYYY-MM-DD') : '—')
                        : (r.paymentSchedule?.dueAt ? dayjs(r.paymentSchedule.dueAt).format('YYYY-MM-DD') : '—')}
                    </td>
                    <td className="px-3 py-2.5">
                      {days != null
                        ? <Chip tone={stale ? 'red' : warn ? 'orange' : 'gray'}>{days} 天</Chip>
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button onClick={() => copyContact(r)}
                              className="px-3 py-1.5 bg-amber text-white rounded-cta text-button"
                              title="复制催办文案到剪贴板, 粘贴给供应商">
                        📋 催发票
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 text-caption text-gray3">
          💡 标红 = 已付款 30 天以上还没开发票; 标黄 = 15 天以上.
          点 "📋 催发票" 复制催办文案到剪贴板, 粘贴到企微 / 微信群即可.
        </div>
      </main>
    </div>
  )
}
