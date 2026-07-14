/** 店长移动端 · 门店库存盘点明细 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { UserMenu } from '@/components/v2/user-menu'

type InventorySummary = {
  status: 'AVAILABLE' | 'NO_BASELINE'
  asOf: string | null
  openingDate: string | null
  totalValue: number | null
  itemCount: number
  nonzeroCount: number
  zeroCount: number
  matchedCount: number
  unmatchedCount: number
  lowStockCount: number
  sourceFilename: string | null
}

type InventoryItem = {
  id: string
  section: string | null
  name: string
  spec: string | null
  unit: string
  quantity: number
  unitPrice: number
  amount: number
  matched: boolean
}

type SnapshotResponse = { summary: InventorySummary; items: InventoryItem[] }
type Filter = 'all' | 'inStock' | 'zero' | 'unmatched'

export default function ManagerInventoryPage() {
  const [data, setData] = useState<SnapshotResponse | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    apiFetch<SnapshotResponse>('/api/inventory/snapshot/latest')
      .then(setData)
      .catch((e) => setError(String(e?.message || e)))
  }, [])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (data?.items || []).filter((item) => {
      if (filter === 'inStock' && item.quantity <= 0) return false
      if (filter === 'zero' && item.quantity > 0) return false
      if (filter === 'unmatched' && item.matched) return false
      return !keyword || `${item.name} ${item.spec || ''} ${item.section || ''}`.toLowerCase().includes(keyword)
    })
  }, [data, filter, query])

  const grouped = useMemo(() => {
    const groups = new Map<string, InventoryItem[]>()
    for (const item of visible) {
      const key = item.section || '未分岗'
      groups.set(key, [...(groups.get(key) || []), item])
    }
    return [...groups.entries()]
  }, [visible])

  const summary = data?.summary
  const asOf = summary?.asOf?.slice(5).replace('-', '/')

  return (
    <div className="min-h-screen bg-bg pb-8">
      <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <a href="/v2/manager/home" aria-label="返回工作台"
           className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center text-h2">‹</a>
        <div className="flex-1">
          <h1 className="text-h1">门店库存</h1>
          <p className="text-micro text-gray3">{asOf ? `${asOf} 闭店实物盘点` : '等待建立盘点基准'}</p>
        </div>
        <UserMenu />
      </header>

      {error ? (
        <div className="m-4 rounded-card border border-red/30 bg-red-bg p-4 text-body text-red-fg">库存读取失败：{error}</div>
      ) : !data ? (
        <div className="p-8 text-center text-caption text-gray3">正在读取库存…</div>
      ) : summary?.status !== 'AVAILABLE' ? (
        <div className="m-4 rounded-card border border-amber/30 bg-amber/10 p-5">
          <div className="text-h2 text-amber-fg">盘点基准待导入</div>
          <p className="text-body text-gray2 mt-2">系统没有用历史累计采购量冒充当前库存。导入实物盘点后，这里会显示真实盘点品项和金额。</p>
        </div>
      ) : (
        <>
          <section className="m-4 overflow-hidden rounded-card bg-white border border-border">
            <div className="px-4 pt-4 pb-3">
              <div className="text-caption text-gray2">盘点库存金额</div>
              <div className="font-num text-[32px] leading-tight mt-1">
                ¥{Number(summary.totalValue || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div className="text-micro text-gray3 mt-1">{summary.openingDate?.slice(5).replace('-', '/')} 期初库存基准 · 尚非实时库存</div>
            </div>
            <div className="grid grid-cols-3 border-t border-border bg-bg/40">
              <SummaryCell label="全部品项" value={summary.itemCount} />
              <SummaryCell label="有库存" value={summary.nonzeroCount} />
              <SummaryCell label="盘点为 0" value={summary.zeroCount} tone="red" />
            </div>
          </section>

          <section className="px-4">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray3">⌕</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索物品、规格或岗位"
                     className="w-full rounded-cta border border-border bg-white py-2.5 pl-9 pr-3 text-body outline-none focus:border-amber" />
            </div>
            <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
              <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>全部 {summary.itemCount}</FilterButton>
              <FilterButton active={filter === 'inStock'} onClick={() => setFilter('inStock')}>有库存 {summary.nonzeroCount}</FilterButton>
              <FilterButton active={filter === 'zero'} onClick={() => setFilter('zero')}>盘点为0 {summary.zeroCount}</FilterButton>
              <FilterButton active={filter === 'unmatched'} onClick={() => setFilter('unmatched')}>待匹配 {summary.unmatchedCount}</FilterButton>
            </div>
          </section>

          <div className="px-4 mt-4 space-y-5">
            {grouped.length === 0 && <div className="py-10 text-center text-caption text-gray3">没有符合条件的库存品项</div>}
            {grouped.map(([section, items]) => (
              <section key={section}>
                <div className="flex items-baseline justify-between mb-2">
                  <h2 className="text-h2">{section}</h2>
                  <span className="text-caption text-gray3">{items.length} 种</span>
                </div>
                <div className="overflow-hidden rounded-card border border-border bg-white divide-y divide-border">
                  {items.map((item) => (
                    <article key={item.id} className="px-3 py-3 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-button truncate">{item.name}</span>
                          {!item.matched && <span className="shrink-0 rounded-chip bg-amber/10 px-1.5 py-0.5 text-micro text-amber-fg">待匹配</span>}
                        </div>
                        <div className="text-micro text-gray3 truncate mt-0.5">{item.spec || '未记录规格'} · ¥{item.unitPrice.toFixed(3)}/{item.unit}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={`font-num text-h2 ${item.quantity <= 0 ? 'text-red-fg' : 'text-ink'}`}>{item.quantity} <span className="text-micro font-normal">{item.unit}</span></div>
                        <div className="font-num text-micro text-gray3">¥{item.amount.toFixed(2)}</div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SummaryCell({ label, value, tone }: { label: string; value: number; tone?: 'red' }) {
  return (
    <div className="py-3 text-center border-r border-border last:border-r-0">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`font-num text-h2 mt-0.5 ${tone === 'red' ? 'text-red-fg' : ''}`}>{value}<span className="text-micro font-normal ml-0.5">种</span></div>
    </div>
  )
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
            className={`shrink-0 rounded-cta px-3 py-1.5 text-button ${active ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
      {children}
    </button>
  )
}
