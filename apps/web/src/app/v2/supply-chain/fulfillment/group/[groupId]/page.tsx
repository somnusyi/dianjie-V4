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
import { loadAllProductCatalog } from '@/lib/load-product-catalog'
import { clearShipmentDraft, readShipmentDraft, shipmentDraftStorageKey, writeShipmentDraft } from '@/lib/shipment-draft-storage'
import { apiFetch, getUser } from '@/lib/v2-auth'

const PURCHASE_QUANTITY_MAX = 99_999_999.99

type Item = { id: string; productId: string; name: string; spec: string | null; unit: string; quantity: string; unitPrice: string; amount: string }
type Member = {
  id: string; no: string; rowVersion: number; createdAt: string; submittedAt?: string | null; status?: string | null
  store?: { name?: string; address?: string | null } | null; supplier?: { name?: string } | null
  items: Item[]; orderedItems: Item[]; shipmentItems: Item[]
  deliverySummaries: Array<{ id: string; no: string; status: string; rowVersion: number; hasReceipt: boolean; items: Item[] }>
}
type Detail = {
  source: 'pending' | 'accepted'
  group: { id: string; supplierId: string; expectedDate: string; memberOrderIds: string[]; memberOrderNos: string[]; memberCount: number; firstCreatedAt: string; lastCreatedAt: string; isEligible?: boolean; blockedOrderIds?: string[] }
  orders: Member[]
  progressStep: number
  totals: { quantity: string; amount: string; orderedQuantity: string; orderedAmount: string; originalOrderAmount: string; shipmentQuantity: string; shipmentAmount: string; hasAnyShipment: boolean; snapshotComplete: boolean }
}
type DraftRow = OrderDetailTableRow & { productId: string; orderId: string; itemId: string; deliveryId?: string; isDeliveryAddition?: boolean }

function money(value: string | number) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fingerprint(rows: DraftRow[]) {
  return JSON.stringify([...rows].sort((a, b) => a.key.localeCompare(b.key)).map(row => [row.orderId, row.productId, row.quantity]))
}

function rowsFromDetail(detail: Detail): DraftRow[] {
  return detail.orders.flatMap(order => {
    if (detail.source === 'accepted' && order.deliverySummaries.length > 0) {
      return order.deliverySummaries.flatMap(delivery => delivery.items.map(item => ({
        key: `${order.id}:${item.id}`, itemId: item.id, orderId: order.id, deliveryId: delivery.id, productId: item.productId,
        name: item.name, spec: item.spec, unit: item.unit, quantity: Number(item.quantity),
        originalQuantity: Number(item.quantity), unitPrice: Number(item.unitPrice), sourceLabel: `原订单 #${order.no}`,
      })))
    }
    return order.orderedItems.map(item => ({
      key: `${order.id}:${item.id}`, itemId: item.id, orderId: order.id, productId: item.productId,
      name: item.name, spec: item.spec, unit: item.unit, quantity: Number(item.quantity),
      originalQuantity: Number(item.quantity), unitPrice: Number(item.unitPrice), sourceLabel: `原订单 #${order.no}`,
    }))
  })
}

