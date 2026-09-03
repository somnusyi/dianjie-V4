/**
 * 供应商 · 订单详情
 *
 * GET /api/orders/:id (后端按 supplierId 自动过滤越权)
 * 操作: 接单 / 发货 (按状态显示)
 */
'use client'
import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { apiFetch, getUser } from '@/lib/v2-auth'
import {
  SUPPLIER_MONEY_TERMS,
  supplierLossClaimKindMeta,
  supplierLossClaimResponsibility,
  supplierLossClaimSettlementHint,
  supplierOrderStatusMeta,
} from '@/lib/supplier-domain'
import { Chip } from '@/components/v2'
import {
  OrderAmountCard,
  OrderDeliverySummary,
  OrderDetailHeader,
  OrderProductTable,
  OrderProgressCard,
  type OrderDetailTableRow,
} from '@/components/v2/order-detail-shared'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import dayjs from 'dayjs'
import { clientRequestId } from '@/lib/client-id'
import {
  buildPartialShipmentLines,
  buildShipmentConfirmBody,
  computeShipmentNewTotal,
  mapFulfillmentToCloseSummary,
} from '@/lib/partial-shipment-ui'
import {
  calculateRevisionLineAmount,
  matchesWarehouseProductSearch,
  RevisionCatalogProduct,
  resolveRevisionCatalogPricing,
  sumRevisionLineAmounts,
} from '@/lib/supplier-revision-cost-pricing'
import {
  clearShipmentDraft,
  readShipmentDraft,
  shipmentDraftStorageKey,
} from '@/lib/shipment-draft-storage'
import { loadAllProductCatalog, loadAllWarehouseProductCatalog } from '@/lib/load-product-catalog'

type Order = {
  id: string; no: string; status: string
  totalAmount: string
  originalTotalAmount?: string | null
  currentOrderAmount?: string | null
  rowVersion: number
  currentRevisionNo?: number
  expectedDate: string; createdAt: string; submittedAt?: string | null
  shippedAt: string | null; receivedAt: string | null
  shippedNote: string | null
  note: string | null
  // 厨师发的验收单 (DELIVERING 在途时发) — 补类型, 修历史 TS 报错 (2026-06)
  chefAckAt?: string | null
  chefAckImages?: string[] | null
  chefAckNote?: string | null
  store: { id: string; name: string; no: string; address?: string | null }
  supplier: { id: string; name: string; contactName?: string | null; contactPhone?: string | null; inventoryMode?: 'NOT_TRACKED' | 'STRICT' }
  createdBy: { id: string; name: string }
  shippedBy: { id: string; name: string } | null
  items: { id: string; productId: string; quantity: string; shippedQty: string | null; unitPrice: string; amount: string; receivedQty: string | null; orderUnitSnapshot?: string | null; productUnitSnapshot?: string | null; product?: { name: string; spec: string | null; unit: string; code: string; shipUpperPct?: string | number; shipUpperBuffer?: string | number } }[]
  revisions?: {
    id: string; revisionNo: number; status: string; reason: string; requestedAt: string
    changeSet: { kind: string; productId?: string; before?: any; after?: any }[]
    requestedBy?: { name: string }; reviewedBy?: { name: string } | null; reviewedAt?: string | null; reviewNote?: string | null
  }[]
  deliveries?: {
    id: string; no: string; status: string; actualTotalAmount: string; rowVersion: number; createdAt?: string | null; shippedAt?: string | null; deliveredAt?: string | null; receivedAt?: string | null
    items: { id: string; purchaseOrderItemId?: string | null; productId: string; shippedQty: string; receivedQty?: string | null; unitPriceSnapshot?: string; amount?: string; productSpecSnapshot?: string | null; productUnitSnapshot?: string | null; product?: { name: string; unit: string; spec?: string | null } }[]
    receipt?: { id: string; no: string; totalAmount: string; status: string } | null
  }[]
  lossClaims?: {
    id: string; no: string; status: string
    kind?: string | null
    payableBasis?: string | null
    totalLossAmount: string; description: string
    deliveryOrder?: { id: string; no: string } | null
    receipt?: { id: string; no: string } | null
    evidenceImages?: string[] | null
    handlerNote?: string | null
    createdAt?: string
    items: { product: { name: string; unit?: string }; lossQty: string; lossAmount: string }[]
  }[]
  receipt?: { id: string; no: string } | null
  receipts?: { id: string; no: string; totalAmount: string; status: string }[]
}

type OperationGroupDetailResponse = {
  source: 'pending' | 'accepted'
  group: { id: string; memberCount: number }
  orders: Array<{
    id: string
    no: string
    createdAt: string
    submittedAt?: string | null
    status: string
  }>
}

type PendingDeliveryAddition = {
  key: string
  purchaseOrderItemId?: string | null
  productId: string
  name: string
  spec: string | null
  unit: string
  unitPrice: number
  quantity: number
  pendingRemoval?: boolean
}

type ShipmentDraftPayloadItem = {
  purchaseOrderItemId: string | null
  productId: string
  shippedQty: number
  removed: boolean
}

type ShipmentDraftRecovery = {
  attemptedItems: ShipmentDraftPayloadItem[]
  shipQty: Record<string, number>
  removedItemIds: string[]
  restoreQty: Record<string, number>
  additions: PendingDeliveryAddition[]
  quantityDrafts: Record<string, string>
  errorMessage: string
}

