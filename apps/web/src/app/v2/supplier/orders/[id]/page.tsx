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
import { Chip, ProgressDots } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import dayjs from 'dayjs'
import { clientRequestId } from '@/lib/client-id'
import {
  buildPartialShipmentLines,
  buildShipmentConfirmBody,
  computeShipmentNewTotal,
  hasAnyPositiveShipment,
  mapFulfillmentToCloseSummary,
} from '@/lib/partial-shipment-ui'
import {
  calculateRevisionLineAmount,
  RevisionCatalogProduct,
  resolveRevisionCatalogPricing,
  sumRevisionLineAmounts,
} from '@/lib/supplier-revision-cost-pricing'
import {
  clearShipmentDraft,
  readShipmentDraft,
  shipmentDraftStorageKey,
  writeShipmentDraft,
} from '@/lib/shipment-draft-storage'

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
    id: string; no: string; status: string; actualTotalAmount: string; rowVersion: number; shippedAt?: string | null; deliveredAt?: string | null; receivedAt?: string | null
    items: { id: string; productId: string; shippedQty: string; receivedQty?: string | null; unitPriceSnapshot?: string; amount?: string; productSpecSnapshot?: string | null; productUnitSnapshot?: string | null; product?: { name: string; unit: string; spec?: string | null } }[]
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
  productId: string
  name: string
  spec: string | null
  unit: string
  unitPrice: number
  quantity: number
}

