/**
 * 供应商 · 库存总览
 *
 * 顶部 KPI: 总 SKU / 库存价值 / 低于警戒 / 已断货
 * 列表: 按库存升序 (越紧急越上面), 支持 全部 / 低于警戒 / 已断货 筛选
 * 操作: + 入库 / 单 SKU 进详情看流水 + 盘点 / 报损
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { BottomNav, Chip } from '@/components/v2'

type Item = {
  id: string; code: string; name: string; spec: string | null; unit: string
  category: string; stock: number; minStock: number; price: number
  shelfDays: number | null
  statusFlag: 'OUT' | 'LOW' | 'OK'
  in7d: number; out7d: number; in30d: number; out30d: number
  nearestExpiry: string | null; daysToExpiry: number | null
}
type Summary = { totalSku: number; lowStock: number; outOfStock: number; totalValue: number }

const STATUS_LABEL: Record<string, string> = { OUT: '已断货', LOW: '低于警戒', OK: '充足' }
const STATUS_TONE: Record<string, 'red'|'orange'|'green'|'gray'> = { OUT: 'red', LOW: 'orange', OK: 'green' }

export default function InventoryPage() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [filter, setFilter] = useState<'all'|'low'|'out'>('all')
  const [searchQ, setSearchQ] = useState('')
  const [error, setError] = useState<string | null>(null)

  function load() {
    apiFetch<Item[]>('/api/supplier/stock').then(setItems).catch(e => setError(e.message))
    apiFetch<Summary>('/api/supplier/stock/summary').then(setSummary).catch(() => {})
  }
  useEffect(() => { load() }, [])

  // 模糊匹配: name + spec + code, 多关键字 AND (跟选品抽屉一致风格)
  function matchesQuery(i: Item, q: string) {
    if (!q.trim()) return true
    const hay = `${i.name} ${i.spec || ''} ${i.code || ''}`.toLowerCase()
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))
  }

  const visible = !items ? [] : items.filter(i => {
    if (filter === 'low' && i.statusFlag !== 'LOW') return false
    if (filter === 'out' && i.statusFlag !== 'OUT') return false
    if (!matchesQuery(i, searchQ)) return false
    return true
  })

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <h1 className="text-h1 flex-1">库存</h1>
        <a href="/v2/supplier/inventory/import" className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2">↥ 导入清单</a>
        <a href="/v2/supplier/inventory/inbound" className="px-3 py-2 bg-amber text-white rounded-cta text-button">↓ 入库</a>
      </header>

      {/* KPI */}
      {summary && (
        <div className="px-4 grid grid-cols-2 gap-2">
          <div className="bg-white rounded-card border border-border p-3">
            <div className="text-micro text-gray3">总 SKU</div>
            <div className="text-h1 font-num">{summary.totalSku}</div>
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <div className="text-micro text-gray3">库存总价值</div>
            <div className="text-h1 font-num">¥{summary.totalValue.toLocaleString()}</div>
          </div>
          <div className={`rounded-card border p-3 ${summary.lowStock > 0 ? 'bg-amber/10 border-amber/30' : 'bg-white border-border'}`}>
            <div className="text-micro text-gray3">低于警戒</div>
            <div className="text-h1 font-num text-amber-fg">{summary.lowStock}</div>
          </div>
          <div className={`rounded-card border p-3 ${summary.outOfStock > 0 ? 'bg-red-bg border-red/30' : 'bg-white border-border'}`}>
            <div className="text-micro text-gray3">已断货</div>
            <div className="text-h1 font-num text-red-fg">{summary.outOfStock}</div>
          </div>
        </div>
      )}

      {/* 搜索栏 — 客户反馈: 库存 SKU 多, 直接翻不方便 */}
      <div className="px-4 mt-3">
        <div className="relative">
          <input
            type="search"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder="搜索 名称 / 规格 / 编码"
            className="w-full bg-white border border-border rounded-card pl-9 pr-9 py-2 text-body outline-none focus:border-amber"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray3 text-caption pointer-events-none">🔍</span>
          {searchQ && (
            <button
              type="button"
              onClick={() => setSearchQ('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray5 text-gray2 text-caption flex items-center justify-center"
              aria-label="清除搜索"
            >×</button>
          )}
        </div>
      </div>

      {/* Filter */}
      <div className="px-4 mt-3 flex gap-2">
        {([['all','全部'],['low','低于警戒'],['out','已断货']] as const).map(([k,l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-full text-caption ${filter===k?'bg-ink text-white':'bg-white border border-border text-gray2'}`}>
            {l}
          </button>
        ))}
        {searchQ && (
          <span className="text-caption text-gray3 ml-auto self-center">匹配 {visible.length} 项</span>
        )}
      </div>

      {/* List */}
      <div className="px-4 mt-3">
        {error && <div className="bg-red-bg text-red-fg rounded p-3 text-caption">{error}</div>}
        {items === null && <div className="text-caption text-gray3 text-center py-8">加载中…</div>}
        {items !== null && visible.length === 0 && (
          <div className="bg-white rounded-card border border-border p-8 text-center text-caption text-gray3">
            {filter === 'all' && !searchQ ? '暂无 SKU. 先去 商品报价表 添加商品' : '没有符合的商品'}
          </div>
        )}
        <ul className="space-y-2">
          {visible.map(i => (
            <li key={i.id} className="bg-white rounded-card border border-border p-3">
              <a href={`/v2/supplier/inventory/${i.id}`} className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-h2 truncate">{i.name}</span>
                    <Chip tone={STATUS_TONE[i.statusFlag]}>{STATUS_LABEL[i.statusFlag]}</Chip>
                  </div>
                  <div className="text-micro text-gray3 mt-0.5">
                    {i.spec ? `${i.spec} · ` : ''}#{i.code}
                    {i.shelfDays != null && <span className="ml-1.5">· 保质 {i.shelfDays}d</span>}
                  </div>
                  <div className="text-caption text-gray2 mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-num">
                    <span>近 7 日 <span className="text-green-fg">+{i.in7d}</span> / <span className="text-red-fg">-{i.out7d}</span></span>
                    {i.nearestExpiry && (
                      <span className={
                        i.daysToExpiry !== null && i.daysToExpiry < 0 ? 'text-red-fg' :
                        i.daysToExpiry !== null && i.daysToExpiry <= 7 ? 'text-amber-fg' : 'text-gray3'
                      }>
                        最近到期 {i.nearestExpiry}
                        {i.daysToExpiry !== null && (
                          i.daysToExpiry < 0 ? ` (已过期 ${-i.daysToExpiry}d)` :
                          i.daysToExpiry <= 7 ? ` (${i.daysToExpiry}d 内过期)` : ''
                        )}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-h1 font-num ${i.statusFlag==='OUT'?'text-red-fg':i.statusFlag==='LOW'?'text-amber-fg':'text-ink'}`}>
                    {i.stock}
                  </div>
                  <div className="text-micro text-gray3">{i.unit} · 警戒 {i.minStock}</div>
                </div>
                <span className="text-gray3 self-center">›</span>
              </a>
            </li>
          ))}
        </ul>
      </div>

      <BottomNav
        tabs={[
          { key: 'home',    label: '首页', icon: '⌂' },
          { key: 'orders',  label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me',      label: '我的', icon: '◐' },
        ]}
        activeKey="inventory"
        onChange={(k) => {
          if (k === 'home') location.href = '/v2/supplier/home'
          if (k === 'orders') location.href = '/v2/supplier/orders'
          if (k === 'billing') location.href = '/v2/supplier/billing'
          if (k === 'me') location.href = '/v2/supplier/history'
        }}
      />
    </div>
  )
}
