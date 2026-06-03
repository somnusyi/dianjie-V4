/**
 * 财务 PC Web · 付款申请列表
 *
 * Phase 3 P0
 * 接 /api/payment-requests?status=&pageSize=100
 *
 * vs Phase 2 的 review tab (那个只显示 PENDING + 批量审):
 *   - 这里支持全部状态 (PENDING / APPROVED / AUTO_APPROVED / REJECTED / CANCELED) tab 切换
 *   - 详情入口 → /finance-pc/payment-requests/[id] (含 mark-paid 操作)
 *   - 待执行 (APPROVED 但没 mark-paid) 单独 highlight
 *
 * PC 端 UX:
 *   - 表格 + 状态 tabs
 *   - 单条点击 → 详情页 (审批/付款执行)
 *   - 搜索 (标题 / 收款方 / 单号)
 *   - + 新建按钮 (跳手机端新建页, 因为新建表单复杂)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type Doc = {
  id: string; no: string; title: string; amount: string
  isOverThreshold: boolean
  payload: any
  status: 'PENDING' | 'APPROVED' | 'AUTO_APPROVED' | 'REJECTED' | 'CANCELED'
  initiator: { name: string } | null
  store?: { name: string } | null
  steps?: Array<{ seq: number; approverRole: string; status: string }>
  createdAt: string
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '审批中', APPROVED: '已批准', AUTO_APPROVED: '自动批准',
  REJECTED: '已拒绝', CANCELED: '已撤回',
}
const STATUS_TONE: Record<string, 'amber' | 'green' | 'red' | 'gray'> = {
  PENDING: 'amber', APPROVED: 'green', AUTO_APPROVED: 'green',
  REJECTED: 'red', CANCELED: 'gray',
}

const fmt = (n: number) => `¥${Math.round(n).toLocaleString()}`
const fmt2 = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FinancePCPaymentRequestsPage() {
  const [status, setStatus] = useState<string>(() => {
    if (typeof window === 'undefined') return 'ALL'
    const sp = new URLSearchParams(window.location.search)
    const s = sp.get('status')
    return ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'PAID'].includes(s || '') ? (s || 'ALL') : 'ALL'
  })
  const [data, setData] = useState<Doc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  async function reload() {
    setData(null)
    try {
      // status=PAID 是前端虚拟分类 (payload.paidAt), 实际 API 不支持, 拉 APPROVED+AUTO_APPROVED 自己 filter
      const apiStatus = status === 'PAID' ? 'ALL' : status
      const d = await apiFetch<{ items: Doc[] }>(`/api/payment-requests?status=${apiStatus}&pageSize=200`)
      setData(d.items || [])
    } catch (e: any) {
      setError(e.message)
    }
  }
  useEffect(() => { reload() }, [status])

  const list = data || []
  const filtered = useMemo(() => {
    let res = list
    if (status === 'PAID') {
      res = res.filter(d => !!d.payload?.paidAt)
    }
    const q = search.trim().toLowerCase()
    if (q) {
      res = res.filter(d =>
        d.no?.toLowerCase().includes(q) ||
        d.title?.toLowerCase().includes(q) ||
        d.payload?.payeeName?.toLowerCase?.().includes(q) ||
        d.initiator?.name?.toLowerCase().includes(q)
      )
    }
    return res
  }, [list, status, search])

  const stats = useMemo(() => {
    const pending = list.filter(d => d.status === 'PENDING').length
    const toPayCount = list.filter(d => ['APPROVED', 'AUTO_APPROVED'].includes(d.status) && !d.payload?.paidAt).length
    const toPaySum = list.filter(d => ['APPROVED', 'AUTO_APPROVED'].includes(d.status) && !d.payload?.paidAt)
      .reduce((s, d) => s + Number(d.amount), 0)
    const paidCount = list.filter(d => !!d.payload?.paidAt).length
    return { pending, toPayCount, toPaySum, paidCount }
  }, [list])

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">付款申请</h1>
            <p className="text-caption text-gray3">税费 · 房租 · 维修 · 咨询 等</p>
          </div>
          <div className="flex items-center gap-3">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索 (标题 / 单号 / 收款方 / 发起人)"
              className="px-3 py-2 rounded-cta border border-border bg-white text-button w-72"
            />
            <a href="/v2/finance-pc/payment-requests/new"
               className="px-4 py-2 bg-ink text-white rounded-cta text-button">+ 新建</a>
          </div>
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>
        )}

        {/* Hero 4 卡 */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="待我审" value={String(stats.pending)} unit="单" tone={stats.pending > 0 ? 'red' : 'gray'} />
          <Stat label="待执行付款" value={String(stats.toPayCount)} unit="单" tone={stats.toPayCount > 0 ? 'amber' : 'gray'} />
          <Stat label="待执行金额" value={fmt(stats.toPaySum)} tone="amber" />
          <Stat label="已付" value={String(stats.paidCount)} unit="单" tone="green" />
        </div>

        {/* 状态 tabs */}
        <div className="flex gap-2 mb-3 flex-wrap">
          {[
            { k: 'ALL',      label: `全部 ${list.length}` },
            { k: 'PENDING',  label: `审批中 ${stats.pending}` },
            { k: 'APPROVED', label: `待执行 ${stats.toPayCount}` },
            { k: 'PAID',     label: `已付 ${stats.paidCount}` },
            { k: 'REJECTED', label: '已拒绝' },
          ].map(t => (
            <button key={t.k} onClick={() => setStatus(t.k)}
              className={`px-3 py-1.5 rounded-cta text-button ${status === t.k ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* 表格 */}
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-40">单号 / 时间</th>
                <th className="px-3 py-2 font-normal">收款方 / 用途</th>
                <th className="px-3 py-2 font-normal w-28">发起人</th>
                <th className="px-3 py-2 font-normal text-right w-32">金额</th>
                <th className="px-3 py-2 font-normal w-32">状态</th>
                <th className="px-3 py-2 font-normal text-right w-20">操作</th>
              </tr>
            </thead>
            <tbody>
              {data === null && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {data !== null && filtered.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">
                  {search ? '无匹配单子' : '暂无付款申请'}
                </td></tr>
              )}
              {filtered.map(d => {
                const isPaid = !!d.payload?.paidAt
                const canPay = ['APPROVED', 'AUTO_APPROVED'].includes(d.status) && !isPaid
                const ageHours = dayjs().diff(d.createdAt, 'hour')
                const stale = d.status === 'PENDING' && ageHours >= 24
                return (
                  <tr key={d.id}
                    className={`border-t border-border hover:bg-[#FAF8F2] ${d.isOverThreshold ? 'bg-red-bg/30' : canPay ? 'bg-amber/5' : stale ? 'bg-orange-bg/30' : ''}`}>
                    <td className="px-3 py-2.5">
                      <div className="text-micro text-gray3 font-num">{d.no}</div>
                      <div className="text-micro text-gray3 mt-0.5">{dayjs(d.createdAt).format('MM/DD HH:mm')}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-body truncate">{d.payload?.payeeName || d.title}</div>
                      <div className="text-micro text-gray3 truncate">
                        {d.payload?.usageLabel || '—'}
                        {d.payload?.accountCode && ` · 科目 ${d.payload.accountCode}`}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-caption">{d.initiator?.name || '—'}</td>
                    <td className="px-3 py-2.5 font-num text-right">{fmt2(Number(d.amount))}</td>
                    <td className="px-3 py-2.5">
                      <Chip tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Chip>
                      {isPaid && <div className="mt-0.5"><Chip tone="gray">已付</Chip></div>}
                      {canPay && <div className="mt-0.5"><Chip tone="amber">待执行</Chip></div>}
                      {d.isOverThreshold && <div className="mt-0.5"><Chip tone="red">超阈</Chip></div>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <a href={`/v2/finance-pc/payment-requests/${d.id}`}
                        className="px-3 py-1.5 bg-ink text-white rounded-cta text-button">
                        详情
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}

function Stat({ label, value, unit, tone = 'default' }: { label: string; value: string; unit?: string; tone?: 'default' | 'red' | 'green' | 'gray' | 'amber' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'green' ? 'text-green-fg' : tone === 'amber' ? 'text-amber-fg' : tone === 'gray' ? 'text-gray3' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>
        {value}
        {unit && <span className="text-caption text-gray3 ml-1">{unit}</span>}
      </div>
    </div>
  )
}