export default function SupplierOrderDetailPage() {
  const viewer = getUser()
  const orderBase = viewer?.role === 'SUPPLY_CHAIN'
    ? '/v2/supply-chain/fulfillment'
    : '/v2/supplier/orders'
  const viewerRole = viewer?.role || ''
  const viewerUserId = viewer?.id || ''
  const canRemoveDeliveryItem = viewerRole === 'SUPPLY_CHAIN'
  const canAdjustDeliveryBeforeDelivery = viewerRole === 'SUPPLY_CHAIN'
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
  const [deliveryAddProductId, setDeliveryAddProductId] = useState('')
  const [deliveryAdjustError, setDeliveryAdjustError] = useState<string | null>(null)
  const [shipNote, setShipNote] = useState('')
  // 发货时可调整每行的实际发货量 (称重 / 缺货). key=itemId, value=shippedQty
  const [shipQty, setShipQty] = useState<Record<string, number>>({})
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
  // 数量编辑允许短暂为空，避免用户必须先输入新数字再删除旧数字。
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({})
  const [addSearch, setAddSearch] = useState('')
  const [revisionError, setRevisionError] = useState<string | null>(null)
  const [groupAddContext, setGroupAddContext] = useState<{
    groupId: string
    targetNo: string
    targetCreatedAt: string
    memberCount: number
  } | null>(null)
  const groupAddAttemptedRef = useRef<string | null>(null)
  const revisionRequestKeyRef = useRef<string | null>(null)
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

  function load() {
    apiFetch<Order>(`/api/orders/${id}`).then(data => {
      setOrder(data)
      setDeliveryQty(Object.fromEntries((data.deliveries || []).flatMap(delivery =>
        delivery.items.map(item => [item.id, String(item.shippedQty)]))))
      setAddQty(Object.fromEntries(data.items.map(item => [item.productId, Number(item.quantity)])))
      setQuantityDrafts({})
      setRemovedDeliveryItemIds([])
      setPendingDeliveryAdditions([])
      const draftKey = shipmentDraftKey(data.id)
      if (typeof window !== 'undefined' && draftKey && data.status === 'CONFIRMED') {
        const restored = readShipmentDraft(localStorage, draftKey, {
          orderId: data.id,
          orderRowVersion: data.rowVersion,
          userId: viewerUserId,
          itemIds: data.items.map(item => item.id),
        })
        setShipQty(restored?.quantities || {})
        setSavedShipQty(restored?.quantities || {})
      } else {
        if (typeof window !== 'undefined' && draftKey) clearShipmentDraft(localStorage, draftKey)
        setShipQty({})
        setSavedShipQty({})
      }
    }).catch(e => setError(e.message || '加载失败'))
  }
  useEffect(() => { load() }, [id])

  function ship() {
    if (!order || isOperationGroupContext) return
    setShipmentNotice(null)
    const lines = buildPartialShipmentLines(order.items, shipQty)
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
    if (!hasAnyPositiveShipment(lines)) {
      setError('本次发货数量必须大于 0，零实发不会关闭订单或释放预占。如不发货请不要提交。')
      return
    }

    const itemsBody = changed.length > 0 ? lines.map(l => ({ itemId: l.it.id, shippedQty: l.sq })) : undefined
    const body = buildShipmentConfirmBody({
      itemCount: order.items.length,
      lines,
      newTotal,
      oldTotal: Number(order.totalAmount),
      inventoryMode: order.supplier.inventoryMode,
    })

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
            body: JSON.stringify({ note: shipNote.trim() || undefined, items: itemsBody, idempotencyKey: clientRequestId() }),
          })
          const fulfillment = mapFulfillmentToCloseSummary(res?.fulfillment)
          if (fulfillment?.hasClosedRemainder) {
            const closedNames = fulfillment.lines.filter(l => l.closedQty > 0).map(l => `${l.productName || '商品'} ${l.closedQty}`).join('、')
            setShipmentNotice(`发货成功。未发余量已关闭: ${closedNames}。不会补送，如仍需须门店重新下单。`)
          }
          const draftKey = shipmentDraftKey(order.id)
          if (typeof window !== 'undefined' && draftKey) clearShipmentDraft(localStorage, draftKey)
          load()
        } catch (e: any) { setError(e.message || '发货失败'); throw e }
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
    revisionRequestKeyRef.current = clientRequestId()
    setAddOpen(true)
    setAddSearch(''); setRevisionError(null)
    try {
      const catalogEndpoint = isDirectOperationGroupRevision && order?.supplier.id
        ? `/api/products?supplierId=${encodeURIComponent(order.supplier.id)}`
        : '/api/products'
      const data = await apiFetch<any>(catalogEndpoint)
      const list = Array.isArray(data) ? data : (data?.items || [])
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
    setAddQty(prev => {
      const next = { ...prev }
      if (q <= 0) delete next[pid]
      else next[pid] = q
      return next
    })
  }

  function showRevisionError(message: string) {
    if (isDirectOperationGroupRevision) setRevisionError(message)
    else setError(message)
  }

  async function submitAdd() {
    if (!order) return
    const catalogItems = Object.entries(addQty).filter(([, q]) => q > 0).map(([productId, quantity]) => ({ productId, quantity }))
    const items = catalogItems
    if (items.length === 0) { showRevisionError('订货单至少保留一个商品'); return }
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
    setRemovedDeliveryItemIds(current => current.includes(itemId)
      ? current.filter(id => id !== itemId)
      : [...current, itemId])
  }

  async function openDeliveryAdd(delivery: NonNullable<Order['deliveries']>[number]) {
    if (!order || !canAdjustDeliveryBeforeDelivery || delivery.receipt || delivery.status !== 'SHIPPED') return
    setDeliveryAdjustError(null)
    setDeliveryAddTarget(delivery)
    setDeliveryAddProductId('')
    try {
      const data = await apiFetch<any>(`/api/products?supplierId=${encodeURIComponent(order.supplier.id)}&page=1&pageSize=100`)
      const list = Array.isArray(data) ? data : (data?.items || [])
      setCatalog((list as RevisionCatalogProduct[]).filter(product => product.status === 'ENABLED'))
    } catch (e: any) {
      setDeliveryAddTarget(null)
      setDeliveryAdjustError(e.message || '加载商品目录失败')
    }
  }

  async function submitDeliveryAdd() {
    if (!order || !deliveryAddTarget) return
    setDeliveryAdjustError(null)
    if (!deliveryAddProductId) { setDeliveryAdjustError('请选择仓库商品'); return }
    const product = catalog.find(item => item.id === deliveryAddProductId)
    const pricing = product ? resolveRevisionCatalogPricing(product) : null
    if (!product || pricing?.status !== 'READY') { setDeliveryAdjustError('该商品价格待核验，暂不能加入'); return }
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
        additions: pendingDeliveryAdditions.map(item => ({ productId: item.productId, quantity: item.quantity })),
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
  const originalAmount = Number(order.originalTotalAmount ?? order.totalAmount)
  const currentOrderAmount = Number(order.currentOrderAmount ?? order.originalTotalAmount ?? order.totalAmount)
  const shipmentAmount = (order.deliveries || [])
    .filter(delivery => delivery.status !== 'CANCELLED')
    .reduce((sum, delivery) => sum + Number(delivery.actualTotalAmount || 0), 0)
  const receivedAmount = (order.receipts || []).reduce((sum, receipt) => sum + Number(receipt.totalAmount || 0), 0)
  const shipLinesForButton = order.status === 'CONFIRMED' ? buildPartialShipmentLines(order.items, shipQty) : null
  const shipAllZero = shipLinesForButton ? !hasAnyPositiveShipment(shipLinesForButton) : false
  const editableDelivery = (order.deliveries || []).find(delivery =>
    canAdjustDeliveryBeforeDelivery && !delivery.receipt && delivery.status === 'SHIPPED')
  const canEditSubmittedDetails = order.status === 'SUBMITTED'
    && (isDirectOperationGroupRevision || !pendingRevision)
  const canEditConfirmedDetails = order.status === 'CONFIRMED' && !isOperationGroupContext
  const canEditDeliveryDetails = Boolean(editableDelivery)

  const submittedCatalogRows = catalog.filter(product =>
    (addQty[product.id] || 0) > 0 && !order.items.some(item => item.productId === product.id))
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
      }
    }),
  ].filter(row => row.quantity > 0)

  const confirmedLines = canEditConfirmedDetails ? buildPartialShipmentLines(order.items, shipQty) : []
  const deliveryRows = editableDelivery ? [
    ...editableDelivery.items.filter(item => !removedDeliveryItemIds.includes(item.id)).map(item => ({
      key: item.id,
      itemId: item.id,
      productId: item.productId,
      name: item.product?.name || '-',
      spec: item.productSpecSnapshot || item.product?.spec || null,
      unit: item.productUnitSnapshot || item.product?.unit || '',
      unitPrice: Number(item.unitPriceSnapshot ?? (Number(item.amount || 0) / Math.max(Number(item.shippedQty), 1))),
      quantity: Number(deliveryQty[item.id] ?? item.shippedQty),
      originalQuantity: Number(item.shippedQty),
      source: 'delivery' as const,
    })),
    ...pendingDeliveryAdditions.map(item => ({
      key: item.key,
      productId: item.productId,
      name: item.name,
      spec: item.spec,
      unit: item.unit,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      originalQuantity: 0,
      source: 'delivery-addition' as const,
    })),
  ] : []

  const detailRows = canEditDeliveryDetails
    ? deliveryRows
    : canEditConfirmedDetails
      ? confirmedLines.filter(line => line.sq > 0).map(line => {
          const fullItem = order.items.find(item => item.id === line.it.id)
          return ({
          key: line.it.id,
          itemId: line.it.id,
          productId: line.it.productId,
          name: line.it.product?.name || '-',
          spec: fullItem?.product?.spec || null,
          unit: fullItem?.orderUnitSnapshot || fullItem?.productUnitSnapshot || line.it.product?.unit || '',
          unitPrice: Number(line.it.unitPrice),
          quantity: line.sq,
          originalQuantity: savedShipQty[line.it.id] ?? line.remaining,
          source: 'shipment' as const,
        })})
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
          }))

  const submittedDirty = canEditSubmittedDetails && (
    order.items.some(item => Math.abs((addQty[item.productId] ?? 0) - Number(item.quantity)) >= 0.0001)
    || submittedCatalogRows.length > 0
  )
  const shipmentDirty = canEditConfirmedDetails && confirmedLines.some(line =>
    Math.abs(line.sq - (savedShipQty[line.it.id] ?? line.remaining)) >= 0.0001)
  const deliveryDirty = canEditDeliveryDetails && (
    editableDelivery?.items.some(item => !removedDeliveryItemIds.includes(item.id)
      && Math.abs(Number(deliveryQty[item.id] ?? item.shippedQty) - Number(item.shippedQty)) >= 0.0001)
    || removedDeliveryItemIds.length > 0
    || pendingDeliveryAdditions.length > 0
  )
  const detailsDirty = submittedDirty || shipmentDirty || deliveryDirty
  const canShowSave = canEditSubmittedDetails || canEditConfirmedDetails || canEditDeliveryDetails

  async function saveDetails() {
    if (!order || !detailsDirty || submitting) return
    setError(null)
    setSaveNotice(null)
    if (canEditSubmittedDetails) {
      await submitAdd()
      return
    }
    if (canEditConfirmedDetails) {
      const quantities = Object.fromEntries(confirmedLines.map(line => [line.it.id, line.sq]))
      if (typeof window === 'undefined') return
      const draftKey = shipmentDraftKey(order.id)
      if (!draftKey) {
        setError('无法确认当前租户或用户，发货草稿未保存')
        return
      }
      try {
        writeShipmentDraft(localStorage, draftKey, {
          version: 1,
          orderId: order.id,
          orderRowVersion: order.rowVersion,
          userId: viewerUserId,
          quantities,
          updatedAt: new Date().toISOString(),
        })
      } catch {
        setError('发货草稿保存失败，请检查浏览器存储空间')
        return
      }
      setSavedShipQty(quantities)
      setSaveNotice('发货数量已保存到本机，刷新页面也会保留；点击“确认发货”后写入配送单。')
      return
    }
    if (editableDelivery) {
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
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <h1 className="text-h1 flex-1 truncate">订单详情</h1>
        <button
          onClick={() => router.push(`${orderBase}/${order.id}/delivery-note`)}
          className="px-3 py-1.5 rounded-cta border border-border bg-white text-button text-gray2 whitespace-nowrap"
          title="打开打印 / 导出 PDF 页面"
        >🖨 送货单</button>
        <Chip tone={tone}>{status.detailLabel}</Chip>
      </header>
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

      {/* 主信息 */}
      <div className="mx-4 mt-2 bg-white rounded-card border border-border p-4">
        <div className="text-micro text-gray3 font-num">#{order.no}</div>
        <div className="flex items-baseline justify-between mt-1">
          <span className="text-h2">{order.store.name}</span>
          <span className="text-right"><span className="text-micro text-gray3 block">{SUPPLIER_MONEY_TERMS.orderedAmount}</span><span className="font-num text-h1">¥{currentOrderAmount.toLocaleString()}</span></span>
        </div>
        {order.store.address && <div className="text-micro text-gray3 mt-1">📍 {order.store.address}</div>}
        <div className="text-caption text-gray2 mt-2">
          下单 {dayjs(order.createdAt).format('MM/DD HH:mm')} · 期望到货 {dayjs(order.expectedDate).format('MM/DD')}
          <br />创建人 {order.createdBy.name}
          {order.shippedAt && <><br />发货 {dayjs(order.shippedAt).format('MM/DD HH:mm')} · {order.shippedBy?.name || '-'}</>}
          {order.receivedAt && <><br />收货 {dayjs(order.receivedAt).format('MM/DD HH:mm')}</>}
        </div>
        {order.note && <div className="mt-2 bg-bg rounded p-2 text-caption text-gray2">📝 {order.note}</div>}
        {order.shippedNote && <div className="mt-2 bg-amber/10 rounded p-2 text-caption text-amber-fg">📦 发货备注: {order.shippedNote}</div>}
        {(order.currentRevisionNo || 0) > 0 && (
          <div className="mt-2 text-micro text-gray3">
            原始订货 ¥{originalAmount.toLocaleString()} · 当前第 {order.currentRevisionNo} 版 ¥{currentOrderAmount.toLocaleString()}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-border">
          <div>
            <div className="text-micro text-gray3">{SUPPLIER_MONEY_TERMS.orderedAmount}</div>
            <div className="font-num text-caption">¥{currentOrderAmount.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-micro text-gray3">{SUPPLIER_MONEY_TERMS.shipmentAmount}</div>
            <div className="font-num text-caption">{shipmentAmount > 0 ? `¥${shipmentAmount.toLocaleString()}` : '—'}</div>
          </div>
          <div>
            <div className="text-micro text-gray3">{SUPPLIER_MONEY_TERMS.payableAmount}</div>
            <div className="font-num text-caption">{receivedAmount > 0 ? `¥${receivedAmount.toLocaleString()}` : '—'}</div>
          </div>
        </div>
        <p className="text-micro text-gray3 mt-2">订货按已确认订单；实发按配送单；应付按门店实收入库单，三者不混用。</p>
      </div>

      {/* 改单审批状态与历史 */}
      {(order.revisions?.length ?? 0) > 0 && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
          <h2 className="text-h2">改单记录 ({order.revisions!.length})</h2>
          <ul className="mt-2 space-y-2">
            {order.revisions!.map(revision => (
              <li key={revision.id} className={`rounded-cta border p-2 ${revision.status === 'PENDING' ? 'border-amber bg-amber/10' : 'border-border bg-bg'}`}>
                <div className="flex items-center gap-2">
                  <span className="text-caption">第 {revision.revisionNo} 次 · {revision.reason}</span>
                  <Chip tone={revision.status === 'PENDING' ? 'orange' : revision.status === 'APPROVED' ? 'green' : 'gray'}>
                    {revision.status === 'PENDING'
                      ? (isDirectOperationGroupRevision ? '历史改单待处理' : '待门店确认')
                      : revision.status === 'APPROVED'
                        ? (isDirectOperationGroupRevision ? '已生效' : '已确认')
                        : revision.status === 'CANCELLED' ? (isDirectOperationGroupRevision ? '已替代' : '已取消') : '已驳回'}
                  </Chip>
                </div>
                <div className="text-micro text-gray3 mt-1">
                  {revision.requestedBy?.name || '供应商'} · {dayjs(revision.requestedAt).format('MM/DD HH:mm')} · {revision.changeSet?.length || 0} 项变化
                  {revision.reviewedBy?.name && <> · {revision.reviewedBy.name} 已处理</>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(order.deliveries?.length ?? 0) > 0 && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
          <h2 className="text-h2">关联配送单 ({order.deliveries!.length})</h2>
          <p className="mt-2 overflow-x-auto whitespace-nowrap text-caption text-gray2">
            {order.deliveries!.flatMap(delivery => delivery.items).length > 0
              ? order.deliveries!.flatMap(delivery => delivery.items).map((item, itemIndex) =>
                  `${itemIndex + 1}${item.product?.name || '商品'}${item.shippedQty}${item.product?.unit || ''}`)
                  .join('、')
              : '暂无配送商品'}
          </p>
        </div>
      )}

      {/* 进度条 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border p-4">
        <ProgressDots
          steps={['已发起', '已接单', '在途', '送达', '门店已收'].map(label => ({label}))}
          currentIndex={step}
        />
      </div>

      {/* 商品明细 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border">
        <div className="px-3 pt-3 pb-2 flex items-center gap-2">
          <h2 className="text-h2">商品明细 ({detailRows.length})</h2>
          {(canEditSubmittedDetails || canEditDeliveryDetails) && (
            <button type="button" onClick={() => canEditDeliveryDetails && editableDelivery ? void openDeliveryAdd(editableDelivery) : void openAddPicker()}
              className="px-2 py-1 rounded-cta border border-amber text-amber-fg text-caption">＋ 增加商品</button>
          )}
          <span className="ml-auto text-caption text-gray3 font-num">合计 ¥{detailRows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          {canShowSave && (
            <button type="button" onClick={() => void saveDetails()} disabled={!detailsDirty || submitting}
              className="px-4 py-1.5 rounded-cta bg-ink text-white text-button whitespace-nowrap disabled:opacity-40">
              {submitting ? '保存中…' : '保存'}
            </button>
          )}
        </div>
        {deliveryAdjustError && <div className="mx-3 mb-2 rounded-cta border border-red/30 bg-red-bg px-3 py-2 text-caption text-red-fg">{deliveryAdjustError}</div>}
        {revisionError && <p className="mx-3 mb-2 text-micro text-red-fg">{revisionError}</p>}
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[760px] text-left text-caption">
            <thead className="bg-bg text-micro text-gray3">
              <tr>
                <th className="w-16 px-3 py-2">序号</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">规格</th>
                <th className="px-3 py-2 text-right">数量</th>
                <th className="px-3 py-2 text-right">单价</th>
                <th className="px-3 py-2 text-right">总价</th>
                {canShowSave && <th className="w-20 px-3 py-2 text-right">操作</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {detailRows.map((row, itemIndex) => {
                const rowDirty = Math.abs(row.quantity - row.originalQuantity) >= 0.0001 || row.originalQuantity === 0
                return <tr key={row.key} className={rowDirty ? 'bg-red-bg/50 text-red-fg' : ''}>
                  <td className="px-3 py-3 font-num text-gray3">{itemIndex + 1}</td>
                  <td className="px-3 py-3">{row.name}</td>
                  <td className="px-3 py-3 text-gray2">{row.spec || '-'}</td>
                  <td className="px-3 py-3 text-right font-num">
                    {canShowSave ? <span className="inline-flex items-center gap-1">
                      <input type="number" inputMode="decimal" min="0" step="0.01" value={quantityDrafts[row.key] ?? String(row.quantity)} aria-label={`${row.name}数量`}
                        onChange={event => {
                          const rawValue = event.target.value
                          setQuantityDrafts(current => ({ ...current, [row.key]: rawValue }))
                          if (rawValue === '') return
                          const quantity = Number(rawValue)
                          if (!Number.isFinite(quantity) || quantity < 0) return
                          setSaveNotice(null)
                          if (row.source === 'order' || row.source === 'catalog') setAddQtyFor(row.productId, quantity)
                          else if (row.source === 'shipment' && row.itemId) setShipQty(current => ({ ...current, [row.itemId!]: quantity }))
                          else if (row.source === 'delivery' && row.itemId) setDeliveryQty(current => ({ ...current, [row.itemId!]: String(quantity) }))
                          else if (row.source === 'delivery-addition') setPendingDeliveryAdditions(current => current.map(item => item.key === row.key ? { ...item, quantity } : item))
                        }}
                        onBlur={() => setQuantityDrafts(current => {
                          const next = { ...current }
                          delete next[row.key]
                          return next
                        })}
                        className={`w-20 rounded-cta border bg-white px-2 py-1 text-right font-num ${rowDirty ? 'border-red text-red-fg' : 'border-border text-ink'}`} />
                      <span className="text-gray3">{row.unit}</span>
                    </span> : <>{row.quantity}{row.unit}</>}
                  </td>
                  <td className="px-3 py-3 text-right font-num">¥{row.unitPrice.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right font-num">¥{(row.quantity * row.unitPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  {canShowSave && <td className="px-3 py-3 text-right">
                    <button type="button" onClick={() => {
                      setSaveNotice(null)
                      if (row.source === 'order' || row.source === 'catalog') setAddQtyFor(row.productId, 0)
                      else if (row.source === 'shipment' && row.itemId) setShipQty(current => ({ ...current, [row.itemId!]: 0 }))
                      else if (row.source === 'delivery' && row.itemId) removeDeliveryItem(row.itemId)
                      else if (row.source === 'delivery-addition') setPendingDeliveryAdditions(current => current.filter(item => item.key !== row.key))
                    }} className="rounded-cta border border-red-fg/40 px-2 py-1 text-micro text-red-fg">移除</button>
                  </td>}
                </tr>
              })}
            </tbody>
          </table>
        </div>
        {canEditConfirmedDetails && <div className="border-t border-border p-3">
          <label className="text-micro text-gray3 block mb-1">发货备注 (选填)</label>
          <input value={shipNote} onChange={event => setShipNote(event.target.value)} maxLength={120}
            className="w-full bg-bg border border-border rounded p-2 text-body" placeholder="如：司机张三 18800001234 / 预计 2h 到" />
        </div>}
      </div>

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
            <button disabled className="py-3 bg-amber/10 border border-amber text-amber-fg rounded-cta text-button opacity-70">待门店确认</button>
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
          <button onClick={rejectOrder} disabled={submitting}
            className="py-3 bg-white border border-red text-red-fg rounded-cta text-button disabled:opacity-40">拒单</button>
          <button onClick={ship} disabled={submitting || shipAllZero}
            className="py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : shipAllZero ? '发货数量不能为 0' : '确认发货 (出发)'}
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
              disabled={submitting}
              className="py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
              {submitting ? '提交中…' : '✓ 确认送达 (司机到店时点)'}
            </button>
            <p className="text-micro text-gray3 text-center">在途状态 — 货还没送到门店, 不会自动收货</p>
          </div>
        </>
      )}

      {/* 接单前改单申请抽屉 */}
      {addOpen && (() => {
        const filtered = catalog.filter(p => {
          if (!addSearch.trim()) return true
          const hay = `${p.name} ${p.spec || ''}`.toLowerCase()
          return addSearch.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))
        })
        const selectedDetails = Object.entries(addQty).filter(([, q]) => q > 0)
        const selectedCount = selectedDetails.length
        const hasPendingSelected = selectedDetails.some(([pid]) => {
          const existing = order.items.find(it => it.productId === pid)
          if (existing) return false
          const p = catalog.find(c => c.id === pid)
          return !p || resolveRevisionCatalogPricing(p).status === 'PENDING'
        })
        const selectedAmounts = selectedDetails.map(([pid, q]) => {
          const existing = order.items.find(it => it.productId === pid)
          if (existing) {
            const p = catalog.find(c => c.id === pid)
            const unit = existing.orderUnitSnapshot || existing.productUnitSnapshot || existing.product?.unit || p?.unit || '订货单位'
            return calculateRevisionLineAmount(q, {
              status: 'READY',
              orderUnitPrice: existing.unitPrice,
              orderUnit: unit,
              unitLabel: `元 / ${unit}`,
              costPriceSource: '历史冻结订货价',
            })
          }
          const p = catalog.find(c => c.id === pid)
          if (!p) return null
          return calculateRevisionLineAmount(q, resolveRevisionCatalogPricing(p))
        })
        const selectedTotal = sumRevisionLineAmounts(selectedAmounts)
        return (
          <div className="fixed inset-0 z-50" onClick={() => setAddOpen(false)}>
            <div className="absolute inset-0 bg-ink/60" />
            <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[80vh] flex flex-col"
                 onClick={e => e.stopPropagation()}>
              <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
              <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
                <h3 className="text-h2">
                  选择要加入明细的商品
                </h3>
                <span className="text-caption text-gray3">{filtered.length}/{catalog.length} 商品</span>
              </div>
              <p className="px-4 pb-2 text-micro text-gray3">
                这里只负责选择商品；数量、移除和保存统一回到“商品明细”操作。
              </p>
              {revisionError && (
                <div className="mx-4 mb-2 rounded-cta border border-red/30 bg-red-bg px-3 py-2 text-caption text-red-fg">{revisionError}</div>
              )}
              <div className="px-4 pb-2 relative">
                <input type="search" value={addSearch} onChange={e => setAddSearch(e.target.value)}
                       placeholder={isDirectOperationGroupRevision ? '搜索目录商品 名称 / 规格' : '搜索 名称 / 规格'}
                       className="w-full bg-bg rounded-chip px-9 py-2 text-body outline-none" />
                <span className="absolute left-7 top-1/2 -translate-y-1/2 text-gray3 text-caption">🔍</span>
                {addSearch && (
                  <button onClick={() => setAddSearch('')}
                          className="absolute right-6 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray5 text-gray2 text-caption flex items-center justify-center">×</button>
                )}
              </div>
              <ul className="overflow-auto flex-1 divide-y divide-border">
                {filtered.length === 0 && <li className="px-4 py-8 text-center text-caption text-gray3">无匹配商品</li>}
                {filtered.map(p => {
                  const q = addQty[p.id] || 0
                  const existing = order.items.find(it => it.productId === p.id)
                  const pricing = existing ? null : resolveRevisionCatalogPricing(p)
                  const canSelect = !!existing || pricing?.status === 'READY'
                  return (
                    <li key={p.id} className={`flex items-center px-4 py-3 ${q > 0 ? 'bg-amber/5' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-body truncate">{p.name}</div>
                        <div className="text-micro text-gray3 font-num">
                          {(() => {
                            if (existing) {
                              const unit = existing.orderUnitSnapshot || existing.productUnitSnapshot || existing.product?.unit || p.unit || '订货单位'
                              return `¥${Number(existing.unitPrice).toFixed(2)} / ${unit} · 历史冻结价`
                            }
                            if (pricing?.status === 'READY') {
                              return `¥${pricing.orderUnitPrice} · ${pricing.unitLabel} · ${pricing.costPriceSource}`
                            }
                            if (pricing?.status === 'PENDING') {
                              return <span className="text-red-fg">{pricing.message}</span>
                            }
                            return '无法计算订货价'
                          })()}
                        </div>
                      </div>
                      {q === 0 ? (
                        <button onClick={() => setAddQtyFor(p.id, 1)}
                                disabled={!canSelect}
                                className="px-3 py-1.5 rounded-cta bg-amber/10 text-amber-fg text-button disabled:opacity-40 disabled:bg-gray5">
                          {canSelect ? '+ 加入' : '不可加入'}
                        </button>
                      ) : <span className="rounded-chip bg-green-bg px-3 py-1.5 text-button text-green-fg">已加入明细</span>}
                    </li>
                  )
                })}
              </ul>
              <div className="border-t border-border p-3 flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-micro text-gray3">已选 {selectedCount} 项</div>
                  <div className={selectedTotal === null ? 'text-caption text-red-fg' : 'font-num text-h2'}>
                    {selectedTotal === null
                      ? '调整后金额待核验'
                      : `调整后 ¥${Number(selectedTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </div>
                </div>
                <button onClick={() => setAddOpen(false)} disabled={hasPendingSelected || selectedCount > 500}
                        className="px-6 py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">完成选择</button>
              </div>
            </div>
          </div>
        )
      })()}

      {deliveryAddTarget && (() => {
        const existingProductIds = new Set(deliveryAddTarget.items.map(item => item.productId))
        const availableProducts = catalog.filter(product => !existingProductIds.has(product.id))
        const selectedProduct = availableProducts.find(product => product.id === deliveryAddProductId)
        const selectedPricing = selectedProduct ? resolveRevisionCatalogPricing(selectedProduct) : null
        return (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" onClick={() => { if (!submitting) setDeliveryAddTarget(null) }}>
            <div className="w-full max-w-lg rounded-card bg-white p-4" onClick={event => event.stopPropagation()}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-h2">增加配送商品</h3>
                  <p className="mt-1 text-micro text-gray3">仅在送达前可操作，加入后同步库存、金额和送货单。</p>
                </div>
                <button type="button" onClick={() => setDeliveryAddTarget(null)} disabled={submitting} className="h-8 w-8 rounded-full bg-bg text-gray2 disabled:opacity-40">×</button>
              </div>
              {deliveryAdjustError && (
                <div className="mt-3 rounded-cta border border-red/30 bg-red-bg px-3 py-2 text-caption text-red-fg">{deliveryAdjustError}</div>
              )}
              <div className="mt-4 space-y-3">
                <label className="block text-micro text-gray3">选择仓库商品</label>
                <select value={deliveryAddProductId} onChange={event => setDeliveryAddProductId(event.target.value)} className="w-full rounded-cta border border-border bg-white px-3 py-2 text-body">
                  <option value="">请选择原配送单中没有的仓库商品</option>
                  {availableProducts.map(product => {
                    const pricing = resolveRevisionCatalogPricing(product)
                    return <option key={product.id} value={product.id} disabled={pricing.status !== 'READY'}>{product.name}{product.spec ? ` · ${product.spec}` : ''}{pricing.status === 'READY' ? ` · ¥${pricing.orderUnitPrice}/${pricing.orderUnit}` : ' · 价格待核验'}</option>
                  })}
                </select>
                <div className="rounded-cta bg-bg px-3 py-2 text-caption text-gray2">
                  {selectedPricing?.status === 'READY' ? `系统价格：¥${selectedPricing.orderUnitPrice} / ${selectedPricing.orderUnit}` : '选择仓库商品后自动带出系统价格'}
                </div>
              </div>

              <p className="mt-4 text-micro text-gray3">加入后默认数量为 1，请回到商品明细中调整。</p>
              <div className="mt-5 flex gap-2">
                <button type="button" onClick={() => setDeliveryAddTarget(null)} disabled={submitting} className="flex-1 rounded-cta border border-border py-2.5 text-button text-gray2 disabled:opacity-40">取消</button>
                <button type="button" onClick={() => void submitDeliveryAdd()}
                  disabled={submitting || !deliveryAddProductId || selectedPricing?.status !== 'READY'}
                  className="flex-1 rounded-cta bg-ink py-2.5 text-button text-white disabled:opacity-40">
                  {submitting ? '提交中…' : '确认增加'}
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
