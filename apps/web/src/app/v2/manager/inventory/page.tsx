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
type EstimatedItem = {
  id: string
  code: string
  name: string
  spec: string | null
  category: string
  unit: string
  stock: number
  avgUnitCost: number
  inventoryValue: number
  isLowStock: boolean
  hasDataIssue: boolean
  openingDate: string
  asOf: string
  baselineItemCount: number
  baselineMatchedCount: number
  estimateIncomplete: boolean
}
type Filter = 'all' | 'inStock' | 'zero' | 'issue'

export default function ManagerInventoryPage() {
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null)
  const [estimate, setEstimate] = useState<EstimatedItem[]>([])
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    Promise.all([
      apiFetch<SnapshotResponse>('/api/inventory/snapshot/latest'),
      apiFetch<EstimatedItem[]>('/api/inventory').catch(() => []),
    ])
      .then(([latestSnapshot, estimated]) => { setSnapshot(latestSnapshot); setEstimate(estimated) })
      .catch((e) => setError(String(e?.message || e)))
  }, [])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return estimate.filter((item) => {
      if (filter === 'inStock' && item.stock <= 0) return false
      if (filter === 'zero' && Math.abs(item.stock) >= 0.0001) return false
      if (filter === 'issue' && !item.hasDataIssue) return false
      return !keyword || `${item.name} ${item.spec || ''} ${item.category || ''} ${item.code || ''}`.toLowerCase().includes(keyword)
    })
  }, [estimate, filter, query])

  const grouped = useMemo(() => {
    const groups = new Map<string, EstimatedItem[]>()
    for (const item of visible) {
      const key = item.category || '其他'
      groups.set(key, [...(groups.get(key) || []), item])
    }
    return [...groups.entries()]
  }, [visible])

  const summary = snapshot?.summary
  const asOf = summary?.asOf?.slice(5).replace('-', '/')
  const estimatedValue = estimate.reduce((sum, item) => sum + Number(item.inventoryValue || 0), 0)
  const lowCount = estimate.filter(item => item.isLowStock).length
  const issueCount = estimate.filter(item => item.hasDataIssue).length
  const estimateAsOf = estimate[0]?.asOf

  return (
    <div className="min-h-screen bg-bg pb-8">
      <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <a href="/v2/manager/home" aria-label="返回工作台"
           className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center text-h2">‹</a>
        <div className="flex-1">
          <h1 className="text-h1">门店实时预估库存</h1>
          <p className="text-micro text-gray3">{asOf ? `基于 ${asOf} 最近盘点持续滚动` : '等待建立盘点基准'}</p>
        </div>
        <UserMenu />
      </header>

      <div className="mx-4 mt-3">
        <a href="/v2/inventory-counts" className="flex items-center gap-3 rounded-card border border-amber/30 bg-amber/10 px-3 py-3">
          <span className="w-9 h-9 rounded-full bg-amber text-white flex items-center justify-center">盘</span>
          <div className="flex-1"><div className="text-button text-amber-fg">月度在线盘点</div><div className="text-micro text-gray2">创建、录入、确认或冲销盘点单</div></div>
          <span className="text-gray3">›</span>
        </a>
      </div>

      {error ? (
        <div className="m-4 rounded-card border border-red/30 bg-red-bg p-4 text-body text-red-fg">库存读取失败：{error}</div>
      ) : !snapshot ? (
        <div className="p-8 text-center text-caption text-gray3">正在读取库存…</div>
      ) : summary?.status !== 'AVAILABLE' ? (
        <div className="m-4 rounded-card border border-amber/30 bg-amber/10 p-5">
          <div className="text-h2 text-amber-fg">盘点基准待导入</div>
          <p className="text-body text-gray2 mt-2">建立首次实物盘点后，系统会叠加后续收货、BOM/人工消耗和门店报损，形成实时账面预估库存。</p>
        </div>
      ) : (
        <>
          <section className="m-4 overflow-hidden rounded-card bg-white border border-border">
            <div className="px-4 pt-4 pb-3">
              <div className="text-caption text-gray2">实时预估库存金额</div>
              <div className="font-num text-[32px] leading-tight mt-1">
                ¥{estimatedValue.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div className="text-micro text-gray3 mt-1">
                {estimateAsOf ? `数据更新至 ${new Date(estimateAsOf).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '等待生成预计库存'}
                {' '}· 每次打开按最新业务流水重新计算
              </div>
              {summary.matchedCount < summary.itemCount && (
                <div className="text-micro text-amber-fg mt-2">
                  最近盘点品项匹配 {summary.matchedCount}/{summary.itemCount}；未匹配食材暂不计入实时预估，请在下次盘点前完成主数据匹配。
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 border-t border-border bg-bg/40">
              <SummaryCell label="预计有库存" value={estimate.filter(item => Number(item.stock) > 0).length} />
              <SummaryCell label="低库存" value={lowCount} tone={lowCount > 0 ? 'red' : undefined} />
              <SummaryCell label="需校准" value={issueCount} tone={issueCount > 0 ? 'red' : undefined} />
            </div>
          </section>

          <section className="px-4">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray3">⌕</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索物品、规格或岗位"
                     className="w-full rounded-cta border border-border bg-white py-2.5 pl-9 pr-3 text-body outline-none focus:border-amber" />
            </div>
            <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
              <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>全部 {estimate.length}</FilterButton>
              <FilterButton active={filter === 'inStock'} onClick={() => setFilter('inStock')}>有库存 {estimate.filter(item => item.stock > 0).length}</FilterButton>
              <FilterButton active={filter === 'zero'} onClick={() => setFilter('zero')}>预计为0 {estimate.filter(item => Math.abs(item.stock) < 0.0001).length}</FilterButton>
              <FilterButton active={filter === 'issue'} onClick={() => setFilter('issue')}>需校准 {issueCount}</FilterButton>
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
                          {item.hasDataIssue && <span className="shrink-0 rounded-chip bg-red-bg px-1.5 py-0.5 text-micro text-red-fg">需校准</span>}
                        </div>
                        <div className="text-micro text-gray3 truncate mt-0.5">{item.spec || item.code} · 移动均价 ¥{Number(item.avgUnitCost).toFixed(3)}/{item.unit}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={`font-num text-h2 ${item.stock <= 0 ? 'text-red-fg' : 'text-ink'}`}>{Number(item.stock)} <span className="text-micro font-normal">{item.unit}</span></div>
                        <div className="font-num text-micro text-gray3">¥{Number(item.inventoryValue).toFixed(2)}</div>
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
