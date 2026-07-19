/**
 * 供应商 · 订单详情
 *
 * GET /api/orders/:id (后端按 supplierId 自动过滤越权)
 * 操作: 接单 / 发货 (按状态显示)
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
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

type Order = {
  id: string; no: string; status: string
  totalAmount: string
  originalTotalAmount?: string | null
  currentOrderAmount?: string | null
  rowVersion: number
  currentRevisionNo?: number
  expectedDate: string; createdAt: string
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
  items: { id: string; productId: string; quantity: string; shippedQty: string | null; unitPrice: string; amount: string; receivedQty: string | null; product?: { name: string; spec: string | null; unit: string; code: string; shipUpperPct?: string | number; shipUpperBuffer?: string | number } }[]
  revisions?: {
    id: string; revisionNo: number; status: string; reason: string; requestedAt: string
    changeSet: { kind: string; productId?: string; before?: any; after?: any }[]
    requestedBy?: { name: string }; reviewedBy?: { name: string } | null; reviewedAt?: string | null; reviewNote?: string | null
  }[]
  deliveries?: {
    id: string; no: string; status: string; actualTotalAmount: string; shippedAt?: string | null; deliveredAt?: string | null; receivedAt?: string | null
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

export default function SupplierOrderDetailPage() {
  const params = useParams() as any
  const router = useRouter()
  const id = params.id as string
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
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
  const [catalog, setCatalog] = useState<{ id: string; name: string; unit: string; price: string; spec?: string | null; category?: string; status: string }[]>([])
  const [addQty, setAddQty] = useState<Record<string, number>>({})
  const [addSearch, setAddSearch] = useState('')
  const [adjustReason, setAdjustReason] = useState('')
  const [confirmState, openConfirm] = useConfirmSheet()

  function load() {
    apiFetch<Order>(`/api/orders/${id}`).then(setOrder).catch(e => setError(e.message || '加载失败'))
  }
  useEffect(() => { load() }, [id])

  function ship() {
    if (!order) return
    // 计算实际发货金额 + 找出有调整的行
    const lines = order.items.map(it => {
      const ordered = Number(it.quantity)
      const previous = Number(it.shippedQty || 0)
      const remaining = Math.max(0, ordered - previous)
      const sq = shipQty[it.id] != null ? shipQty[it.id] : remaining
      return { it, ordered, previous, remaining, sq, changed: Math.abs(sq - remaining) > 0.0001 }
    })
    const newTotal = lines.reduce((s, l) => s + l.sq * Number(l.it.unitPrice), 0)
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
    const itemsBody = changed.length > 0 ? lines.map(l => ({ itemId: l.it.id, shippedQty: l.sq })) : undefined

    let body = `${order.items.length} 件商品`
    if (changed.length > 0) {
      body += `\n⚠ 已调整 ${changed.length} 项: ${changed.slice(0, 3).map(l => `${l.it.product?.name || ''} 剩余${l.remaining}→本次${l.sq}`).join(', ')}${changed.length > 3 ? ' …' : ''}`
      body += `\n本次配送金额 ¥${newTotal.toLocaleString()}`
    } else {
      body += ` · 共 ¥${Number(order.totalAmount).toLocaleString()}`
    }
    body += order.supplier.inventoryMode === 'STRICT'
      ? `\n发货后会自动扣减供应商库存，门店收货后再更新门店库存。`
      : `\n当前未核算供应商仓库库存，本次发货不会扣供应商库存；门店收货后仍会正常更新门店库存。`

    openConfirm({
      title: `确认发货 ${order.no}?`,
      body,
      confirmLabel: '确认发货',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/orders/${order.id}/ship`, {
            method: 'PATCH',
            body: JSON.stringify({ note: shipNote.trim() || undefined, items: itemsBody, idempotencyKey: clientRequestId() }),
          })
          load()
        } catch (e: any) { setError(e.message || '发货失败'); throw e }
        finally { setSubmitting(false) }
      },
    })
  }

  function confirmOrder() {
    if (!order) return
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
      setCatalog(list.filter((p: any) => p.status === 'ENABLED' || existingIds.has(p.id)))
    } catch (e: any) {
      setError(e.message || '加载 catalog 失败')
      setAddOpen(false)
    }
  }
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
    const total = items.reduce((s, i) => {
      const p = catalog.find(c => c.id === i.productId)
      return s + (p ? Number(p.price) * i.quantity : 0)
    }, 0)
    openConfirm({
      title: `申请调整订货单?`,
      body: `调整后 ${items.length} 项 · ¥${total.toLocaleString()}\n提交后须门店确认，确认前不能接单。\n原因: ${adjustReason.trim()}`,
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
            }),
          })
          setAddOpen(false); load()
        } catch (e: any) { setError(e.message || '改单申请失败'); throw e }
        finally { setSubmitting(false) }
      },
    })
  }

  function rejectOrder() {
    if (!order) return
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

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <h1 className="text-h1 flex-1 truncate">订单详情</h1>
        <button
          onClick={() => router.push(`/v2/supplier/orders/${order.id}/delivery-note`)}
          className="px-3 py-1.5 rounded-cta border border-border bg-white text-button text-gray2 whitespace-nowrap"
          title="打开打印 / 导出 PDF 页面"
        >🖨 送货单</button>
        <Chip tone={tone}>{status.detailLabel}</Chip>
      </header>

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
          <ul className="mt-2 space-y-2">
            {order.deliveries!.map(delivery => (
              <li key={delivery.id} className="rounded-cta border border-border bg-bg p-2">
                <div className="flex items-center gap-2">
                  <span className="font-num text-caption">{delivery.no}</span>
                  <Chip tone={delivery.status === 'RECEIVED' ? 'green' : 'orange'}>{delivery.status}</Chip>
                  <span className="ml-auto font-num text-caption">¥{Number(delivery.actualTotalAmount).toLocaleString()}</span>
                </div>
                <div className="text-micro text-gray3 mt-1">
                  本次 {delivery.items.map(item => `${item.product?.name || ''} ${item.shippedQty}${item.product?.unit || ''}`).join('、')}
                  {delivery.receipt && <> · 入库单 {delivery.receipt.no}</>}
                </div>
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
        const lines = order.items.map(it => {
          const orig = Number(it.quantity)
          const previous = Number(it.shippedQty || 0)
          const remaining = Math.max(0, orig - previous)
          const sq = shipQty[it.id] != null ? shipQty[it.id] : remaining
          return { it, orig, previous, remaining, sq, changed: Math.abs(sq - remaining) > 0.0001 }
        })
        const newTotal = lines.reduce((s, l) => s + l.sq * Number(l.it.unitPrice), 0)
        const oldTotal = Number(order.totalAmount)
        const totalDiffer = Math.abs(newTotal - oldTotal) > 0.01
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
                          <input
                            type="number" inputMode="decimal" step="0.01" min="0" max={upper}
                            value={l.sq}
                            onChange={e => setShipQty(prev => ({ ...prev, [l.it.id]: Math.max(0, Math.min(upper, Number(e.target.value) || 0)) }))}
                            className={`w-20 text-right font-num bg-bg rounded-chip px-2 py-1 outline-none ${l.changed ? (l.sq > l.orig ? 'border border-red text-red-fg' : 'border border-amber text-amber-fg') : ''}`}
                          />
                        )
                      })()}
                      <span className="text-micro text-gray3">{l.it.product?.unit}</span>
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
              <p className="text-micro text-gray3 mt-2">默认按剩余未配送数量发完；数量改为 0 表示本次不发，可在本次收货完成后继续补送。价格继承已确认订货单，配送不可改价。</p>
            </div>
            <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
              <label className="text-micro text-gray3 block mb-1">发货备注 (选填)</label>
              <input value={shipNote} onChange={e => setShipNote(e.target.value)} maxLength={120}
                className="w-full bg-bg border border-border rounded p-2 text-body" placeholder="如: 司机张三 18800001234 / 预计 2h 到" />
            </div>
          </>
        )
      })()}

      {/* 底部固定操作栏 - 按状态显示按钮 */}
      {order.status === 'SUBMITTED' && (
        <div className={`fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4 grid ${pendingRevision ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button onClick={rejectOrder} disabled={submitting}
            className="py-3 bg-white border border-red text-red-fg rounded-cta text-button disabled:opacity-40">拒单</button>
          {pendingRevision ? (
            <button disabled className="py-3 bg-amber/10 border border-amber text-amber-fg rounded-cta text-button opacity-70">待门店确认</button>
          ) : (
            <>
              <button onClick={openAddPicker} disabled={submitting}
                className="py-3 bg-white border border-amber text-amber-fg rounded-cta text-button disabled:opacity-40">申请调整</button>
              <button onClick={confirmOrder} disabled={submitting}
                className="py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                {submitting ? '提交中…' : '接单'}
              </button>
            </>
          )}
        </div>
      )}
      {order.status === 'CONFIRMED' && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4 grid grid-cols-2 gap-2"
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button onClick={rejectOrder} disabled={submitting}
            className="py-3 bg-white border border-red text-red-fg rounded-cta text-button disabled:opacity-40">拒单</button>
          <button onClick={ship} disabled={submitting}
            className="py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : '确认发货 (出发)'}
          </button>
        </div>
      )}
      {/* DELIVERING (在途) — 司机到门店后填备注 + 点「确认送达」启动 24h 倒计时 */}
      {order.status === 'DELIVERING' && (
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
        const selectedTotal = Object.entries(addQty).reduce((s, [pid, q]) => {
          const p = catalog.find(c => c.id === pid)
          return s + (p ? Number(p.price) * q : 0)
        }, 0)
        const selectedCount = Object.values(addQty).filter(q => q > 0).length
        return (
          <div className="fixed inset-0 z-50" onClick={() => setAddOpen(false)}>
            <div className="absolute inset-0 bg-ink/60" />
            <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[80vh] flex flex-col"
                 onClick={e => e.stopPropagation()}>
              <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
              <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
                <h3 className="text-h2">申请调整订货单</h3>
                <span className="text-caption text-gray3">{filtered.length}/{catalog.length} 商品</span>
              </div>
              <p className="px-4 pb-2 text-micro text-gray3">可调整数量、移除或增加商品；价格不可修改。提交后须门店确认才能接单。</p>
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
                  return (
                    <li key={p.id} className={`flex items-center px-4 py-3 ${q > 0 ? 'bg-amber/5' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-body truncate">{p.name}</div>
                        <div className="text-micro text-gray3 font-num">¥{Number(p.price).toFixed(2)} / {p.unit}{p.spec ? ' · ' + p.spec : ''}</div>
                      </div>
                      {q === 0 ? (
                        <button onClick={() => setAddQtyFor(p.id, 1)}
                                className="px-3 py-1.5 rounded-cta bg-amber/10 text-amber-fg text-button">+ 加入</button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button onClick={() => setAddQtyFor(p.id, q - 1)}
                                  className="w-8 h-8 rounded-full bg-bg text-h2 flex items-center justify-center">−</button>
                          <input type="number" inputMode="decimal" min="0" step="0.5" value={q}
                                 onChange={e => setAddQtyFor(p.id, Math.max(0, Number(e.target.value) || 0))}
                                 className="w-14 text-center font-num text-body bg-bg rounded-chip py-1 outline-none" />
                          <button onClick={() => setAddQtyFor(p.id, q + 1)}
                                  className="w-8 h-8 rounded-full bg-amber text-white text-h2 flex items-center justify-center">+</button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="border-t border-border p-3 flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-micro text-gray3">已选 {selectedCount} 项</div>
                  <div className="font-num text-h2">调整后 ¥{selectedTotal.toFixed(2)}</div>
                </div>
                <button onClick={() => setAddOpen(false)}
                        className="px-4 py-3 rounded-cta border border-border text-button text-gray2">取消</button>
                <button onClick={submitAdd} disabled={submitting || selectedCount === 0 || !adjustReason.trim()}
                        className="px-6 py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">提交申请</button>
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
