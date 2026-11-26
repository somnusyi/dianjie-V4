/**
 * 内部供应链 · 订货单查询（桌面端 · 只读）
 *
 * 消费 /api/orders 分页列表；筛选全部由服务端执行。
 * 不提供任何写操作按钮；不展示财务/应付/银行/营业额/成本率字段。
 */
'use client'
import { SearchableSelect } from '@/components/v2/searchable-select'

import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Chip } from '@/components/v2'
import { OrderCenterHorizontalTable } from '@/components/v2/order-center-horizontal-table'
import {
  OrderCenterResizableTable,
  type OrderCenterTableColumn,
} from '@/components/v2/order-center-resizable-table'
import { OrderCenterTabs } from '@/components/v2/order-center-tabs'
import { EmptyState, FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { apiDownload, apiFetch } from '@/lib/v2-auth'
import { storePrintIdentity } from '@/lib/store-print-identity'
import {
  buildOrderQuery,
  DEFAULT_ORDER_FILTERS,
  formatOrderStatusLabel,
  formatDeliveryStatusLabel,
  hasActiveOrderFilters,
  keepOrderFiltersForPage,
  orderDeliveryDateText,
  orderDateTimeText,
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

const ORDER_COLUMNS: readonly OrderCenterTableColumn<ProjectedOrder>[] = [
  {
    id: 'sequence',
    header: '序号',
    defaultWidth: 58,
    cellClassName: 'font-num text-gray3',
    renderCell: (_order, index) => index + 1,
  },
  {
    id: 'orderNo',
    header: '订货单号',
    defaultWidth: 238,
    cellClassName: 'font-num',
    renderCell: order => (
      <div>
        <b>{order.no}</b>
        {['CONFIRMED', 'DELIVERING', 'PENDING_CONFIRM', 'RECEIVED', 'COMPLETED'].includes(order.status) && (
          <a
            className="mt-1 block text-micro underline"
            href={`/v2/supply-chain/fulfillment/${order.id}/delivery-note`}
          >打印送货单 / PDF</a>
        )}
      </div>
    ),
  },
  {
    id: 'store',
    header: '门店',
    defaultWidth: 136,
    cellClassName: 'text-gray2',
    renderCell: order => order.store?.name || '—',
  },
  {
    id: 'supplier',
    header: '供应商',
    defaultWidth: 214,
    cellClassName: 'text-gray2',
    renderCell: order => order.supplier?.name || '—',
  },
  {
    id: 'createdAt',
    header: '创建日期',
    defaultWidth: 110,
    cellClassName: 'font-num text-gray2',
    renderCell: order => orderDeliveryDateText(order.createdAt),
  },
  {
    id: 'creationSource',
    header: '创建来源',
    defaultWidth: 128,
    cellClassName: 'text-gray2',
    renderCell: order => order.creationSource,
  },
  {
    id: 'creationType',
    header: '创建类型',
    defaultWidth: 105,
    cellClassName: 'text-gray2',
    renderCell: order => order.creationType,
  },
  {
    id: 'expectedDeliveryDate',
    header: '期望到货日',
    defaultWidth: 97,
    cellClassName: 'font-num text-gray2',
    renderCell: order => orderDeliveryDateText(order.expectedDeliveryDate),
  },
  {
    id: 'status',
    header: '状态',
    defaultWidth: 77,
    renderCell: order => <Chip tone={orderStatusTone(order.status)}>{formatOrderStatusLabel(order.status)}</Chip>,
  },
  {
    id: 'submittedAt',
    header: '提交时间',
    defaultWidth: 146,
    cellClassName: 'font-num text-gray2',
    renderCell: order => orderDateTimeText(order.submittedAt),
  },
  {
    id: 'splitAt',
    header: '分单时间',
    defaultWidth: 146,
    cellClassName: 'font-num text-gray2',
    renderCell: order => orderDateTimeText(order.splitAt),
  },
  {
    id: 'lastOperationAt',
    header: '操作时间',
    defaultWidth: 146,
    cellClassName: 'font-num text-gray2',
    renderCell: order => orderDateTimeText(order.lastOperationAt),
  },
  {
    id: 'note',
    header: '备注',
    defaultWidth: 180,
    cellClassName: 'text-gray2',
    renderCell: order => <span title={order.note || ''}>{order.note || '—'}</span>,
  },
  {
    id: 'printStatus',
    header: '打印状态',
    defaultWidth: 112,
    cellClassName: 'text-gray2',
    renderCell: order => order.printStatus,
  },
  {
    id: 'createdBy',
    header: '创建人',
    defaultWidth: 118,
    cellClassName: 'text-gray2',
    renderCell: order => order.createdBy?.name || '—',
  },
  {
    id: 'downstreamDocuments',
    header: '下游单据',
    defaultWidth: 240,
    cellClassName: 'text-gray2',
    renderCell: order => order.downstreamDocuments.length > 0
      ? <div className="flex flex-wrap gap-x-2 gap-y-1">{order.downstreamDocuments.map((delivery: { id: string; no: string; status: string }) => (
          <a
            key={delivery.id}
            href={`/v2/supply-chain/deliveries?keyword=${encodeURIComponent(delivery.no)}`}
            className="text-amber-fg underline decoration-dotted underline-offset-2"
          >{delivery.no} · {formatDeliveryStatusLabel(delivery.status)}</a>
        ))}</div>
      : '—',
  },
  {
    id: 'summary',
    header: '商品摘要',
    defaultWidth: 400,
    cellClassName: 'text-gray2',
    renderCell: order => {
      const summary = orderItemSummary(order)
      return <span title={summary}>{summary}</span>
    },
  },
  {
    id: 'amount',
    header: '金额',
    defaultWidth: 104,
    align: 'right',
    cellClassName: 'font-num',
    renderCell: order => `¥${Number(order.totalAmount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  },
  {
    id: 'action',
    header: '操作',
    defaultWidth: 103,
    align: 'right',
    renderCell: order => <a href={`/v2/supply-chain/fulfillment/${order.id}`} className="text-button text-amber-fg">查看履约 ›</a>,
  },
]

export default function InternalSupplyChainOrdersPage() {
  const [orders, setOrders] = useState<ProjectedOrder[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<OrderFilters>(DEFAULT_ORDER_FILTERS)
  const [draftFilters, setDraftFilters] = useState<OrderFilters>(DEFAULT_ORDER_FILTERS)
  const [stores, setStores] = useState<Store[]>([])
  const [dateError, setDateError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([])
  const [printOrders, setPrintOrders] = useState<ProjectedOrder[]>([])
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
        setSelectedOrderIds([])
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
  const selectedOrders = (orders || []).filter(order => selectedOrderIds.includes(order.id))
  const allSelected = Boolean(orders?.length) && selectedOrders.length === orders?.length
  const printColumns: readonly OrderCenterTableColumn<ProjectedOrder>[] = [
    {
      id: 'select', header: '选择', defaultWidth: 64,
      renderHeader: () => <input type="checkbox" aria-label="全选当前页订货单" checked={allSelected}
        onChange={event => setSelectedOrderIds(event.target.checked ? (orders || []).map(order => order.id) : [])} />,
      renderCell: order => <input type="checkbox" aria-label={`选择订货单 ${order.no}`}
        checked={selectedOrderIds.includes(order.id)}
        onChange={event => setSelectedOrderIds(current => event.target.checked ? [...current, order.id] : current.filter(id => id !== order.id))} />,
    },
    ...ORDER_COLUMNS,
  ]

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

  async function exportOrders() {
    if (exporting) return
    setExporting(true)
    setError(null)
    try {
      const query = buildOrderQuery({ ...filters, page: 1, pageSize: filters.pageSize })
      const { blob, filename } = await apiDownload(`/api/orders/export.xlsx${query}`, '门店订货单.xlsx')
      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(href), 5_000)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setExporting(false)
    }
  }

  async function printSelectedOrders() {
    if (printing || selectedOrders.length === 0) return
    setPrinting(true)
    setError(null)
    try {
      await apiFetch('/api/orders/print-events', {
        method: 'POST', body: JSON.stringify({ action: 'BROWSER_PRINT', orderIds: selectedOrders.map(order => order.id) }),
      })
      flushSync(() => setPrintOrders(selectedOrders))
      window.print()
      setFilters(current => ({ ...current }))
    } catch (reason: any) {
      setError(String(reason?.message || reason || '合并打印失败'))
    } finally {
      setPrinting(false)
    }
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
          <button
            onClick={exportOrders}
            disabled={exporting || Boolean(dateError)}
            className="rounded-cta border border-accent bg-white px-4 py-2 text-button text-accent disabled:opacity-40"
          >{exporting ? '正在导出…' : '导出'}</button>
          <button type="button" onClick={() => void printSelectedOrders()} disabled={printing || selectedOrders.length === 0}
            className="rounded-cta border border-ink bg-white px-4 py-2 text-button text-ink disabled:opacity-40">
            {printing ? '准备打印…' : `合并打印所选（${selectedOrders.length}）`}
          </button>
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
          <div className="overflow-clip rounded-card border border-border bg-white">
            <OrderCenterHorizontalTable>
              <OrderCenterResizableTable
                ariaLabel="订货单查询结果"
                columns={printColumns}
                rows={orders}
                rowKey={order => order.id}
                footer={(
                  <tfoot className="border-t border-border bg-bg">
                    <tr>
                      <td colSpan={19} className="px-4 py-3 text-right font-semibold">合计</td>
                      <td className="px-4 py-3 text-right font-num font-semibold">
                        ¥{orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              />
            </OrderCenterHorizontalTable>
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
      <section data-supply-chain-selected-print aria-hidden="true">
        {printOrders.map(order => {
          const store = storePrintIdentity(order.store || { name: '—' })
          return <article key={order.id} className="supply-chain-selected-print-page">
            <h1>订货单</h1>
            <p>订货单号：{order.no}</p>
            <p>品牌：{store.brand}　门店：{store.branch}　门店编号：{store.no}</p>
            <p>收货方：{store.fullName}　供应商：{order.supplier?.name || '—'}</p>
            <p>期望到货：{orderDeliveryDateText(order.expectedDeliveryDate)}</p>
            <table>
              <thead><tr><th>商品</th><th>数量</th><th>单价</th><th>金额</th></tr></thead>
              <tbody>{order.items.map((item: any, index: number) => (
                <tr key={item.id || index}>
                  <td>{item.productNameSnapshot || '—'}</td>
                  <td>{Number(item.quantity).toLocaleString('zh-CN')} {item.unit || ''}</td>
                  <td>¥{Number(item.unitPrice).toFixed(2)}</td>
                  <td>¥{(Number(item.quantity) * Number(item.unitPrice)).toFixed(2)}</td>
                </tr>
              ))}</tbody>
            </table>
            <p>合计：¥{Number(order.totalAmount).toFixed(2)}</p>
          </article>
        })}
      </section>
      <style jsx global>{`
        [data-supply-chain-selected-print] { display: none; }
        @media print {
          body * { visibility: hidden !important; }
          [data-supply-chain-selected-print], [data-supply-chain-selected-print] * { visibility: visible !important; }
          [data-supply-chain-selected-print] { display: block; position: absolute; inset: 0; padding: 16mm; color: #111; background: #fff; }
          .supply-chain-selected-print-page { break-after: page; page-break-after: always; }
          .supply-chain-selected-print-page:last-child { break-after: auto; page-break-after: auto; }
          .supply-chain-selected-print-page h1 { margin: 0 0 12px; text-align: center; font-size: 22px; }
          .supply-chain-selected-print-page p { margin: 5px 0; font-size: 13px; }
          .supply-chain-selected-print-page table { width: 100%; margin-top: 14px; border-collapse: collapse; font-size: 12px; }
          .supply-chain-selected-print-page th, .supply-chain-selected-print-page td { border: 1px solid #999; padding: 6px; text-align: left; }
        }
      `}</style>
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
      <SearchableSelect searchWhenLong searchLabel={`搜索${label}`}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-10 min-w-36 rounded-cta border border-border bg-white px-3 text-body"
      >
        {children}
      </SearchableSelect>
    </label>
  )
}
