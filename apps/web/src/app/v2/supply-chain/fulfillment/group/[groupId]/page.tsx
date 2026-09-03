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
import {
  matchesWarehouseProductSearch,
  RevisionCatalogProduct,
  resolveRevisionCatalogPricing,
} from '@/lib/supplier-revision-cost-pricing'
import { loadAllWarehouseProductCatalog } from '@/lib/load-product-catalog'
import { buildOperationGroupDeliveryNoteProjection } from '@/lib/operation-group-delivery-note-preview'
import { apiFetch, getUser } from '@/lib/v2-auth'

const PURCHASE_QUANTITY_MAX = 99_999_999.99
const GROUP_DELIVERY_NOTE_PREVIEW_PREFIX = 'dianjie:operation-group-print-preview:'
const GROUP_DELIVERY_NOTE_PREVIEW_INDEX_PREFIX = 'dianjie:operation-group-print-preview-latest:'
const GROUP_DELIVERY_NOTE_PREVIEW_TTL_MS = 30 * 60 * 1000

type Item = {
  id: string
  purchaseOrderItemId?: string | null
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: string
  unitPrice: string
  amount: string
}
type Member = {
  id: string; no: string; rowVersion: number; createdAt: string; submittedAt?: string | null; status?: string | null
  store?: { name?: string; address?: string | null } | null; supplier?: { name?: string } | null
  items: Item[]; orderedItems: Item[]; shipmentItems: Item[]
  shipmentDraft?: ServerShipmentDraft | null
  deliverySummaries: Array<{ id: string; no: string; status: string; rowVersion: number; hasReceipt: boolean; items: Item[] }>
}
type Detail = {
  source: 'pending' | 'accepted'
  group: { id: string; supplierId: string; expectedDate: string; memberOrderIds: string[]; memberOrderNos: string[]; memberCount: number; firstCreatedAt: string; lastCreatedAt: string; isEligible?: boolean; blockedOrderIds?: string[] }
  orders: Member[]
  progressStep: number
  totals: { quantity: string; amount: string; orderedQuantity: string; orderedAmount: string; originalOrderAmount: string; shipmentQuantity: string; shipmentAmount: string; hasAnyShipment: boolean; snapshotComplete: boolean }
}
type ServerShipmentDraft = {
  id: string
  no: string
  status: 'DRAFT'
  rowVersion: number
  items: Array<{
    id: string
    purchaseOrderItemId?: string | null
    productId: string
    shippedQty: string
    unitPriceSnapshot?: string | null
    amount?: string | null
    productSpecSnapshot?: string | null
    productUnitSnapshot?: string | null
    productNameSnapshot?: string | null
    product?: { name?: string | null; spec?: string | null; unit?: string | null } | null
  }>
}
type DraftRow = OrderDetailTableRow & {
  productId: string
  orderId: string
  itemId: string
  purchaseOrderItemId?: string | null
  deliveryId?: string
  isShipmentAddition?: boolean
  isUnsavedAddition?: boolean
  isDeliveryAddition?: boolean
}

type GroupDeliveryNotePreview = {
  schemaVersion: 2
  groupId: string
  ownerUserId: string
  tenantKey: string
  createdAt: number
  expiresAt: number
  serverSignature: string
  draftRows: DraftRow[]
  items: Array<{
    id: string
    productId: string
    name: string
    spec: string | null
    unit: string
    quantity: number
    shippedQty: number
    unitPrice: number
    amount: number
  }>
  totals: { quantity: number; amount: number }
}

function currentPreviewIdentity(): { ownerUserId: string; tenantKey: string } {
  const ownerUserId = String(getUser()?.id || '')
  let tenantKey = ''
  if (typeof window !== 'undefined') {
    try {
      const tenant = JSON.parse(window.localStorage.getItem('tenant') || '{}')
      tenantKey = String(tenant?.id || tenant?.slug || '')
    } catch {
      tenantKey = ''
    }
  }
  return { ownerUserId, tenantKey }
}

function operationGroupServerSignature(detail: Detail, shipmentDrafts: Record<string, ServerShipmentDraft>): string {
  return JSON.stringify([...detail.orders]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(order => [
      order.id,
      Number(order.rowVersion),
      String(order.status || ''),
      shipmentDrafts[order.id]
        ? [shipmentDrafts[order.id].id, Number(shipmentDrafts[order.id].rowVersion)]
        : null,
      [...order.deliverySummaries]
        .filter(delivery => delivery.status !== 'DRAFT')
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(delivery => [
          delivery.id,
          Number(delivery.rowVersion),
          String(delivery.status || ''),
          Boolean(delivery.hasReceipt),
        ]),
    ]))
}

function previewStorageKey(groupId: string, token: string) {
  return `${GROUP_DELIVERY_NOTE_PREVIEW_PREFIX}${groupId}:${token}`
}

function previewIndexKey(groupId: string) {
  return `${GROUP_DELIVERY_NOTE_PREVIEW_INDEX_PREFIX}${groupId}`
}

function discardDeliveryNotePreview(groupId: string, token?: string | null) {
  if (typeof window === 'undefined') return
  try {
    const latestKey = previewIndexKey(groupId)
    const resolvedToken = token || window.sessionStorage.getItem(latestKey)
    if (resolvedToken) window.sessionStorage.removeItem(previewStorageKey(groupId, resolvedToken))
    if (!token || window.sessionStorage.getItem(latestKey) === token) {
      window.sessionStorage.removeItem(latestKey)
    }
  } catch {
    // A locked-down WebView may deny sessionStorage. There is no recoverable
    // local preview to clear in that case.
  }
}

