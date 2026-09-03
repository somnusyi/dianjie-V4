'use client'

import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  OrderAmountCard,
  OrderDeliverySummary,
  OrderDetailHeader,
  OrderProductTable,
  OrderProgressCard,
  type OrderDetailTableRow,
} from '@/components/v2/order-detail-shared'
import { clientRequestId } from '@/lib/client-id'
import { RevisionCatalogProduct, resolveRevisionCatalogPricing } from '@/lib/supplier-revision-cost-pricing'
import { apiFetch } from '@/lib/v2-auth'

const PURCHASE_QUANTITY_MAX = 99_999_999.99

type Item = { id: string; productId: string; name: string; spec: string | null; unit: string; quantity: string; unitPrice: string; amount: string }
type Member = {
  id: string; no: string; rowVersion: number; createdAt: string; submittedAt?: string | null; status?: string | null
  store?: { name?: string; address?: string | null } | null; supplier?: { name?: string } | null
  items: Item[]; orderedItems: Item[]; shipmentItems: Item[]
}
type Detail = {
  source: 'pending' | 'accepted'
  group: { id: string; supplierId: string; expectedDate: string; memberOrderIds: string[]; memberOrderNos: string[]; memberCount: number; firstCreatedAt: string; lastCreatedAt: string; isEligible?: boolean; blockedOrderIds?: string[] }
  orders: Member[]
  progressStep: number
  totals: { quantity: string; amount: string; orderedQuantity: string; orderedAmount: string; shipmentQuantity: string; shipmentAmount: string; hasAnyShipment: boolean; snapshotComplete: boolean }
}
type DraftRow = OrderDetailTableRow & { productId: string; orderId: string; itemId: string }

function money(value: string | number) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fingerprint(rows: DraftRow[]) {
  return JSON.stringify([...rows].sort((a, b) => a.key.localeCompare(b.key)).map(row => [row.orderId, row.productId, row.quantity]))
}

function rowsFromDetail(detail: Detail): DraftRow[] {
  return detail.orders.flatMap(order => {
    const source = detail.source === 'pending'
      ? order.orderedItems
      : detail.totals.hasAnyShipment ? order.shipmentItems : order.orderedItems
    return source.map(item => ({
      key: `${order.id}:${item.id}`, itemId: item.id, orderId: order.id, productId: item.productId,
      name: item.name, spec: item.spec, unit: item.unit, quantity: Number(item.quantity),
      originalQuantity: Number(item.quantity), unitPrice: Number(item.unitPrice), sourceLabel: `原订单 #${order.no}`,
    }))
  })
}

