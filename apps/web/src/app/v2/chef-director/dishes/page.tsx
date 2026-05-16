/**
 * 总厨 · 菜品管理 (BOM 主入口)
 * 列表 + 状态/分类筛选 + 毛利率显示
 */
'use client'
import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Dish = {
  id: string; name: string; code?: string | null
  category?: string | null; unit: string; salePrice: string
  status: 'ACTIVE' | 'DISABLED' | 'UPCOMING'
  foodCost?: number; grossProfit?: number; grossMargin?: number
  recipes?: any[]
}

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '在售', DISABLED: '已停', UPCOMING: '研发中',
}
const STATUS_TONE: Record<string, 'green' | 'gray' | 'amber'> = {
  ACTIVE: 'green', DISABLED: 'gray', UPCOMING: 'amber',
}

function fmt(n: number, d = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

export default function DishesPage() {
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('ACTIVE')
  const [category, setCategory] = useState<string>('all')

  async function reload() {
    setDishes(null)
    try {
      const d = await apiFetch<Dish[]>(`/api/dishes?status=${status}&category=${category}&withCost=1`)
      setDishes(d)
    } catch (e: any) { setError(e.message) }
  }
  useEffect(() => { reload() }, [status, category])

  if (error) return <ErrorScreen message={error} />

  const list = dishes || []
  const categories = ['all', ...Array.from(new Set(list.map(d => d.category || '未分类')))]
  const totalDishes = list.length
  const noBOM = list.filter(d => !d.recipes?.length).length

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">菜品 / 配方</h1>
          <p className="text-caption text-gray3">维护菜品 BOM, 算成本和毛利</p>
        </div>
        <a href="/v2/chef-director/dishes/new" className="px-3 py-2 bg-ink text-white rounded-cta text-button">+ 新建</a>
      </header>

      {/* 状态筛选 */}
      <div className="px-4 mt-3 flex gap-1.5 overflow-x-auto">
        {['ACTIVE', 'UPCOMING', 'DISABLED'].map(s => (
          <button key={s} onClick={() => setStatus(s)}
                  className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${status === s ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {/* 分类 chips */}
      {categories.length > 2 && (
        <div className="px-4 mt-2 flex gap-1.5 overflow-x-auto">
          {categories.map(c => (
            <button key={c} onClick={() => setCategory(c)}
                    className={`shrink-0 px-3 py-1 rounded-chip text-caption ${category === c ? 'bg-amber text-white' : 'bg-bg text-gray2'}`}>
              {c === 'all' ? '全部' : c}
            </button>
          ))}
        </div>
      )}

      {/* hero */}
      <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-3 grid grid-cols-2 gap-2 text-caption">
        <div><div className="text-gray3">本类菜品</div><div className="text-h2 font-num">{totalDishes}</div></div>
        <div><div className="text-gray3">缺配方</div><div className={`text-h2 font-num ${noBOM > 0 ? 'text-red-fg' : ''}`}>{noBOM}</div></div>
      </div>

      {dishes === null && <p className="text-caption text-gray3 text-center mt-12">加载中…</p>}
      {dishes !== null && list.length === 0 && (
        <div className="mx-4 mt-6 bg-white rounded-card border border-border p-6 text-center">
          <p className="text-h2 text-gray3 mb-2">暂无菜品</p>
          <p className="text-caption text-gray3 mb-3">点右上「+ 新建」开始</p>
        </div>
      )}

      <ul className="px-4 mt-3 space-y-2">
        {list.map(d => {
          const hasBOM = (d.recipes?.length || 0) > 0
          const margin = d.grossMargin || 0
          const marginTone: any = margin >= 0.6 ? 'green' : margin >= 0.4 ? 'amber' : 'red'
          return (
            <li key={d.id}>
              <a href={`/v2/chef-director/dishes/${d.id}`}
                 className="block bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Chip>
                  {d.category && <span className="text-micro text-gray3">{d.category}</span>}
                  {!hasBOM && <Chip tone="red">缺配方</Chip>}
                  {hasBOM && <Chip tone={marginTone}>毛利 {(margin * 100).toFixed(0)}%</Chip>}
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-h2 truncate flex-1">{d.name}</span>
                  <span className="font-num text-h2 shrink-0">¥{fmt(Number(d.salePrice))}</span>
                </div>
                {hasBOM && (
                  <p className="text-micro text-gray3 mt-0.5">
                    成本 ¥{fmt(d.foodCost || 0)} · 毛利 ¥{fmt(d.grossProfit || 0)}
                  </p>
                )}
                {!hasBOM && (
                  <p className="text-micro text-amber-fg mt-0.5">未录配方 — 点进去配 ›</p>
                )}
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
