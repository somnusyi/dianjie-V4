/**
 * 内部供应链 · 供货关系总表（桌面端）
 *
 * 回答三个问题：这家供应商可供哪些商品？这个商品能向谁采购？哪些商品还没绑来源？
 * 数据来自 ProductUpstreamSource（与商品页「采购来源」、供应商页「供货商品」同一张表）。
 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { ProductToolTabs } from '@/components/v2/product-tool-tabs'
import { EmptyState, FriendlyError, SkeletonList } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'
import {
  categoriesOfProducts,
  filterRelations,
  filterUnboundProducts,
  groupRelationsByProduct,
  groupRelationsBySupplier,
  groupUnboundByCategory,
  type RelationFilter,
  type SupplyRelation,
  type UnboundProduct,
} from '@/lib/supply-relations'

type View = 'supplier' | 'product' | 'unbound'

const VIEW_LABEL: Record<View, string> = {
  supplier: '按供应商',
  product: '按商品',
  unbound: '未绑定清单',
}

function formatPrice(value: number | null): string {
  return value === null ? '—' : `¥${value.toFixed(2)}`
}

export default function SupplyRelationsPage() {
  const [relations, setRelations] = useState<SupplyRelation[] | null>(null)
  const [unbound, setUnbound] = useState<UnboundProduct[] | null>(null)
  const [view, setView] = useState<View>('supplier')
  const [filter, setFilter] = useState<RelationFilter>({ q: '', category: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  function load() {
    setLoading(true)
    setError(null)
    Promise.all([
      apiFetch<SupplyRelation[]>('/api/upstream-relations'),
      apiFetch<UnboundProduct[]>('/api/upstream-relations/unbound'),
    ])
      .then(([rows, unboundRows]) => {
        setRelations(Array.isArray(rows) ? rows : [])
        setUnbound(Array.isArray(unboundRows) ? unboundRows : [])
      })
      .catch(reason => setError(String(reason?.message || reason)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const filteredRelations = useMemo(
    () => filterRelations(relations ?? [], filter),
    [relations, filter],
  )
  const supplierGroups = useMemo(() => groupRelationsBySupplier(filteredRelations), [filteredRelations])
  const productGroups = useMemo(() => groupRelationsByProduct(filteredRelations), [filteredRelations])
  const filteredUnbound = useMemo(
    () => filterUnboundProducts(unbound ?? [], filter),
    [unbound, filter],
  )
  const unboundGroups = useMemo(() => groupUnboundByCategory(filteredUnbound), [filteredUnbound])
  const categoryOptions = useMemo(() => {
    const fromRelations = (relations ?? []).map(row => ({ category: row.product?.category ?? null }))
    return categoriesOfProducts([...fromRelations, ...(unbound ?? [])])
  }, [relations, unbound])

  return (
    <div className="min-h-screen bg-bg pb-16">
      <header className="mx-auto flex max-w-[1440px] items-end justify-between px-6 pt-6">
        <div>
          <div className="text-caption text-gray3">商品 ↔ 上游供应商 · 供货关系全览</div>
          <h1 className="text-h1">供货关系</h1>
          <p className="mt-1 text-caption text-gray2">
            {relations && unbound
              ? `${relations.length} 条生效绑定 · ${unbound.length} 个商品尚未维护来源`
              : '加载中…'}
          </p>
        </div>
        <a href="/v2/supply-chain/home" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button text-gray2">← 返回工作台</a>
      </header>

      <main className="mx-auto max-w-[1440px] px-6">
        <ProductToolTabs />
        <nav aria-label="供货关系视角" className="my-4 inline-flex flex-wrap rounded-cta border border-border bg-white p-0.5">
          {(Object.keys(VIEW_LABEL) as View[]).map(key => (
            <button
              key={key}
              onClick={() => setView(key)}
              aria-pressed={view === key}
              className={`rounded-cta px-3 py-1.5 text-caption ${
                view === key ? 'bg-ink text-white' : 'text-gray2'
              }`}
            >
              {VIEW_LABEL[key]}
              {key === 'unbound' && unbound && unbound.length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber px-1.5 py-0.5 text-micro text-white">{unbound.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex flex-wrap items-end gap-3 py-4">
          <label className="flex flex-col gap-1">
            <span className="text-micro text-gray3">关键字</span>
            <input
              value={filter.q}
              onChange={e => setFilter(current => ({ ...current, q: e.target.value }))}
              placeholder="商品名 / 编码 / 供应商名"
              className="rounded-cta border border-border bg-white px-3 py-2 text-body outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-micro text-gray3">分类</span>
            <select
              value={filter.category}
              onChange={e => setFilter(current => ({ ...current, category: e.target.value }))}
              className="rounded-cta border border-border bg-white px-3 py-2 text-body outline-none"
            >
              <option value="">全部分类</option>
              {categoryOptions.map(category => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
        </div>

        {error && <div className="mb-4"><FriendlyError message={error} onRetry={load} /></div>}
        {loading && !relations && <SkeletonList count={5} />}

        {!loading && relations && view === 'supplier' && (
          supplierGroups.length === 0 ? (
            <EmptyState icon="🔗" title="暂无供货关系" hint="到「供应商管理 → 供货商品」批量绑定，或在商品页维护采购来源" />
          ) : (
            <div className="space-y-4">
              {supplierGroups.map(group => (
                <section key={group.supplier.id} className="overflow-hidden rounded-card border border-border bg-white">
                  <header className="flex items-center justify-between border-b border-border bg-bg px-4 py-3">
                    <div>
                      <b className="text-button">{group.supplier.name}</b>
                      <span className="ml-2 font-num text-micro text-gray3">{group.supplier.no}</span>
                      {group.supplier.status !== 'ENABLED' && <Chip tone="red">已停用</Chip>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-micro text-gray3">{group.rows.length} 个商品</span>
                      <a
                        href={`/v2/supply-chain/suppliers/${group.supplier.id}/products`}
                        className="text-button text-accent"
                      >管理供货商品 →</a>
                    </div>
                  </header>
                  <RelationTable rows={group.rows} show="product" />
                </section>
              ))}
            </div>
          )
        )}

        {!loading && relations && view === 'product' && (
          productGroups.length === 0 ? (
            <EmptyState icon="🔍" title="没有匹配的商品" hint="调整筛选条件，或到未绑定清单查看还没来源的商品" />
          ) : (
            <div className="overflow-hidden rounded-card border border-border bg-white">
              <table className="w-full text-left text-caption">
                <thead className="bg-bg text-gray3">
                  <tr>
                    <th className="px-4 py-3">商品</th>
                    <th className="px-4 py-3">分类</th>
                    <th className="px-4 py-3">供应商</th>
                    <th className="px-4 py-3">采购单位</th>
                    <th className="px-4 py-3 text-right">协议价</th>
                    <th className="px-4 py-3">主供</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {productGroups.map(group => group.rows.map((row, index) => (
                    <tr key={row.id}>
                      {index === 0 && (
                        <td rowSpan={group.rows.length} className="border-r border-border px-4 py-3 align-top">
                          <b>{group.product.name}</b>
                          <div className="font-num text-micro text-gray3">{group.product.code}</div>
                        </td>
                      )}
                      {index === 0 && (
                        <td rowSpan={group.rows.length} className="border-r border-border px-4 py-3 align-top text-gray2">
                          {group.product.category || '其他'}
                        </td>
                      )}
                      <td className="px-4 py-3 text-gray2">{row.supplier?.name || '—'}</td>
                      <td className="px-4 py-3 text-gray2">{row.purchaseUnit}</td>
                      <td className="px-4 py-3 text-right font-num">{formatPrice(row.quotedUnitPrice)}</td>
                      <td className="px-4 py-3">{row.isPrimary ? <Chip tone="amber">主供</Chip> : <span className="text-gray3">备选</span>}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )
        )}

        {!loading && unbound && view === 'unbound' && (
          unboundGroups.length === 0 ? (
            <EmptyState icon="✅" title="全部商品都已维护采购来源" hint="新上架的商品会出现在这里提醒补录" />
          ) : (
            <div className="space-y-4">
              <div className="rounded-card border border-amber/30 bg-amber/10 px-4 py-3 text-caption text-amber-fg">
                这些商品总仓还不知道该向谁采购。点分类下的「去绑定」跳到供应商管理，选供应商后批量勾选绑定。
              </div>
              {unboundGroups.map(group => (
                <section key={group.category} className="overflow-hidden rounded-card border border-border bg-white">
                  <header className="flex items-center justify-between border-b border-border bg-bg px-4 py-3">
                    <b className="text-button">{group.category}</b>
                    <div className="flex items-center gap-3">
                      <span className="text-micro text-gray3">{group.rows.length} 个</span>
                      <a href="/v2/supply-chain/suppliers" className="text-button text-accent">去绑定 →</a>
                    </div>
                  </header>
                  <table className="w-full text-left text-caption">
                    <tbody className="divide-y divide-border">
                      {group.rows.map(product => (
                        <tr key={product.id}>
                          <td className="px-4 py-2.5"><b>{product.name}</b></td>
                          <td className="px-4 py-2.5 font-num text-gray3">{product.code}</td>
                          <td className="px-4 py-2.5 text-gray2">{product.spec || '—'}</td>
                          <td className="px-4 py-2.5 text-right font-num">{formatPrice(product.price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </div>
          )
        )}
      </main>
    </div>
  )
}

function RelationTable({ rows, show }: { rows: SupplyRelation[]; show: 'product' }) {
  void show
  return (
    <table className="w-full text-left text-caption">
      <thead className="bg-white text-gray3">
        <tr>
          <th className="px-4 py-2.5">商品编码</th>
          <th className="px-4 py-2.5">名称</th>
          <th className="px-4 py-2.5">分类</th>
          <th className="px-4 py-2.5">采购单位</th>
          <th className="px-4 py-2.5">换算比</th>
          <th className="px-4 py-2.5 text-right">协议价</th>
          <th className="px-4 py-2.5">主供</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map(row => (
          <tr key={row.id}>
            <td className="px-4 py-2.5 font-num text-gray2">{row.product?.code || '—'}</td>
            <td className="px-4 py-2.5"><b>{row.product?.name || '—'}</b></td>
            <td className="px-4 py-2.5 text-gray2">{row.product?.category || '其他'}</td>
            <td className="px-4 py-2.5 text-gray2">{row.purchaseUnit}</td>
            <td className="px-4 py-2.5 font-num text-gray2">×{row.inventoryUnitsPerPurchaseUnit}</td>
            <td className="px-4 py-2.5 text-right font-num">{formatPrice(row.quotedUnitPrice)}</td>
            <td className="px-4 py-2.5">{row.isPrimary ? <Chip tone="amber">主供</Chip> : <span className="text-gray3">备选</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