export default function OperationGroupDetailPage() {
  const router = useRouter()
  const groupId = String((useParams() as { groupId?: string }).groupId || '')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [rows, setRows] = useState<DraftRow[]>([])
  const [baseline, setBaseline] = useState('')
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({})
  const [catalog, setCatalog] = useState<RevisionCatalogProduct[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const requestKeyRef = useRef<string | null>(null)
  const confirmKeyRef = useRef<string | null>(null)

  async function load() {
    setLoading(true); setLoadError(null)
    try {
      const data = await apiFetch<Detail>(`/api/orders/operation-groups/${encodeURIComponent(groupId)}`)
      const nextRows = rowsFromDetail(data)
      setDetail(data); setRows(nextRows); setBaseline(fingerprint(nextRows)); setQuantityDrafts({}); requestKeyRef.current = null
    } catch (error: any) { setLoadError(error?.message || '集合加载失败') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [groupId])

  const sortedOrders = useMemo(() => [...(detail?.orders || [])].sort((a, b) => Date.parse(a.submittedAt || a.createdAt) - Date.parse(b.submittedAt || b.createdAt) || a.id.localeCompare(b.id)), [detail])
  const latestOrder = sortedOrders[sortedOrders.length - 1]
  const editable = detail?.source === 'pending' && detail.orders.every(order => order.status === 'SUBMITTED')
  const dirty = editable && fingerprint(rows) !== baseline
  const blocked = Boolean(detail?.group.blockedOrderIds?.length)
  const canAccept = Boolean(detail?.source === 'pending' && detail.group.isEligible && !blocked && !dirty)

  function updateQuantity(row: DraftRow, value: number) {
    if (!Number.isFinite(value) || value < 0 || value > PURCHASE_QUANTITY_MAX) return
    setRows(current => current.map(item => item.key === row.key ? { ...item, quantity: value } : item))
    setActionError(null); setNotice(null)
  }

  function removeRow(row: DraftRow) {
    if (rows.filter(item => item.orderId === row.orderId).length <= 1) {
      setActionError('每张原订单至少保留一个商品')
      return
    }
    setRows(current => current.filter(item => item.key !== row.key)); setActionError(null); setNotice(null)
  }

  async function openAdd() {
    if (!detail || !editable) return
    try {
      const data = await apiFetch<any>(`/api/products?supplierId=${encodeURIComponent(detail.group.supplierId)}&page=1&pageSize=100`)
      const list = Array.isArray(data) ? data : data?.items || []
      setCatalog((list as RevisionCatalogProduct[]).filter(product => product.status === 'ENABLED'))
      setSearch(''); setAddOpen(true); setActionError(null)
    } catch (error: any) { setActionError(error?.message || '加载商品目录失败') }
  }

  function addProduct(product: RevisionCatalogProduct) {
    if (!latestOrder) return
    const pricing = resolveRevisionCatalogPricing(product)
    if (pricing.status !== 'READY') { setActionError(pricing.message); return }
    const existing = rows.find(row => row.orderId === latestOrder.id && row.productId === product.id)
    if (existing) updateQuantity(existing, existing.quantity + 1)
    else setRows(current => [...current, {
      key: `${latestOrder.id}:added:${product.id}`, itemId: `added:${product.id}`, orderId: latestOrder.id, productId: product.id,
      name: product.name, spec: product.spec || null, unit: pricing.orderUnit, quantity: 1, originalQuantity: 0,
      unitPrice: Number(pricing.orderUnitPrice), sourceLabel: `原订单 #${latestOrder.no}`,
    }])
    setAddOpen(false); setNotice(null)
  }

  async function save() {
    if (!detail || !editable || !dirty || submitting) return
    const invalid = rows.find(row => row.quantity <= 0 || row.quantity > PURCHASE_QUANTITY_MAX || Math.abs(row.quantity * 100 - Math.round(row.quantity * 100)) > 0.000001)
    if (invalid) { setActionError(`${invalid.name}数量必须大于 0，且最多保留 2 位小数`); return }
    const orders = detail.orders.map(order => ({
      orderId: order.id, baseRowVersion: order.rowVersion,
      items: rows.filter(row => row.orderId === order.id).map(row => ({ productId: row.productId, quantity: row.quantity })),
    }))
    if (orders.some(order => order.items.length === 0)) { setActionError('每张原订单至少保留一个商品'); return }
    const requestKey = requestKeyRef.current || clientRequestId(); requestKeyRef.current = requestKey
    setSubmitting(true); setActionError(null)
    try {
      await apiFetch(`/api/orders/operation-groups/${encodeURIComponent(detail.group.id)}/items`, { method: 'PATCH', body: JSON.stringify({ requestKey, orders }) })
      await load(); setNotice('整组商品明细已原子保存，可继续批量接单')
    } catch (error: any) { setActionError(error?.message || '整组保存失败，所有原订单均未更改') }
    finally { setSubmitting(false) }
  }

  async function accept() {
    if (!detail || !canAccept || submitting) return
    setSubmitting(true); setActionError(null)
    try {
      const idempotencyKey = confirmKeyRef.current || clientRequestId(); confirmKeyRef.current = idempotencyKey
      await apiFetch(`/api/orders/operation-groups/${encodeURIComponent(detail.group.id)}/confirm`, { method: 'POST', body: JSON.stringify({ orderIds: detail.group.memberOrderIds, idempotencyKey }) })
      setConfirmOpen(false); confirmKeyRef.current = null; await load()
    } catch (error: any) { setActionError(error?.message || '批量接单失败') }
    finally { setSubmitting(false) }
  }

  if (loading) return <div className="min-h-screen bg-bg p-5 text-center text-caption text-gray3">集合加载中…</div>
  if (loadError || !detail) return <div className="min-h-screen bg-bg p-4"><button onClick={() => router.back()} className="text-caption text-gray2">‹ 返回</button><div className="mt-6 rounded-card bg-red-bg p-4 text-red-fg">{loadError || '集合不存在'}</div></div>

  const first = detail.orders[0]
  const productTotal = rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0)
  const deliveryLines = detail.orders.flatMap(order => order.shipmentItems.map(item => `${item.name}${item.quantity}${item.unit}`))
  const filteredCatalog = catalog.filter(product => !search.trim() || `${product.name} ${product.spec || ''}`.toLowerCase().includes(search.trim().toLowerCase()))

  return <div className="min-h-screen bg-bg pb-28">
    <OrderDetailHeader onBack={() => router.back()} onDeliveryNote={() => router.push(`/v2/supply-chain/fulfillment/${encodeURIComponent(detail.group.id)}/delivery-note`)}
      statusLabel={detail.source === 'pending' ? '待接单集合' : '已接单集合'} statusTone={detail.source === 'pending' ? 'orange' : 'green'} />
    {actionError && <div className="mx-4 mt-2 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{actionError}</div>}
    {notice && <div className="mx-4 mt-2 rounded-card border border-green-fg/20 bg-green-bg p-3 text-caption text-green-fg">{notice}</div>}

    <OrderAmountCard eyebrow={`${detail.group.memberCount} 张原订单 · ${detail.group.memberOrderNos.map(no => `#${no}`).join('、')}`}
      name={first?.store?.name || '未知门店'} amountLabel="实发金额"
      amount={money(detail.totals.shipmentAmount)} originalOrderAmount={money(detail.totals.orderedAmount)}>
      {first?.store?.address && <div className="mt-1 text-micro text-gray3">📍 {first.store.address}</div>}
      <div className="mt-2 text-caption text-gray2">下单 {dayjs(detail.group.firstCreatedAt).format('MM/DD HH:mm')}{detail.group.firstCreatedAt !== detail.group.lastCreatedAt && ` — ${dayjs(detail.group.lastCreatedAt).format('MM/DD HH:mm')}`} · 期望到货 {dayjs(detail.group.expectedDate).format('MM/DD')}<br />供应商 {first?.supplier?.name || '-'}</div>
    </OrderAmountCard>
    <OrderDeliverySummary lines={deliveryLines} />
    <OrderProgressCard currentIndex={detail.progressStep} />
    <OrderProductTable rows={rows} editable={Boolean(editable)} total={money(productTotal)} saving={submitting} dirty={Boolean(dirty)} onAdd={() => void openAdd()} onSave={() => void save()} onRemove={row => removeRow(row as DraftRow)}
      notice={editable ? <p className="mx-3 mb-2 text-micro text-gray3">每行标明原订单归属；点一次保存后，所有变化在同一个事务中生效或全部回滚。</p> : null}
      renderQuantity={rowBase => {
        const row = rowBase as DraftRow
        return editable ? <span className="inline-flex items-center gap-1"><input type="number" inputMode="decimal" min="0" max={PURCHASE_QUANTITY_MAX} step="0.01" aria-label={`${row.name}数量`}
          value={quantityDrafts[row.key] ?? String(row.quantity)} onChange={event => { const raw = event.target.value; setQuantityDrafts(current => ({ ...current, [row.key]: raw })); if (raw !== '') updateQuantity(row, Number(raw)) }}
          onBlur={() => setQuantityDrafts(current => { const next = { ...current }; delete next[row.key]; return next })}
          className={`w-24 rounded-cta border bg-white px-2 py-1 text-right font-num ${Math.abs(row.quantity - row.originalQuantity) >= 0.0001 ? 'border-red text-red-fg' : 'border-border text-ink'}`} /><span className="text-gray3">{row.unit}</span></span> : <>{row.quantity}{row.unit}</>
      }} />

    <section className="mx-4 mt-3 rounded-card border border-border bg-white"><div className="border-b border-border px-4 py-3"><h2 className="text-h2">集合内订单 ({detail.orders.length})</h2></div><div className="overflow-x-auto"><table className="w-full min-w-[420px] text-caption"><thead className="bg-bg text-micro text-gray3"><tr><th className="px-4 py-2 text-left">序号</th><th className="px-4 py-2 text-left">原订单号</th><th className="px-4 py-2 text-left">下单时间</th></tr></thead><tbody className="divide-y divide-border">{sortedOrders.map((order, index) => <tr key={order.id}><td className="px-4 py-3 font-num text-gray3">{index + 1}</td><td className="px-4 py-3 font-num">#{order.no}</td><td className="px-4 py-3 text-gray2">{dayjs(order.createdAt).format('MM/DD HH:mm')}</td></tr>)}</tbody></table></div></section>

    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-white/95 p-3 backdrop-blur"><div className="mx-auto max-w-5xl">{detail.source === 'accepted' ? <div className="rounded-cta bg-green-bg px-4 py-3 text-center text-button text-green-fg">集合已接单</div> : <button onClick={() => setConfirmOpen(true)} disabled={!canAccept || submitting} className="w-full rounded-cta bg-ink px-4 py-3 text-button text-white disabled:opacity-40">批量接单</button>}</div></div>

    {addOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true"><div className="w-full max-w-lg rounded-card bg-white p-4"><div className="flex items-center"><h2 className="flex-1 text-h2">增加商品</h2><button onClick={() => setAddOpen(false)} className="text-caption text-gray2">关闭</button></div><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索商品名称或规格" className="mt-3 w-full rounded-cta border border-border bg-bg px-3 py-2" /><div className="mt-3 max-h-[55vh] overflow-y-auto rounded-cta border border-border">{filteredCatalog.map(product => { const pricing = resolveRevisionCatalogPricing(product); return <button key={product.id} disabled={pricing.status !== 'READY'} onClick={() => addProduct(product)} className="flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left last:border-0 disabled:opacity-40"><span className="min-w-0 flex-1"><span className="block">{product.name}</span><span className="text-micro text-gray3">{product.spec || '-'}</span></span><span className="font-num text-caption">{pricing.status === 'READY' ? `¥${money(pricing.orderUnitPrice)}` : '价格待核验'}</span></button> })}</div></div></div>}
    {confirmOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-card bg-white p-4"><h2 className="text-h2">确认批量接单？</h2><p className="mt-2 text-caption text-gray2">将一次接单 {detail.group.memberCount} 张原订单。不会创建聚合订单，原订单号与历史保留不变。</p><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => setConfirmOpen(false)} className="rounded-cta border border-border px-4 py-2.5">取消</button><button onClick={() => void accept()} disabled={submitting} className="rounded-cta bg-ink px-4 py-2.5 text-white disabled:opacity-50">{submitting ? '提交中…' : '确认批量接单'}</button></div></div></div>}
  </div>
}
