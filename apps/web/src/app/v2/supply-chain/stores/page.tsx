'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Chip } from '@/components/v2'
import { ErrorScreen, LoadingScreen, useDashboard } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Store = { id: string; no: string; name: string }
type StoreView = 'overview' | 'orders' | 'receipts' | 'inventory' | 'consumption'
type OrderRow = {
  id: string
  no: string
  status: string
  createdAt?: string
  expectedDate?: string
  expectedDeliveryDate?: string
  totalAmount?: number | string
  supplier?: { id: string; name: string }
  items?: unknown[]
}
type ReceiptRow = {
  id: string
  no: string
  status: string
  deliveryDate?: string
  confirmedAt?: string
  supplier?: { id: string; name: string }
  items?: unknown[]
}
type InventoryRow = {
  id: string
  code?: string
  name: string
  inventoryUnit?: string
  unit?: string
  stock?: number | string
  minStock?: number | string
}
type ConsumptionRow = {
  id: string
  date: string
  inventoryQuantity?: number | string | null
  quantity: number | string
  inventoryUnitSnapshot?: string | null
  unitSnapshot?: string | null
  product?: { code?: string; name: string; unit?: string }
}
type StoreOverview = {
  orderCount: number
  orderStatusBreakdown: {
    SUBMITTED: number
    CONFIRMED: number
    DELIVERING: number
    inProgress: number
  }
  validReceiptCount: number
  inventoryProductCount: number
  lowStockCount: number
  consumptionCount30d: number
}
type ConsumptionRankingDimension = 'PRODUCT' | 'CATEGORY'
type ConsumptionRanking = {
  dimension: ConsumptionRankingDimension
  days: 7 | 30 | 90
  startDate: string
  endDate: string
  totalAmount: number
  top10Amount: number
  top10Coverage: number
  recordCount: number
  pricedRecordCount: number
  unpricedRecordCount: number
  items: Array<{
    id: string
    name: string
    code?: string | null
    category: string
    amount: number
    share: number
    recordCount: number
    pricedRecordCount: number
  }>
}

const VIEWS: Array<{ id: StoreView; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'orders', label: '订货记录' },
  { id: 'receipts', label: '收货记录' },
  { id: 'inventory', label: '当前库存' },
  { id: 'consumption', label: '消耗记录' },
]

const ORDER_STATUS: Record<string, string> = {
  DRAFT: '草稿',
  SUBMITTED: '已提交',
  CONFIRMED: '已确认',
  DELIVERING: '配送中',
  PENDING_CONFIRM: '待确认',
  RECEIVED: '已收货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

const RECEIPT_STATUS: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '待送达',
  PENDING_CONFIRM: '待确认',
  CONFIRMED: '已确认',
  ACCOUNTED: '已入账',
  VOID: '已作废',
  REJECTED: '已拒收',
}

function dateText(value?: string) {
  return value ? value.slice(0, 10) : '—'
}