export default function SupplierOrderDetailPage() {
  const viewer = getUser()
  const orderBase = viewer?.role === 'SUPPLY_CHAIN'
    ? '/v2/supply-chain/fulfillment'
    : '/v2/supplier/orders'
  const viewerRole = viewer?.role || ''
  const viewerUserId = viewer?.id || ''
  const canAdjustDeliveryDetails = viewerRole === 'SUPPLY_CHAIN'
  const params = useParams() as any
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = params.id as string
  const operationGroupId = searchParams.get('operationGroup')
  const groupAddRequested = searchParams.get('groupAdd') === '1'
  // A group entry is an operation view, not an invitation to run an
  // individual-order action.  Keep this guard independent of the async group
  // metadata load so a stale/deep link cannot expose a one-order mutation.
  const isOperationGroupContext = Boolean(operationGroupId)
  // 内部供应链修改订货明细直接生效，不再进入门店确认步骤。
  const isDirectOperationGroupRevision = viewerRole === 'SUPPLY_CHAIN'
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shipmentNotice, setShipmentNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deliveryQty, setDeliveryQty] = useState<Record<string, string>>({})
  const [removedDeliveryItemIds, setRemovedDeliveryItemIds] = useState<string[]>([])
  const [pendingDeliveryAdditions, setPendingDeliveryAdditions] = useState<PendingDeliveryAddition[]>([])
  const [savedShipQty, setSavedShipQty] = useState<Record<string, number>>({})
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [deliveryAddTarget, setDeliveryAddTarget] = useState<NonNullable<Order['deliveries']>[number] | null>(null)
  const [shipmentAddOpen, setShipmentAddOpen] = useState(false)
  const [deliveryAddProductId, setDeliveryAddProductId] = useState('')
  const [deliveryAddSearch, setDeliveryAddSearch] = useState('')
  const [deliveryAdjustError, setDeliveryAdjustError] = useState<string | null>(null)
  const [shipNote, setShipNote] = useState('')
  // 发货时可调整每行的实际发货量 (称重 / 缺货). key=itemId, value=shippedQty
  const [shipQty, setShipQty] = useState<Record<string, number>>({})
  const [removedShipmentItemIds, setRemovedShipmentItemIds] = useState<string[]>([])
  const [savedRemovedShipmentItemIds, setSavedRemovedShipmentItemIds] = useState<string[]>([])
  const [shipmentRestoreQty, setShipmentRestoreQty] = useState<Record<string, number>>({})
  const [pendingShipmentAdditions, setPendingShipmentAdditions] = useState<PendingDeliveryAddition[]>([])
  // 送达备注 — 不用 window.prompt (WebView 禁用)
  const [deliverNote, setDeliverNote] = useState('')
  // 报损拒绝弹层 (state-driven, 替代 window.prompt)
  const [rejectingClaim, setRejectingClaim] = useState<{ id: string; no: string; amount: string } | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  // 图片全屏放大 (target="_blank" 在 WebView 不工作)
  const [zoomImg, setZoomImg] = useState<string | null>(null)
  // 接单前改单：普通供应商保持申请流；内部操作组提交后直接生效。
  const [addOpen, setAddOpen] = useState(false)
  const [catalog, setCatalog] = useState<RevisionCatalogProduct[]>([])
  const [addQty, setAddQty] = useState<Record<string, number>>({})
  const [removedOrderProductIds, setRemovedOrderProductIds] = useState<string[]>([])
  // 数量编辑允许短暂为空，避免用户必须先输入新数字再删除旧数字。
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({})
  const [revisionError, setRevisionError] = useState<string | null>(null)
  const [groupAddContext, setGroupAddContext] = useState<{
    groupId: string
    targetNo: string
    targetCreatedAt: string
    memberCount: number
  } | null>(null)
  const groupAddAttemptedRef = useRef<string | null>(null)
  const revisionRequestKeyRef = useRef<string | null>(null)
  const shipRequestKeyRef = useRef<string | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  function shipmentDraftKey(orderId: string) {
    if (typeof window === 'undefined' || !viewerUserId) return null
    let tenantId = ''
    try {
      const storedTenant = JSON.parse(localStorage.getItem('tenant') || '{}')
      tenantId = String(storedTenant?.id || storedTenant?.slug || '')
    } catch {}
    // Never place two tenants in a shared fallback namespace.
    if (!tenantId) return null
    return shipmentDraftStorageKey({ tenantId, userId: viewerUserId, orderId })
  }

  function load(options?: { shipmentDraftRecovery?: ShipmentDraftRecovery }) {
    apiFetch<Order>(`/api/orders/${id}`).then(data => {
      setOrder(data)
      if (data.status !== 'CONFIRMED' && shipRequestKeyRef.current) {
        shipRequestKeyRef.current = null
        setDeliveryAdjustError(null)
      }
      setDeliveryQty(Object.fromEntries((data.deliveries || []).flatMap(delivery =>
        delivery.items.map(item => [item.id, String(item.shippedQty)]))))
      setAddQty(Object.fromEntries(data.items.map(item => [item.productId, Number(item.quantity)])))
      setRemovedOrderProductIds([])
      setQuantityDrafts({})
      setRemovedDeliveryItemIds([])
      setPendingDeliveryAdditions([])
      const draftKey = shipmentDraftKey(data.id)
      const serverDraft = (data.deliveries || []).find(delivery => delivery.status === 'DRAFT')
      if (data.status === 'CONFIRMED' && serverDraft) {
        const quantities = Object.fromEntries(serverDraft.items.map(item => [item.purchaseOrderItemId || `draft-${item.id}`, Number(item.shippedQty)]))
        const recovery = options?.shipmentDraftRecovery
        const signature = (items: Array<{ purchaseOrderItemId?: string | null; productId: string; shippedQty: number | string }>) => items
          .map(item => `${item.purchaseOrderItemId || `product:${item.productId}`}|${item.productId}|${Number(item.shippedQty).toFixed(2)}`)
          .sort()
          .join('\n')
        const attemptedActive = recovery?.attemptedItems.filter(item => !item.removed) || []
        const recoveredSave = Boolean(recovery && signature(attemptedActive) === signature(serverDraft.items))
        setShipQty(recovery && !recoveredSave ? { ...quantities, ...recovery.shipQty } : quantities)
        setSavedShipQty(quantities)
        setRemovedShipmentItemIds(recovery && !recoveredSave ? recovery.removedItemIds : [])
        setSavedRemovedShipmentItemIds([])
        setShipmentRestoreQty(recovery && !recoveredSave ? recovery.restoreQty : {})
        setPendingShipmentAdditions(recovery && !recoveredSave ? recovery.additions : [])
        setQuantityDrafts(recovery && !recoveredSave ? recovery.quantityDrafts : {})
        if (recovery) {
          if (recoveredSave) {
            setDeliveryAdjustError(null)
            setSaveNotice('商品明细已保存')
          } else {
            setDeliveryAdjustError(`${recovery.errorMessage}；已刷新服务器最新草稿，本地未保存编辑仍保留，请核对后重试`)
          }
        }
        if (typeof window !== 'undefined' && draftKey) clearShipmentDraft(localStorage, draftKey)
      } else if (data.status === 'CONFIRMED'
          && (options?.shipmentDraftRecovery || (typeof window !== 'undefined' && draftKey))) {
        const restored = typeof window !== 'undefined' && draftKey
          ? readShipmentDraft(localStorage, draftKey, {
              orderId: data.id,
              orderRowVersion: data.rowVersion,
              userId: viewerUserId,
              itemIds: data.items.map(item => item.id),
            })
          : null
        setShipQty(restored?.quantities || {})
        setSavedShipQty(restored?.quantities || {})
        setRemovedShipmentItemIds(restored?.removedItemIds || [])
        setSavedRemovedShipmentItemIds(restored?.removedItemIds || [])
        setShipmentRestoreQty(Object.fromEntries((restored?.removedItemIds || []).map(itemId => {
          const line = buildPartialShipmentLines(data.items, {}).find(candidate => candidate.it.id === itemId)
          return [itemId, line?.remaining || 0]
        })))
        setPendingShipmentAdditions(options?.shipmentDraftRecovery?.additions || [])
        if (options?.shipmentDraftRecovery) {
          setShipQty(current => ({ ...current, ...options.shipmentDraftRecovery!.shipQty }))
          setRemovedShipmentItemIds(options.shipmentDraftRecovery.removedItemIds)
          setShipmentRestoreQty(options.shipmentDraftRecovery.restoreQty)
          setQuantityDrafts(options.shipmentDraftRecovery.quantityDrafts)
          setDeliveryAdjustError(`${options.shipmentDraftRecovery.errorMessage}；服务器尚未返回已保存草稿，本地编辑仍保留，请重试`)
        }
      } else {
        if (typeof window !== 'undefined' && draftKey) clearShipmentDraft(localStorage, draftKey)
        setShipQty({})
        setSavedShipQty({})
        setRemovedShipmentItemIds([])
        setSavedRemovedShipmentItemIds([])
        setShipmentRestoreQty({})
        setPendingShipmentAdditions([])
      }
    }).catch(e => {
      if (options?.shipmentDraftRecovery) {
        setDeliveryAdjustError(`${options.shipmentDraftRecovery.errorMessage}；重新加载最新草稿也失败，本地编辑仍保留`)
      } else {
        setError(e.message || '加载失败')
      }
    })
  }
  useEffect(() => {
    shipRequestKeyRef.current = null
    load()
  }, [id])

  function ship() {
    if (!order || isOperationGroupContext) return
    setShipmentNotice(null)
    setDeliveryAdjustError(null)
    const serverDraft = (order.deliveries || []).find(delivery => delivery.status === 'DRAFT') || null
    const activeDraftOrderItemIds = new Set((serverDraft?.items || []).map(item => item.purchaseOrderItemId).filter(Boolean))
    const effectiveShipQty = {
      ...shipQty,
      ...Object.fromEntries(removedShipmentItemIds.map(itemId => [itemId, 0])),
      ...(serverDraft ? Object.fromEntries(order.items
        .filter(item => !activeDraftOrderItemIds.has(item.id))
        .map(item => [item.id, 0])) : {}),
    }
    const lines = buildPartialShipmentLines(order.items, effectiveShipQty)
    const newTotal = computeShipmentNewTotal(lines)
    const changed = lines.filter(l => l.changed)
    // 实发上限 per-product: max(下单 × shipUpperPct, 下单 + shipUpperBuffer)
    // 阈值在 Product 上 (2026-05-28 戊方案), 供应商可在商品页自调; 默认 1.10 / 5.00
    const shipUpper = (it: typeof lines[0]['it']) => {
      const ordered = Number(it.quantity)
      const pct    = Number(it.product?.shipUpperPct    ?? 1.10)
      const buffer = Number(it.product?.shipUpperBuffer ?? 5)
      return Math.max(ordered * pct, ordered + buffer)
    }
    const overLimit = lines.find(l => l.previous + l.sq > shipUpper(l.it) + 0.0001)
    if (overLimit) {
      const pct = Number(overLimit.it.product?.shipUpperPct ?? 1.10)
      const buf = Number(overLimit.it.product?.shipUpperBuffer ?? 5)
      setError(`${overLimit.it.product?.name || ''} 实发超上限 ${shipUpper(overLimit.it).toFixed(2)} (下单 ${overLimit.it.quantity}, 该商品阈值: ≤ ${pct}×下单 或 ≤ 下单+${buf} 取大). 在商品页可调阈值.`)
      return
    }
    const itemsBody = !serverDraft && changed.length > 0 ? lines.map(l => ({ itemId: l.it.id, shippedQty: l.sq })) : undefined
    const body = serverDraft ? `已保存 ${serverDraft.items.length} 项实发商品明细。确认后生成配送单并进入配送中。` : buildShipmentConfirmBody({
      itemCount: order.items.length,
      lines,
      newTotal,
      oldTotal: Number(order.totalAmount),
      inventoryMode: order.supplier.inventoryMode,
    })
    const shipRequestKey = shipRequestKeyRef.current || clientRequestId()
    shipRequestKeyRef.current = shipRequestKey

    openConfirm({
      title: `确认发货 ${order.no}?`,
      body,
      confirmLabel: '确认发货',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          const res = await apiFetch<any>(`/api/orders/${order.id}/ship`, {
            method: 'PATCH',
            body: JSON.stringify({
              note: shipNote.trim() || undefined,
              ...(!serverDraft ? { items: itemsBody, removedItemIds: removedShipmentItemIds } : {}),
              ...(serverDraft ? { draftRowVersion: serverDraft.rowVersion } : {}),
              idempotencyKey: shipRequestKey,
            }),
          })
          shipRequestKeyRef.current = null
          const fulfillment = mapFulfillmentToCloseSummary(res?.fulfillment)
          if (fulfillment?.hasClosedRemainder) {
            const closedNames = fulfillment.lines.filter(l => l.closedQty > 0).map(l => `${l.productName || '商品'} ${l.closedQty}`).join('、')
            setShipmentNotice(`发货成功。未发余量已关闭: ${closedNames}。不会补送，如仍需须门店重新下单。`)
          }
          const draftKey = shipmentDraftKey(order.id)
          if (typeof window !== 'undefined' && draftKey) clearShipmentDraft(localStorage, draftKey)
          load()
        } catch (e: any) {
          setDeliveryAdjustError(e.message || '发货失败')
          // A lost response may still mean the transaction committed. Reloading
          // reveals that success; otherwise the same request key remains ready
          // for a user-confirmed retry against the refreshed draft version.
          load()
        }
        finally { setSubmitting(false) }
      },
    })
  }

  function confirmOrder() {
    if (!order || isOperationGroupContext) return
    openConfirm({
      title: `接单 ${order.no}?`,
      body: `${order.items.length} 件商品 · 共 ¥${Number(order.currentOrderAmount ?? order.originalTotalAmount ?? order.totalAmount).toLocaleString()}\n接单后店长能看到"已接单"状态, 你需要按期望日期 ${dayjs(order.expectedDate).format('MM/DD')} 前发货.${order.supplier.inventoryMode === 'STRICT' ? '\n系统会预占本单所需的供应商库存。' : '\n当前未核算供应商仓库库存，不会因库存数字不完整阻断接单。'}`,
      confirmLabel: '接单',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/orders/${order.id}/confirm`, { method: 'PATCH' })
          load()
        } catch (e: any) { setError(e.message || '接单失败'); throw e }
        finally { setSubmitting(false) }
      },
    })
  }

  // 打开改单 picker — 拉自家 catalog, 预填当前订单数量
  async function openAddPicker() {
    if (!order) return
    revisionRequestKeyRef.current = clientRequestId()
    setAddOpen(true)
    setCatalog([])
    setDeliveryAddProductId('')
    setDeliveryAddSearch('')
    setRevisionError(null)
    try {
      const list = isDirectOperationGroupRevision
        ? await loadAllWarehouseProductCatalog(order.supplier.id)
        : await loadAllProductCatalog()
      const existingIds = new Set((order?.items || []).map(it => it.productId))
      setCatalog((list as RevisionCatalogProduct[]).filter((p: RevisionCatalogProduct) => p.status === 'ENABLED' || existingIds.has(p.id)))
    } catch (e: any) {
      setError(e.message || '加载 catalog 失败')
      closeAddPicker()
    }
  }

  function closeAddPicker() {
    setAddOpen(false)
    setRevisionError(null)
    revisionRequestKeyRef.current = null
  }

  // A group card routes to the latest source order, while the API rechecks
  // that ownership.  Auto-open the existing revision picker so the group
  // entry has the same interaction as the original single-order flow.
  useEffect(() => {
    if (!order || !operationGroupId || !groupAddRequested) return
    if (groupAddAttemptedRef.current === operationGroupId) return
    groupAddAttemptedRef.current = operationGroupId
    let cancelled = false
    void apiFetch<OperationGroupDetailResponse>(`/api/orders/operation-groups/${encodeURIComponent(operationGroupId)}`)
      .then(detail => {
        if (cancelled) return
        const members = [...(detail.orders || [])].sort((a, b) => {
          const aTime = Date.parse(a.submittedAt || a.createdAt)
          const bTime = Date.parse(b.submittedAt || b.createdAt)
          return aTime - bTime || a.id.localeCompare(b.id)
        })
        const latest = members[members.length - 1]
        if (detail.source !== 'pending' || !latest || latest.id !== order.id) {
          setError('集合新增商品只能加入集合内下单时间最晚的原订单，请从集合入口重新打开')
          return
        }
        setGroupAddContext({
          groupId: detail.group.id,
          targetNo: latest.no,
          targetCreatedAt: latest.createdAt,
          memberCount: members.length,
        })
        if (order.status === 'SUBMITTED'
            && (isDirectOperationGroupRevision || !order.revisions?.some(revision => revision.status === 'PENDING'))) {
          void openAddPicker()
        }
      })
      .catch(error => {
        if (!cancelled) setError(error?.message || '集合信息加载失败')
      })
    return () => { cancelled = true }
  }, [order, operationGroupId, groupAddRequested, isDirectOperationGroupRevision])

  function setAddQtyFor(pid: string, q: number) {
    setRevisionError(null)
    setRemovedOrderProductIds(current => current.filter(productId => productId !== pid))
    setAddQty(prev => {
      if (q < 0) return prev
      return { ...prev, [pid]: q }
    })
  }

  function removeOrderProduct(pid: string) {
    setRevisionError(null)
    setRemovedOrderProductIds(current => current.includes(pid) ? current : [...current, pid])
    setSaveNotice(null)
  }

  function restoreOrderProduct(pid: string) {
    setRemovedOrderProductIds(current => current.filter(productId => productId !== pid))
    setRevisionError(null)
    setSaveNotice(null)
  }

  function showRevisionError(message: string) {
    if (isDirectOperationGroupRevision) setRevisionError(message)
    else setError(message)
  }

  async function submitAdd() {
    if (!order) return
    const catalogItems = Object.entries(addQty)
      .filter(([productId, q]) => q >= 0 && !removedOrderProductIds.includes(productId))
      .map(([productId, quantity]) => ({ productId, quantity }))
    const items = catalogItems
    if (items.length > 500) { showRevisionError('单次最多保留 500 条商品明细'); return }
    const catalogAmounts = catalogItems.map(({ productId, quantity }) => {
      const existing = order.items.find(it => it.productId === productId)
      if (existing) {
        const p = catalog.find(c => c.id === productId)
        const unit = existing.orderUnitSnapshot || existing.productUnitSnapshot || existing.product?.unit || p?.unit || '订货单位'
        return calculateRevisionLineAmount(quantity, {
          status: 'READY',
          orderUnitPrice: existing.unitPrice,
          orderUnit: unit,
          unitLabel: `元 / ${unit}`,
          costPriceSource: '历史冻结订货价',
        })
      }
      const p = catalog.find(c => c.id === productId)
      if (!p) {
        showRevisionError('商品目录已变化，请刷新后重新申请调整')
        return null
      }
      const pricing = resolveRevisionCatalogPricing(p)
      if (pricing.status === 'PENDING') {
        showRevisionError(pricing.message)
        return null
      }
      return calculateRevisionLineAmount(quantity, pricing)
    })
    const total = sumRevisionLineAmounts(catalogAmounts)
    if (total === null) return
    const requestKey = revisionRequestKeyRef.current || clientRequestId()
    revisionRequestKeyRef.current = requestKey
    const automaticReason = viewerRole === 'SUPPLY_CHAIN' ? '内部供应链商品明细调整' : '供应商商品明细调整'

    openConfirm({
      title: isDirectOperationGroupRevision ? '确认并立即更新订货单？' : '申请调整订货单?',
      body: isDirectOperationGroupRevision
        ? `调整后 ${items.length} 项 · ¥${Number(total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n提交后立即生效，可返回集合继续批量接单。`
        : `调整后 ${items.length} 项 · ¥${Number(total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n提交后须门店确认，确认前不能接单。`,
      confirmLabel: isDirectOperationGroupRevision ? '确认修改' : '提交申请',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/orders/${order.id}/revisions`, {
            method: 'POST',
            body: JSON.stringify({
              items,
              reason: automaticReason,
              baseRowVersion: order.rowVersion,
              requestKey,
              ...(operationGroupId ? { operationGroupId } : {}),
            }),
          })
          closeAddPicker()
          if (isDirectOperationGroupRevision && operationGroupId) {
            router.replace(`/v2/supply-chain/fulfillment/group/${encodeURIComponent(operationGroupId)}`)
          } else {
            load()
          }
        } catch (e: any) {
          showRevisionError(e.message || (isDirectOperationGroupRevision ? '直接改单失败' : '改单申请失败'))
          throw e
        }
        finally { setSubmitting(false) }
      },
    })
  }

  function rejectOrder() {
    if (!order || isOperationGroupContext) return
    const reason = window.prompt('请说明拒单原因 (店长能看到):')
    if (!reason || !reason.trim()) return
    openConfirm({
      title: `拒单 ${order.no}?`,
      body: `理由: ${reason.trim()}\n\n拒单后订单将被取消, 店长收到通知, 需要重新下单.`,
      confirmLabel: '确认拒单',
      tone: 'danger',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/orders/${order.id}/reject`, {
            method: 'PATCH',
            body: JSON.stringify({ reason: reason.trim() }),
          })
          load()
        } catch (e: any) { setError(e.message || '拒单失败'); throw e }
        finally { setSubmitting(false) }
      },
    })
  }

  function removeDeliveryItem(itemId: string) {
    setDeliveryAdjustError(null)
    setRemovedDeliveryItemIds(current => current.includes(itemId) ? current : [...current, itemId])
    setSaveNotice(null)
  }

  function restoreDeliveryItem(itemId: string) {
    const productId = order?.deliveries
      ?.flatMap(delivery => delivery.items)
      .find(item => item.id === itemId)?.productId
    setRemovedDeliveryItemIds(current => current.filter(id => id !== itemId))
    // A restored server row owns this product again. Drop any stale local
    // addition defensively so save can never submit add + remove together.
    if (productId) {
      setPendingDeliveryAdditions(current => current.filter(item => item.productId !== productId))
    }
    setSaveNotice(null)
  }

  function removeShipmentItem(itemId: string, displayedQuantity?: number) {
    const currentLine = order ? buildPartialShipmentLines(order.items, shipQty).find(line => line.it.id === itemId) : null
    setShipmentRestoreQty(current => ({
      ...current,
      [itemId]: displayedQuantity ?? (currentLine && currentLine.sq > 0 ? currentLine.sq : currentLine?.remaining || 0),
    }))
    setRemovedShipmentItemIds(current => current.includes(itemId) ? current : [...current, itemId])
    setSaveNotice(null)
  }

  function restoreShipmentItem(itemId: string, displayedQuantity?: number) {
    const fallback = order ? buildPartialShipmentLines(order.items, {}).find(line => line.it.id === itemId)?.remaining || 0 : 0
    const quantity = shipmentRestoreQty[itemId] ?? displayedQuantity ?? fallback
    setShipQty(current => ({ ...current, [itemId]: quantity }))
    setRemovedShipmentItemIds(current => current.filter(id => id !== itemId))
    setQuantityDrafts(current => {
      const next = { ...current }
      delete next[itemId]
      return next
    })
    setSaveNotice(null)
  }

  async function openShipmentAdd() {
    if (!order || order.status !== 'CONFIRMED') return
    setDeliveryAdjustError(null)
    setDeliveryAddTarget(null)
    setShipmentAddOpen(true)
    setDeliveryAddProductId('')
    setDeliveryAddSearch('')
    setCatalog([])
    try {
      const list = await loadAllWarehouseProductCatalog(order.supplier.id)
      const originalProductIds = new Set(order.items.map(item => item.productId))
      const products = new Map((list as RevisionCatalogProduct[]).map(product => [product.id, product]))
      // 已保存移除的原订货行不会出现在 DRAFT items 中；即使商品后来
      // 停用或移出仓库目录，也必须保留一个原订单快照入口供用户恢复。
      for (const item of order.items) {
        if (products.has(item.productId)) continue
        products.set(item.productId, {
          id: item.productId,
          name: item.product?.name || '商品',
          code: item.product?.code || null,
          spec: item.product?.spec || null,
          category: null,
          unit: item.orderUnitSnapshot || item.productUnitSnapshot || item.product?.unit || null,
          status: 'ORDER_SNAPSHOT',
        })
      }
      setCatalog([...products.values()].filter(product => product.status === 'ENABLED' || originalProductIds.has(product.id)))
    } catch (e: any) {
      setShipmentAddOpen(false)
      setDeliveryAdjustError(e.message || '加载商品目录失败')
    }
  }

  async function openDeliveryAdd(delivery: NonNullable<Order['deliveries']>[number]) {
    if (!order || !canAdjustDeliveryDetails || delivery.receipt || !['SHIPPED', 'DELIVERED'].includes(delivery.status)) return
    setDeliveryAdjustError(null)
    setShipmentAddOpen(false)
    setDeliveryAddTarget(delivery)
    setDeliveryAddProductId('')
    setDeliveryAddSearch('')
    setCatalog([])
    try {
      const list = await loadAllWarehouseProductCatalog(order.supplier.id)
      setCatalog((list as RevisionCatalogProduct[]).filter(product => product.status === 'ENABLED'))
    } catch (e: any) {
      setDeliveryAddTarget(null)
      setDeliveryAdjustError(e.message || '加载商品目录失败')
    }
  }

  async function submitDetailAdd() {
    if (!order || (!deliveryAddTarget && !shipmentAddOpen && !addOpen)) return
    setDeliveryAdjustError(null)
    if (!deliveryAddProductId) { setDeliveryAdjustError('请选择仓库商品'); return }
    const product = catalog.find(item => item.id === deliveryAddProductId)
    if (!product) { setDeliveryAdjustError('商品目录已变化，请重新选择'); return }
    if (addOpen) {
      const existing = order.items.find(item => item.productId === product.id)
      if (existing && removedOrderProductIds.includes(product.id)) {
        restoreOrderProduct(product.id)
      } else {
        const pricing = existing ? null : resolveRevisionCatalogPricing(product)
        if (!existing && pricing?.status !== 'READY') { setDeliveryAdjustError('该商品价格待核验，暂不能加入'); return }
        setAddQtyFor(product.id, 1)
      }
      closeAddPicker()
      setDeliveryAddProductId('')
      setSaveNotice(null)
      return
    }
    if (shipmentAddOpen) {
      const original = order.items.find(item => item.productId === product.id)
      const pricing = original ? null : resolveRevisionCatalogPricing(product)
      if (!original && pricing?.status !== 'READY') { setDeliveryAdjustError('该商品价格待核验，暂不能加入'); return }
      const unit = original?.orderUnitSnapshot || original?.productUnitSnapshot || original?.product?.unit
        || (pricing?.status === 'READY' ? pricing.orderUnit : product.unit) || ''
      const unitPrice = original ? Number(original.unitPrice) : Number(pricing?.status === 'READY' ? pricing.orderUnitPrice : 0)
      setPendingShipmentAdditions(current => [...current, {
        key: original?.id || `shipment-add-${product.id}`,
        purchaseOrderItemId: original?.id || null,
        productId: product.id,
        name: original?.product?.name || product.name,
        spec: original?.product?.spec || product.spec || null,
        unit,
        unitPrice,
        quantity: original ? Number(original.quantity) : 1,
      }])
      setShipmentAddOpen(false)
      setDeliveryAddProductId('')
      setSaveNotice(null)
      return
    }
    const pendingRemovedItem = deliveryAddTarget!.items.find(item =>
      item.productId === product.id && removedDeliveryItemIds.includes(item.id))
    if (pendingRemovedItem) {
      // Re-selecting a row removed during this unsaved edit is an undo. Do not
      // send an addition and removal for the same delivery product.
      restoreDeliveryItem(pendingRemovedItem.id)
      setDeliveryAddProductId('')
      setDeliveryAddTarget(null)
      return
    }
    const pricing = resolveRevisionCatalogPricing(product)
    if (pricing.status !== 'READY') { setDeliveryAdjustError('该商品价格待核验，暂不能加入'); return }
    setPendingDeliveryAdditions(current => [...current, {
      key: clientRequestId(),
      productId: product.id,
      name: product.name,
      spec: product.spec || null,
      unit: pricing.orderUnit,
      unitPrice: Number(pricing.orderUnitPrice),
      quantity: 1,
    }])
    setDeliveryAddTarget(null)
    setSaveNotice(null)
  }

  async function saveDeliveryDetails(delivery: NonNullable<Order['deliveries']>[number]) {
    const quantityChanges = delivery.items.flatMap(item => {
      if (removedDeliveryItemIds.includes(item.id)) return []
      const targetQuantity = Number(deliveryQty[item.id] ?? item.shippedQty)
      if (!Number.isFinite(targetQuantity) || targetQuantity < 0) throw new Error(`${item.product?.name || '商品'}数量无效`)
      return Math.abs(targetQuantity - Number(item.shippedQty)) >= 0.0001
        ? [{ itemId: item.id, targetQuantity }]
        : []
    })
    await apiFetch(`/api/deliveries/${delivery.id}/items`, {
      method: 'PATCH',
      body: JSON.stringify({
        rowVersion: delivery.rowVersion,
        reason: '商品明细统一保存',
        quantityChanges,
        removals: removedDeliveryItemIds.map(itemId => ({ itemId })),
        additions: pendingDeliveryAdditions
          .filter(item => !item.pendingRemoval)
          .map(item => ({ productId: item.productId, quantity: item.quantity })),
      }),
    })
  }

  if (!order && !error) {
    return (
      <div className="min-h-screen bg-bg p-4">
        <button onClick={() => router.back()} className="text-caption text-gray2">‹ 返回</button>
        <p className="text-gray3 mt-6 text-center">加载中…</p>
      </div>
    )
  }
  if (error) {
    return (
      <div className="min-h-screen bg-bg p-4">
        <button onClick={() => router.back()} className="text-caption text-gray2">‹ 返回</button>
        <div className="mt-6 bg-red-bg text-red-fg rounded-card p-4">{error}</div>
      </div>
    )
  }
  if (!order) return null

  const status = supplierOrderStatusMeta(order.status)
  const step = status.progressStep
  const tone = status.tone
  const pendingRevision = order.revisions?.find(revision => revision.status === 'PENDING')
  const currentOrderAmount = Number(order.currentOrderAmount ?? order.originalTotalAmount ?? order.totalAmount)
  const shipmentAmount = (order.deliveries || [])
    .filter(delivery => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
    .reduce((sum, delivery) => sum + Number(delivery.actualTotalAmount || 0), 0)
  const effectiveShipQty = {
    ...shipQty,
    ...Object.fromEntries(removedShipmentItemIds.map(itemId => [itemId, 0])),
  }
  // The detail API returns deliveries in creation order. Once a real delivery
  // exists it owns the editable/displayed product snapshot until its receipt
  // is saved; purchase-order lines are only a pre-delivery source.
  const currentDeliveries = (order.deliveries || [])
    .filter(delivery => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
  const currentDelivery = currentDeliveries[currentDeliveries.length - 1] || null
  const draftDelivery = (order.deliveries || []).find(delivery => delivery.status === 'DRAFT') || null
  const editableDelivery = currentDelivery
    && canAdjustDeliveryDetails
    && !currentDelivery.receipt
    && ['SHIPPED', 'DELIVERED'].includes(currentDelivery.status)
    ? currentDelivery
    : null
  const canEditSubmittedDetails = !currentDelivery && order.status === 'SUBMITTED'
    && (isDirectOperationGroupRevision || !pendingRevision)
  const canEditConfirmedDetails = !currentDelivery && order.status === 'CONFIRMED' && !isOperationGroupContext
  const canEditDeliveryDetails = Boolean(editableDelivery)

  const submittedCatalogRows = catalog.filter(product =>
    Object.prototype.hasOwnProperty.call(addQty, product.id) && !order.items.some(item => item.productId === product.id))
  const submittedRows = [
    ...order.items.map(item => ({
      key: item.id,
      itemId: item.id,
      productId: item.productId,
      name: item.product?.name || '-',
      spec: item.product?.spec || null,
      unit: item.orderUnitSnapshot || item.productUnitSnapshot || item.product?.unit || '',
      unitPrice: Number(item.unitPrice),
      quantity: addQty[item.productId] ?? Number(item.quantity),
      originalQuantity: Number(item.quantity),
      source: 'order' as const,
      pendingRemoval: removedOrderProductIds.includes(item.productId),
    })),
    ...submittedCatalogRows.map(product => {
      const pricing = resolveRevisionCatalogPricing(product)
      return {
        key: `catalog-${product.id}`,
        productId: product.id,
        name: product.name,
        spec: product.spec || null,
        unit: pricing.status === 'READY' ? pricing.orderUnit : product.unit,
        unitPrice: pricing.status === 'READY' ? Number(pricing.orderUnitPrice) : 0,
        quantity: addQty[product.id] || 0,
        originalQuantity: 0,
        source: 'catalog' as const,
        pendingRemoval: removedOrderProductIds.includes(product.id),
      }
    }),
  ]

  const confirmedLines = canEditConfirmedDetails ? buildPartialShipmentLines(order.items, effectiveShipQty) : []
  const confirmedDraftRows = draftDelivery ? draftDelivery.items.map(item => {
    const original = order.items.find(candidate => candidate.id === item.purchaseOrderItemId)
      || order.items.find(candidate => candidate.productId === item.productId)
    const key = item.purchaseOrderItemId || `draft-${item.id}`
    const pendingRemoval = removedShipmentItemIds.includes(key)
    const baselineQuantity = Number(item.shippedQty)
    return {
      key,
      itemId: key,
      purchaseOrderItemId: item.purchaseOrderItemId || null,
      productId: item.productId,
      name: item.product?.name || original?.product?.name || '-',
      spec: item.productSpecSnapshot || item.product?.spec || original?.product?.spec || null,
      unit: item.productUnitSnapshot || item.product?.unit || original?.orderUnitSnapshot || original?.productUnitSnapshot || original?.product?.unit || '',
      unitPrice: Number(item.unitPriceSnapshot ?? (Number(item.amount || 0) / Math.max(baselineQuantity, 1))),
      quantity: pendingRemoval
        ? shipmentRestoreQty[key] ?? savedShipQty[key] ?? baselineQuantity
        : shipQty[key] ?? baselineQuantity,
      originalQuantity: savedShipQty[key] ?? baselineQuantity,
      source: 'shipment' as const,
      pendingRemoval,
    }
  }) : []
  const localShipmentAdditionRows = pendingShipmentAdditions.map(item => ({
    key: item.key,
    itemId: item.key,
    purchaseOrderItemId: item.purchaseOrderItemId || null,
    productId: item.productId,
    name: item.name,
    spec: item.spec,
    unit: item.unit,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    originalQuantity: 0,
    source: 'shipment-addition' as const,
    pendingRemoval: item.pendingRemoval === true,
  }))
  const deliveryRows = currentDelivery ? [
    ...currentDelivery.items
      .map(item => ({
      key: item.id,
      itemId: item.id,
      productId: item.productId,
      name: item.product?.name || '-',
      spec: item.productSpecSnapshot || item.product?.spec || null,
      unit: item.productUnitSnapshot || item.product?.unit || '',
      unitPrice: Number(item.unitPriceSnapshot ?? (Number(item.amount || 0) / Math.max(Number(item.shippedQty), 1))),
      quantity: canEditDeliveryDetails ? Number(deliveryQty[item.id] ?? item.shippedQty) : Number(item.shippedQty),
      originalQuantity: Number(item.shippedQty),
      source: 'delivery' as const,
      pendingRemoval: canEditDeliveryDetails && removedDeliveryItemIds.includes(item.id),
    })),
    ...(canEditDeliveryDetails
      ? pendingDeliveryAdditions.map(item => ({
          key: item.key,
          productId: item.productId,
          name: item.name,
          spec: item.spec,
          unit: item.unit,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          originalQuantity: 0,
          source: 'delivery-addition' as const,
          pendingRemoval: item.pendingRemoval === true,
        }))
      : []),
  ] : []

  const detailRows = currentDelivery
    ? deliveryRows
    : canEditConfirmedDetails
      ? [
        ...(draftDelivery ? confirmedDraftRows : confirmedLines
          .filter(line => !(savedRemovedShipmentItemIds.includes(line.it.id) && removedShipmentItemIds.includes(line.it.id)))
          .map(line => {
          const fullItem = order.items.find(item => item.id === line.it.id)
          const pendingRemoval = removedShipmentItemIds.includes(line.it.id)
          return ({
          key: line.it.id,
          itemId: line.it.id,
          productId: line.it.productId,
          name: line.it.product?.name || '-',
          spec: fullItem?.product?.spec || null,
          unit: fullItem?.orderUnitSnapshot || fullItem?.productUnitSnapshot || line.it.product?.unit || '',
          unitPrice: Number(line.it.unitPrice),
          quantity: pendingRemoval
            ? shipmentRestoreQty[line.it.id] ?? savedShipQty[line.it.id] ?? line.remaining
            : line.sq,
          originalQuantity: savedShipQty[line.it.id] ?? line.remaining,
          source: 'shipment' as const,
          pendingRemoval,
        })})),
        ...localShipmentAdditionRows,
      ]
      : canEditSubmittedDetails
        ? submittedRows
        : order.items.map(item => ({
            key: item.id,
            itemId: item.id,
            productId: item.productId,
            name: item.product?.name || '-',
            spec: item.product?.spec || null,
            unit: item.orderUnitSnapshot || item.productUnitSnapshot || item.product?.unit || '',
            unitPrice: Number(item.unitPrice),
            quantity: Number(item.shippedQty ?? item.quantity),
            originalQuantity: Number(item.shippedQty ?? item.quantity),
            source: 'readonly' as const,
            pendingRemoval: false,
          }))

  const detailTotal = detailRows
    .filter(row => !row.pendingRemoval)
    .reduce((sum, row) => sum + row.quantity * row.unitPrice, 0)

  const quantityDraftReason = (rawValue: string) => {
    const text = rawValue.trim()
    const quantity = Number(text)
    if (!text || !Number.isFinite(quantity) || quantity < 0) return '数量不能为空且不能小于 0'
    if (Math.abs(quantity * 100 - Math.round(quantity * 100)) >= 0.000001) return '数量最多保留 2 位小数'
    return null
  }
  let invalidQuantityDraft: { name: string; reason: string } | null = null
  for (const [key, rawValue] of Object.entries(quantityDrafts)) {
    const row = detailRows.find(candidate => candidate.key === key)
    if (!row || row.pendingRemoval) continue
    const reason = quantityDraftReason(rawValue)
    if (reason) {
      invalidQuantityDraft = { name: row.name, reason }
      break
    }
  }

  const submittedDirty = canEditSubmittedDetails && (
    order.items.some(item => Math.abs((addQty[item.productId] ?? 0) - Number(item.quantity)) >= 0.0001)
    || submittedCatalogRows.length > 0
    || removedOrderProductIds.length > 0
  )
  const shipmentDirty = canEditConfirmedDetails && (detailRows.some(row =>
    row.source === 'shipment-addition'
    || row.pendingRemoval
    || (row.source === 'shipment' && Math.abs(row.quantity - row.originalQuantity) >= 0.0001))
    || [...removedShipmentItemIds].sort().join('|') !== [...savedRemovedShipmentItemIds].sort().join('|')
    || pendingShipmentAdditions.length > 0)
  const deliveryDirty = canEditDeliveryDetails && (
    editableDelivery?.items.some(item => !removedDeliveryItemIds.includes(item.id)
      && Math.abs(Number(deliveryQty[item.id] ?? item.shippedQty) - Number(item.shippedQty)) >= 0.0001)
    || removedDeliveryItemIds.length > 0
    || pendingDeliveryAdditions.length > 0
  )
  const detailsDirty = submittedDirty || shipmentDirty || deliveryDirty || Boolean(invalidQuantityDraft)
  const canShowSave = canEditSubmittedDetails || canEditConfirmedDetails || canEditDeliveryDetails
  const hasActualDelivery = (order.deliveries || []).some(delivery => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
  const displayedShipmentAmount = canShowSave || !hasActualDelivery ? detailTotal : shipmentAmount

  async function saveDetails() {
    if (!order || !detailsDirty || submitting) return
    setError(null)
    setSaveNotice(null)
    if (invalidQuantityDraft) {
      setDeliveryAdjustError(`${invalidQuantityDraft.name}：${invalidQuantityDraft.reason}`)
      return
    }
    if (canEditSubmittedDetails) {
      const hasServerChange = order.items.some(item => removedOrderProductIds.includes(item.productId)
        || Math.abs((addQty[item.productId] ?? Number(item.quantity)) - Number(item.quantity)) >= 0.0001)
        || submittedCatalogRows.some(product => !removedOrderProductIds.includes(product.id))
      if (!hasServerChange) {
        const cancelledProductIds = new Set(removedOrderProductIds.filter(productId => !order.items.some(item => item.productId === productId)))
        setAddQty(current => Object.fromEntries(Object.entries(current).filter(([productId]) => !cancelledProductIds.has(productId))))
        setRemovedOrderProductIds(current => current.filter(productId => !cancelledProductIds.has(productId)))
        setSaveNotice('商品明细已保存')
        return
      }
      await submitAdd()
      return
    }
    if (canEditConfirmedDetails) {
      const confirmedRowsForSave = detailRows.filter(row => row.source === 'shipment' || row.source === 'shipment-addition')
      const originalIds = new Set(order.items.map(item => item.id))
      const items: Array<{
        purchaseOrderItemId: string | null
        productId: string
        shippedQty: number
        removed: boolean
      }> = order.items.map(item => {
        const row = confirmedRowsForSave.find(candidate => candidate.key === item.id
          || ('purchaseOrderItemId' in candidate && candidate.purchaseOrderItemId === item.id))
        const removed = !row || row.pendingRemoval === true
        return {
          purchaseOrderItemId: item.id,
          productId: item.productId,
          shippedQty: removed ? 0 : row.quantity,
          removed,
        }
      })
      for (const row of confirmedRowsForSave) {
        const purchaseOrderItemId = 'purchaseOrderItemId' in row ? row.purchaseOrderItemId : row.itemId
        if ((purchaseOrderItemId && originalIds.has(purchaseOrderItemId))
            || (row.source === 'shipment-addition' && row.pendingRemoval)) continue
        items.push({
          purchaseOrderItemId: purchaseOrderItemId || null,
          productId: row.productId,
          shippedQty: row.pendingRemoval ? 0 : row.quantity,
          removed: row.pendingRemoval === true,
        })
      }
      const invalid = items.find(item => !Number.isFinite(item.shippedQty) || item.shippedQty < 0)
      if (invalid) { setError('实发数量不能小于 0'); return }
      setSubmitting(true)
      try {
        await apiFetch(`/api/orders/${order.id}/shipment-draft`, {
          method: 'PUT',
          body: JSON.stringify({
            orderRowVersion: order.rowVersion,
            draftRowVersion: draftDelivery?.rowVersion ?? null,
            items,
          }),
        })
        const draftKey = shipmentDraftKey(order.id)
        if (typeof window !== 'undefined' && draftKey) clearShipmentDraft(localStorage, draftKey)
        setSaveNotice('商品明细已保存')
        load()
      } catch (e: any) {
        const errorMessage = e.message || '发货商品明细保存失败'
        setDeliveryAdjustError(errorMessage)
        load({
          shipmentDraftRecovery: {
            attemptedItems: items.map(item => ({ ...item })),
            shipQty: { ...shipQty },
            removedItemIds: [...removedShipmentItemIds],
            restoreQty: { ...shipmentRestoreQty },
            additions: pendingShipmentAdditions.map(item => ({ ...item })),
            quantityDrafts: { ...quantityDrafts },
            errorMessage,
          },
        })
      } finally {
        setSubmitting(false)
      }
      return
    }
    if (editableDelivery) {
      const hasServerChange = editableDelivery.items.some(item => !removedDeliveryItemIds.includes(item.id)
        && Math.abs(Number(deliveryQty[item.id] ?? item.shippedQty) - Number(item.shippedQty)) >= 0.0001)
        || removedDeliveryItemIds.length > 0
        || pendingDeliveryAdditions.some(item => !item.pendingRemoval)
      if (!hasServerChange) {
        setPendingDeliveryAdditions([])
        setSaveNotice('商品明细已保存')
        return
      }
      setSubmitting(true)
      try {
        await saveDeliveryDetails(editableDelivery)
        setSaveNotice('商品明细已保存')
        load()
      } catch (e: any) {
        setDeliveryAdjustError(e.message || '保存商品明细失败')
      } finally {
        setSubmitting(false)
      }
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <OrderDetailHeader onBack={() => router.back()} onDeliveryNote={() => router.push(`${orderBase}/${order.id}/delivery-note`)}
        statusLabel={status.detailLabel} statusTone={tone} />
      {shipmentNotice && (
        <div className="mx-4 mt-2 rounded-card border border-green-fg/20 bg-green-bg p-3 text-caption text-green-fg">
          {shipmentNotice}
        </div>
      )}
      {saveNotice && (
        <div className="mx-4 mt-2 rounded-card border border-green-fg/20 bg-green-bg p-3 text-caption text-green-fg">
          {saveNotice}
        </div>
      )}
      {groupAddContext && (
        <div className="mx-4 mt-2 rounded-card border border-amber/30 bg-amber/10 p-3 text-caption text-amber-fg">
          集合改单将更新下单时间最晚的原订单 <b>#{groupAddContext.targetNo}</b>（{dayjs(groupAddContext.targetCreatedAt).format('MM/DD HH:mm')}）。
          集合内共 {groupAddContext.memberCount} 张原订单，其他订单不变。
        </div>
      )}

      <OrderAmountCard eyebrow={`#${order.no}`} name={order.store.name} amountLabel={SUPPLIER_MONEY_TERMS.shipmentAmount}
        amount={displayedShipmentAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        originalOrderAmount={Number(order.originalTotalAmount ?? order.totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}>
        {order.store.address && <div className="text-micro text-gray3 mt-1">📍 {order.store.address}</div>}
        <div className="text-caption text-gray2 mt-2">
          下单 {dayjs(order.createdAt).format('MM/DD HH:mm')} · 期望到货 {dayjs(order.expectedDate).format('MM/DD')}
          <br />创建人 {order.createdBy.name}
          {order.shippedAt && <><br />发货 {dayjs(order.shippedAt).format('MM/DD HH:mm')} · {order.shippedBy?.name || '-'}</>}
          {order.receivedAt && <><br />收货 {dayjs(order.receivedAt).format('MM/DD HH:mm')}</>}
        </div>
        {order.note && <div className="mt-2 bg-bg rounded p-2 text-caption text-gray2">📝 {order.note}</div>}
        {order.shippedNote && <div className="mt-2 bg-amber/10 rounded p-2 text-caption text-amber-fg">📦 发货备注: {order.shippedNote}</div>}
      </OrderAmountCard>

      <OrderDeliverySummary lines={(order.deliveries || [])
        .filter(delivery => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
        .flatMap(delivery => delivery.items.map(item => `${item.product?.name || '商品'}${item.shippedQty}${item.productUnitSnapshot || item.product?.unit || ''}`))} />
      <OrderProgressCard currentIndex={step} />

      <OrderProductTable
        rows={detailRows as OrderDetailTableRow[]}
        editable={canShowSave}
        total={detailTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        saving={submitting}
        dirty={detailsDirty}
        onAdd={(canEditSubmittedDetails || canEditConfirmedDetails || canEditDeliveryDetails) ? () => {
          if (canEditDeliveryDetails && editableDelivery) void openDeliveryAdd(editableDelivery)
          else if (canEditConfirmedDetails) void openShipmentAdd()
          else void openAddPicker()
        } : undefined}
        onSave={() => void saveDetails()}
        notice={<>
          {deliveryAdjustError && <div className="mx-3 mb-2 rounded-cta border border-red/30 bg-red-bg px-3 py-2 text-caption text-red-fg">{deliveryAdjustError}</div>}
          {revisionError && <p className="mx-3 mb-2 text-micro text-red-fg">{revisionError}</p>}
          {canEditConfirmedDetails && <div className="mx-3 mb-2">
            <p className="text-micro text-gray3">数量 0 仍保留商品，“移除”才会从本次发货中删除。</p>
          </div>}
        </>}
        renderQuantity={baseRow => {
          const row = detailRows.find(item => item.key === baseRow.key)!
          if (row.pendingRemoval) return <>{row.quantity}{row.unit}</>
          const rowDirty = Math.abs(row.quantity - row.originalQuantity) >= 0.0001
            || row.source === 'catalog'
            || row.source === 'shipment-addition'
            || row.source === 'delivery-addition'
          return canShowSave ? <span className="inline-flex items-center gap-1">
            <input type="number" inputMode="decimal" min="0" step="0.01" value={quantityDrafts[row.key] ?? String(row.quantity)} aria-label={`${row.name}数量`}
              onChange={event => {
                const rawValue = event.target.value
                setQuantityDrafts(current => ({ ...current, [row.key]: rawValue }))
                setDeliveryAdjustError(null)
                if (quantityDraftReason(rawValue)) return
                const quantity = Number(rawValue)
                setSaveNotice(null)
                if (row.source === 'order' || row.source === 'catalog') setAddQtyFor(row.productId, quantity)
                else if (row.source === 'shipment' && row.itemId) setShipQty(current => ({ ...current, [row.itemId!]: quantity }))
                else if (row.source === 'shipment-addition') setPendingShipmentAdditions(current => current.map(item => item.key === row.key ? { ...item, quantity } : item))
                else if (row.source === 'delivery' && row.itemId) setDeliveryQty(current => ({ ...current, [row.itemId!]: String(quantity) }))
                else if (row.source === 'delivery-addition') setPendingDeliveryAdditions(current => current.map(item => item.key === row.key ? { ...item, quantity } : item))
              }}
              onBlur={() => {
                const rawValue = quantityDrafts[row.key]
                const reason = rawValue === undefined ? null : quantityDraftReason(rawValue)
                if (reason) {
                  setDeliveryAdjustError(`${row.name}：${reason}`)
                  return
                }
                setQuantityDrafts(current => { const next = { ...current }; delete next[row.key]; return next })
              }}
              className={`w-20 rounded-cta border bg-white px-2 py-1 text-right font-num ${rowDirty ? 'border-red text-red-fg' : 'border-border text-ink'}`} />
            <span className="text-gray3">{row.unit}</span>
          </span> : <>{row.quantity}{row.unit}</>
        }}
        onRemove={baseRow => {
          const row = detailRows.find(item => item.key === baseRow.key)!
          setSaveNotice(null)
          if (row.source === 'order' || row.source === 'catalog') removeOrderProduct(row.productId)
          else if (row.source === 'shipment' && row.itemId) removeShipmentItem(row.itemId, row.quantity)
          else if (row.source === 'shipment-addition') setPendingShipmentAdditions(current => current.map(item => item.key === row.key ? { ...item, pendingRemoval: true } : item))
          else if (row.source === 'delivery' && row.itemId) removeDeliveryItem(row.itemId)
          else if (row.source === 'delivery-addition') setPendingDeliveryAdditions(current => current.map(item => item.key === row.key ? { ...item, pendingRemoval: true } : item))
        }}
        onRestore={baseRow => {
          const row = detailRows.find(item => item.key === baseRow.key)!
          if (row.source === 'order' || row.source === 'catalog') restoreOrderProduct(row.productId)
          else if (row.source === 'shipment' && row.itemId) restoreShipmentItem(row.itemId, row.quantity)
          else if (row.source === 'shipment-addition') setPendingShipmentAdditions(current => current.map(item => item.key === row.key ? { ...item, pendingRemoval: false } : item))
          else if (row.source === 'delivery' && row.itemId) restoreDeliveryItem(row.itemId)
          else if (row.source === 'delivery-addition') setPendingDeliveryAdditions(current => current.map(item => item.key === row.key ? { ...item, pendingRemoval: false } : item))
        }}
      />
      {canEditConfirmedDetails && <div className="mx-4 border-x border-b border-border bg-white p-3">
        <label className="mb-1 block text-micro text-gray3">发货备注 (选填)</label>
        <input value={shipNote} onChange={event => setShipNote(event.target.value)} maxLength={120}
          className="w-full rounded border border-border bg-bg p-2 text-body" placeholder="如：司机张三 18800001234 / 预计 2h 到" />
      </div>}

      {/* 到货差异 — 显示履约链、完整明细、证据与处理按钮 */}
      {(order.lossClaims?.length ?? 0) > 0 && (
        <div className="mx-4 mt-3 bg-red-bg/40 rounded-card border border-red/30 p-3">
          <div className="text-h2 text-red-fg mb-2">⚠ 到货差异 {order.lossClaims!.length} 条</div>
          {order.lossClaims!.map(c => {
            const kind = supplierLossClaimKindMeta(c.kind)
            const statusLabel = ({
              PENDING: '待处理', APPROVED: '已同意', AUTO_APPROVED: '24h 自动同意',
              REJECTED: '已拒绝', RESOLVED: '总厨已仲裁', NEGOTIATING: '协商中',
            } as Record<string, string>)[c.status] || c.status
            const statusTone = c.status === 'APPROVED' || c.status === 'AUTO_APPROVED' || c.status === 'RESOLVED' ? 'green'
                             : c.status === 'REJECTED' ? 'red' : 'orange'
            return (
              <div key={c.id} className="bg-white rounded-cta p-3 mt-2 first:mt-0 border border-red/20">
                <div className="flex items-baseline gap-2 mb-1">
                  <Chip tone={statusTone as any}>{statusLabel}</Chip>
                  <Chip tone="blue">{kind.label}</Chip>
                  <span className="text-caption text-gray3 font-num">#{c.no}</span>
                  <span className="ml-auto font-num text-h2 text-red-fg">−¥{Number(c.totalLossAmount).toLocaleString()}</span>
                </div>
                {c.description && <div className="text-caption text-gray2 mt-1">{c.description}</div>}
                <div className="mt-2 grid grid-cols-1 lg:grid-cols-3 gap-1 text-micro text-gray3">
                  <span>责任节点：{supplierLossClaimResponsibility(c.status)}</span>
                  <span>配送单：{c.deliveryOrder?.no || '历史未关联'}</span>
                  <span>收货单：{c.receipt?.no || '历史未关联'}</span>
                </div>
                <ul className="mt-2 text-micro text-gray2 space-y-0.5">
                  {c.items.map((ci, i) => (
                    <li key={i}>· {ci.product.name} {kind.quantityLabel} <b className="font-num text-red-fg">{ci.lossQty}{ci.product.unit || ''}</b> = ¥{Number(ci.lossAmount).toLocaleString()}</li>
                  ))}
                </ul>
                {/* 证据图 */}
                {(c.evidenceImages?.length ?? 0) > 0 && (
                  <>
                    <div className="text-micro text-gray3 mt-2 mb-1">证据 {c.evidenceImages!.length} 张 · 点击放大</div>
                    <div className="flex gap-2 overflow-x-auto">
                      {c.evidenceImages!.map((url, i) => {
                        const isVideo = /\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(url)
                        return (
                          <button key={i} type="button" onClick={() => setZoomImg(url)} className="shrink-0 relative">
                            {isVideo
                              ? <video src={url} muted playsInline preload="metadata" className="w-20 h-20 object-cover rounded border border-border bg-gray5" />
                              : <img src={url} alt="" className="w-20 h-20 object-cover rounded border border-border" />}
                            {isVideo && <span className="absolute bottom-0 left-0 right-0 bg-ink/60 text-white text-micro text-center py-0.5 rounded-b">▶ 视频</span>}
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
                {c.handlerNote && (
                  <p className="text-micro text-amber-fg mt-2">已处理: {c.handlerNote}</p>
                )}
                <a
                  href={`/v2/loss-claims/${c.id}/print`}
                  className="mt-3 w-full py-2 rounded-cta border border-ink text-ink text-button flex items-center justify-center"
                >查看并打印差异单</a>
                {/* 处理按钮 — 仅 PENDING 状态可操作 */}
                {c.status === 'PENDING' && (
                  <div className="flex gap-2 mt-3 pt-2 border-t border-border">
                    <button
                      onClick={() => {
                        setRejectingClaim({ id: c.id, no: c.no, amount: c.totalLossAmount })
                        setRejectNote('')
                      }}
                      className="flex-1 py-2 border border-red text-red-fg rounded-cta text-button">
                      提出异议 (送总厨仲裁)
                    </button>
                    <button
                      onClick={() => {
                        openConfirm({
                          title: `${kind.supplierActionLabel} ¥${Number(c.totalLossAmount).toFixed(2)}`,
                          body: supplierLossClaimSettlementHint(c.payableBasis),
                          confirmLabel: kind.supplierActionLabel,
                          tone: 'primary',
                          onConfirm: async () => {
                            try {
                              await apiFetch(`/api/loss-claims/${c.id}/handle`, {
                                method: 'PATCH',
                                body: JSON.stringify({ action: 'approve' }),
                              })
                              load()
                            } catch (e: any) { alert(e.message || '操作失败'); throw e }
                          },
                        })
                      }}
                      className="flex-1 py-2 bg-ink text-white rounded-cta text-button">
                      {kind.supplierActionLabel}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 入库单 (收货后才有) */}
      {order.receipt && (
        <div className="mx-4 mt-3 bg-green-bg/40 rounded-card border border-green/30 p-3 text-caption text-gray2">
          ✓ 已生成入库单 <b className="font-num">{order.receipt.no}</b>
        </div>
      )}

      {/* 底部只保留流程动作，商品调整统一由顶部保存。 */}
      {order.status === 'SUBMITTED' && !isOperationGroupContext && (
        <div className={`fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4 grid ${pendingRevision ? 'grid-cols-2' : 'grid-cols-2'} gap-2`}
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button onClick={rejectOrder} disabled={submitting}
            className="py-3 bg-white border border-red text-red-fg rounded-cta text-button disabled:opacity-40">拒单</button>
          {pendingRevision && !isDirectOperationGroupRevision ? (
            <button disabled className="py-3 bg-amber/10 border border-amber text-amber-fg rounded-cta text-button opacity-70">修改处理中</button>
          ) : (
            <button onClick={confirmOrder} disabled={submitting || detailsDirty}
              className="py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              {submitting ? '提交中…' : '接单'}
            </button>
          )}
        </div>
      )}
      {order.status === 'CONFIRMED' && !isOperationGroupContext && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4 grid grid-cols-2 gap-2"
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          {detailsDirty && <p className="col-span-2 text-center text-micro text-amber-fg">请先保存商品明细后再确认发货</p>}
          <button onClick={rejectOrder} disabled={submitting}
            className="py-3 bg-white border border-red text-red-fg rounded-cta text-button disabled:opacity-40">拒单</button>
          <button onClick={ship} disabled={submitting || detailsDirty}
            className="py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : '确认发货 (出发)'}
          </button>
        </div>
      )}
      {/* DELIVERING (在途) — 司机到门店后填备注 + 点「确认送达」启动 24h 倒计时 */}
      {order.status === 'DELIVERING' && !isOperationGroupContext && (
        <>
          {/* 客户验收单 — 2026-05-29 客户反馈: 厨师收货后传照片+备注, 供应商看完确认无误才点送达 */}
          {order.chefAckAt ? (
            <div className="mx-4 mt-3 bg-green-50 border border-green-300 rounded-card p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-h2 text-green-700">📷 客户已发验收单</span>
                <span className="text-micro text-gray3">{order.chefAckAt && new Date(order.chefAckAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              {(order.chefAckImages?.length ?? 0) > 0 && (
                <>
                  <div className="text-micro text-gray3 mb-1">客户验收照 {order.chefAckImages!.length} 张 · 点击放大</div>
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    {order.chefAckImages!.map((url: string, i: number) => (
                      <button key={i} type="button" onClick={() => setZoomImg(url)}
                        className="aspect-square bg-bg rounded overflow-hidden border border-border">
                        <img src={url} alt={`验收照 ${i + 1}`} className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </>
              )}
              {order.chefAckNote && (
                <div className="text-caption text-gray2 bg-white rounded p-2 border border-border">
                  <span className="text-micro text-gray3">客户备注: </span>
                  {order.chefAckNote}
                </div>
              )}
            </div>
          ) : (
            <div className="mx-4 mt-3 bg-amber/10 border border-amber/40 rounded-card p-3">
              <div className="text-caption text-amber-fg">
                ⏳ 客户还未发验收单
              </div>
              <p className="text-micro text-gray3 mt-1">
                建议等客户收货后确认无误再点送达; 如急可强制送达 (24h 倒计时会触发自动收货)
              </p>
            </div>
          )}
          {/* 送达备注输入 — 在固定底部 bar 上方 */}
          <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">送达备注 (选填, 比如 司机姓名 / 签收人)</label>
            <input value={deliverNote} onChange={e => setDeliverNote(e.target.value)} maxLength={120}
              className="w-full bg-bg border border-border rounded p-2 text-body"
              placeholder="如: 司机张三 18800001234 / 签收人 林城" />
          </div>
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4 grid grid-cols-1 gap-2"
               style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            {detailsDirty && <p className="text-center text-micro text-amber-fg">请先保存商品明细后再确认送达</p>}
            <button
              onClick={() => {
                const hasAck = !!order.chefAckAt
                openConfirm({
                  title: hasAck ? `确认 ${order.no} 已送达门店?` : `客户还没发验收单, 仍要送达?`,
                  body: hasAck
                    ? `客户已发验收单, 确认收货无误 — 提交后启动 24h 自动收货${deliverNote ? `\n\n备注: ${deliverNote}` : ''}`
                    : `⚠ 客户还没发验收单, 强制送达会启动 24h 自动收货倒计时, 如客户有异议可能撞期。建议等客户发验收单后再点。${deliverNote ? `\n\n备注: ${deliverNote}` : ''}`,
                  confirmLabel: hasAck ? '确认送达' : '强制送达',
                  tone: hasAck ? 'primary' : 'danger',
                  onConfirm: async () => {
                    setSubmitting(true)
                    try {
                      await apiFetch(`/api/orders/${order.id}/deliver`, {
                        method: 'PATCH',
                        body: JSON.stringify({ note: deliverNote.trim() || undefined }),
                      })
                      load()
                    } catch (e: any) { setError(e.message || '提交失败'); throw e }
                    finally { setSubmitting(false) }
                  },
                })
              }}
              disabled={submitting || detailsDirty}
              className="py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
              {submitting ? '提交中…' : '✓ 确认送达 (司机到店时点)'}
            </button>
            <p className="text-micro text-gray3 text-center">在途状态 — 货还没送到门店, 不会自动收货</p>
          </div>
        </>
      )}

      {(deliveryAddTarget || shipmentAddOpen || addOpen) && (() => {
        const isSubmittedAdd = addOpen
        const isShipmentDraftAdd = shipmentAddOpen
        const pendingRemovedProductIds = isSubmittedAdd
          ? new Set(removedOrderProductIds)
          : new Set((deliveryAddTarget?.items || [])
              .filter(item => removedDeliveryItemIds.includes(item.id))
              .map(item => item.productId))
        const existingProductIds = isSubmittedAdd
          ? new Set(detailRows.filter(item => !item.pendingRemoval).map(item => item.productId))
          : isShipmentDraftAdd
            ? new Set(detailRows.map(item => item.productId))
            : new Set((deliveryAddTarget?.items || [])
                .filter(item => !removedDeliveryItemIds.includes(item.id))
                .map(item => item.productId))
        const pendingAdditionProductIds = new Set((isSubmittedAdd
          ? []
          : isShipmentDraftAdd ? pendingShipmentAdditions : pendingDeliveryAdditions).map(item => item.productId))
        const availableProducts = catalog
          .filter(product => !existingProductIds.has(product.id) && !pendingAdditionProductIds.has(product.id))
          .filter(product => matchesWarehouseProductSearch(product, deliveryAddSearch))
        const selectedProduct = availableProducts.find(product => product.id === deliveryAddProductId)
        const selectedPendingRemoval = Boolean(selectedProduct && pendingRemovedProductIds.has(selectedProduct.id))
        const selectedRestoresOriginal = Boolean((isShipmentDraftAdd || isSubmittedAdd) && selectedProduct
          && order.items.some(item => item.productId === selectedProduct.id))
        const selectedPricing = selectedProduct ? resolveRevisionCatalogPricing(selectedProduct) : null
        const closeDetailAdd = () => {
          setDeliveryAddTarget(null)
          setShipmentAddOpen(false)
          if (isSubmittedAdd) closeAddPicker()
        }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4" onClick={() => { if (!submitting) closeDetailAdd() }}>
            <div className="w-full max-w-lg rounded-card bg-white p-4" onClick={event => event.stopPropagation()}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-h2">增加商品</h3>
                  <p className="mt-1 text-micro text-gray3">{isSubmittedAdd || isShipmentDraftAdd ? '加入后回到商品明细调整数量，并由右上角统一保存。' : '收货单保存前可操作，加入后同步库存、金额和送货单。'}</p>
                </div>
                <button type="button" onClick={closeDetailAdd} disabled={submitting} className="h-8 w-8 rounded-full bg-bg text-gray2 disabled:opacity-40">×</button>
              </div>
              {deliveryAdjustError && (
                <div className="mt-3 rounded-cta border border-red/30 bg-red-bg px-3 py-2 text-caption text-red-fg">{deliveryAdjustError}</div>
              )}
              <div className="mt-4 space-y-3">
                <label className="block text-micro text-gray3" htmlFor="delivery-warehouse-product-search">选择仓库商品</label>
                <input
                  id="delivery-warehouse-product-search"
                  type="search"
                  value={deliveryAddSearch}
                  onChange={event => { setDeliveryAddSearch(event.target.value); setDeliveryAddProductId('') }}
                  placeholder="搜索商品名称"
                  className="w-full rounded-cta border border-border bg-bg px-3 py-2 text-body outline-none focus:border-accent"
                />
                <div className="max-h-72 overflow-y-auto rounded-cta border border-border bg-white">
                  {availableProducts.length === 0 && <div className="px-3 py-8 text-center text-caption text-gray3">没有匹配的仓库商品</div>}
                  {availableProducts.map(product => {
                    const pricing = resolveRevisionCatalogPricing(product)
                    const selected = deliveryAddProductId === product.id
                    const restoresPendingRemoval = pendingRemovedProductIds.has(product.id)
                    return (
                      <button
                        key={product.id}
                        type="button"
                        disabled={pricing.status !== 'READY' && !restoresPendingRemoval && !((isSubmittedAdd || isShipmentDraftAdd) && order.items.some(item => item.productId === product.id))}
                        aria-pressed={selected}
                        onClick={() => setDeliveryAddProductId(product.id)}
                        className={`flex w-full items-center gap-3 border-b border-l-4 border-border px-3 py-3 text-left transition-colors last:border-b-0 disabled:opacity-40 ${selected ? 'border-l-amber bg-amber/20' : 'border-l-transparent hover:bg-bg'}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className={`block text-body ${selected ? 'font-medium text-amber-fg' : ''}`}>{product.name}</span>
                          <span className="block text-micro text-gray3">{[product.code, product.category, product.spec].filter(Boolean).join(' · ') || '暂无编码、分类或规格'}</span>
                        </span>
                        <span className="shrink-0 text-right font-num text-caption">
                          <span className="block">{restoresPendingRemoval || ((isSubmittedAdd || isShipmentDraftAdd) && order.items.some(item => item.productId === product.id)) ? '恢复原明细' : pricing.status === 'READY' ? `¥${pricing.orderUnitPrice}/${pricing.orderUnit}` : '价格待核验'}</span>
                          {selected && <span className="mt-1 block text-button text-amber-fg">✓ 已选择</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="rounded-cta bg-bg px-3 py-2 text-caption text-gray2">
                  {selectedPendingRemoval || selectedRestoresOriginal ? '确认后恢复到商品明细' : selectedPricing?.status === 'READY' ? `系统价格：¥${selectedPricing.orderUnitPrice} / ${selectedPricing.orderUnit}` : '选择仓库商品后自动带出系统价格'}
                </div>
              </div>

              <p className="mt-4 text-micro text-gray3">加入后默认数量为 1，请回到商品明细中调整。</p>
              <div className="mt-5 flex gap-2">
                <button type="button" onClick={closeDetailAdd} disabled={submitting} className="flex-1 rounded-cta border border-border py-2.5 text-button text-gray2 disabled:opacity-40">取消</button>
                <button type="button" onClick={() => void submitDetailAdd()}
                  disabled={submitting || !deliveryAddProductId || (!selectedPendingRemoval && !selectedRestoresOriginal && selectedPricing?.status !== 'READY')}
                  className="flex-1 rounded-cta bg-ink py-2.5 text-button text-white disabled:opacity-40">
                  {submitting ? '提交中…' : selectedPendingRemoval || selectedRestoresOriginal ? '确认恢复' : '确认增加'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 报损拒绝弹层 — 替代 window.prompt (WebView 友好) */}
      {rejectingClaim && (
        <div className="fixed inset-0 z-50 bg-ink/60 flex items-end justify-center"
             onClick={() => setRejectingClaim(null)}>
          <div className="bg-white rounded-t-card w-full max-w-md p-4"
               onClick={e => e.stopPropagation()}
               style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-3" />
            <h3 className="text-h2">拒绝报损 #{rejectingClaim.no}</h3>
            <p className="text-caption text-gray2 mt-1">
              报损金额 ¥{Number(rejectingClaim.amount).toFixed(2)} · 拒绝后送总厨仲裁
            </p>
            <label className="block mt-4 text-micro text-gray3 mb-1">拒绝理由 *</label>
            <textarea value={rejectNote} onChange={e => setRejectNote(e.target.value)}
                      rows={3} maxLength={200}
                      placeholder="如: 司机签收时数量没问题, 门店签收人也确认了, 不应算我方报损"
                      className="w-full bg-bg border border-border rounded-cta p-2 text-body" />
            <div className="flex gap-2 mt-4">
              <button onClick={() => setRejectingClaim(null)}
                      className="px-4 py-2 border border-border rounded-cta text-button text-gray2">取消</button>
              <button
                disabled={!rejectNote.trim() || submitting}
                onClick={async () => {
                  setSubmitting(true)
                  try {
                    await apiFetch(`/api/loss-claims/${rejectingClaim.id}/handle`, {
                      method: 'PATCH',
                      body: JSON.stringify({ action: 'reject', note: rejectNote.trim() }),
                    })
                    setRejectingClaim(null)
                    load()
                  } catch (e: any) { alert(e.message || '操作失败') }
                  finally { setSubmitting(false) }
                }}
                className="flex-1 py-2 bg-red text-white rounded-cta text-button disabled:opacity-40">
                {submitting ? '提交中…' : '确认拒绝'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 图片全屏 lightbox */}
      {zoomImg && (
        <div className="fixed inset-0 z-50 bg-ink/90 flex items-center justify-center p-4"
             onClick={() => setZoomImg(null)}>
          {/\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(zoomImg)
            ? <video src={zoomImg} controls autoPlay playsInline className="max-w-full max-h-full rounded" />
            : <img src={zoomImg} alt="" className="max-w-full max-h-full object-contain rounded" />}
          <button onClick={() => setZoomImg(null)}
                  className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 text-white text-h2 flex items-center justify-center">×</button>
        </div>
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
