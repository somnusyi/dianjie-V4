/**
 * 厨师长 · 每日消耗视图 (chef/inventory 页内 Tab)
 * 数据源: GET /api/stores/:storeId/consumption/daily(+/:productId)
 * 口径: 消耗仅含已发布 BOM 的菜品扣减与门店报损; 日报未确认的日期无数据。
 */
'use client'
import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { EmptyState, SkeletonCard, FriendlyError } from '@/components/v2/skeleton'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { formatQuantity } from '@/lib/format'

type DailyItem = {
  productId: string
  code: string
  name: string
  spec: string | null
  unit: string
  qty: number
  cost: number
  dishCount: number
  prev7AvgQty: number | null
  changePct: number | null
}

type DailyResponse = { date: string; totalCost: number; items: DailyItem[] }

type DetailRow = {
  key: string
  dishId: string | null
  dishName: string | null
  manual: boolean
  qty: number
  cost: number
}

type DetailResponse = {
  date: string
  product: { id: string; code: string; name: string; spec: string | null; unit: string }
  rows: DetailRow[]
}

function todayText() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shiftDay(date: string, delta: number) {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + delta)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const money = (n: number) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function ChefConsumptionView() {
  const [storeId] = useState<string | null>(() => {
    const u = getUser()
    return u?.storeId || u?.store?.id || null
  })
  const [date, setDate] = useState(todayText())
  const [daily, setDaily] = useState<DailyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    if (!storeId) { setError('未绑定门店'); return }
    let cancelled = false
    setDaily(null)
    setError(null)
    setExpanded(null)
    setDetail(null)
    apiFetch<DailyResponse>(`/api/stores/${storeId}/consumption/daily?date=${date}`)
      .then(result => { if (!cancelled) setDaily(result) })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [storeId, date])

  const toggleDetail = (productId: string) => {
    if (expanded === productId) {
      setExpanded(null)
      setDetail(null)
      return
    }
    setExpanded(productId)
    setDetail(null)
    setDetailLoading(true)
    apiFetch<DetailResponse>(`/api/stores/${storeId}/consumption/daily/${productId}?date=${date}`)
      .then(result => setDetail(result))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false))
  }

  const today = todayText()

  return (
    <div>
      {/* 日期选择: 默认今天, 可前后翻页或直接选 */}
      <div className="px-4 mt-3 flex items-center gap-2">
        <button
          type="button"
          aria-label="前一天"
          onClick={() => setDate(shiftDay(date, -1))}
          className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center text-gray2"
        >‹</button>
        <input
          type="date"
          value={date}
          max={today}
          onChange={e => e.target.value && setDate(e.target.value)}
          className="flex-1 h-9 px-3 rounded-cta bg-white border border-border text-body font-num"
        />
        <button
          type="button"
          aria-label="后一天"
          disabled={date >= today}
          onClick={() => setDate(shiftDay(date, 1))}
          className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center text-gray2 disabled:opacity-40"
        >›</button>
        {date !== today && (
          <button type="button" onClick={() => setDate(today)} className="px-3 h-9 rounded-cta bg-bg text-button text-gray2 shrink-0">回今天</button>
        )}
      </div>

      {error && <div className="px-4 mt-3"><FriendlyError message={error} /></div>}
      {!daily && !error && (
        <div className="px-4 mt-3 space-y-2">
          {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
        </div>
      )}

      {daily && daily.items.length === 0 && !error && (
        <div className="px-4 mt-4">
          <EmptyState icon="🥬" title="该日暂无消耗数据" hint="日报未确认或当天无 BOM 扣减与报损" />
        </div>
      )}

      {daily && daily.items.length > 0 && (
        <>
          <div className="px-4 mt-3 flex items-baseline justify-between">
            <span className="text-caption text-gray2">合计消耗金额</span>
            <span className="font-num text-h2 font-semibold">{money(daily.totalCost)}</span>
          </div>
          <ul className="mx-4 mt-2 bg-white rounded-card border border-border divide-y divide-border">
            {daily.items.map(item => {
              const open = expanded === item.productId
              return (
                <li key={item.productId}>
                  <button
                    type="button"
                    onClick={() => toggleDetail(item.productId)}
                    className="w-full px-3 py-3 flex items-center gap-3 text-left hover:bg-bg-warm"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-body truncate">{item.name}</div>
                      <div className="text-micro text-gray3 truncate">
                        {item.spec || item.code}
                        {item.dishCount > 0 ? ` · ${item.dishCount} 个菜品` : ''}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-num text-body">{formatQuantity(item.qty, item.unit)}</div>
                      <div className="text-micro text-gray3 font-num">{money(item.cost)}</div>
                    </div>
                    <ChangeBadge changePct={item.changePct} />
                    <span className="text-gray3 shrink-0">{open ? '▾' : '›'}</span>
                  </button>
                  {open && (
                    <div className="bg-bg/50 border-t border-border px-3 py-2">
                      {detailLoading && <p className="text-micro text-gray3 py-1">明细加载中…</p>}
                      {!detailLoading && !detail && <p className="text-micro text-gray3 py-1">明细加载失败</p>}
                      {!detailLoading && detail && detail.rows.length === 0 && (
                        <p className="text-micro text-gray3 py-1">无明细行</p>
                      )}
                      {!detailLoading && detail && detail.rows.length > 0 && (
                        <ul className="divide-y divide-border">
                          {detail.rows.map(row => (
                            <li key={row.key} className="py-2 flex items-center gap-2">
                              {row.manual
                                ? <Chip tone="orange">人工报损</Chip>
                                : <span className="text-body flex-1 min-w-0 truncate">{row.dishName || '其他扣减'}</span>}
                              {row.manual && <span className="flex-1" />}
                              <span className="font-num text-caption text-gray2 shrink-0">{formatQuantity(row.qty, detail.product.unit)}</span>
                              <span className="font-num text-caption shrink-0 w-20 text-right">{money(row.cost)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      <p className="px-4 mt-3 text-micro text-gray3">
        消耗仅含已发布 BOM 的菜品扣减与门店报损；日报未确认的日期无数据
      </p>
    </div>
  )
}

/** 较 7 日均值环比: 升红降绿 (消耗上升=成本压力) */
function ChangeBadge({ changePct }: { changePct: number | null }) {
  if (changePct === null) return <span className="text-micro text-gray3 shrink-0 w-14 text-right">—</span>
  const tone = changePct > 0 ? 'text-red-fg' : changePct < 0 ? 'text-green-fg' : 'text-gray3'
  const arrow = changePct > 0 ? '↑' : changePct < 0 ? '↓' : '→'
  return (
    <span className={`text-micro font-num font-medium shrink-0 w-14 text-right ${tone}`}>
      {arrow}{Math.abs(changePct).toFixed(0)}%
    </span>
  )
}
