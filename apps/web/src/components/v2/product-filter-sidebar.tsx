/**
 * 供应商商品工作台 · 桌面端左侧分类/状态筛选栏
 *
 * 与 apps/web/src/app/v2/supplier/products/page.tsx 配套使用。
 * 仅做展示与筛选切换，不触碰审批、库存、订单等业务规则。
 */
'use client'
import React from 'react'

export type FilterProduct = { status: string }
export type FilterCategory = { name: string; count: number }

type ProductFilterSidebarProps = {
  products: FilterProduct[]
  categories: FilterCategory[]
  categoryFilter: string
  statusFilter: string
  onCategoryChange: (category: string) => void
  onStatusChange: (status: string) => void
  onClear: () => void
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'ENABLED', label: '供应中' },
  { value: 'PENDING_APPROVAL', label: '上架待审' },
  { value: 'PENDING_DISABLE', label: '停售待审' },
  { value: 'DISABLED', label: '已停售' },
]

export function ProductFilterSidebar({
  products,
  categories,
  categoryFilter,
  statusFilter,
  onCategoryChange,
  onStatusChange,
  onClear,
}: ProductFilterSidebarProps) {
  const total = products.length
  const statusCounts = React.useMemo(() => {
    const map: Record<string, number> = {}
    products.forEach(p => {
      map[p.status] = (map[p.status] || 0) + 1
    })
    return map
  }, [products])

  const hasFilter = Boolean(categoryFilter || statusFilter)

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-4 space-y-4 pl-4">
        <div className="bg-bg-card border border-border rounded-card p-3">
          <h2 className="text-h2 text-ink mb-2">分类</h2>
          <ul className="space-y-1">
            <li>
              <FilterButton
                label="全部"
                count={total}
                selected={!categoryFilter}
                onClick={() => onCategoryChange('')}
              />
            </li>
            {categories.map(category => (
              <li key={category.name}>
                <FilterButton
                  label={category.name || '其他'}
                  count={category.count}
                  selected={categoryFilter === category.name}
                  onClick={() => onCategoryChange(category.name)}
                />
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-bg-card border border-border rounded-card p-3">
          <h2 className="text-h2 text-ink mb-2">状态</h2>
          <ul className="space-y-1">
            {STATUS_OPTIONS.map(option => (
              <li key={option.value || 'all'}>
                <FilterButton
                  label={option.label}
                  count={option.value ? statusCounts[option.value] || 0 : total}
                  selected={statusFilter === option.value}
                  onClick={() => onStatusChange(option.value)}
                />
              </li>
            ))}
          </ul>
        </div>

        {hasFilter && (
          <button
            type="button"
            onClick={onClear}
            className="w-full py-2 rounded-cta bg-white border border-border text-button text-gray2 hover:bg-bg transition"
          >
            清除筛选
          </button>
        )}
      </div>
    </aside>
  )
}

function FilterButton({
  label,
  count,
  selected,
  onClick,
}: {
  label: string
  count: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`w-full flex items-center justify-between rounded-cta px-2 py-1.5 text-caption transition ${
        selected
          ? 'bg-accent text-white'
          : 'text-ink hover:bg-bg'
      }`}
    >
      <span className="truncate">{label}</span>
      <span className={`ml-2 shrink-0 font-num ${selected ? 'text-white/90' : 'text-gray3'}`}>
        {count}
      </span>
    </button>
  )
}
