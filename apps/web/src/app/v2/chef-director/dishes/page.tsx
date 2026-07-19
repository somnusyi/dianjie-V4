/**
 * 总厨 · 菜品管理 (BOM 主入口)
 * 列表 + 状态/分类筛选 + BOM 完整性显示
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
  inventoryPolicy: 'BOM' | 'EXCLUDE'
  recipes?: any[]
  activeBomVariants?: string[]
  hasAnyEffectiveBom?: boolean
  primaryBomVariant?: string
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

  async function reload(showLoading = true) {
    if (showLoading) setDishes(null)
    try {
      const d = await apiFetch<Dish[]>(`/api/dishes?status=${status}&category=${category}&withCost=1`)
      setDishes(d)
    } catch (e: any) { setError(e.message) }
  }
  useEffect(() => {
    void reload()
    // 从 BOM 详情页返回时，Safari / PWA 可能恢复旧页面而不重新挂载。
    // 在页面恢复、重新获得焦点或重新可见时静默刷新，避免已发布 BOM 仍显示“缺配方”。
    const refresh = () => { void reload(false) }
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('pageshow', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('pageshow', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [status, category])

  if (error) return <ErrorScreen message={error} />

  const list = dishes || []
  const categories = ['all', ...Array.from(new Set(list.map(d => d.category || '未分类')))]
  const totalDishes = list.length
  const noBOM = list.filter(d => d.inventoryPolicy === 'BOM' && !d.hasAnyEffectiveBom).length

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">菜品 / 配方</h1>
          <p className="text-caption text-gray3">维护菜品 BOM 与库存扣减规则</p>
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
          const hasDefaultBOM = (d.recipes?.length || 0) > 0
          const hasBOM = Boolean(d.hasAnyEffectiveBom)
          const excluded = d.inventoryPolicy === 'EXCLUDE'
          const variantQuery = !hasDefaultBOM && d.primaryBomVariant
            ? `?variant=${encodeURIComponent(d.primaryBomVariant)}`
            : ''
          return (
            <li key={d.id}>
              <a href={`/v2/chef-director/dishes/${d.id}${variantQuery}`}
                 className="block bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Chip>
                  {d.category && <span className="text-micro text-gray3">{d.category}</span>}
                  {!excluded && !hasBOM && <Chip tone="red">缺配方</Chip>}
                  {excluded && <Chip tone="gray">不扣库存</Chip>}
                  {hasDefaultBOM && <Chip tone="green">已配方</Chip>}
                  {!hasDefaultBOM && hasBOM && <Chip tone="amber">{d.activeBomVariants?.length || 0} 个规格 BOM</Chip>}
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-h2 truncate flex-1">{d.name}</span>
                  <span className="font-num text-h2 shrink-0">¥{fmt(Number(d.salePrice))}</span>
                </div>
                {hasDefaultBOM && <p className="text-micro text-gray3 mt-0.5">按已发布 BOM 扣减库存</p>}
                {!excluded && !hasBOM && (
                  <p className="text-micro text-amber-fg mt-0.5">未录配方 — 点进去配 ›</p>
                )}
                {!hasDefaultBOM && hasBOM && (
                  <p className="text-micro text-amber-fg mt-0.5">已有规格配方；没有默认兜底 BOM ›</p>
                )}
                {excluded && <p className="text-micro text-gray3 mt-0.5">纸巾、赠品等明确不参与食材扣减</p>}
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
