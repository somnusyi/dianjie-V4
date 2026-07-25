'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { ErrorScreen, LoadingScreen, useDashboard } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Store = { id: string; no: string; name: string }
type DocumentRow = {
  id: string
  no: string
  status: string
  totalAmount?: number | string
  actualTotalAmount?: number | string
  store?: { id: string; name: string }
  supplier?: { id: string; name: string }
  createdAt?: string
  deliveryDate?: string
}
type InventoryRow = {
  id: string
  code?: string
  name: string
  inventoryUnit?: string
  unit?: string
  stock?: number
  minStock?: number
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

function queryForStore(storeId: string) {
  return storeId ? `&storeId=${encodeURIComponent(storeId)}` : ''
}

function money(value: unknown) {
  const amount = Number(value || 0)
  return Number.isFinite(amount) ? `¥${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : '—'
}

function dateText(value?: string) {
  return value ? value.slice(0, 10) : '—'
}

export default function InternalSupplyChainHomePage() {
  const { data, error } = useDashboard()
  const [storeId, setStoreId] = useState('')
  const [orders, setOrders] = useState<DocumentRow[]>([])
  const [deliveries, setDeliveries] = useState<DocumentRow[]>([])
  const [receipts, setReceipts] = useState<DocumentRow[]>([])
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [consumptions, setConsumptions] = useState<ConsumptionRow[]>([])
  const [loadingRows, setLoadingRows] = useState(true)
  const [rowError, setRowError] = useState('')

  const stores = useMemo<Store[]>(() => data?.supplyChain?.stores || [], [data])
  const selectedStore = stores.find(store => store.id === storeId)

  useEffect(() => {
    let alive = true
    setLoadingRows(true)
    setRowError('')
    const storeQuery = queryForStore(storeId)
    Promise.all([
      apiFetch<{ items: DocumentRow[] }>(`/api/orders?pageSize=8${storeQuery}`),
      apiFetch<{ items: DocumentRow[] }>(`/api/deliveries?pageSize=8${storeQuery}`),
      apiFetch<{ items: DocumentRow[] }>(`/api/receipts?pageSize=8${storeQuery}`),
    ]).then(([orderData, deliveryData, receiptData]) => {
      if (!alive) return
      setOrders(orderData.items || [])
      setDeliveries(deliveryData.items || [])
      setReceipts(receiptData.items || [])
    }).catch(reason => {
      if (alive) setRowError(String(reason?.message || reason))
    }).finally(() => {
      if (alive) setLoadingRows(false)
    })
    return () => { alive = false }
  }, [storeId])

  useEffect(() => {
    let alive = true
    if (!storeId) {
      setInventory([])
      setConsumptions([])
      return
    }
    Promise.all([
      apiFetch<InventoryRow[]>(`/api/inventory?storeId=${encodeURIComponent(storeId)}`),
      apiFetch<ConsumptionRow[]>(`/api/inventory/consumptions?days=30&storeId=${encodeURIComponent(storeId)}`),
    ]).then(([inventoryRows, consumptionRows]) => {
      if (!alive) return
      setInventory(inventoryRows || [])
      setConsumptions(consumptionRows || [])
    }).catch(reason => {
      if (alive) setRowError(String(reason?.message || reason))
    })
    return () => { alive = false }
  }, [storeId])

  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="green">内部只读</Chip>
            <span className="text-caption text-gray3">供应履约 · 租户内跨店</span>
          </div>
          <h1 className="text-h1">内部供应链工作台</h1>
          <p className="mt-1 text-caption text-gray2">供应履约与商品管理；不提供账单或销售分析。</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-caption text-gray2">
            门店
            <select
              aria-label="筛选门店"
              value={storeId}
              onChange={event => setStoreId(event.target.value)}
              className="ml-2 h-10 min-w-52 rounded-cta border border-border bg-white px-3 text-body"
            >
              <option value="">全部门店（履约单据）</option>
              {stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
            </select>
          </label>
          <a href="/v2/supply-chain/products" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button">商品管理</a>
          <a href="/v2/me" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button">账户</a>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px]">
        <section className="grid gap-3 py-5 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="门店范围" value={`${stores.length} 家`} />
          <Metric label="进行中订单" value={String(data.supplyChain?.counts.orders || 0)} />
          <Metric label="在途配送" value={String(data.supplyChain?.counts.deliveries || 0)} />
          <Metric label="有效收货" value={String(data.supplyChain?.counts.receipts || 0)} />
        </section>

        {rowError && <div className="mb-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{rowError}</div>}

        <section className="grid gap-4 xl:grid-cols-3">
          <DocumentTable title="采购订单" rows={orders} amountKey="totalAmount" loading={loadingRows} />
          <DocumentTable title="配送单" rows={deliveries} amountKey="actualTotalAmount" loading={loadingRows} />
          <DocumentTable title="收货单" rows={receipts} amountKey="totalAmount" loading={loadingRows} dateKey="deliveryDate" />
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-2">
          <div className="rounded-card border border-border bg-white">
            <SectionHeader title="门店库存" subtitle={selectedStore ? selectedStore.name : '请选择具体门店'} />
            {!selectedStore ? (
              <Empty text="选择门店后查看预计库存" />
            ) : (
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full text-left text-caption">
                  <thead className="sticky top-0 bg-bg text-gray3"><tr><th className="px-4 py-2">食材</th><th className="px-4 py-2">预计库存</th><th className="px-4 py-2">安全线</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {inventory.map(row => (
                      <tr key={row.id}>
                        <td className="px-4 py-3"><b>{row.name}</b><span className="ml-2 text-micro text-gray3">{row.code}</span></td>
                        <td className="px-4 py-3 font-num">{Number(row.stock || 0).toLocaleString()} {row.inventoryUnit || row.unit}</td>
                        <td className="px-4 py-3 font-num text-gray2">{Number(row.minStock || 0).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {inventory.length === 0 && <Empty text="暂无库存数据" />}
              </div>
            )}
          </div>

          <div className="rounded-card border border-border bg-white">
            <SectionHeader title="近 30 天纯消耗" subtitle={selectedStore ? selectedStore.name : '请选择具体门店'} />
            {!selectedStore ? (
              <Empty text="选择门店后查看消耗，不含营业额与成本率" />
            ) : (
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full text-left text-caption">
                  <thead className="sticky top-0 bg-bg text-gray3"><tr><th className="px-4 py-2">日期</th><th className="px-4 py-2">食材</th><th className="px-4 py-2">消耗量</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {consumptions.map(row => (
                      <tr key={row.id}>
                        <td className="px-4 py-3 font-num text-gray2">{dateText(row.date)}</td>
                        <td className="px-4 py-3"><b>{row.product?.name || '未知食材'}</b><span className="ml-2 text-micro text-gray3">{row.product?.code}</span></td>
                        <td className="px-4 py-3 font-num">{Number(row.inventoryQuantity ?? row.quantity).toLocaleString()} {row.inventoryUnitSnapshot || row.unitSnapshot || row.product?.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {consumptions.length === 0 && <Empty text="近 30 天暂无消耗记录" />}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className="mt-1 font-num text-h1">{value}</div></div>
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="flex items-baseline justify-between border-b border-border px-4 py-3"><h2 className="text-h2">{title}</h2><span className="text-micro text-gray3">{subtitle}</span></div>
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-10 text-center text-caption text-gray3">{text}</div>
}

function DocumentTable({
  title,
  rows,
  amountKey,
  dateKey = 'createdAt',
  loading,
}: {
  title: string
  rows: DocumentRow[]
  amountKey: 'totalAmount' | 'actualTotalAmount'
  dateKey?: 'createdAt' | 'deliveryDate'
  loading: boolean
}) {
  return (
    <div className="rounded-card border border-border bg-white">
      <SectionHeader title={title} subtitle="最近 8 条 · 只读" />
      <div className="max-h-[360px] overflow-auto">
        <table className="w-full text-left text-caption">
          <thead className="sticky top-0 bg-bg text-gray3"><tr><th className="px-4 py-2">单号 / 门店</th><th className="px-4 py-2">状态</th><th className="px-4 py-2 text-right">金额</th></tr></thead>
          <tbody className="divide-y divide-border">
            {rows.map(row => (
              <tr key={row.id}>
                <td className="px-4 py-3"><b className="font-num">{row.no}</b><div className="mt-0.5 text-micro text-gray3">{row.store?.name || '—'} · {dateText(row[dateKey])}</div></td>
                <td className="px-4 py-3"><Chip tone="gray">{row.status}</Chip></td>
                <td className="px-4 py-3 text-right font-num">{money(row[amountKey])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <Empty text="暂无记录" />}
        {loading && <Empty text="加载中…" />}
      </div>
    </div>
  )
}
