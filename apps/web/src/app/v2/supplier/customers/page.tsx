/**
 * 供应商 · 客户/门店关系
 *
 * 列出所有合作过的门店, 按本月成交额排序, 标 VIP / 沉睡客户
 * 接 GET /api/supplier/insights/customers?days=90
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Customer = {
  storeId: string; name: string; no: string
  totalOrders: number; totalAmount: number
  monthOrders: number; monthAmount: number
  lastOrderAt: string
  daysSinceLastOrder: number
  isVip: boolean
  isSleeping: boolean
}

export default function SupplierCustomersPage() {
  const router = useRouter()
  const [list, setList] = useState<Customer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'vip' | 'sleeping' | 'active'>('all')

  useEffect(() => {
    apiFetch<Customer[]>('/api/supplier/insights/customers?days=90')
      .then(setList)
      .catch(e => setError(e.message || '加载失败'))
  }, [])

  const filtered = (list || []).filter(c => {
    if (filter === 'vip') return c.isVip
    if (filter === 'sleeping') return c.isSleeping
    if (filter === 'active') return !c.isSleeping
    return true
  })

  // 集计
  const totalAmount = (list || []).reduce((s, c) => s + c.totalAmount, 0)
  const monthAmount = (list || []).reduce((s, c) => s + c.monthAmount, 0)
  const vipCount = (list || []).filter(c => c.isVip).length
  const sleepingCount = (list || []).filter(c => c.isSleeping).length

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <h1 className="text-h1 flex-1">客户 / 门店</h1>
        {list && <Chip tone="gray">{list.length} 家</Chip>}
      </header>
      <p className="px-4 mt-1 text-micro text-gray3">最近 90 天合作的所有门店,按累计成交额排序</p>

      {/* Hero stats */}
      {list && list.length > 0 && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-micro text-gray3">本月成交</div>
              <div className="font-num text-h1 text-amber-fg mt-0.5">¥{Math.round(monthAmount).toLocaleString()}</div>
            </div>
            <div>
              <div className="text-micro text-gray3">90 天累计</div>
              <div className="font-num text-h1 mt-0.5">¥{Math.round(totalAmount).toLocaleString()}</div>
            </div>
          </div>
          {(vipCount > 0 || sleepingCount > 0) && (
            <div className="mt-3 pt-3 border-t border-border flex gap-3 text-caption">
              {vipCount > 0 && <span><b className="text-amber-fg">{vipCount}</b> 家 VIP</span>}
              {sleepingCount > 0 && <span><b className="text-red-fg">{sleepingCount}</b> 家 沉睡 (>30天没下单)</span>}
            </div>
          )}
        </div>
      )}

      {/* 筛选 chips */}
      {list && list.length > 0 && (
        <div className="px-4 mt-3 flex gap-2 overflow-x-auto">
          {[
            { key: 'all', label: `全部 ${list.length}` },
            { key: 'vip', label: `VIP ${vipCount}` },
            { key: 'active', label: `活跃 ${list.length - sleepingCount}` },
            { key: 'sleeping', label: `沉睡 ${sleepingCount}` },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key as any)}
                    className={`px-3 py-1.5 rounded-chip text-caption whitespace-nowrap ${filter === f.key ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {f.label}
            </button>
          ))}
        </div>
      )}

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      {!list && !error && <p className="mx-4 mt-6 text-center text-gray3">加载中…</p>}
      {list && list.length === 0 && (
        <div className="mx-4 mt-12 text-center">
          <div className="text-4xl mb-2">🏪</div>
          <p className="text-h2 text-gray2">还没有合作门店</p>
          <p className="text-caption text-gray3 mt-1">收到第一单后会出现在这里</p>
        </div>
      )}
      {list && filtered.length === 0 && list.length > 0 && (
        <p className="mx-4 mt-6 text-center text-gray3">该筛选下无门店</p>
      )}

      <ul className="mx-4 mt-3 space-y-2">
        {filtered.map(c => (
          <li key={c.storeId} className="bg-white rounded-card border border-border p-3">
            <div className="flex items-baseline gap-2">
              <span className="text-h2 truncate flex-1">{c.name}</span>
              {c.isVip && <Chip tone="orange">VIP</Chip>}
              {c.isSleeping && <Chip tone="red">沉睡</Chip>}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2 text-caption">
              <div className="bg-bg rounded-cta p-2">
                <div className="text-micro text-gray3">本月</div>
                <div className="font-num text-body mt-0.5">¥{Math.round(c.monthAmount).toLocaleString()}</div>
                <div className="text-micro text-gray3">{c.monthOrders} 单</div>
              </div>
              <div className="bg-bg rounded-cta p-2">
                <div className="text-micro text-gray3">90 天累计</div>
                <div className="font-num text-body mt-0.5">¥{Math.round(c.totalAmount).toLocaleString()}</div>
                <div className="text-micro text-gray3">{c.totalOrders} 单</div>
              </div>
            </div>
            <div className="mt-2 text-micro text-gray3 flex items-center justify-between">
              <span>上次下单: {dayjs(c.lastOrderAt).format('MM/DD')} ({c.daysSinceLastOrder} 天前)</span>
              {c.isSleeping && <span className="text-red-fg">建议主动联系</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