function draftRowsFromPreview(
  detail: Detail,
  shipmentDrafts: Record<string, ServerShipmentDraft>,
): DraftRow[] | null {
  if (typeof window === 'undefined') return null
  const { ownerUserId, tenantKey } = currentPreviewIdentity()
  const latestKey = previewIndexKey(detail.group.id)
  let token = ''
  try {
    token = window.sessionStorage.getItem(latestKey) || ''
    if (!/^[0-9a-f-]{36}$/i.test(token)) {
      discardDeliveryNotePreview(detail.group.id, token)
      return null
    }
    const raw = window.sessionStorage.getItem(previewStorageKey(detail.group.id, token))
    if (!raw) {
      discardDeliveryNotePreview(detail.group.id, token)
      return null
    }
    const preview = JSON.parse(raw) as Partial<GroupDeliveryNotePreview>
    const createdAt = Number(preview.createdAt)
    const expiresAt = Number(preview.expiresAt)
    const now = Date.now()
    const identityMatches = Boolean(ownerUserId && tenantKey
      && preview.ownerUserId === ownerUserId && preview.tenantKey === tenantKey)
    if (preview.schemaVersion !== 2 || preview.groupId !== detail.group.id || !identityMatches
      || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt <= 0 || createdAt > now
      || expiresAt <= now || expiresAt - createdAt !== GROUP_DELIVERY_NOTE_PREVIEW_TTL_MS
      || preview.serverSignature !== operationGroupServerSignature(detail, shipmentDrafts)
      || !Array.isArray(preview.draftRows) || preview.draftRows.length > 5000) {
      discardDeliveryNotePreview(detail.group.id, token)
      return null
    }

    const orderIds = new Set(detail.orders.map(order => order.id))
    const deliveryIds = new Set(detail.orders.flatMap(order => order.deliverySummaries
      .filter(delivery => delivery.status !== 'DRAFT')
      .map(delivery => delivery.id)))
    const seenKeys = new Set<string>()
    const restoredRows: DraftRow[] = []
    for (const candidate of preview.draftRows) {
      const row = candidate as Partial<DraftRow>
      const key = String(row.key || '')
      const itemId = String(row.itemId || '')
      const orderId = String(row.orderId || '')
      const productId = String(row.productId || '')
      const name = String(row.name || '')
      const unit = String(row.unit || '')
      const quantity = Number(row.quantity)
      const originalQuantity = Number(row.originalQuantity)
      const unitPrice = Number(row.unitPrice)
      const deliveryId = row.deliveryId == null ? undefined : String(row.deliveryId)
      if (!key || seenKeys.has(key) || !itemId || !orderIds.has(orderId) || !productId || !name || !unit
        || !Number.isFinite(quantity) || quantity < 0 || quantity > PURCHASE_QUANTITY_MAX
        || !Number.isFinite(originalQuantity) || originalQuantity < 0 || originalQuantity > PURCHASE_QUANTITY_MAX
        || !Number.isFinite(unitPrice) || unitPrice < 0
        || (deliveryId && !deliveryIds.has(deliveryId))) {
        discardDeliveryNotePreview(detail.group.id, token)
        return null
      }
      seenKeys.add(key)
      restoredRows.push({
        key,
        itemId,
        orderId,
        productId,
        name,
        spec: row.spec == null ? null : String(row.spec),
        unit,
        quantity,
        originalQuantity,
        unitPrice,
        ...(row.purchaseOrderItemId == null ? {} : { purchaseOrderItemId: String(row.purchaseOrderItemId) }),
        ...(deliveryId ? { deliveryId } : {}),
        ...(row.sourceLabel == null ? {} : { sourceLabel: String(row.sourceLabel) }),
        ...(row.pendingRemoval === true ? { pendingRemoval: true } : { pendingRemoval: false }),
        ...(row.isShipmentAddition === true ? { isShipmentAddition: true } : {}),
        ...(row.isUnsavedAddition === true ? { isUnsavedAddition: true } : {}),
        ...(row.isDeliveryAddition === true ? { isDeliveryAddition: true } : {}),
      })
    }
    return restoredRows
  } catch {
    discardDeliveryNotePreview(detail.group.id, token)
    return null
  }
}

function money(value: string | number) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function quantityDraftReason(rawValue: string): string | null {
  const text = rawValue.trim()
  const value = Number(text)
  if (!text || !Number.isFinite(value) || value < 0) return '数量不能为空且不能小于 0'
  if (value > PURCHASE_QUANTITY_MAX) return '数量超过系统上限'
  if (Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) return '数量最多保留 2 位小数'
  return null
}

function fingerprint(rows: DraftRow[]) {
  return JSON.stringify([...rows].sort((a, b) => a.key.localeCompare(b.key)).map(row => [
    row.orderId,
    row.productId,
    row.quantity,
    row.pendingRemoval === true,
  ]))
}

function rowsFromDetail(detail: Detail, shipmentDrafts: Record<string, ServerShipmentDraft>): DraftRow[] {
  return detail.orders.flatMap<DraftRow>(order => {
    const shipmentDraft = order.status === 'CONFIRMED' ? shipmentDrafts[order.id] : null
    if (detail.source === 'accepted' && shipmentDraft) {
      return shipmentDraft.items.map(item => ({
        key: `${order.id}:${item.id}`,
        itemId: item.id,
        purchaseOrderItemId: item.purchaseOrderItemId || null,
        orderId: order.id,
        productId: item.productId,
        name: item.product?.name || item.productNameSnapshot || '—',
        spec: item.productSpecSnapshot || item.product?.spec || null,
        unit: item.productUnitSnapshot || item.product?.unit || '—',
        quantity: Number(item.shippedQty),
        originalQuantity: Number(item.shippedQty),
        unitPrice: Number(item.unitPriceSnapshot || 0),
        sourceLabel: `原订单 #${order.no}`,
        isShipmentAddition: !item.purchaseOrderItemId,
        pendingRemoval: false,
      }))
    }
    if (detail.source === 'accepted' && order.deliverySummaries.length > 0) {
      return order.deliverySummaries.flatMap(delivery => delivery.items.map(item => ({
        key: `${order.id}:${item.id}`, itemId: item.id, purchaseOrderItemId: item.purchaseOrderItemId || null,
        orderId: order.id, deliveryId: delivery.id, productId: item.productId,
        name: item.name, spec: item.spec, unit: item.unit, quantity: Number(item.quantity),
        originalQuantity: Number(item.quantity), unitPrice: Number(item.unitPrice), sourceLabel: `原订单 #${order.no}`,
        pendingRemoval: false,
      })))
    }
    return order.orderedItems.map(item => ({
      key: `${order.id}:${item.id}`, itemId: item.id, purchaseOrderItemId: item.id,
      orderId: order.id, productId: item.productId,
      name: item.name, spec: item.spec, unit: item.unit, quantity: Number(item.quantity),
      originalQuantity: Number(item.quantity), unitPrice: Number(item.unitPrice), sourceLabel: `原订单 #${order.no}`,
      pendingRemoval: false,
    }))
  })
}

