/**
 * 财务 · 付款申请列表
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Doc = {
  id: string; no: string; title: string; amount: string
  isOverThreshold: boolean
  payload: any
  status: 'PENDING' | 'APPROVED' | 'AUTO_APPROVED' | 'REJECTED' | 'CANCELED'
  initiator: { name: string } | null
  steps: Array<{ seq: number; approverRole: string; status: string }>
  createdAt: string
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '审批中', APPROVED: '已批准', AUTO_APPROVED: '自动批准',
  REJECTED: '已拒绝', CANCELED: '已撤回',
}
const STATUS_TONE: Record<string, 'amber' | 'green' | 'red' | 'gray' | 'blue'> = {
  PENDING: 'amber', APPROVED: 'green', AUTO_APPROVED: 'green',
  REJECTED: 'red', CANCELED: 'gray',
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function PaymentRequestsPage() {
  const [status, setStatus] = useState<string>('ALL')
  const [data, setData] = useState<Doc[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setData(null)
    try {
      const d = await apiFetch<{ items: Doc[] }>(`/api/payment-requests?status=${status}&pageSize=50`)
      setData(d.items)
    } catch (e: any) {
      setError(e.message)
    }
  }
  useEffect(() => { reload() }, [status])

  if (error) return <ErrorScreen message={error} />

  const list = data || []
  const stats = {
    pending: list.filter(d => d.status === 'PENDING').length,
    approved: list.filter(d => ['APPROVED', 'AUTO_APPROVED'].includes(d.status) && !d.payload?.paidAt).length,
    paid: list.filter(d => d.payload?.paidAt).length,
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">付款申请</h1>
          <p className="text-caption text-gray3">税费 · 房租 · 维修 · 咨询 等</p>
        </div>
        <a href="/v2/finance/payment-requests/new"
           className="px-3 py-2 bg-ink text-white rounded-cta text-button">+ 新建</a>
      </header>

      {/* 状态过滤 */}
      <div className="px-4 mt-3 flex gap-1.5 overflow-x-auto">
        {['ALL', 'PENDING', 'APPROVED', 'REJECTED'].map(s => (
          <button key={s} onClick={() => setStatus(s)}
                  className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${status === s ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {s === 'ALL' ? '全部' : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {/* hero */}
      <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-3 grid grid-cols-3 gap-2 text-caption">
        <div><div className="text-gray3">审批中</div><div className="text-h2 font-num">{stats.pending}</div></div>
        <div><div className="text-gray3">待执行</div><div className="text-h2 font-num text-amber-fg">{stats.approved}</div></div>
        <div><div className="text-gray3">已付</div><div className="text-h2 font-num">{stats.paid}</div></div>
      </div>

      <ul className="px-4 mt-3 space-y-2">
        {data === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {data !== null && list.length === 0 && (
          <li className="text-caption text-gray3 text-center py-12">暂无付款申请</li>
        )}
        {list.map(d => {
          const isPaid = !!d.payload?.paidAt
          const canPay = ['APPROVED', 'AUTO_APPROVED'].includes(d.status) && !isPaid
          return (
            <li key={d.id}>
              <a href={`/v2/finance/payment-requests/${d.id}`}
                 className="block bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Chip>
                  {isPaid && <Chip tone="gray">已付</Chip>}
                  {canPay && <Chip tone="amber">待执行</Chip>}
                  {d.isOverThreshold && <Chip tone="red">超阈</Chip>}
                  <span className="text-micro text-gray3 ml-auto">{dayjs(d.createdAt).format('MM/DD HH:mm')}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-h2 truncate flex-1 min-w-0">{d.payload?.payeeName || d.title}</span>
                  <span className="font-num text-h2 ml-2 shrink-0">¥{fmt(Number(d.amount))}</span>
                </div>
                <p className="text-caption text-gray2 mt-0.5">
                  {d.payload?.usageLabel || '—'}
                  {d.initiator && ` · ${d.initiator.name} 发起`}
                  {d.no && ` · ${d.no}`}
                </p>
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