function money(value: unknown) {
  const amount = Number(value || 0)
  return Number.isFinite(amount)
    ? `¥${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
    : '—'
}

function quantity(value: unknown) {
  const amount = Number(value || 0)
  return Number.isFinite(amount) ? amount.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : '—'
}

function statusTone(status: string): 'red' | 'orange' | 'green' | 'gray' {
  if (['CANCELLED', 'VOID', 'REJECTED'].includes(status)) return 'red'
  if (['SUBMITTED', 'DELIVERING', 'PENDING', 'PENDING_CONFIRM'].includes(status)) return 'orange'
  if (['CONFIRMED', 'RECEIVED', 'COMPLETED', 'ACCOUNTED'].includes(status)) return 'green'
  return 'gray'
}

export default function InternalSupplyChainStoresPage() {
  const { data, error: dashboardError } = useDashboard()
  const stores = useMemo<Store[]>(() => data?.supplyChain?.stores || [], [data])
  const [storeId, setStoreId] = useState('')
  const [view, setView] = useState<StoreView>('overview')
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [orderTotal, setOrderTotal] = useState(0)
  const [receipts, setReceipts] = useState<ReceiptRow[]>([])
  const [receiptTotal, setReceiptTotal] = useState(0)
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [consumptions, setConsumptions] = useState<ConsumptionRow[]>([])
  const [overview, setOverview] = useState<StoreOverview | null>(null)
  const [rankingDays, setRankingDays] = useState<7 | 30 | 90>(30)
  const [rankingDimension, setRankingDimension] = useState<ConsumptionRankingDimension>('PRODUCT')
  const [consumptionRanking, setConsumptionRanking] = useState<ConsumptionRanking | null>(null)
  const [rankingLoading, setRankingLoading] = useState(false)
  const [rankingError, setRankingError] = useState('')
  const [loading, setLoading] = useState(false)
  const [rowError, setRowError] = useState('')
  const requestSequence = useRef(0)
  const rankingSequence = useRef(0)

  useEffect(() => {
    if (!storeId && stores.length > 0) setStoreId(stores[0].id)
  }, [storeId, stores])

  useEffect(() => {
    if (!storeId) return
    const sequence = ++requestSequence.current
    setLoading(true)
    setRowError('')
    const encodedStoreId = encodeURIComponent(storeId)
    Promise.all([
      apiFetch<{ items: OrderRow[]; total: number }>(`/api/orders?storeId=${encodedStoreId}&page=1&pageSize=50`),
      apiFetch<{ items: ReceiptRow[]; total: number }>(`/api/receipts?storeId=${encodedStoreId}&page=1&pageSize=50`),
      apiFetch<InventoryRow[]>(`/api/inventory?storeId=${encodedStoreId}`),
      apiFetch<ConsumptionRow[]>(`/api/inventory/consumptions?days=30&storeId=${encodedStoreId}`),
      apiFetch<StoreOverview>(`/api/stores/${encodedStoreId}/overview`),
    ]).then(([orderData, receiptData, inventoryRows, consumptionRows, overviewData]) => {
      if (sequence !== requestSequence.current) return
      setOrders(orderData.items || [])
      setOrderTotal(orderData.total || 0)
      setReceipts(receiptData.items || [])
      setReceiptTotal(receiptData.total || 0)
      setInventory(inventoryRows || [])
      setConsumptions(consumptionRows || [])
      setOverview(overviewData)
    }).catch(reason => {
      if (sequence === requestSequence.current) setRowError(String(reason?.message || reason))
    }).finally(() => {
      if (sequence === requestSequence.current) setLoading(false)
    })
  }, [storeId])

  useEffect(() => {
    if (!storeId) return
    const sequence = ++rankingSequence.current
    setRankingLoading(true)
    setRankingError('')
    setConsumptionRanking(null)
    const encodedStoreId = encodeURIComponent(storeId)
    apiFetch<ConsumptionRanking>(
      `/api/stores/${encodedStoreId}/consumption-ranking?days=${rankingDays}&dimension=${rankingDimension}`,
    ).then(result => {
      if (sequence === rankingSequence.current) setConsumptionRanking(result)
    }).catch(reason => {
      if (sequence === rankingSequence.current) setRankingError(String(reason?.message || reason))
    }).finally(() => {
      if (sequence === rankingSequence.current) setRankingLoading(false)
    })
  }, [storeId, rankingDays, rankingDimension])

  if (dashboardError) return <ErrorScreen message={dashboardError} />
  if (!data) return <LoadingScreen />

  const selectedStore = stores.find(store => store.id === storeId)
  const lowStock = inventory.filter(row => Number(row.minStock || 0) > 0 && Number(row.stock || 0) < Number(row.minStock || 0))
  const activeOrders = orders.filter(row => !['RECEIVED', 'COMPLETED', 'CANCELLED'].includes(row.status))
  const inProgressCount = overview?.orderStatusBreakdown.inProgress ?? activeOrders.length
  const lowStockCount = overview?.lowStockCount ?? lowStock.length

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="green">内部只读</Chip>
            <span className="text-caption text-gray3">门店订货 · 收货 · 库存 · 消耗</span>
          </div>
          <h1 className="text-h1">门店运营</h1>
          <p className="mt-1 text-caption text-gray2">以门店为中心查看供应链业务，不在这里修改门店库存或收货结果。</p>
        </div>
        <label className="text-caption text-gray2">
          当前门店
          <select
            aria-label="选择门店"
            value={storeId}
            onChange={event => setStoreId(event.target.value)}
            className="ml-2 h-10 min-w-60 rounded-cta border border-border bg-white px-3 text-body"
          >
            {stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
          </select>
        </label>
      </header>

      <main className="mx-auto max-w-[1440px]">
        {stores.length === 0 ? (
          <Empty text="当前租户没有启用中的门店" />
        ) : (
          <>
            <section className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="订货记录" value={`${orderTotal} 单`} hint="当前门店全部历史" />
              <Metric label="进行中订货" value={`${inProgressCount} 单`} hint="待接单、待发货与配送中" tone={inProgressCount > 0 ? 'orange' : undefined} />
              <Metric label="有效收货" value={`${overview?.validReceiptCount ?? receiptTotal} 单`} hint="不含作废与拒收" />
              <Metric label="低于安全线" value={`${lowStockCount} 项`} hint="按当前预计库存与门店策略判断" tone={lowStockCount > 0 ? 'red' : 'green'} />
            </section>

            {rowError && <div className="mb-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{rowError}</div>}

            <nav aria-label="门店运营视图" className="mb-4 flex flex-wrap gap-2 border-b border-border">
              {VIEWS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setView(item.id)}
                  aria-current={view === item.id ? 'page' : undefined}
                  className={`border-b-2 px-4 py-3 text-button ${
                    view === item.id ? 'border-accent text-amber-fg' : 'border-transparent text-gray2 hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            {loading ? <Empty text="正在加载门店数据…" /> : (
              <>
                {view === 'overview' && (
                  <section className="grid items-start gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                    <div className="space-y-4">
                      <Panel title="库存提醒" subtitle={selectedStore?.name || '—'}>
                        {lowStock.length > 0 ? (
                          <InventoryTable rows={lowStock.slice(0, 5)} />
                        ) : <Empty text="当前没有低于安全线的商品" compact />}
                        <PanelLink onClick={() => setView('inventory')}>查看全部库存 ›</PanelLink>
                      </Panel>
                      <Panel title="近期订货" subtitle={`${inProgressCount} 单进行中`}>
                        {orders.length > 0 ? <OrderTable rows={orders.slice(0, 4)} compact /> : <Empty text="当前门店暂无订货记录" compact />}
                        <PanelLink onClick={() => setView('orders')}>查看全部订货 ›</PanelLink>
                      </Panel>
                      <Panel title="近期收货" subtitle={`${receiptTotal} 单`}>
                        {receipts.length > 0 ? <ReceiptTable rows={receipts.slice(0, 4)} compact /> : <Empty text="当前门店暂无收货记录" compact />}
                        <PanelLink onClick={() => setView('receipts')}>查看全部收货 ›</PanelLink>
                      </Panel>
                    </div>
                    <ConsumptionRankingChart
                      data={consumptionRanking}
                      loading={rankingLoading}
                      error={rankingError}
                      days={rankingDays}
                      dimension={rankingDimension}
                      onDaysChange={setRankingDays}
                      onDimensionChange={setRankingDimension}
                      onOpenDetails={() => setView('consumption')}
                    />
                  </section>
                )}

                {view === 'orders' && (
                  <Panel title="订货记录" subtitle={`${selectedStore?.name || '—'} · 最近 ${orders.length} 条`}>
                    {orders.length > 0 ? <OrderTable rows={orders} /> : <Empty text="当前门店暂无订货记录" />}
                  </Panel>
                )}

                {view === 'receipts' && (
                  <Panel title="收货记录" subtitle={`${selectedStore?.name || '—'} · 最近 ${receipts.length} 条`}>
                    {receipts.length > 0 ? <ReceiptTable rows={receipts} /> : <Empty text="当前门店暂无收货记录" />}
                  </Panel>
                )}

                {view === 'inventory' && (
                  <Panel title="当前预计库存" subtitle={`${selectedStore?.name || '—'} · 最近盘点 + 后续实收 − 消耗 − 报损`}>
                    {inventory.length > 0 ? <InventoryTable rows={inventory} /> : <Empty text="当前门店暂无库存数据" />}
                  </Panel>
                )}

                {view === 'consumption' && (
                  <Panel title="近30天消耗" subtitle={`${selectedStore?.name || '—'} · 不含营业额与成本率`}>
                    {consumptions.length > 0 ? <ConsumptionTable rows={consumptions} /> : <Empty text="当前门店近30天暂无消耗记录" />}
                  </Panel>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function Metric({ label, value, hint, tone }: {
  label: string
  value: string
  hint: string
  tone?: 'red' | 'orange' | 'green'
}) {
  const color = tone === 'red' ? 'text-red-fg' : tone === 'orange' ? 'text-orange' : tone === 'green' ? 'text-green-fg' : ''
  return (
    <div className="rounded-card border border-border bg-white p-4">
      <div className="text-caption text-gray3">{label}</div>
      <div className={`mt-1 font-num text-h1 ${color}`}>{value}</div>
      <div className="mt-1 text-micro text-gray3">{hint}</div>
    </div>
  )
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-border bg-white">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-h2">{title}</h2>
        <span className="text-micro text-gray3">{subtitle}</span>
      </header>
      {children}
    </section>
  )
}

function PanelLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="w-full border-t border-border px-4 py-3 text-right text-caption text-accent">{children}</button>
}

function ConsumptionRankingChart({
  data,
  loading,
  error,
  days,
  dimension,
  onDaysChange,
  onDimensionChange,
  onOpenDetails,
}: {
  data: ConsumptionRanking | null
  loading: boolean
  error: string
  days: 7 | 30 | 90
  dimension: ConsumptionRankingDimension
  onDaysChange: (days: 7 | 30 | 90) => void
  onDimensionChange: (dimension: ConsumptionRankingDimension) => void
  onOpenDetails: () => void
}) {
  const maxAmount = Math.max(1, ...(data?.items.map(item => item.amount) || []))
  const dimensionLabel = dimension === 'PRODUCT' ? '商品' : '分类'

  return (
    <section className="overflow-hidden rounded-card border border-border bg-white" aria-label="消耗金额排行">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4">
        <div>
          <h2 className="text-h2">消耗金额 Top 10</h2>
          <p className="mt-1 text-micro text-gray3">
            按历史冻结成本汇总 · {data ? `${data.startDate} 至 ${data.endDate}` : `近 ${days} 天`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-cta border border-border bg-bg p-1" aria-label="排行维度">
            {([
              ['PRODUCT', '按商品'],
              ['CATEGORY', '按分类'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={dimension === value}
                onClick={() => onDimensionChange(value)}
                className={`rounded px-3 py-1.5 text-button ${
                  dimension === value ? 'bg-white text-amber-fg shadow-sm' : 'text-gray2'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex rounded-cta border border-border bg-bg p-1" aria-label="时间范围">
            {([7, 30, 90] as const).map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={days === value}
                onClick={() => onDaysChange(value)}
                className={`rounded px-3 py-1.5 text-button ${
                  days === value ? 'bg-white text-amber-fg shadow-sm' : 'text-gray2'
                }`}
              >
                {value}天
              </button>
            ))}
          </div>
        </div>
      </header>

      {loading ? (
        <Empty text="正在统计消耗金额…" />
      ) : error ? (
        <div className="px-4 py-10 text-center text-caption text-red-fg">{error}</div>
      ) : !data || data.recordCount === 0 ? (
        <Empty text={`当前门店近 ${days} 天暂无消耗记录`} />
      ) : (
        <>
          <div className="grid gap-3 border-b border-border bg-bg/60 p-4 sm:grid-cols-3">
            <RankingMetric label="已计价消耗" value={money(data.totalAmount)} />
            <RankingMetric label="Top 10 覆盖率" value={`${(data.top10Coverage * 100).toFixed(1)}%`} />
            <RankingMetric
              label="未计价记录"
              value={`${data.unpricedRecordCount} 条`}
              warning={data.unpricedRecordCount > 0}
            />
          </div>

          {data.unpricedRecordCount > 0 && (
            <div className="border-b border-orange/20 bg-orange/5 px-4 py-2 text-micro text-orange">
              {data.unpricedRecordCount} 条历史消耗缺少冻结成本，未计入金额排行。
            </div>
          )}

          {data.items.length === 0 ? (
            <Empty text="当前记录尚无可用于金额排行的冻结成本" />
          ) : (
            <ol className="space-y-3.5 p-4 lg:p-5">
              {data.items.map((item, index) => {
                const barWidth = Math.max(2, (item.amount / maxAmount) * 100)
                return (
                  <li key={item.id} data-ranking-item={item.id}>
                    <div className="mb-1.5 flex items-start justify-between gap-4 text-caption">
                      <div className="min-w-0">
                        <span className="mr-2 inline-block w-5 text-right font-num text-gray3">{index + 1}</span>
                        <b>{item.name}</b>
                        {dimension === 'PRODUCT' && item.code && (
                          <span className="ml-2 text-micro text-gray3">{item.code}</span>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <b className="font-num">{money(item.amount)}</b>
                        <span className="ml-2 font-num text-micro text-gray3">{(item.share * 100).toFixed(1)}%</span>
                      </div>
                    </div>
                    <div
                      className="ml-7 h-2.5 overflow-hidden rounded-full bg-bg"
                      role="img"
                      aria-label={`第 ${index + 1} 名 ${dimensionLabel}${item.name}，消耗金额 ${money(item.amount)}`}
                    >
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-300"
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
          <PanelLink onClick={onOpenDetails}>查看全部消耗流水 ›</PanelLink>
        </>
      )}
    </section>
  )
}

function RankingMetric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className="rounded-card border border-border bg-white px-4 py-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`mt-1 font-num text-h2 ${warning ? 'text-orange' : ''}`}>{value}</div>
    </div>
  )
}

function OrderTable({ rows, compact = false }: { rows: OrderRow[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-caption">
        <thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">订货单</th>{!compact && <th className="px-4 py-2">供应商</th>}<th className="px-4 py-2">日期</th><th className="px-4 py-2">状态</th>{!compact && <th className="px-4 py-2 text-right">金额</th>}</tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map(row => (
            <tr key={row.id}>
              <td className="px-4 py-3 font-num"><a className="text-accent" href={`/v2/supply-chain/fulfillment/${row.id}`}>{row.no}</a></td>
              {!compact && <td className="px-4 py-3 text-gray2">{row.supplier?.name || '—'}</td>}
              <td className="px-4 py-3 font-num text-gray2">{dateText(row.createdAt)}</td>
              <td className="px-4 py-3"><Chip tone={statusTone(row.status)}>{ORDER_STATUS[row.status] || row.status}</Chip></td>
              {!compact && <td className="px-4 py-3 text-right font-num">{money(row.totalAmount)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReceiptTable({ rows, compact = false }: { rows: ReceiptRow[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-caption">
        <thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">收货单</th>{!compact && <th className="px-4 py-2">供应商</th>}<th className="px-4 py-2">到货日</th><th className="px-4 py-2">状态</th></tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map(row => (
            <tr key={row.id}>
              <td className="px-4 py-3 font-num"><b>{row.no}</b></td>
              {!compact && <td className="px-4 py-3 text-gray2">{row.supplier?.name || '—'}</td>}
              <td className="px-4 py-3 font-num text-gray2">{dateText(row.deliveryDate || row.confirmedAt)}</td>
              <td className="px-4 py-3"><Chip tone={statusTone(row.status)}>{RECEIPT_STATUS[row.status] || row.status}</Chip></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InventoryTable({ rows }: { rows: InventoryRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-caption">
        <thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">食材</th><th className="px-4 py-2 text-right">预计库存</th><th className="px-4 py-2 text-right">安全线</th></tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map(row => {
            const low = Number(row.minStock || 0) > 0 && Number(row.stock || 0) < Number(row.minStock || 0)
            const unit = row.inventoryUnit || row.unit || ''
            return (
              <tr key={row.id}>
                <td className="px-4 py-3"><b>{row.name}</b><span className="ml-2 text-micro text-gray3">{row.code}</span></td>
                <td className={`px-4 py-3 text-right font-num ${low ? 'text-red-fg' : ''}`}>{quantity(row.stock)} {unit}</td>
                <td className="px-4 py-3 text-right font-num text-gray2">{quantity(row.minStock)} {unit}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ConsumptionTable({ rows }: { rows: ConsumptionRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-caption">
        <thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">日期</th><th className="px-4 py-2">食材</th><th className="px-4 py-2 text-right">消耗量</th></tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map(row => (
            <tr key={row.id}>
              <td className="px-4 py-3 font-num text-gray2">{dateText(row.date)}</td>
              <td className="px-4 py-3"><b>{row.product?.name || '未知食材'}</b><span className="ml-2 text-micro text-gray3">{row.product?.code}</span></td>
              <td className="px-4 py-3 text-right font-num">{quantity(row.inventoryQuantity ?? row.quantity)} {row.inventoryUnitSnapshot || row.unitSnapshot || row.product?.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Empty({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`px-4 text-center text-caption text-gray3 ${compact ? 'py-6' : 'py-10'}`}>{text}</div>
}