export default function OperationGroupDetailPage() {
  const router = useRouter()
  const groupId = String((useParams() as { groupId?: string }).groupId || '')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [rows, setRows] = useState<DraftRow[]>([])
  const [shipmentDrafts, setShipmentDrafts] = useState<Record<string, ServerShipmentDraft>>({})
  const [baseline, setBaseline] = useState('')
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({})
  const [catalog, setCatalog] = useState<RevisionCatalogProduct[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [addDeliveryId, setAddDeliveryId] = useState('')
  const [addProductId, setAddProductId] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [shipConfirmOpen, setShipConfirmOpen] = useState(false)
  const [shipNote, setShipNote] = useState('')
  const [deliverConfirmOpen, setDeliverConfirmOpen] = useState(false)
  const [deliverNote, setDeliverNote] = useState('')
  const requestKeyRef = useRef<string | null>(null)
  const confirmKeyRef = useRef<string | null>(null)
  const shipKeysRef = useRef<Record<string, string>>({})

  async function load() {
    setLoading(true); setLoadError(null)
    try {
      const data = await apiFetch<Detail>(`/api/orders/operation-groups/${encodeURIComponent(groupId)}`)
      const nextShipmentDrafts = Object.fromEntries(data.orders.flatMap(order =>
        order.status === 'CONFIRMED' && order.shipmentDraft
          ? [[order.id, order.shipmentDraft] as const]
          : []))
      const nextRows = rowsFromDetail(data, nextShipmentDrafts)
      const confirmedIds = new Set(data.orders.filter(order => order.status === 'CONFIRMED').map(order => order.id))
      const editableDeliveryIds = new Set(data.orders.flatMap(order => order.deliverySummaries
        .filter(delivery => ['SHIPPED', 'DELIVERED'].includes(delivery.status) && !delivery.hasReceipt)
        .map(delivery => delivery.id)))
      const baselineRows = data.source === 'pending'
        ? nextRows
        : nextRows.filter(row => confirmedIds.has(row.orderId) || Boolean(row.deliveryId && editableDeliveryIds.has(row.deliveryId)))
      const recoveredRows = draftRowsFromPreview(data, nextShipmentDrafts)
      setDetail(data)
      setRows(recoveredRows || nextRows)
      setShipmentDrafts(nextShipmentDrafts)
      setBaseline(fingerprint(baselineRows))
      setQuantityDrafts({})
      if (recoveredRows) setNotice('已恢复查看送货单前未保存的商品明细')
      requestKeyRef.current = null
    } catch (error: any) { setLoadError(error?.message || '集合加载失败') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [groupId])

  const sortedOrders = useMemo(() => [...(detail?.orders || [])].sort((a, b) => Date.parse(a.submittedAt || a.createdAt) - Date.parse(b.submittedAt || b.createdAt) || a.id.localeCompare(b.id)), [detail])
  const deliveryNoteProjection = useMemo(() => buildOperationGroupDeliveryNoteProjection(rows), [rows])
  const latestOrder = sortedOrders[sortedOrders.length - 1]
  const editable = detail?.source === 'pending' && detail.orders.every(order => order.status === 'SUBMITTED')
  const shipmentEditable = detail?.source === 'accepted' && detail.orders.some(order => order.status === 'CONFIRMED')
  const editableDeliveries = (detail?.orders || []).flatMap(order => order.deliverySummaries
    .filter(delivery => ['SHIPPED', 'DELIVERED'].includes(delivery.status) && !delivery.hasReceipt)
    .map(delivery => ({ ...delivery, orderId: order.id, orderNo: order.no })))
  const deliveryEditable = editableDeliveries.length > 0
  const editableDeliveryIds = new Set(editableDeliveries.map(delivery => delivery.id))
  const detailEditable = Boolean(editable || shipmentEditable || deliveryEditable)
  const confirmedOrders = (detail?.orders || []).filter(order => order.status === 'CONFIRMED')
  const deliveringOrders = (detail?.orders || []).filter(order => order.status === 'DELIVERING')
  const pendingConfirmOrders = (detail?.orders || []).filter(order => order.status === 'PENDING_CONFIRM')
  const confirmedOrderIds = new Set(confirmedOrders.map(order => order.id))
  const editableRows = editable ? rows : rows.filter(row => confirmedOrderIds.has(row.orderId)
    || Boolean(row.deliveryId && editableDeliveryIds.has(row.deliveryId)) || row.isDeliveryAddition)
  const hasInvalidQuantityDraft = Object.values(quantityDrafts)
    .some(raw => quantityDraftReason(raw) !== null)
  const dirty = detailEditable && (fingerprint(editableRows) !== baseline || hasInvalidQuantityDraft)
  const blocked = Boolean(detail?.group.blockedOrderIds?.length)
  const canAccept = Boolean(detail?.source === 'pending' && detail.group.isEligible && !blocked && !dirty)

  function updateQuantity(row: DraftRow, value: number) {
    // Keep the last valid row value authoritative. Invalid raw text stays in
    // quantityDrafts so preview/save remain blocked until the user corrects it.
    if (quantityDraftReason(String(value)) !== null) return
    clearDeliveryNotePreview()
    setRows(current => current.map(item => item.key === row.key ? { ...item, quantity: value } : item))
    setActionError(null); setNotice(null)
  }

  function removeRow(row: DraftRow) {
    clearDeliveryNotePreview()
    setRows(current => current.map(item => item.key === row.key ? { ...item, pendingRemoval: true } : item))
    setActionError(null); setNotice(null)
  }

  function removeShipmentRow(row: DraftRow) {
    if (!confirmedOrderIds.has(row.orderId) && !(row.deliveryId && editableDeliveryIds.has(row.deliveryId))) {
      setActionError('已经发货的原订单不能再次修改')
      return
    }
    clearDeliveryNotePreview()
    setRows(current => current.map(item => item.key === row.key ? { ...item, pendingRemoval: true } : item))
    setActionError(null); setNotice(null)
  }

  function restoreShipmentRow(row: DraftRow) {
    clearDeliveryNotePreview()
    setRows(current => current.map(item => item.key === row.key ? { ...item, pendingRemoval: false } : item))
    setQuantityDrafts(current => {
      const next = { ...current }
      delete next[row.key]
      return next
    })
    setActionError(null); setNotice(null)
  }

  async function openAdd() {
    if (!detail || !detailEditable) return
    try {
      const list = await loadAllWarehouseProductCatalog(detail.group.supplierId)
      const snapshotProductIds = new Set<string>()
      const products = new Map((list as RevisionCatalogProduct[]).map(product => [product.id, product]))
      const snapshotItems = [
        ...detail.orders.flatMap(order => order.orderedItems),
        ...rows.map(row => ({
          productId: row.productId,
          name: row.name,
          spec: row.spec,
          unit: row.unit,
          unitPrice: String(row.unitPrice),
        })),
      ]
      for (const item of snapshotItems) {
        snapshotProductIds.add(item.productId)
        if (products.has(item.productId)) continue
        products.set(item.productId, {
          id: item.productId,
          name: item.name || '商品',
          spec: item.spec || null,
          unit: item.unit || '—',
          price: item.unitPrice,
          status: 'ORDER_SNAPSHOT',
        })
      }
      setCatalog([...products.values()]
        .filter(product => product.status === 'ENABLED' || snapshotProductIds.has(product.id)))
      const addTargets = [
        ...confirmedOrders.map(order => `order:${order.id}`),
        ...editableDeliveries.map(delivery => `delivery:${delivery.id}`),
      ]
      setAddDeliveryId(addTargets.length === 1 ? addTargets[0] : '')
      setAddProductId(''); setSearch(''); setAddOpen(true); setActionError(null)
    } catch (error: any) { setActionError(error?.message || '加载商品目录失败') }
  }

  function addProduct(product: RevisionCatalogProduct) {
    if (shipmentEditable && addDeliveryId.startsWith('order:')) {
      const orderId = addDeliveryId.slice('order:'.length)
      const order = confirmedOrders.find(candidate => candidate.id === orderId)
      if (!order) { setActionError('请先选择要增加商品的原订单'); return }
      const existing = rows.find(row => row.orderId === order.id && row.productId === product.id)
      if (existing?.pendingRemoval) {
        restoreShipmentRow(existing)
      } else if (existing) {
        setActionError('该原订单已有此商品，请直接修改数量')
        return
      } else {
        const orderedItem = order.orderedItems.find(item => item.productId === product.id)
        const pricing = resolveRevisionCatalogPricing(product)
        if (!orderedItem && pricing.status !== 'READY') { setActionError(pricing.message); return }
        clearDeliveryNotePreview()
        setRows(current => [...current, orderedItem ? {
          key: `${order.id}:${orderedItem.id}`,
          itemId: orderedItem.id,
          purchaseOrderItemId: orderedItem.id,
          orderId: order.id,
          productId: orderedItem.productId,
          name: orderedItem.name,
          spec: orderedItem.spec,
          unit: orderedItem.unit,
          quantity: Number(orderedItem.quantity),
          originalQuantity: Number(orderedItem.quantity),
          unitPrice: Number(orderedItem.unitPrice),
          sourceLabel: `原订单 #${order.no}`,
          pendingRemoval: false,
        } : {
          key: `shipment-add:${order.id}:${product.id}`,
          itemId: `shipment-add:${product.id}`,
          purchaseOrderItemId: null,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          spec: product.spec || null,
          unit: pricing.status === 'READY' ? pricing.orderUnit : product.unit || '—',
          quantity: 1,
          originalQuantity: 0,
          unitPrice: pricing.status === 'READY' ? Number(pricing.orderUnitPrice) : 0,
          sourceLabel: `原订单 #${order.no}`,
          isShipmentAddition: true,
          isUnsavedAddition: true,
          pendingRemoval: false,
        }])
      }
      setAddOpen(false); setNotice(null); setActionError(null)
      return
    }
    if (deliveryEditable && addDeliveryId.startsWith('delivery:')) {
      const deliveryId = addDeliveryId.slice('delivery:'.length)
      const delivery = editableDeliveries.find(candidate => candidate.id === deliveryId)
      if (!delivery) { setActionError('请先选择要增加商品的原订单'); return }
      const existing = rows.find(row => row.deliveryId === delivery.id && row.productId === product.id)
      if (existing?.pendingRemoval) {
        restoreShipmentRow(existing)
        setAddOpen(false); setNotice(null); setActionError(null)
        return
      }
      if (existing || delivery.items.some(item => item.productId === product.id)) {
        setActionError('该配送单已有此商品，请直接修改数量')
        return
      }
      const order = detail?.orders.find(candidate => candidate.id === delivery.orderId)
      const recoverableOriginal = order?.orderedItems.find(item => item.productId === product.id)
      const pricing = resolveRevisionCatalogPricing(product)
      if (!recoverableOriginal && pricing.status !== 'READY') { setActionError(pricing.message); return }
      const key = `delivery-add:${delivery.id}:${product.id}`
      clearDeliveryNotePreview()
      setRows(current => {
        const existing = current.find(row => row.key === key)
        if (existing) return current
        return [...current, {
          key, itemId: key, orderId: delivery.orderId, deliveryId: delivery.id, isDeliveryAddition: true,
          productId: product.id,
          name: recoverableOriginal?.name || product.name,
          spec: recoverableOriginal?.spec || product.spec || null,
          unit: recoverableOriginal?.unit || (pricing.status === 'READY' ? pricing.orderUnit : product.unit || '—'),
          quantity: recoverableOriginal ? Number(recoverableOriginal.quantity) : 1,
          originalQuantity: 0,
          unitPrice: recoverableOriginal ? Number(recoverableOriginal.unitPrice) : pricing.status === 'READY' ? Number(pricing.orderUnitPrice) : 0,
          sourceLabel: `原订单 #${delivery.orderNo}`,
          pendingRemoval: false,
        }]
      })
      setAddOpen(false); setNotice(null); setActionError(null)
      return
    }
    if (!latestOrder) return
    const existing = rows.find(row => row.orderId === latestOrder.id && row.productId === product.id)
    if (existing?.pendingRemoval) {
      restoreShipmentRow(existing)
      setAddOpen(false); setNotice(null); setActionError(null)
      return
    }
    if (existing) {
      setActionError('该原订单已有此商品，请直接修改数量')
      return
    }
    const orderedItem = latestOrder.orderedItems.find(item => item.productId === product.id)
    const pricing = resolveRevisionCatalogPricing(product)
    if (!orderedItem && pricing.status !== 'READY') { setActionError(pricing.message); return }
    clearDeliveryNotePreview()
    setRows(current => [...current, orderedItem ? {
      key: `${latestOrder.id}:${orderedItem.id}`, itemId: orderedItem.id, purchaseOrderItemId: orderedItem.id,
      orderId: latestOrder.id, productId: orderedItem.productId, name: orderedItem.name, spec: orderedItem.spec,
      unit: orderedItem.unit, quantity: Number(orderedItem.quantity), originalQuantity: Number(orderedItem.quantity),
      unitPrice: Number(orderedItem.unitPrice), sourceLabel: `原订单 #${latestOrder.no}`, pendingRemoval: false,
    } : {
      key: `${latestOrder.id}:added:${product.id}`, itemId: `added:${product.id}`, orderId: latestOrder.id, productId: product.id,
      name: product.name, spec: product.spec || null, unit: pricing.status === 'READY' ? pricing.orderUnit : product.unit || '—', quantity: 1, originalQuantity: 0,
      unitPrice: pricing.status === 'READY' ? Number(pricing.orderUnitPrice) : 0, sourceLabel: `原订单 #${latestOrder.no}`,
      isUnsavedAddition: true,
      pendingRemoval: false,
    }])
    setAddOpen(false); setNotice(null); setActionError(null)
  }

  function clearDeliveryNotePreview() {
    if (detail) discardDeliveryNotePreview(detail.group.id)
  }

  function openDeliveryNote() {
    if (!detail) return
    if (hasInvalidQuantityDraft) {
      setActionError('请先填写有效数量，再查看送货单')
      return
    }
    const { ownerUserId, tenantKey } = currentPreviewIdentity()
    if (!ownerUserId || !tenantKey) {
      setActionError('当前登录信息不完整，请重新登录后查看送货单')
      return
    }

    try {
      clearDeliveryNotePreview()
      const token = clientRequestId()
      const latestKey = previewIndexKey(detail.group.id)
      const storageKey = previewStorageKey(detail.group.id, token)
      const createdAt = Date.now()
      const preview: GroupDeliveryNotePreview = {
        schemaVersion: 2,
        groupId: detail.group.id,
        ownerUserId,
        tenantKey,
        createdAt,
        expiresAt: createdAt + GROUP_DELIVERY_NOTE_PREVIEW_TTL_MS,
        serverSignature: operationGroupServerSignature(detail, shipmentDrafts),
        draftRows: rows,
        items: deliveryNoteProjection.items,
        totals: deliveryNoteProjection.totals,
      }
      window.sessionStorage.setItem(storageKey, JSON.stringify(preview))
      window.sessionStorage.setItem(latestKey, token)
      router.push(`/v2/supply-chain/fulfillment/${encodeURIComponent(detail.group.id)}/delivery-note?preview=${encodeURIComponent(token)}`)
    } catch {
      setActionError('当前浏览器无法同步未保存的修改，请保存后再查看送货单')
    }
  }

  async function save() {
    if (!detail || !detailEditable || !dirty || submitting) return
    if (hasInvalidQuantityDraft) {
      setActionError('请先填写有效数量，数量可以为 0，最多保留 2 位小数')
      return
    }
    const invalid = rows.find(row => row.quantity < 0 || row.quantity > PURCHASE_QUANTITY_MAX || Math.abs(row.quantity * 100 - Math.round(row.quantity * 100)) > 0.000001)
    if (invalid) { setActionError(`${invalid.name}数量不能小于 0，且最多保留 2 位小数`); return }
    const saveDeliveryMutations = async () => {
      const mutationTargets = editableDeliveries.map(delivery => {
        const additions = rows
          .filter(row => row.isDeliveryAddition && row.deliveryId === delivery.id && !row.pendingRemoval)
          .map(row => ({ productId: row.productId, quantity: row.quantity }))
        const quantityChanges = rows
          .filter(row => !row.isDeliveryAddition && !row.pendingRemoval && row.deliveryId === delivery.id
            && Math.abs(row.quantity - row.originalQuantity) >= 0.0001)
          .map(row => ({ itemId: row.itemId, targetQuantity: row.quantity }))
        const removals = rows
          .filter(row => !row.isDeliveryAddition && row.pendingRemoval && row.deliveryId === delivery.id)
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
          await load()
          setRows(current => [
            ...current.filter(row => !row.deliveryId || !remainingDeliveryIds.has(row.deliveryId)),
            ...remainingRows,
          ])
          const completed = index
          throw new Error(completed > 0
            ? `已保存 ${completed} 张配送单；剩余修改已保留，可重试。${error?.message || '后续配送单保存失败'}`
            : error?.message || '配送商品明细保存失败')
        }
      }
    }
    if (shipmentEditable) {
      setSubmitting(true); setActionError(null)
      let completed = 0
      const confirmedToSave = detail.orders.filter(candidate => candidate.status === 'CONFIRMED')
      try {
        for (const order of confirmedToSave) {
          const visibleRows = rows.filter(row => row.orderId === order.id)
          const items = visibleRows
            // An unsaved addition that was removed never became a document row.
            .filter(row => !(row.isUnsavedAddition && row.pendingRemoval))
            .map(row => ({
              ...(row.purchaseOrderItemId ? { purchaseOrderItemId: row.purchaseOrderItemId } : {}),
              productId: row.productId,
              shippedQty: row.pendingRemoval ? 0 : row.quantity,
              ...(row.pendingRemoval ? { removed: true } : {}),
            }))
          const submittedOriginalIds = new Set(items.flatMap(item => item.purchaseOrderItemId ? [item.purchaseOrderItemId] : []))
          for (const orderedItem of order.orderedItems) {
            if (submittedOriginalIds.has(orderedItem.id)) continue
            items.push({
              purchaseOrderItemId: orderedItem.id,
              productId: orderedItem.productId,
              shippedQty: 0,
              removed: true,
            })
          }
          await apiFetch(`/api/orders/${encodeURIComponent(order.id)}/shipment-draft`, {
            method: 'PUT',
            body: JSON.stringify({
              orderRowVersion: order.rowVersion,
              ...(shipmentDrafts[order.id] ? { draftRowVersion: shipmentDrafts[order.id].rowVersion } : {}),
              items,
            }),
          })
          completed += 1
        }
        const hasDeliveryMutations = editableDeliveries.some(delivery => rows.some(row => row.deliveryId === delivery.id
          && (row.pendingRemoval || row.isDeliveryAddition || Math.abs(row.quantity - row.originalQuantity) >= 0.0001)))
        if (hasDeliveryMutations) {
          await saveDeliveryMutations()
        }
        clearDeliveryNotePreview()
        await load()
        setNotice(hasDeliveryMutations
          ? '实发草稿和配送商品明细已保存'
          : '实发商品明细已保存，刷新页面也会保留；可继续批量确认发货')
      } catch (error: any) {
        const remainingOrderIds = new Set(confirmedToSave.slice(completed).map(order => order.id))
        const remainingRows = rows.filter(row => remainingOrderIds.has(row.orderId))
        await load()
        setRows(current => [
          ...current.filter(row => !remainingOrderIds.has(row.orderId)),
          ...remainingRows,
        ])
        setActionError(completed > 0
          ? `已保存 ${completed} 张发货草稿；其余修改已保留，可重试：${error?.message || '保存失败'}`
          : error?.message || '实发商品明细保存失败')
      } finally { setSubmitting(false) }
      return
    }
    if (deliveryEditable) {
      setSubmitting(true); setActionError(null)
      try {
        await saveDeliveryMutations()
        clearDeliveryNotePreview()
        await load(); setNotice('配送商品明细已保存')
      } catch (error: any) { setActionError(error?.message || '配送商品明细保存失败') }
      finally { setSubmitting(false) }
      return
    }
    const activeRows = rows.filter(row => !row.pendingRemoval)
    const orders = detail.orders.map(order => ({
      orderId: order.id, baseRowVersion: order.rowVersion,
      items: activeRows.filter(row => row.orderId === order.id).map(row => ({ productId: row.productId, quantity: row.quantity })),
    }))
    const requestKey = requestKeyRef.current || clientRequestId(); requestKeyRef.current = requestKey
    setSubmitting(true); setActionError(null)
    try {
      await apiFetch(`/api/orders/operation-groups/${encodeURIComponent(detail.group.id)}/items`, { method: 'PATCH', body: JSON.stringify({ requestKey, orders }) })
      clearDeliveryNotePreview()
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
      setConfirmOpen(false); confirmKeyRef.current = null; clearDeliveryNotePreview(); await load()
    } catch (error: any) { setActionError(error?.message || '批量接单失败') }
    finally { setSubmitting(false) }
  }

  async function shipGroup() {
    if (!detail || !shipmentEditable || dirty || submitting) return
    const confirmedOrders = detail.orders.filter(order => order.status === 'CONFIRMED')
    setSubmitting(true); setActionError(null)
    let completed = 0
    try {
      for (const order of confirmedOrders) {
        const idempotencyKey = shipKeysRef.current[order.id] || clientRequestId()
        shipKeysRef.current[order.id] = idempotencyKey
        const serverDraft = shipmentDrafts[order.id]
        const legacyRows = rows.filter(row => row.orderId === order.id)
        await apiFetch(`/api/orders/${encodeURIComponent(order.id)}/ship`, {
          method: 'PATCH',
          body: JSON.stringify({
            note: shipNote.trim() || undefined,
            idempotencyKey,
            ...(serverDraft ? {
              draftRowVersion: serverDraft.rowVersion,
            } : {
              items: legacyRows.filter(row => row.purchaseOrderItemId && !row.pendingRemoval)
                .map(row => ({ itemId: row.purchaseOrderItemId!, shippedQty: row.quantity })),
              removedItemIds: legacyRows.filter(row => row.purchaseOrderItemId && row.pendingRemoval)
                .map(row => row.purchaseOrderItemId!),
            }),
          }),
        })
        delete shipKeysRef.current[order.id]
        completed += 1
      }
      setShipConfirmOpen(false); setShipNote('')
      clearDeliveryNotePreview()
      await load(); setNotice(`批量发货成功，已分别生成 ${completed} 张配送单`)
    } catch (error: any) {
      await load()
      setActionError(completed > 0
        ? `已完成 ${completed} 张，其余未发货：${error?.message || '发货失败'}。可再次点击继续发货。`
        : error?.message || '批量发货失败')
    } finally { setSubmitting(false) }
  }

  async function deliverGroup() {
    if (!detail || deliveringOrders.length === 0 || dirty || submitting) return
    setSubmitting(true); setActionError(null)
    let completed = 0
    try {
      for (const order of deliveringOrders) {
        await apiFetch(`/api/orders/${encodeURIComponent(order.id)}/deliver`, {
          method: 'PATCH',
          body: JSON.stringify({ note: deliverNote.trim() || undefined }),
        })
        completed += 1
      }
      setDeliverConfirmOpen(false); setDeliverNote('')
      clearDeliveryNotePreview()
      await load(); setNotice(`批量确认送达成功，已更新 ${completed} 张原订单`)
    } catch (error: any) {
      setDeliverConfirmOpen(false)
      await load()
      setActionError(completed > 0
        ? `已确认送达 ${completed} 张，其余仍在配送中：${error?.message || '确认送达失败'}。可再次操作剩余订单。`
        : error?.message || '批量确认送达失败')
    } finally { setSubmitting(false) }
  }

  if (loading) return <div className="min-h-screen bg-bg p-5 text-center text-caption text-gray3">集合加载中…</div>
  if (loadError || !detail) return <div className="min-h-screen bg-bg p-4"><button onClick={() => router.back()} className="text-caption text-gray2">‹ 返回</button><div className="mt-6 rounded-card bg-red-bg p-4 text-red-fg">{loadError || '集合不存在'}</div></div>

  const first = detail.orders[0]
  const productTotal = deliveryNoteProjection.totals.amount
  const deliveryLines = detail.orders.flatMap(order => order.deliverySummaries.flatMap(delivery =>
    delivery.items.map(item => `${item.name}${item.quantity}${item.unit}`)))
  const addTargetRows = editable
    ? rows.filter(row => row.orderId === latestOrder?.id)
    : addDeliveryId.startsWith('order:')
      ? rows.filter(row => row.orderId === addDeliveryId.slice('order:'.length))
      : addDeliveryId.startsWith('delivery:')
        ? rows.filter(row => row.deliveryId === addDeliveryId.slice('delivery:'.length))
        : []
  const addTargetOrder = editable
    ? latestOrder
    : addDeliveryId.startsWith('order:')
      ? detail.orders.find(order => order.id === addDeliveryId.slice('order:'.length))
      : addDeliveryId.startsWith('delivery:')
        ? detail.orders.find(order => order.id === editableDeliveries
          .find(delivery => delivery.id === addDeliveryId.slice('delivery:'.length))?.orderId)
        : null
  const recoverableOriginalByProductId = new Map((addTargetOrder?.orderedItems || [])
    .map(item => [item.productId, item]))
  const activeAddProductIds = new Set(addTargetRows
    .filter(row => !row.pendingRemoval)
    .map(row => row.productId))
  const pendingRemovalByProductId = new Map(addTargetRows
    .filter(row => row.pendingRemoval)
    .map(row => [row.productId, row]))
  const filteredCatalog = catalog
    .filter(product => matchesWarehouseProductSearch(product, search))
    .filter(product => {
      if (activeAddProductIds.has(product.id)) return false
      if (pendingRemovalByProductId.has(product.id)) return true
      if (recoverableOriginalByProductId.has(product.id)) return true
      return product.status === 'ENABLED' && resolveRevisionCatalogPricing(product).status === 'READY'
    })
  const selectedAddProduct = filteredCatalog.find(product => product.id === addProductId) || null
  const selectedRestoreRow = selectedAddProduct ? pendingRemovalByProductId.get(selectedAddProduct.id) || null : null
  const selectedRecoverableOriginal = selectedAddProduct ? recoverableOriginalByProductId.get(selectedAddProduct.id) || null : null
  const selectedRestoreSnapshot = selectedRestoreRow || selectedRecoverableOriginal
  const selectedIsRestore = Boolean(selectedRestoreSnapshot)
  const selectedAddPricing = selectedAddProduct ? resolveRevisionCatalogPricing(selectedAddProduct) : null
  const groupPhase = detail.source === 'pending'
    ? { label: '待接单集合', tone: 'orange' as const }
    : confirmedOrders.length > 0
      ? { label: '待发货集合', tone: 'orange' as const }
      : deliveringOrders.length > 0
        ? { label: '配送中集合', tone: 'orange' as const }
        : pendingConfirmOrders.length > 0
          ? { label: '已送达待收货', tone: 'orange' as const }
          : { label: '集合已收货', tone: 'green' as const }

  return <div className="min-h-screen bg-bg pb-28">
    <OrderDetailHeader onBack={() => router.back()} onDeliveryNote={openDeliveryNote}
      statusLabel={groupPhase.label} statusTone={groupPhase.tone} />
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
    <OrderProductTable rows={rows} editable={detailEditable} total={money(productTotal)} saving={submitting} dirty={Boolean(dirty)} onAdd={detailEditable ? () => void openAdd() : undefined} onSave={() => void save()} onRemove={row => {
      const draftRow = row as DraftRow
      if (editable) removeRow(draftRow)
      else removeShipmentRow(draftRow)
    }} onRestore={row => {
      restoreShipmentRow(row as DraftRow)
    }} canRemove={row => {
      const draftRow = row as DraftRow
      return Boolean(editable || confirmedOrderIds.has(draftRow.orderId) || draftRow.isDeliveryAddition
        || (draftRow.deliveryId && editableDeliveryIds.has(draftRow.deliveryId)))
    }}
      notice={editable ? <p className="mx-3 mb-2 text-micro text-gray3">每行标明原订单归属；点一次保存后，所有变化在同一个事务中生效或全部回滚。</p> : (shipmentEditable || deliveryEditable) ? <div className="mx-3 mb-2">
        <p className="text-micro text-gray3">这里填写每张原订单的实发数量；数量 0 仍保留商品，“移除”才会从本次发货中删除。</p>
      </div> : null}
      renderQuantity={rowBase => {
        const row = rowBase as DraftRow
        const rowEditable = Boolean(editable || confirmedOrderIds.has(row.orderId) || row.isDeliveryAddition
          || (row.deliveryId && editableDeliveryIds.has(row.deliveryId)))
        if (row.pendingRemoval) return <>{row.quantity}{row.unit}</>
        return rowEditable ? <span className="inline-flex items-center gap-1"><input type="number" inputMode="decimal" min="0" max={PURCHASE_QUANTITY_MAX} step="0.01" aria-label={`${row.name}数量`}
          value={quantityDrafts[row.key] ?? String(row.quantity)} onChange={event => { const raw = event.target.value; setQuantityDrafts(current => ({ ...current, [row.key]: raw })); if (quantityDraftReason(raw) === null) updateQuantity(row, Number(raw)) }}
          onBlur={() => {
            const raw = quantityDrafts[row.key]
            const reason = raw === undefined ? null : quantityDraftReason(raw)
            if (reason) { setActionError(`${row.name}：${reason}`); return }
            setQuantityDrafts(current => { const next = { ...current }; delete next[row.key]; return next })
          }}
          className={`w-24 rounded-cta border bg-white px-2 py-1 text-right font-num ${Math.abs(row.quantity - row.originalQuantity) >= 0.0001 ? 'border-red text-red-fg' : 'border-border text-ink'}`} /><span className="text-gray3">{row.unit}</span></span> : <>{row.quantity}{row.unit}</>
      }} />

    <section className="mx-4 mt-3 rounded-card border border-border bg-white"><div className="border-b border-border px-4 py-3"><h2 className="text-h2">集合内订单 ({detail.orders.length})</h2></div><div className="overflow-x-auto"><table className="w-full min-w-[420px] text-caption"><thead className="bg-bg text-micro text-gray3"><tr><th className="px-4 py-2 text-left">序号</th><th className="px-4 py-2 text-left">原订单号</th><th className="px-4 py-2 text-left">下单时间</th></tr></thead><tbody className="divide-y divide-border">{sortedOrders.map((order, index) => <tr key={order.id}><td className="px-4 py-3 font-num text-gray3">{index + 1}</td><td className="px-4 py-3 font-num">#{order.no}</td><td className="px-4 py-3 text-gray2">{dayjs(order.createdAt).format('MM/DD HH:mm')}</td></tr>)}</tbody></table></div></section>

    {shipmentEditable && <section className="mx-4 mt-3 rounded-card border border-border bg-white p-4"><label className="mb-1 block text-micro text-gray3">发货备注（选填）</label><input value={shipNote} onChange={event => setShipNote(event.target.value)} maxLength={200} placeholder="例如司机、车辆或送货说明" className="w-full rounded-cta border border-border bg-bg px-3 py-2 text-body" /></section>}

    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-white/95 p-3 backdrop-blur"><div className="mx-auto max-w-5xl">{detail.source === 'pending'
      ? <button onClick={() => setConfirmOpen(true)} disabled={!canAccept || submitting} className="w-full rounded-cta bg-ink px-4 py-3 text-button text-white disabled:opacity-40">批量接单</button>
      : shipmentEditable
        ? <button onClick={() => setShipConfirmOpen(true)} disabled={dirty || submitting} className="w-full rounded-cta bg-ink px-4 py-3 text-button text-white disabled:opacity-40">{dirty ? '请先保存实发数量' : '批量确认发货'}</button>
        : deliveringOrders.length > 0
          ? <button onClick={() => setDeliverConfirmOpen(true)} disabled={dirty || submitting} className="w-full rounded-cta bg-amber px-4 py-3 text-button text-white disabled:opacity-40">{dirty ? '请先保存商品明细' : `批量确认送达 (${deliveringOrders.length})`}</button>
          : pendingConfirmOrders.length > 0
            ? <div className="rounded-cta bg-amber/10 px-4 py-3 text-center text-button text-amber-fg">已送达，待收货</div>
            : <div className="rounded-cta bg-green-bg px-4 py-3 text-center text-button text-green-fg">集合已收货</div>}</div></div>

    {addOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4" role="dialog" aria-modal="true"
      onClick={() => { if (!submitting) setAddOpen(false) }}>
      <div className="w-full max-w-lg rounded-card bg-white p-4" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-h2">增加商品</h2>
            <p className="mt-1 text-micro text-gray3">选择一项后确认增加，数量回到商品明细中调整，并由右上角统一保存。</p>
          </div>
          <button type="button" onClick={() => setAddOpen(false)} disabled={submitting}
            className="h-8 w-8 rounded-full bg-bg text-gray2 disabled:opacity-40">×</button>
        </div>
        {actionError && <div className="mt-3 rounded-cta border border-red/30 bg-red-bg px-3 py-2 text-caption text-red-fg">{actionError}</div>}
        {!editable && <label className="mt-4 block text-micro text-gray3">加入哪张原订单
          <select value={addDeliveryId} onChange={event => {
            setAddDeliveryId(event.target.value)
            setAddProductId('')
            setActionError(null)
          }} className="mt-1 w-full rounded-cta border border-border bg-white px-3 py-2 text-body">
            <option value="">请选择原订单</option>
            {confirmedOrders.map(order => <option key={`order:${order.id}`} value={`order:${order.id}`}>原订单 #{order.no} · 待发货</option>)}
            {editableDeliveries.map(delivery => <option key={`delivery:${delivery.id}`} value={`delivery:${delivery.id}`}>原订单 #{delivery.orderNo} · 配送单 #{delivery.no}</option>)}
          </select>
        </label>}
        <div className="mt-4 space-y-3">
          <label className="block text-micro text-gray3" htmlFor="group-warehouse-product-search">选择仓库商品</label>
          <input id="group-warehouse-product-search" type="search" value={search}
            onChange={event => { setSearch(event.target.value); setAddProductId('') }}
            placeholder="搜索商品名称" className="w-full rounded-cta border border-border bg-bg px-3 py-2 text-body outline-none focus:border-accent" />
          <div className="max-h-72 overflow-y-auto rounded-cta border border-border bg-white">
            {filteredCatalog.length === 0 && <div className="px-3 py-8 text-center text-caption text-gray3">没有匹配的仓库商品</div>}
            {filteredCatalog.map(product => {
              const pricing = resolveRevisionCatalogPricing(product)
              const selected = addProductId === product.id
              const restoreRow = pendingRemovalByProductId.get(product.id)
              const recoverableOriginal = recoverableOriginalByProductId.get(product.id)
              const restoreSnapshot = restoreRow || recoverableOriginal
              return <button key={product.id} type="button" disabled={(!restoreSnapshot && pricing.status !== 'READY') || (!editable && !addDeliveryId)}
                aria-pressed={selected} onClick={() => setAddProductId(product.id)}
                className={`flex w-full items-center gap-3 border-b border-l-4 border-border px-3 py-3 text-left transition-colors last:border-b-0 disabled:opacity-40 ${selected ? 'border-l-amber bg-amber/20' : 'border-l-transparent hover:bg-bg'}`}>
                <span className="min-w-0 flex-1">
                  <span className={`block text-body ${selected ? 'font-medium text-amber-fg' : ''}`}>{product.name}</span>
                  <span className="block text-micro text-gray3">{[product.code, product.category, product.spec].filter(Boolean).join(' · ') || '暂无编码、分类或规格'}</span>
                </span>
                <span className="shrink-0 text-right font-num text-caption">
                  <span className="block">{restoreSnapshot
                    ? `恢复原明细 · ¥${money(restoreSnapshot.unitPrice)} / ${restoreSnapshot.unit}`
                    : pricing.status === 'READY' ? `¥${money(pricing.orderUnitPrice)} / ${pricing.orderUnit}` : '价格待核验'}</span>
                  {selected && <span className="mt-1 block text-button text-amber-fg">✓ 已选择</span>}
                </span>
              </button>
            })}
          </div>
          <div className="rounded-cta bg-bg px-3 py-2 text-caption text-gray2">
            {selectedRestoreSnapshot
              ? `将按原订单冻结价 ¥${money(selectedRestoreSnapshot.unitPrice)} / ${selectedRestoreSnapshot.unit} 恢复`
              : selectedAddPricing?.status === 'READY' ? `系统价格：¥${selectedAddPricing.orderUnitPrice} / ${selectedAddPricing.orderUnit}` : '选择仓库商品后自动带出系统价格'}
          </div>
        </div>
        <p className="mt-4 text-micro text-gray3">{selectedIsRestore ? '恢复后带回原订单数量，仍可在商品明细中调整。' : '加入后默认数量为 1，请回到商品明细中调整。'}</p>
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => setAddOpen(false)} disabled={submitting}
            className="flex-1 rounded-cta border border-border py-2.5 text-button text-gray2 disabled:opacity-40">取消</button>
          <button type="button" onClick={() => { if (selectedAddProduct) addProduct(selectedAddProduct) }}
            disabled={submitting || !selectedAddProduct || (!selectedIsRestore && selectedAddPricing?.status !== 'READY') || (!editable && !addDeliveryId)}
            className="flex-1 rounded-cta bg-ink py-2.5 text-button text-white disabled:opacity-40">{selectedIsRestore ? '确认恢复' : '确认增加'}</button>
        </div>
      </div>
    </div>}
    {confirmOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-card bg-white p-4"><h2 className="text-h2">确认批量接单？</h2><p className="mt-2 text-caption text-gray2">将一次接单 {detail.group.memberCount} 张原订单。不会创建聚合订单，原订单号与历史保留不变。</p><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => setConfirmOpen(false)} className="rounded-cta border border-border px-4 py-2.5">取消</button><button onClick={() => void accept()} disabled={submitting} className="rounded-cta bg-ink px-4 py-2.5 text-white disabled:opacity-50">{submitting ? '提交中…' : '确认批量接单'}</button></div></div></div>}
    {shipConfirmOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-card bg-white p-4"><h2 className="text-h2">确认批量发货？</h2><p className="mt-2 whitespace-pre-line text-caption text-gray2">将发货 {detail.orders.filter(order => order.status === 'CONFIRMED').length} 张原订单，并按原订单分别生成配送单。{shipNote.trim() ? `\n备注：${shipNote.trim()}` : ''}</p><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => setShipConfirmOpen(false)} className="rounded-cta border border-border px-4 py-2.5">取消</button><button onClick={() => void shipGroup()} disabled={submitting} className="rounded-cta bg-ink px-4 py-2.5 text-white disabled:opacity-50">{submitting ? '发货中…' : '确认批量发货'}</button></div></div></div>}
    {deliverConfirmOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-card bg-white p-4"><h2 className="text-h2">确认批量送达？</h2><p className="mt-2 text-caption text-gray2">将确认 {deliveringOrders.length} 张原订单已送达，并进入收货阶段。</p><label className="mt-3 block text-micro text-gray3">送达备注（选填）<input value={deliverNote} onChange={event => setDeliverNote(event.target.value)} maxLength={200} placeholder="例如司机、签收人或送达说明" className="mt-1 w-full rounded-cta border border-border bg-bg px-3 py-2 text-body" /></label><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => setDeliverConfirmOpen(false)} disabled={submitting} className="rounded-cta border border-border px-4 py-2.5 disabled:opacity-50">取消</button><button onClick={() => void deliverGroup()} disabled={dirty || submitting} className="rounded-cta bg-amber px-4 py-2.5 text-white disabled:opacity-50">{submitting ? '提交中…' : '确认批量送达'}</button></div></div></div>}
  </div>
}
