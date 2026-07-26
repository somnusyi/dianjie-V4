/**
 * 内部供应链 · 订货单查询（桌面端 · 只读）
 *
 * 消费 /api/orders 分页列表；筛选全部由服务端执行。
 * 不提供任何写操作按钮；不展示财务/应付/银行/营业额/成本率字段。
 */
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Chip } from '@/components/v2'
import { OrderCenterTabs } from '@/components/v2/order-center-tabs'
import { EmptyState, FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'
import {
  buildOrderQuery,
  DEFAULT_ORDER_FILTERS,
  formatOrderStatusLabel,
  hasActiveOrderFilters,
  keepOrderFiltersForPage,
  orderDeliveryDateText,
  orderDeliveryPaginationRange,
  orderDeliveryTotalPages,
  orderItemSummary,
  orderStatusTone,
  projectOrderRow,
  resetOrderFilterPage,
  validateOrderDeliveryDateRange,
  type OrderFilters,
  ORDER_STATUS_OPTIONS,
  PAGE_SIZE_OPTIONS,
} from '@/lib/supply-order-delivery-pc'

type Store = { id: string; no: string; name: string }

type ProjectedOrder = ReturnType<typeof projectOrderRow>

export default function InternalSupplyChainOrdersPage() {
  const [orders, setOrders] = useState<ProjectedOrder[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<OrderFilters>(DEFAULT_ORDER_FILTERS)
  const [draftFilters, setDraftFilters] = useState<OrderFilters>(DEFAULT_ORDER_FILTERS)
  const [stores, setStores] = useState<Store[]>([])
  const [dateError, setDateError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    apiFetch<{ items: Store[] } | Store[]>('/api/stores')
      .then(data => {
        if (!alive) return
        const list = Array.isArray(data) ? data : data.items || []
        setStores(list.map((s: any) => ({ id: s.id, no: s.no, name: s.name })))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller

    setLoading(true)
    setError(null)
    apiFetch<{ items: any[]; total: number; page: number; pageSize: number }>(
      `/api/orders${buildOrderQuery(filters)}`,
      { signal: controller.signal },
    )
      .then(data => {
        if (controller.signal.aborted) return
        setOrders((data.items || []).map(projectOrderRow))
        setTotal(data.total || 0)
      })
      .catch(reason => {
        if (controller.signal.aborted) return
        setError(String(reason?.message || reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => {
      controller.abort()
    }
  }, [filters])

  const totalPages = useMemo(() => orderDeliveryTotalPages(total, filters.pageSize), [total, filters.pageSize])
  const range = useMemo(() => orderDeliveryPaginationRange(filters.page, filters.pageSize, total), [filters.page, filters.pageSize, total])
  const filterActive = hasActiveOrderFilters(draftFilters)

  function updateDraftFilters(changes: Partial<OrderFilters>) {
    const nextDateFrom = changes.dateFrom !== undefined ? changes.dateFrom : draftFilters.dateFrom
    const nextDateTo = changes.dateTo !== undefined ? changes.dateTo : draftFilters.dateTo
    setDraftFilters(current => resetOrderFilterPage(current, changes))
    setDateError(validateOrderDeliveryDateRange(nextDateFrom, nextDateTo))
  }

  function applyFilters() {
    const validationError = validateOrderDeliveryDateRange(draftFilters.dateFrom, draftFilters.dateTo)
    setDateError(validationError)
    if (validationError) return
    setFilters({
      ...draftFilters,
      keyword: draftFilters.keyword.trim(),
      page: 1,
    })
  }

  function clearFilters() {
    const cleared = { ...DEFAULT_ORDER_FILTERS }
    setDraftFilters(cleared)
    setFilters(cleared)
    setDateError(null)
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="green">内部只读</Chip>
            <span className="text-caption text-gray3">订货单查询 · 跨店</span>
          </div>
          <h1 className="text-h1">订货单查询</h1>
          <p className="mt-1 text-caption text-gray2">
            {orders ? `${total} 条订货记录` : '加载中…'}
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px]">
        <OrderCenterTabs />
        <div className="flex flex-wrap items-end gap-3 py-4">
          <FilterInput
            label="关键字"
            value={draftFilters.keyword}
            onChange={value => updateDraftFilters({ keyword: value })}
            placeholder="订单号 / 门店 / 商品名称 / 编码 / 规格"
          />
          <FilterSelect
            label="门店"
            value={draftFilters.storeId}
            onChange={value => updateDraftFilters({ storeId: value })}
          >
            <option value="">全部门店</option>
            {stores.map(store => (
              <option key={store.id} value={store.id}>{store.no} · {store.name}</option>
            ))}
          </FilterSelect>
          <FilterInput
            label="开始日期"
            type="date"
            value={draftFilters.dateFrom}
            onChange={value => updateDraftFilters({ dateFrom: value })}
          />
          <FilterInput
            label="结束日期"
            type="date"
            value={draftFilters.dateTo}
            onChange={value => updateDraftFilters({ dateTo: value })}
          />
          <FilterSelect
            label="状态"
            value={draftFilters.status}
            onChange={value => updateDraftFilters({ status: value as OrderFilters['status'] })}
          >
            <option value="">全部状态</option>
            {ORDER_STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="每页"
            value={String(draftFilters.pageSize)}
            onChange={value => updateDraftFilters({ pageSize: Number(value) })}
          >
            {PAGE_SIZE_OPTIONS.map(size => (
              <option key={size} value={String(size)}>{size} 条</option>
            ))}
          </FilterSelect>
          <button
            onClick={applyFilters}
            disabled={Boolean(dateError)}
            className="rounded-cta bg-accent px-4 py-2 text-button text-white disabled:opacity-40"
          >查询</button>
          <button
            onClick={clearFilters}
            disabled={!filterActive}
            className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2 disabled:opacity-40"
          >清空</button>
        </div>

        {dateError && (
          <div className="mb-4 rounded-card border border-red-fg/20 bg-red-bg px-4 py-3 text-caption text-red-fg">
            {dateError}
          </div>
        )}

        {error && <div className="mb-4"><FriendlyError message={error} onRetry={() => setFilters(current => ({ ...current }))} /></div>}

        {!orders && !error && <div className="space-y-2">{[1, 2, 3].map(i => <SkeletonCard key={i} />)}</div>}

        {orders && orders.length === 0 && !loading && (
          <EmptyState
            icon="📋"
            title={filterActive ? '没有匹配的订货记录' : '暂无订货记录'}
            hint={filterActive ? '尝试调整筛选条件' : '订货单将在门店提交后出现'}
          />
        )}

        {orders && orders.length > 0 && (
          <div className="overflow-hidden rounded-card border border-border bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-caption">
                <thead className="bg-bg text-gray3">
                  <tr>
                    <th className="px-4 py-3">订货单号</th>
                    <th className="px-4 py-3">门店</th>
                    <th className="px-4 py-3">供应商</th>
                    <th className="px-4 py-3">创建日期</th>
                    <th className="px-4 py-3">期望到货日</th>
                    <th className="px-4 py-3">状态</th>
                    <th className="px-4 py-3">商品摘要</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {orders.map(order => (
                    <tr key={order.id} className="hover:bg-bg/50">
                      <td className="px-4 py-3 font-num"><b>{order.no}</b></td>
                      <td className="px-4 py-3 text-gray2">{order.store?.name || '—'}</td>
                      <td className="px-4 py-3 text-gray2">{order.supplier?.name || '—'}</td>
                      <td className="px-4 py-3 font-num text-gray2">{orderDeliveryDateText(order.createdAt)}</td>
                      <td className="px-4 py-3 font-num text-gray2">{orderDeliveryDateText(order.expectedDeliveryDate)}</td>
                      <td className="px-4 py-3"><Chip tone={orderStatusTone(order.status)}>{formatOrderStatusLabel(order.status)}</Chip></td>
                      <td className="px-4 py-3 text-gray2">{orderItemSummary(order)}</td>
                      <td className="px-4 py-3 text-right">
                        <a href={`/v2/supply-chain/fulfillment/${order.id}`} className="text-button text-amber-fg">查看履约 ›</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {total > 0 && (
          <div className="flex items-center justify-between py-4 text-caption text-gray2">
            <span>第 {range.start}–{range.end} 项，共 {total} 项</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFilters(current => keepOrderFiltersForPage(current, filters.page - 1))}
                disabled={filters.page <= 1}
                className="rounded-cta border border-border bg-white px-3 py-1.5 text-button disabled:opacity-40"
              >上一页</button>
              <span className="font-num">{filters.page} / {totalPages}</span>
              <button
                onClick={() => setFilters(current => keepOrderFiltersForPage(current, filters.page + 1))}
                disabled={filters.page >= totalPages}
                className="rounded-cta border border-border bg-white px-3 py-1.5 text-button disabled:opacity-40"
              >下一页</button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function FilterInput({ label, value, onChange, placeholder, type = 'search' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro text-gray3">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 min-w-44 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent"
      />
    </label>
  )
}

function FilterSelect({ label, value, onChange, children }: {
  label: string; value: string; onChange: (v: string) => void; children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro text-gray3">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-10 min-w-36 rounded-cta border border-border bg-white px-3 text-body"
      >
        {children}
      </select>
    </label>
  )
}