export default function OperationGroupDetailPage() {
  const router = useRouter()
  const viewerUserId = getUser()?.id || ''
  const groupId = String((useParams() as { groupId?: string }).groupId || '')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [rows, setRows] = useState<DraftRow[]>([])
  const [removedShipmentRows, setRemovedShipmentRows] = useState<DraftRow[]>([])
  const [baseline, setBaseline] = useState('')
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({})
  const [catalog, setCatalog] = useState<RevisionCatalogProduct[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [addDeliveryId, setAddDeliveryId] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [shipConfirmOpen, setShipConfirmOpen] = useState(false)
  const [shipNote, setShipNote] = useState('')
  const requestKeyRef = useRef<string | null>(null)
  const confirmKeyRef = useRef<string | null>(null)
  const shipKeysRef = useRef<Record<string, string>>({})

  function shipmentDraftKey(orderId: string) {
    if (typeof window === 'undefined' || !viewerUserId) return null
    let tenantId = ''
    try {
      const storedTenant = JSON.parse(localStorage.getItem('tenant') || '{}')
      tenantId = String(storedTenant?.id || storedTenant?.slug || '')
    } catch {}
    if (!tenantId) return null
    return shipmentDraftStorageKey({ tenantId, userId: viewerUserId, orderId })
  }

  async function load() {
    setLoading(true); setLoadError(null)
    try {
      const data = await apiFetch<Detail>(`/api/orders/operation-groups/${encodeURIComponent(groupId)}`)
      const nextRows = rowsFromDetail(data)
      const confirmedIds = new Set(data.orders.filter(order => order.status === 'CONFIRMED').map(order => order.id))
      const restoredRemoved: DraftRow[] = []
      const restoredRows = nextRows.map(row => {
        if (!confirmedIds.has(row.orderId) || typeof window === 'undefined') return row
        const order = data.orders.find(candidate => candidate.id === row.orderId)!
        const orderRows = nextRows.filter(candidate => candidate.orderId === order.id)
        const draftKey = shipmentDraftKey(order.id)
        const draft = draftKey ? readShipmentDraft(localStorage, draftKey, {
          orderId: order.id,
          orderRowVersion: order.rowVersion,
          userId: viewerUserId,
          itemIds: orderRows.map(candidate => candidate.itemId),
        }) : null
        const quantity = draft?.quantities[row.itemId]
        const restored = quantity === undefined ? row : { ...row, quantity }
        if (draft?.removedItemIds?.includes(row.itemId)) restoredRemoved.push({ ...restored, quantity: 0 })
        return restored
      }).filter(row => !restoredRemoved.some(removed => removed.key === row.key))
      for (const order of data.orders.filter(candidate => candidate.status !== 'CONFIRMED')) {
        const draftKey = shipmentDraftKey(order.id)
        if (typeof window !== 'undefined' && draftKey) clearShipmentDraft(localStorage, draftKey)
      }
      const restoredShipmentRows = [...restoredRows, ...restoredRemoved]
      const editableDeliveryIds = new Set(data.orders.flatMap(order => order.deliverySummaries
        .filter(delivery => delivery.status === 'SHIPPED' && !delivery.hasReceipt)
        .map(delivery => delivery.id)))
      const baselineRows = data.source === 'pending'
        ? restoredRows
        : restoredShipmentRows.filter(row => confirmedIds.has(row.orderId) || Boolean(row.deliveryId && editableDeliveryIds.has(row.deliveryId)))
      setDetail(data); setRows(restoredRows); setRemovedShipmentRows(restoredRemoved); setBaseline(fingerprint(baselineRows)); setQuantityDrafts({}); requestKeyRef.current = null
    } catch (error: any) { setLoadError(error?.message || '集合加载失败') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [groupId])

  const sortedOrders = useMemo(() => [...(detail?.orders || [])].sort((a, b) => Date.parse(a.submittedAt || a.createdAt) - Date.parse(b.submittedAt || b.createdAt) || a.id.localeCompare(b.id)), [detail])
  const latestOrder = sortedOrders[sortedOrders.length - 1]
  const editable = detail?.source === 'pending' && detail.orders.every(order => order.status === 'SUBMITTED')
  const shipmentEditable = detail?.source === 'accepted' && detail.orders.some(order => order.status === 'CONFIRMED')
  const editableDeliveries = (detail?.orders || []).flatMap(order => order.deliverySummaries
    .filter(delivery => delivery.status === 'SHIPPED' && !delivery.hasReceipt)
    .map(delivery => ({ ...delivery, orderId: order.id, orderNo: order.no })))
  const deliveryEditable = editableDeliveries.length > 0
  const editableDeliveryIds = new Set(editableDeliveries.map(delivery => delivery.id))
  const detailEditable = Boolean(editable || shipmentEditable || deliveryEditable)
  const confirmedOrderIds = new Set((detail?.orders || []).filter(order => order.status === 'CONFIRMED').map(order => order.id))
  const shipmentRows = [...rows, ...removedShipmentRows]
  const editableRows = editable ? shipmentRows : shipmentRows.filter(row => confirmedOrderIds.has(row.orderId)
    || Boolean(row.deliveryId && editableDeliveryIds.has(row.deliveryId)) || row.isDeliveryAddition)
  const dirty = detailEditable && fingerprint(editableRows) !== baseline
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

  function removeShipmentRow(row: DraftRow) {
    if (!confirmedOrderIds.has(row.orderId) && !(row.deliveryId && editableDeliveryIds.has(row.deliveryId))) {
      setActionError('已经发货的原订单不能再次修改')
      return
    }
    setRows(current => current.filter(item => item.key !== row.key))
    setRemovedShipmentRows(current => [...current.filter(item => item.key !== row.key), { ...row, quantity: 0 }])
    setActionError(null); setNotice(null)
  }

  function restoreShipmentRow(row: DraftRow) {
    setRemovedShipmentRows(current => current.filter(item => item.key !== row.key))
    setRows(current => current.some(item => item.key === row.key)
      ? current
      : [...current, { ...row, quantity: row.originalQuantity }])
    setQuantityDrafts(current => {
      const next = { ...current }
      delete next[row.key]
      return next
    })
    setActionError(null); setNotice(null)
  }

  async function openAdd() {
    if (!detail || (!editable && !deliveryEditable)) return
    try {
      const list = await loadAllProductCatalog(detail.group.supplierId)
      setCatalog((list as RevisionCatalogProduct[]).filter(product => product.status === 'ENABLED'))
      setAddDeliveryId(editableDeliveries.length === 1 ? editableDeliveries[0].id : '')
      setSearch(''); setAddOpen(true); setActionError(null)
    } catch (error: any) { setActionError(error?.message || '加载商品目录失败') }
  }

  function addProduct(product: RevisionCatalogProduct) {
    const pricing = resolveRevisionCatalogPricing(product)
    if (pricing.status !== 'READY') { setActionError(pricing.message); return }
    if (!editable) {
      const delivery = editableDeliveries.find(candidate => candidate.id === addDeliveryId)
      if (!delivery) { setActionError('请先选择要增加商品的原订单'); return }
      if (delivery.items.some(item => item.productId === product.id)) {
        setActionError('该配送单已有此商品，请直接修改数量')
        return
      }
      const key = `delivery-add:${delivery.id}:${product.id}`
      setRows(current => {
        const existing = current.find(row => row.key === key)
        if (existing) return current.map(row => row.key === key ? { ...row, quantity: row.quantity + 1 } : row)
        return [...current, {
          key, itemId: key, orderId: delivery.orderId, deliveryId: delivery.id, isDeliveryAddition: true,
          productId: product.id, name: product.name, spec: product.spec || null, unit: pricing.orderUnit,
          quantity: 1, originalQuantity: 0, unitPrice: Number(pricing.orderUnitPrice),
          sourceLabel: `原订单 #${delivery.orderNo}`,
        }]
      })
      setAddOpen(false); setNotice(null); setActionError(null)
      return
    }
    if (!latestOrder) return
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
    if (!detail || !detailEditable || !dirty || submitting) return
    const invalid = rows.find(row => row.quantity < 0 || row.quantity > PURCHASE_QUANTITY_MAX || Math.abs(row.quantity * 100 - Math.round(row.quantity * 100)) > 0.000001)
    if (invalid) { setActionError(`${invalid.name}数量不能小于 0，且最多保留 2 位小数`); return }
    const saveDeliveryMutations = async () => {
      const mutationTargets = editableDeliveries.map(delivery => {
        const additions = rows
          .filter(row => row.isDeliveryAddition && row.deliveryId === delivery.id)
          .map(row => ({ productId: row.productId, quantity: row.quantity }))
        const quantityChanges = rows
          .filter(row => !row.isDeliveryAddition && row.deliveryId === delivery.id
            && Math.abs(row.quantity - row.originalQuantity) >= 0.0001)
          .map(row => ({ itemId: row.itemId, targetQuantity: row.quantity }))
        const removals = removedShipmentRows
          .filter(row => row.deliveryId === delivery.id)
          .map(row => ({ itemId: row.itemId }))
        return { delivery, additions, quantityChanges, removals }
      }).filter(target => target.additions.length > 0 || target.quantityChanges.length > 0 || target.removals.length > 0)

      for (let index = 0; index < mutationTargets.length; index += 1) {
        const target = mutationTargets[index]
        try {
          await apiFetch(`/api/deliveries/${encodeURIComponent(target.delivery.id)}/items`, {
            method: 'PATCH',
            body: JSON.stringify({
              rowVersion: target.delivery.rowVersion,
              reason: '集合商品明细统一保存',
              quantityChanges: target.quantityChanges,
              removals: target.removals,
              additions: target.additions,
            }),
          })
        } catch (error: any) {
          const remainingDeliveryIds = new Set(mutationTargets.slice(index).map(candidate => candidate.delivery.id))
          const remainingRows = rows.filter(row => row.deliveryId && remainingDeliveryIds.has(row.deliveryId))
          const remainingRemovedRows = removedShipmentRows.filter(row => row.deliveryId && remainingDeliveryIds.has(row.deliveryId))
          await load()
          setRows(current => [
            ...current.filter(row => !row.deliveryId || !remainingDeliveryIds.has(row.deliveryId)),
            ...remainingRows,
          ])
          setRemovedShipmentRows(current => [
            ...current.filter(row => !row.deliveryId),
            ...remainingRemovedRows,
          ])
          const completed = index
          throw new Error(completed > 0
            ? `已保存 ${completed} 张配送单；剩余修改已保留，可重试。${error?.message || '后续配送单保存失败'}`
            : error?.message || '配送商品明细保存失败')
        }
      }
    }
    if (shipmentEditable) {
      if (typeof window === 'undefined' || !viewerUserId) {
        setActionError('无法确认当前用户，实发数量未保存')
        return
      }
      const emptyOrder = detail.orders
        .filter(order => order.status === 'CONFIRMED')
        .find(order => !rows.some(row => row.orderId === order.id))
      if (emptyOrder) {
        setActionError(`#${emptyOrder.no} 的所有商品已被移除，请至少恢复一个商品后再保存`)
        return
      }
      try {
        for (const order of detail.orders.filter(candidate => candidate.status === 'CONFIRMED')) {
          const draftKey = shipmentDraftKey(order.id)
          if (!draftKey) throw new Error('无法确认当前租户')
          const orderRows = shipmentRows.filter(row => row.orderId === order.id)
          writeShipmentDraft(localStorage, draftKey, {
            version: 1,
            orderId: order.id,
            orderRowVersion: order.rowVersion,
            userId: viewerUserId,
            quantities: Object.fromEntries(orderRows.map(row => [row.itemId, row.quantity])),
            removedItemIds: removedShipmentRows.filter(row => row.orderId === order.id).map(row => row.itemId),
            updatedAt: new Date().toISOString(),
          })
        }
      } catch {
        setActionError('实发数量保存失败，请检查浏览器存储空间')
        return
      }
      const hasDeliveryMutations = editableDeliveries.some(delivery => rows.some(row => row.deliveryId === delivery.id
        && (row.isDeliveryAddition || Math.abs(row.quantity - row.originalQuantity) >= 0.0001))
        || removedShipmentRows.some(row => row.deliveryId === delivery.id))
      if (hasDeliveryMutations) {
        setSubmitting(true)
        try {
          await saveDeliveryMutations()
          await load()
          setNotice('实发数量草稿和配送商品明细已保存')
        } catch (error: any) {
          setActionError(error?.message || '配送商品明细保存失败')
        } finally { setSubmitting(false) }
      } else {
        setBaseline(fingerprint(editableRows))
        setNotice('实发商品数量已保存到本机，刷新页面也会保留；可继续批量确认发货')
        setActionError(null)
      }
      return
    }
    if (deliveryEditable) {
      setSubmitting(true); setActionError(null)
      try {
        await saveDeliveryMutations()
        await load(); setNotice('配送商品明细已保存')
      } catch (error: any) { setActionError(error?.message || '配送商品明细保存失败') }
      finally { setSubmitting(false) }
      return
    }
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

  async function shipGroup() {
    if (!detail || !shipmentEditable || dirty || submitting) return
    const confirmedOrders = detail.orders.filter(order => order.status === 'CONFIRMED')
    const emptyOrder = confirmedOrders.find(order => !shipmentRows.some(row => row.orderId === order.id && row.quantity > 0))
    if (emptyOrder) {
      setActionError(`#${emptyOrder.no} 的实发数量全部为 0，不能发货`)
      setShipConfirmOpen(false)
      return
    }
    setSubmitting(true); setActionError(null)
    let completed = 0
    try {
      for (const order of confirmedOrders) {
        const idempotencyKey = shipKeysRef.current[order.id] || clientRequestId()
        shipKeysRef.current[order.id] = idempotencyKey
        await apiFetch(`/api/orders/${encodeURIComponent(order.id)}/ship`, {
          method: 'PATCH',
          body: JSON.stringify({
            note: shipNote.trim() || undefined,
            idempotencyKey,
            items: shipmentRows.filter(row => row.orderId === order.id).map(row => ({ itemId: row.itemId, shippedQty: row.quantity })),
          }),
        })
        const draftKey = shipmentDraftKey(order.id)
        if (typeof window !== 'undefined' && draftKey) clearShipmentDraft(localStorage, draftKey)
        delete shipKeysRef.current[order.id]
        completed += 1
      }
      setShipConfirmOpen(false); setShipNote('')
      await load(); setNotice(`批量发货成功，已分别生成 ${completed} 张配送单`)
    } catch (error: any) {
      await load()
      setActionError(completed > 0
        ? `已完成 ${completed} 张，其余未发货：${error?.message || '发货失败'}。可再次点击继续发货。`
        : error?.message || '批量发货失败')
    } finally { setSubmitting(false) }
  }

  if (loading) return <div className="min-h-screen bg-bg p-5 text-center text-caption text-gray3">集合加载中…</div>
  if (loadError || !detail) return <div className="min-h-screen bg-bg p-4"><button onClick={() => router.back()} className="text-caption text-gray2">‹ 返回</button><div className="mt-6 rounded-card bg-red-bg p-4 text-red-fg">{loadError || '集合不存在'}</div></div>

  const first = detail.orders[0]
  const productTotal = rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0)
  const deliveryLines = detail.orders.flatMap(order => order.deliverySummaries.flatMap(delivery =>
    delivery.items.map(item => `${item.name}${item.quantity}${item.unit}`)))
  const filteredCatalog = catalog.filter(product => !search.trim() || `${product.name} ${product.spec || ''}`.toLowerCase().includes(search.trim().toLowerCase()))

  return <div className="min-h-screen bg-bg pb-28">
    <OrderDetailHeader onBack={() => router.back()} onDeliveryNote={() => router.push(`/v2/supply-chain/fulfillment/${encodeURIComponent(detail.group.id)}/delivery-note`)}
      statusLabel={detail.source === 'pending' ? '待接单集合' : '已接单集合'} statusTone={detail.source === 'pending' ? 'orange' : 'green'} />
    {actionError && <div className="mx-4 mt-2 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{actionError}</div>}
    {notice && <div className="mx-4 mt-2 rounded-card border border-green-fg/20 bg-green-bg p-3 text-caption text-green-fg">{notice}</div>}

    <OrderAmountCard eyebrow={`${detail.group.memberCount} 张原订单 · ${detail.group.memberOrderNos.map(no => `#${no}`).join('、')}`}
      name={first?.store?.name || '未知门店'} amountLabel="实发金额"
      amount={money(detailEditable ? productTotal : detail.totals.hasAnyShipment ? detail.totals.shipmentAmount : productTotal)} originalOrderAmount={money(detail.totals.originalOrderAmount)}>
      {first?.store?.address && <div className="mt-1 text-micro text-gray3">📍 {first.store.address}</div>}
      <div className="mt-2 text-caption text-gray2">下单 {dayjs(detail.group.firstCreatedAt).format('MM/DD HH:mm')}{detail.group.firstCreatedAt !== detail.group.lastCreatedAt && ` — ${dayjs(detail.group.lastCreatedAt).format('MM/DD HH:mm')}`} · 期望到货 {dayjs(detail.group.expectedDate).format('MM/DD')}<br />供应商 {first?.supplier?.name || '-'}</div>
    </OrderAmountCard>
    <OrderDeliverySummary lines={deliveryLines} />
    <OrderProgressCard currentIndex={detail.progressStep} />
    <OrderProductTable rows={rows} editable={detailEditable} total={money(productTotal)} saving={submitting} dirty={Boolean(dirty)} onAdd={(editable || deliveryEditable) ? () => void openAdd() : undefined} onSave={() => void save()} onRemove={row => {
      const draftRow = row as DraftRow
      if (editable) removeRow(draftRow)
      else if (draftRow.isDeliveryAddition) { setRows(current => current.filter(item => item.key !== draftRow.key)); setActionError(null); setNotice(null) }
      else removeShipmentRow(draftRow)
    }} canRemove={row => {
      const draftRow = row as DraftRow
      return Boolean(editable || confirmedOrderIds.has(draftRow.orderId) || draftRow.isDeliveryAddition
        || (draftRow.deliveryId && editableDeliveryIds.has(draftRow.deliveryId)))
    }}
      notice={editable ? <p className="mx-3 mb-2 text-micro text-gray3">每行标明原订单归属；点一次保存后，所有变化在同一个事务中生效或全部回滚。</p> : (shipmentEditable || deliveryEditable) ? <div className="mx-3 mb-2">
        <p className="text-micro text-gray3">这里填写每张原订单的实发数量；数量 0 仍保留商品，“移除”才会从本次发货中删除。</p>
        {removedShipmentRows.length > 0 && <div className="mt-2 rounded-cta border border-amber/30 bg-amber/10 p-2">
          <div className="text-micro text-amber-fg">已移除商品（可恢复）</div>
          <div className="mt-1 flex flex-wrap gap-2">{removedShipmentRows.map(row => <button key={row.key} type="button" onClick={() => restoreShipmentRow(row)}
            className="rounded-cta border border-amber bg-white px-2 py-1 text-micro text-amber-fg">恢复 {row.name} · {row.sourceLabel}</button>)}</div>
        </div>}
      </div> : null}
      renderQuantity={rowBase => {
        const row = rowBase as DraftRow
        const rowEditable = Boolean(editable || confirmedOrderIds.has(row.orderId) || row.isDeliveryAddition
          || (row.deliveryId && editableDeliveryIds.has(row.deliveryId)))
        return rowEditable ? <span className="inline-flex items-center gap-1"><input type="number" inputMode="decimal" min="0" max={PURCHASE_QUANTITY_MAX} step="0.01" aria-label={`${row.name}数量`}
          value={quantityDrafts[row.key] ?? String(row.quantity)} onChange={event => { const raw = event.target.value; setQuantityDrafts(current => ({ ...current, [row.key]: raw })); if (raw !== '') updateQuantity(row, Number(raw)) }}
          onBlur={() => setQuantityDrafts(current => { const next = { ...current }; delete next[row.key]; return next })}
          className={`w-24 rounded-cta border bg-white px-2 py-1 text-right font-num ${Math.abs(row.quantity - row.originalQuantity) >= 0.0001 ? 'border-red text-red-fg' : 'border-border text-ink'}`} /><span className="text-gray3">{row.unit}</span></span> : <>{row.quantity}{row.unit}</>
      }} />

    <section className="mx-4 mt-3 rounded-card border border-border bg-white"><div className="border-b border-border px-4 py-3"><h2 className="text-h2">集合内订单 ({detail.orders.length})</h2></div><div className="overflow-x-auto"><table className="w-full min-w-[420px] text-caption"><thead className="bg-bg text-micro text-gray3"><tr><th className="px-4 py-2 text-left">序号</th><th className="px-4 py-2 text-left">原订单号</th><th className="px-4 py-2 text-left">下单时间</th></tr></thead><tbody className="divide-y divide-border">{sortedOrders.map((order, index) => <tr key={order.id}><td className="px-4 py-3 font-num text-gray3">{index + 1}</td><td className="px-4 py-3 font-num">#{order.no}</td><td className="px-4 py-3 text-gray2">{dayjs(order.createdAt).format('MM/DD HH:mm')}</td></tr>)}</tbody></table></div></section>

    {shipmentEditable && <section className="mx-4 mt-3 rounded-card border border-border bg-white p-4"><label className="mb-1 block text-micro text-gray3">发货备注（选填）</label><input value={shipNote} onChange={event => setShipNote(event.target.value)} maxLength={200} placeholder="例如司机、车辆或送货说明" className="w-full rounded-cta border border-border bg-bg px-3 py-2 text-body" /></section>}

    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-white/95 p-3 backdrop-blur"><div className="mx-auto max-w-5xl">{detail.source === 'pending'
      ? <button onClick={() => setConfirmOpen(true)} disabled={!canAccept || submitting} className="w-full rounded-cta bg-ink px-4 py-3 text-button text-white disabled:opacity-40">批量接单</button>
      : shipmentEditable
        ? <button onClick={() => setShipConfirmOpen(true)} disabled={dirty || submitting} className="w-full rounded-cta bg-ink px-4 py-3 text-button text-white disabled:opacity-40">{dirty ? '请先保存实发数量' : '批量确认发货'}</button>
        : <div className="rounded-cta bg-green-bg px-4 py-3 text-center text-button text-green-fg">集合已发货</div>}</div></div>

    {addOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true"><div className="w-full max-w-lg rounded-card bg-white p-4"><div className="flex items-center"><h2 className="flex-1 text-h2">增加商品</h2><button onClick={() => setAddOpen(false)} className="text-caption text-gray2">关闭</button></div>{!editable && <label className="mt-3 block text-micro text-gray3">加入哪张原订单配送单<select value={addDeliveryId} onChange={event => { setAddDeliveryId(event.target.value); setActionError(null) }} className="mt-1 w-full rounded-cta border border-border bg-white px-3 py-2 text-body"><option value="">请选择原订单</option>{editableDeliveries.map(delivery => <option key={delivery.id} value={delivery.id}>原订单 #{delivery.orderNo}</option>)}</select></label>}<input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索商品名称或规格" className="mt-3 w-full rounded-cta border border-border bg-bg px-3 py-2" /><div className="mt-3 max-h-[55vh] overflow-y-auto rounded-cta border border-border">{filteredCatalog.map(product => { const pricing = resolveRevisionCatalogPricing(product); return <button key={product.id} disabled={pricing.status !== 'READY' || (!editable && !addDeliveryId)} onClick={() => addProduct(product)} className="flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left last:border-0 disabled:opacity-40"><span className="min-w-0 flex-1"><span className="block">{product.name}</span><span className="text-micro text-gray3">{product.spec || '-'}</span></span><span className="font-num text-caption">{pricing.status === 'READY' ? `¥${money(pricing.orderUnitPrice)}` : '价格待核验'}</span></button> })}</div></div></div>}
    {confirmOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-card bg-white p-4"><h2 className="text-h2">确认批量接单？</h2><p className="mt-2 text-caption text-gray2">将一次接单 {detail.group.memberCount} 张原订单。不会创建聚合订单，原订单号与历史保留不变。</p><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => setConfirmOpen(false)} className="rounded-cta border border-border px-4 py-2.5">取消</button><button onClick={() => void accept()} disabled={submitting} className="rounded-cta bg-ink px-4 py-2.5 text-white disabled:opacity-50">{submitting ? '提交中…' : '确认批量接单'}</button></div></div></div>}
    {shipConfirmOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-card bg-white p-4"><h2 className="text-h2">确认批量发货？</h2><p className="mt-2 whitespace-pre-line text-caption text-gray2">将发货 {detail.orders.filter(order => order.status === 'CONFIRMED').length} 张原订单，并按原订单分别生成配送单。{shipNote.trim() ? `\n备注：${shipNote.trim()}` : ''}</p><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => setShipConfirmOpen(false)} className="rounded-cta border border-border px-4 py-2.5">取消</button><button onClick={() => void shipGroup()} disabled={submitting} className="rounded-cta bg-ink px-4 py-2.5 text-white disabled:opacity-50">{submitting ? '发货中…' : '确认批量发货'}</button></div></div></div>}
  </div>
}
