/**
 * 财务 · 应付账龄分析
 * 分桶: 未到期 / 逾期 0-30 / 30-60 / 60-90 / 90+
 * 按供应商排名 + 明细列表
 */
'use client'
import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Bucket = { count: number; total: number; label: string }
type AgingItem = {
  scheduleId: string
  supplierId: string; supplierName: string
  storeId: string; storeName?: string
  amount: number
  dueAt: string
  overdueDays: number
  bucket: string
  status: string
}
type Aging = {
  asOf: string
  buckets: Record<'notDue' | 'd0_30' | 'd30_60' | 'd60_90' | 'd90plus', Bucket>
  totalOverdue: number
  totalNotDue: number
  grandTotal: number
  items: AgingItem[]
  supplierRank: Array<{ supplierId: string; name: string; total: number; count: number; oldest: number }>
}

const BUCKET_TONE: Record<string, 'gray' | 'amber' | 'orange' | 'red'> = {
  notDue: 'gray', d0_30: 'amber', d30_60: 'orange', d60_90: 'red', d90plus: 'red',
}
const BUCKET_ORDER = ['d90plus', 'd60_90', 'd30_60', 'd0_30', 'notDue']

function fmt(n: number, d = 0) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

export default function FinanceAgingPage() {
  const [data, setData] = useState<Aging | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeBucket, setActiveBucket] = useState<string>('all')

  useEffect(() => {
    apiFetch<Aging>('/api/finance/reports/aging')
      .then(setData)
      .catch(e => setError(String(e?.message || e)))
  }, [])

  if (error) return <ErrorScreen message={error} />
  if (!data) return <div className="min-h-screen bg-bg flex items-center justify-center text-gray3">加载中…</div>

  const itemsFiltered = activeBucket === 'all'
    ? data.items
    : data.items.filter(i => i.bucket === activeBucket)

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">应付账龄</h1>
        <p className="text-caption text-gray3">截至 {dayjs(data.asOf).format('YYYY-MM-DD HH:mm')}</p>
      </header>

      {/* Hero */}
      <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-4">
        <div className="text-caption text-gray3">应付总额</div>
        <div className="text-h1 font-num">¥{fmt(data.grandTotal)}</div>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div>
            <div className="text-caption text-gray3">已逾期</div>
            <div className={`text-h2 font-num ${data.totalOverdue > 0 ? 'text-red-fg' : 'text-gray2'}`}>¥{fmt(data.totalOverdue)}</div>
          </div>
          <div className="text-right">
            <div className="text-caption text-gray3">未到期</div>
            <div className="text-h2 font-num">¥{fmt(data.totalNotDue)}</div>
          </div>
        </div>
      </div>

      {/* 分桶 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border overflow-hidden">
        <button
          onClick={() => setActiveBucket('all')}
          className={`w-full px-3 py-2.5 flex justify-between border-b border-border ${activeBucket === 'all' ? 'bg-amber/10' : ''}`}
        >
          <span className="text-body">全部</span>
          <span className="font-num">{data.items.length} 笔 · ¥{fmt(data.grandTotal)}</span>
        </button>
        {BUCKET_ORDER.map(key => {
          const b = data.buckets[key as keyof typeof data.buckets]
          if (b.count === 0) return null
          const tone = BUCKET_TONE[key]
          return (
            <button
              key={key}
              onClick={() => setActiveBucket(key)}
              className={`w-full px-3 py-2.5 flex justify-between items-center border-b border-border last:border-b-0 ${activeBucket === key ? 'bg-amber/10' : ''}`}
            >
              <span className="flex items-center gap-2">
                <Chip tone={tone}>{b.label}</Chip>
                <span className="text-caption text-gray3">{b.count} 笔</span>
              </span>
              <span className={`font-num text-body ${tone === 'red' ? 'text-red-fg' : ''}`}>¥{fmt(b.total)}</span>
            </button>
          )
        })}
      </div>

      {/* 按供应商排行 */}
      {data.supplierRank.length > 0 && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
          <div className="text-h2 mb-2">供应商 Top {Math.min(5, data.supplierRank.length)}</div>
          {data.supplierRank.slice(0, 5).map(s => (
            <div key={s.supplierId} className="py-2 border-b border-border last:border-b-0">
              <div className="flex justify-between">
                <span className="text-body truncate flex items-center gap-1">
                  {s.name}
                  {s.oldest >= 90 && <Chip tone="red">90+ 天</Chip>}
                  {s.oldest >= 60 && s.oldest < 90 && <Chip tone="orange">60+ 天</Chip>}
                </span>
                <span className="font-num text-body">¥{fmt(s.total)}</span>
              </div>
              <div className="text-micro text-gray3 mt-0.5">{s.count} 笔 · 最长逾期 {s.oldest >= 0 ? `${s.oldest} 天` : '未到期'}</div>
            </div>
          ))}
        </div>
      )}

      {/* 明细 */}
      <div className="mx-4 mt-3">
        <div className="text-caption text-gray3 mb-2">明细 ({itemsFiltered.length} 笔)</div>
        <ul className="space-y-2">
          {itemsFiltered.length === 0 && (
            <li className="text-caption text-gray3 text-center py-8 bg-white rounded-card border border-border">该桶暂无明细</li>
          )}
          {itemsFiltered.map(i => (
            <li key={i.scheduleId} className="bg-white rounded-card border border-border p-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={BUCKET_TONE[i.bucket]}>{data.buckets[i.bucket as keyof typeof data.buckets]?.label}</Chip>
                <span className="text-micro text-gray3 ml-auto">到期 {dayjs(i.dueAt).format('YYYY-MM-DD')}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-h2 truncate">{i.supplierName}</span>
                <span className="font-num text-h2">¥{fmt(i.amount, 2)}</span>
              </div>
              <p className="text-micro text-gray3 mt-0.5">
                {i.storeName || '?'} · {i.overdueDays >= 0 ? `逾期 ${i.overdueDays} 天` : `${-i.overdueDays} 天后到期`} · {i.status}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
