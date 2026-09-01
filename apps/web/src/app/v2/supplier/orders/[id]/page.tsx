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
    items: { id: string; productId: string; shippedQty: string; receivedQty?: string | null; product?: { name: string; unit: string } }[]
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

export default function SupplierOrderDetailPage() {
  const orderBase = getUser()?.role === 'SUPPLY_CHAIN'
    ? '/v2/supply-chain/fulfillment'
    : '/v2/supplier/orders'
  const viewerRole = getUser()?.role || ''
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
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shipmentNotice, setShipmentNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [removingItemId, setRemovingItemId] = useState<string | null>(null)
  const [adjustingItemId, setAdjustingItemId] = useState<string | null>(null)
  const [deliveryQty, setDeliveryQty] = useState<Record<string, string>>({})
  const [deliveryAddTarget, setDeliveryAddTarget] = useState<NonNullable<Order['deliveries']>[number] | null>(null)
  const [deliveryAddMode, setDeliveryAddMode] = useState<'existing' | 'custom'>('existing')
  const [deliveryAddProductId, setDeliveryAddProductId] = useState('')
  const [deliveryAddQuantity, setDeliveryAddQuantity] = useState('1')
  const [deliveryCustomName, setDeliveryCustomName] = useState('')
  const [deliveryCustomUnit, setDeliveryCustomUnit] = useState('件')
  const [deliveryCustomPrice, setDeliveryCustomPrice] = useState('')
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
  // 接单前改单申请: 当前订货数量 + 可追加商品, 全部须门店确认
  const [addOpen, setAddOpen] = useState(false)
  const [catalog, setCatalog] = useState<RevisionCatalogProduct[]>([])
  const [addQty, setAddQty] = useState<Record<string, number>>({})
  const [addSearch, setAddSearch] = useState('')
  const [adjustReason, setAdjustReason] = useState('')
  const [groupAddContext, setGroupAddContext] = useState<{
    groupId: string
    targetNo: string
    targetCreatedAt: string
    memberCount: number
  } | null>(null)
  const groupAddAttemptedRef = useRef<string | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  function load() {
    apiFetch<Order>(`/api/orders/${id}`).then(data => {
      setOrder(data)
      setDeliveryQty(Object.fromEntries((data.deliveries || []).flatMap(delivery =>
        delivery.items.map(item => [item.id, String(item.shippedQty)]))))
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
    setAddOpen(true)
    setAddSearch(''); setAdjustReason('')
    setAddQty(Object.fromEntries((order?.items || []).map(it => [it.productId, Number(it.quantity)])))
    try {
      const data = await apiFetch<any>('/api/products')
      const list = Array.isArray(data) ? data : (data?.items || [])
      const existingIds = new Set((order?.items || []).map(it => it.productId))
      setCatalog((list as RevisionCatalogProduct[]).filter((p: RevisionCatalogProduct) => p.status === 'ENABLED' || existingIds.has(p.id)))
    } catch (e: any) {
      setError(e.message || '加载 catalog 失败')
      setAddOpen(false)
    }
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
        if (order.status === 'SUBMITTED' && !order.revisions?.some(revision => revision.status === 'PENDING')) {
          void openAddPicker()
        }
      })
      .catch(error => {
        if (!cancelled) setError(error?.message || '集合信息加载失败')
      })
    return () => { cancelled = true }
  }, [order, operationGroupId, groupAddRequested])

  function setAddQtyFor(pid: string, q: number) {
    setAddQty(prev => {
      const next = { ...prev }
      if (q <= 0) delete next[pid]
      else next[pid] = q
      return next
    })
  }
  async function submitAdd() {
    if (!order) return
    const items = Object.entries(addQty).filter(([, q]) => q > 0).map(([productId, quantity]) => ({ productId, quantity }))
    if (items.length === 0) { setError('订货单至少保留一个商品'); return }
    if (!adjustReason.trim()) { setError('请填写改单原因'); return }

    const amounts = items.map(({ productId, quantity }) => {
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
        setError('商品目录已变化，请刷新后重新申请调整')
        return null
      }
      const pricing = resolveRevisionCatalogPricing(p)
      if (pricing.status === 'PENDING') {
        setError(pricing.message)
        return null
      }
      return calculateRevisionLineAmount(quantity, pricing)
    })
    const total = sumRevisionLineAmounts(amounts)
    if (total === null) return

    openConfirm({
      title: `申请调整订货单?`,
      body: `调整后 ${items.length} 项 · ¥${Number(total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n提交后须门店确认，确认前不能接单。\n原因: ${adjustReason.trim()}`,
      confirmLabel: '提交申请',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/orders/${order.id}/revisions`, {
            method: 'POST',
            body: JSON.stringify({
              items,
              reason: adjustReason.trim(),
              baseRowVersion: order.rowVersion,
              requestKey: clientRequestId(),
              ...(operationGroupId ? { operationGroupId } : {}),
            }),
          })
          setAddOpen(false); load()
        } catch (e: any) { setError(e.message || '改单申请失败'); throw e }
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

  function removeDeliveryItem(delivery: NonNullable<Order['deliveries']>[number], item: NonNullable<Order['deliveries']>[number]['items'][number]) {
    if (!order || !canRemoveDeliveryItem || delivery.receipt || !['SHIPPED', 'DELIVERED'].includes(delivery.status)) return
    setDeliveryAdjustError(null)
    openConfirm({
      title: `移除配送商品？`,
      body: `${item.product?.name || '该商品'} · 实发 ${item.shippedQty}${item.product?.unit || ''}\n仅在门店确认收货前可操作。移除后会同步冲回供应商库存和配送金额，原订单历史仍保留。`,
      confirmLabel: '确认移除',
      tone: 'danger',
      onConfirm: async () => {
        setSubmitting(true)
        setRemovingItemId(item.id)
        try {
          await apiFetch(`/api/deliveries/${delivery.id}/remove-item`, {
            method: 'PATCH',
            body: JSON.stringify({ itemId: item.id, rowVersion: delivery.rowVersion }),
          })
          load()
        } catch (e: any) { setDeliveryAdjustError(e.message || '移除商品失败'); throw e }
        finally { setSubmitting(false); setRemovingItemId(null) }
      },
    })
  }

  function adjustDeliveryItemQuantity(delivery: NonNullable<Order['deliveries']>[number], item: NonNullable<Order['deliveries']>[number]['items'][number]) {
    if (!order || !canAdjustDeliveryBeforeDelivery || delivery.receipt || delivery.status !== 'SHIPPED') return
    setDeliveryAdjustError(null)
    const targetQuantity = Number(deliveryQty[item.id])
    const currentQuantity = Number(item.shippedQty)
    if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) {
      setDeliveryAdjustError('数量必须大于 0；如需删除整项，请点击“移除”')
      return
    }
    if (Math.abs(targetQuantity - currentQuantity) < 0.0001) return
    openConfirm({
      title: `修改配送数量？`,
      body: `${item.product?.name || '该商品'} · ${currentQuantity}${item.product?.unit || ''} → ${targetQuantity}${item.product?.unit || ''}\n仅在送达前可操作，库存、金额和送货单会同步更新。`,
      confirmLabel: '确认修改',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        setAdjustingItemId(item.id)
        try {
          await apiFetch(`/api/deliveries/${delivery.id}/item-quantity`, {
            method: 'PATCH',
            body: JSON.stringify({ itemId: item.id, targetQuantity, rowVersion: delivery.rowVersion }),
          })
          load()
        } catch (e: any) { setDeliveryAdjustError(e.message || '修改数量失败'); throw e }
        finally { setSubmitting(false); setAdjustingItemId(null) }
      },
    })
  }

  function canSaveDeliveryItemQuantity(item: NonNullable<Order['deliveries']>[number]['items'][number]) {
    const targetQuantity = Number(deliveryQty[item.id])
    return Number.isFinite(targetQuantity)
      && targetQuantity > 0
      && Math.abs(targetQuantity - Number(item.shippedQty)) >= 0.0001
  }

  async function openDeliveryAdd(delivery: NonNullable<Order['deliveries']>[number]) {
    if (!order || !canAdjustDeliveryBeforeDelivery || delivery.receipt || delivery.status !== 'SHIPPED') return
    setDeliveryAdjustError(null)
    setDeliveryAddTarget(delivery)
    setDeliveryAddMode('existing')
    setDeliveryAddProductId('')
    setDeliveryAddQuantity('1')
    setDeliveryCustomName('')
    setDeliveryCustomUnit('件')
    setDeliveryCustomPrice('')
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
    if (!order || !deliveryAddTarget || submitting) return
    setDeliveryAdjustError(null)
    const quantity = Number(deliveryAddQuantity)
    if (!Number.isFinite(quantity) || quantity <= 0) { setDeliveryAdjustError('新增数量必须大于 0'); return }
    const customPrice = Number(deliveryCustomPrice)
    if (deliveryAddMode === 'existing' && !deliveryAddProductId) { setDeliveryAdjustError('请选择已有商品'); return }
    if (deliveryAddMode === 'custom' && (!deliveryCustomName.trim() || !deliveryCustomUnit.trim() || !Number.isFinite(customPrice) || customPrice < 0)) {
      setDeliveryAdjustError('请完整填写自定义商品名称、单位和价格')
      return
    }
    setSubmitting(true)
    try {
      await apiFetch(`/api/deliveries/${deliveryAddTarget.id}/add-item`, {
        method: 'POST',
        body: JSON.stringify({
          quantity,
          rowVersion: deliveryAddTarget.rowVersion,
          ...(deliveryAddMode === 'existing'
            ? { productId: deliveryAddProductId }
            : { customProduct: { name: deliveryCustomName.trim(), unit: deliveryCustomUnit.trim(), unitPrice: customPrice } }),
        }),
      })
      setDeliveryAddTarget(null)
      load()
    } catch (e: any) { setDeliveryAdjustError(e.message || '增加商品失败') }
    finally { setSubmitting(false) }
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
      {groupAddContext && (
        <div className="mx-4 mt-2 rounded-card border border-amber/30 bg-amber/10 p-3 text-caption text-amber-fg">
          集合新增商品默认加入下单时间最晚的原订单 <b>#{groupAddContext.targetNo}</b>（{dayjs(groupAddContext.targetCreatedAt).format('MM/DD HH:mm')}）。
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
                    {revision.status === 'PENDING' ? '待门店确认' : revision.status === 'APPROVED' ? '已确认' : '已驳回'}
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
          {deliveryAdjustError && !deliveryAddTarget && (
            <div className="mt-2 rounded-cta border border-red/30 bg-red-bg px-3 py-2 text-caption text-red-fg">{deliveryAdjustError}</div>
          )}
          <ul className="mt-2 space-y-2">
            {order.deliveries!.map(delivery => (
              <li key={delivery.id} className="rounded-cta border border-border bg-bg p-2">
                <div className="flex items-center gap-2">
                  <span className="font-num text-caption">{delivery.no}</span>
                  <Chip tone={delivery.status === 'RECEIVED' ? 'green' : 'orange'}>{delivery.status}</Chip>
                  <span className="ml-auto font-num text-caption">¥{Number(delivery.actualTotalAmount).toLocaleString()}</span>
                </div>
                <div className="text-micro text-gray3 mt-1">
                  本次 {delivery.items.length > 0 ? delivery.items.map(item => `${item.product?.name || ''} ${item.shippedQty}${item.product?.unit || ''}`).join('、') : '暂无可配送商品'}
                  {delivery.receipt && <> · 入库单 {delivery.receipt.no}</>}
                </div>
                {canAdjustDeliveryBeforeDelivery && !delivery.receipt && delivery.status === 'SHIPPED' && (
                  <div className="mt-2 flex justify-end border-t border-border pt-2">
                    <button type="button" onClick={() => void openDeliveryAdd(delivery)} disabled={submitting}
                      className="rounded-cta border border-amber/50 bg-amber/5 px-3 py-1.5 text-button text-amber-fg disabled:opacity-40">
                      ＋ 增加商品
                    </button>
                  </div>
                )}
                {canRemoveDeliveryItem && !delivery.receipt && ['SHIPPED', 'DELIVERED'].includes(delivery.status) && delivery.items.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border space-y-1">
                    {delivery.items.map(item => (
                      <div key={item.id} className="flex flex-wrap items-center gap-2 text-micro">
                        <span className="flex-1 truncate">{item.product?.name || '商品'} · {item.shippedQty}{item.product?.unit || ''}</span>
                        {canAdjustDeliveryBeforeDelivery && delivery.status === 'SHIPPED' && (
                          <>
                            <input type="number" inputMode="decimal" min="0.01" step="0.01"
                              aria-label={`${item.product?.name || '商品'}配送数量`}
                              value={deliveryQty[item.id] ?? String(item.shippedQty)}
                              onChange={event => setDeliveryQty(current => ({ ...current, [item.id]: event.target.value }))}
                              className="w-20 rounded-cta border border-border bg-white px-2 py-1 text-right font-num text-caption" />
                            <span className="text-gray3">{item.product?.unit || ''}</span>
                            <button type="button" onClick={() => adjustDeliveryItemQuantity(delivery, item)}
                              disabled={submitting || adjustingItemId === item.id || !canSaveDeliveryItemQuantity(item)}
                              className="rounded-cta border border-amber/50 px-2 py-1 text-amber-fg disabled:opacity-40">
                              {adjustingItemId === item.id ? '保存中…' : '保存数量'}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => removeDeliveryItem(delivery, item)}
                          disabled={submitting || removingItemId === item.id}
                          className="rounded-cta border border-red-fg/40 px-2 py-1 text-red-fg disabled:opacity-40"
                        >{removingItemId === item.id ? '处理中…' : '移除'}</button>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
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
          <h2 className="text-h2 flex-1">商品明细 ({order.items.length})</h2>
          {order.status === 'SUBMITTED' && !pendingRevision && (
            <button onClick={openAddPicker}
                    className="px-2 py-1 rounded-cta border border-amber text-amber-fg text-caption"
                    title="库存核查后申请调整，须门店确认">申请调整</button>
          )}
          <span className="text-caption text-gray3 font-num">合计 ¥{currentOrderAmount.toLocaleString()}</span>
        </div>
        <ul className="divide-y divide-border">
          {order.items.map(it => (
            <li key={it.id} className="px-3 py-2 flex items-start gap-2 text-caption">
              <div className="flex-1 min-w-0">
                <div className="truncate">{it.product?.name || '-'}</div>
                {it.product?.spec && <div className="text-micro text-gray3">{it.product.spec}</div>}
              </div>
              <div className="text-right font-num">
                {/* 总价醒目 + 下方"数量 × 单价"拆解, 替代原来易误解的 "¥50 → ¥250" 箭头 */}
                <div className="text-caption">¥{Number(it.amount).toLocaleString()}</div>
                <div className="text-micro text-gray3">
                  {it.quantity}{it.product?.unit || ''} × ¥{it.unitPrice}{it.product?.unit ? `/${it.product.unit}` : ''}
                </div>
                {it.shippedQty != null && Math.abs(Number(it.shippedQty) - Number(it.quantity)) > 0.0001 && (
                  <div className="text-micro text-amber-fg">实发 {it.shippedQty}</div>
                )}
                {it.receivedQty != null && Math.abs(Number(it.receivedQty) - Number(it.shippedQty ?? it.quantity)) > 0.0001 && (
                  <div className="text-micro text-red-fg">实收 {it.receivedQty}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
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

      {/* CONFIRMED 状态: 让供应商调整发货量 + 填发货备注 */}
      {order.status === 'CONFIRMED' && (() => {
        const lines = buildPartialShipmentLines(order.items, shipQty)
        const newTotal = computeShipmentNewTotal(lines)
        const oldTotal = Number(order.totalAmount)
        const totalDiffer = Math.abs(newTotal - oldTotal) > 0.01
        const allZero = !hasAnyPositiveShipment(lines)
        return (
          <>
            <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
              <div className="flex items-center justify-between mb-2">
                <label className="text-micro text-gray3">实际发货量 (称重 / 缺货可改)</label>
                <button
                  type="button"
                  onClick={() => setShipQty({})}
                  className="text-micro text-accent"
                  disabled={lines.every(l => !l.changed)}
                >全部按剩余量</button>
              </div>
              <ul className="divide-y divide-border">
                {lines.map(l => (
                  <li key={l.it.id} className="py-2 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-body truncate">{l.it.product?.name || '-'}</div>
                      <div className="text-micro text-gray3">下单 {l.orig} · 已发 {l.previous} · 剩余 {l.remaining} {l.it.product?.unit} · ¥{l.it.unitPrice}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      {(() => {
                        const pct = Number(l.it.product?.shipUpperPct ?? 1.10)
                        const buf = Number(l.it.product?.shipUpperBuffer ?? 5)
                        const upper = Math.max(0, Math.max(l.orig * pct, l.orig + buf) - l.previous)
                        return (
                          <>
                            <input
                              type="number" inputMode="decimal" step="0.01" min="0" max={upper}
                              value={l.sq}
                              onChange={e => setShipQty(prev => ({ ...prev, [l.it.id]: Math.max(0, Math.min(upper, Number(e.target.value) || 0)) }))}
                              className={`w-20 text-right font-num bg-bg rounded-chip px-2 py-1 outline-none ${l.changed ? (l.sq > l.orig ? 'border border-red text-red-fg' : 'border border-amber text-amber-fg') : ''}`}
                            />
                            <span className="text-micro text-gray3">{l.it.product?.unit}</span>
                            <button
                              type="button"
                              onClick={() => setShipQty(prev => ({ ...prev, [l.it.id]: 0 }))}
                              disabled={l.sq === 0}
                              title={`将${l.it.product?.name || '该商品'}本次实发设为 0`}
                              aria-label={`移除${l.it.product?.name || '该商品'}（实发设为 0）`}
                              className="ml-1 rounded-cta border border-red-fg/40 px-2 py-1 text-micro text-red-fg disabled:opacity-40"
                            >移除</button>
                          </>
                        )
                      })()}
                    </div>
                    <span className="font-num text-caption w-20 text-right">¥{(l.sq * Number(l.it.unitPrice)).toFixed(2)}</span>
                  </li>
                ))}
              </ul>
              {totalDiffer && (
                <div className="mt-2 pt-2 border-t border-border flex items-center justify-between text-caption">
                  <span className="text-amber-fg">实发金额</span>
                  <span className="font-num text-amber-fg">¥{newTotal.toLocaleString()} <span className="text-gray3 line-through ml-1">¥{oldTotal.toLocaleString()}</span></span>
                </div>
              )}
              <p className="text-micro text-gray3 mt-2">默认按剩余未配送数量发完。可直接修改实发数量（称重 / 缺货）；点击行内“移除”会将该行本次实发设为 0。首次发货后，所有未发余量将永久关闭，不会补送；如仍需须门店重新下单。价格继承已确认订货单，配送不可改价。</p>
              {allZero && <p className="text-micro text-red-fg mt-1">⚠ 所有商品发货数量为 0，无法提交。请至少填写一项正数发货量。</p>}
            </div>
            <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
              <label className="text-micro text-gray3 block mb-1">发货备注 (选填)</label>
              <input value={shipNote} onChange={e => setShipNote(e.target.value)} maxLength={120}
                className="w-full bg-bg border border-border rounded p-2 text-body" placeholder="如: 司机张三 18800001234 / 预计 2h 到" />
            </div>
          </>
        )
      })()}

      {/* 底部固定操作栏 - 按状态显示按钮。集合上下文只保留改单入口，
          不允许从原订单详情绕过集合执行拒单/接单/发货。 */}
      {order.status === 'SUBMITTED' && (
        <div className={`fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4 grid ${isOperationGroupContext ? 'grid-cols-1' : pendingRevision ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          {!isOperationGroupContext && (
            <button onClick={rejectOrder} disabled={submitting}
              className="py-3 bg-white border border-red text-red-fg rounded-cta text-button disabled:opacity-40">拒单</button>
          )}
          {pendingRevision ? (
            <button disabled className="py-3 bg-amber/10 border border-amber text-amber-fg rounded-cta text-button opacity-70">待门店确认</button>
          ) : (
            <>
              <button onClick={openAddPicker} disabled={submitting}
                className="py-3 bg-white border border-amber text-amber-fg rounded-cta text-button disabled:opacity-40">申请调整</button>
              {!isOperationGroupContext && (
                <button onClick={confirmOrder} disabled={submitting}
                  className="py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                  {submitting ? '提交中…' : '接单'}
                </button>
              )}
            </>
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
                <h3 className="text-h2">{groupAddContext ? '申请调整订货单（加入最晚订单）' : '申请调整订货单'}</h3>
                <span className="text-caption text-gray3">{filtered.length}/{catalog.length} 商品</span>
              </div>
              <p className="px-4 pb-2 text-micro text-gray3">可调整数量、移除或增加商品；已有行保持冻结订货价，新增商品按当前四单位合同换算订货价，待核验或非 1:1 合同缺失商品不可加入。提交后须门店确认才能接单。</p>
              <div className="px-4 pb-2">
                <label className="text-micro text-gray3 block mb-1">改单原因 *</label>
                <textarea value={adjustReason} onChange={e => setAdjustReason(e.target.value)} maxLength={200} rows={2}
                  placeholder="例如：土豆库存不足，申请 20kg 调整为 15kg"
                  className="w-full bg-bg border border-border rounded-cta px-3 py-2 text-body outline-none focus:border-amber" />
              </div>
              <div className="px-4 pb-2 relative">
                <input type="search" value={addSearch} onChange={e => setAddSearch(e.target.value)}
                       placeholder="搜索 名称 / 规格" className="w-full bg-bg rounded-chip px-9 py-2 text-body outline-none" />
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
                      ) : (
                        <div className="flex items-center gap-2">
                          <button onClick={() => setAddQtyFor(p.id, q - 1)}
                                  className="w-8 h-8 rounded-full bg-bg text-h2 flex items-center justify-center">−</button>
                          <input type="number" inputMode="decimal" min="0" step="0.5" value={q}
                                 onChange={e => setAddQtyFor(p.id, Math.max(0, Number(e.target.value) || 0))}
                                 disabled={!canSelect}
                                 className="w-14 text-center font-num text-body bg-bg rounded-chip py-1 outline-none disabled:opacity-50" />
                          <button onClick={() => setAddQtyFor(p.id, q + 1)}
                                  disabled={!canSelect}
                                  className="w-8 h-8 rounded-full bg-amber text-white text-h2 flex items-center justify-center disabled:opacity-40">+</button>
                        </div>
                      )}
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
                <button onClick={() => setAddOpen(false)}
                        className="px-4 py-3 rounded-cta border border-border text-button text-gray2">取消</button>
                <button onClick={submitAdd} disabled={submitting || selectedCount === 0 || !adjustReason.trim() || hasPendingSelected}
                        className="px-6 py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">提交申请</button>
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
        const parsedAddQuantity = Number(deliveryAddQuantity)
        const addQuantityValid = Number.isFinite(parsedAddQuantity) && parsedAddQuantity > 0
        const parsedCustomPrice = Number(deliveryCustomPrice)
        const customPriceValid = deliveryCustomPrice.trim() !== '' && Number.isFinite(parsedCustomPrice) && parsedCustomPrice >= 0
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
              <div className="mt-4 grid grid-cols-2 rounded-cta bg-bg p-1">
                <button type="button" onClick={() => setDeliveryAddMode('existing')} className={`rounded-cta px-3 py-2 text-button ${deliveryAddMode === 'existing' ? 'bg-white text-ink shadow-sm' : 'text-gray3'}`}>已有商品</button>
                <button type="button" onClick={() => setDeliveryAddMode('custom')} className={`rounded-cta px-3 py-2 text-button ${deliveryAddMode === 'custom' ? 'bg-white text-ink shadow-sm' : 'text-gray3'}`}>自定义商品</button>
              </div>

              {deliveryAddMode === 'existing' ? (
                <div className="mt-4 space-y-3">
                  <label className="block text-micro text-gray3">选择商品</label>
                  <select value={deliveryAddProductId} onChange={event => setDeliveryAddProductId(event.target.value)} className="w-full rounded-cta border border-border bg-white px-3 py-2 text-body">
                    <option value="">请选择原配送单中没有的商品</option>
                    {availableProducts.map(product => {
                      const pricing = resolveRevisionCatalogPricing(product)
                      return <option key={product.id} value={product.id} disabled={pricing.status !== 'READY'}>{product.name}{product.spec ? ` · ${product.spec}` : ''}{pricing.status === 'READY' ? ` · ¥${pricing.orderUnitPrice}/${pricing.orderUnit}` : ' · 价格待核验'}</option>
                    })}
                  </select>
                  <div className="rounded-cta bg-bg px-3 py-2 text-caption text-gray2">
                    {selectedPricing?.status === 'READY' ? `系统价格：¥${selectedPricing.orderUnitPrice} / ${selectedPricing.orderUnit}` : '选择商品后自动带出系统价格'}
                  </div>
                </div>
              ) : (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-micro text-gray3 sm:col-span-2">商品名称<input value={deliveryCustomName} onChange={event => setDeliveryCustomName(event.target.value)} maxLength={80} className="mt-1 w-full rounded-cta border border-border px-3 py-2 text-body" placeholder="请输入新商品名称" /></label>
                  <label className="text-micro text-gray3">单位<input value={deliveryCustomUnit} onChange={event => setDeliveryCustomUnit(event.target.value)} maxLength={16} className="mt-1 w-full rounded-cta border border-border px-3 py-2 text-body" placeholder="件 / kg / 箱" /></label>
                  <label className="text-micro text-gray3">单价<input type="number" inputMode="decimal" min="0" step="0.01" value={deliveryCustomPrice} onChange={event => setDeliveryCustomPrice(event.target.value)} className="mt-1 w-full rounded-cta border border-border px-3 py-2 font-num text-body" placeholder="0.00" /></label>
                </div>
              )}

              <label className="mt-4 block text-micro text-gray3">增加数量<input type="number" inputMode="decimal" min="0.01" step="0.01" value={deliveryAddQuantity} onChange={event => setDeliveryAddQuantity(event.target.value)} className="mt-1 w-full rounded-cta border border-border px-3 py-2 font-num text-body" /></label>
              <div className="mt-5 flex gap-2">
                <button type="button" onClick={() => setDeliveryAddTarget(null)} disabled={submitting} className="flex-1 rounded-cta border border-border py-2.5 text-button text-gray2 disabled:opacity-40">取消</button>
                <button type="button" onClick={() => void submitDeliveryAdd()}
                  disabled={submitting || !addQuantityValid || (deliveryAddMode === 'existing' ? !deliveryAddProductId || selectedPricing?.status !== 'READY' : !deliveryCustomName.trim() || !deliveryCustomUnit.trim() || !customPriceValid)}
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
