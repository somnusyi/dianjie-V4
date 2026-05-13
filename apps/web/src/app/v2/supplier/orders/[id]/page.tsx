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
import { Chip, ProgressDots } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import dayjs from 'dayjs'

type Order = {
  id: string; no: string; status: string
  totalAmount: string
  expectedDate: string; createdAt: string
  shippedAt: string | null; receivedAt: string | null
  shippedNote: string | null
  note: string | null
  store: { id: string; name: string; no: string; address?: string | null }
  supplier: { id: string; name: string; contactName?: string | null; contactPhone?: string | null }
  createdBy: { id: string; name: string }
  shippedBy: { id: string; name: string } | null
  items: { id: string; quantity: string; unitPrice: string; amount: string; receivedQty: string | null; product?: { name: string; spec: string | null; unit: string; code: string } }[]
  lossClaims?: { id: string; no: string; status: string; totalLossAmount: string; description: string; items: { product: { name: string }; lossQty: string; lossAmount: string }[] }[]
  receipt?: { id: string; no: string } | null
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '待接单', CONFIRMED: '已接单', DELIVERING: '配送中',
  PENDING_CONFIRM: '已发货 (待门店收货)', RECEIVED: '已收货', COMPLETED: '已完成',
  CANCELED: '已取消',
}
const STATUS_TONE: Record<string, 'red' | 'orange' | 'gray' | 'green'> = {
  SUBMITTED: 'red', CONFIRMED: 'orange', DELIVERING: 'orange',
  PENDING_CONFIRM: 'orange', RECEIVED: 'green', COMPLETED: 'green', CANCELED: 'gray',
}
const STATUS_TO_STEP: Record<string, number> = {
  SUBMITTED: 0, CONFIRMED: 1, DELIVERING: 2,
  PENDING_CONFIRM: 3, RECEIVED: 4, COMPLETED: 4,
}

export default function SupplierOrderDetailPage() {
  const params = useParams() as any
  const router = useRouter()
  const id = params.id as string
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [shipNote, setShipNote] = useState('')
  const [confirmState, openConfirm] = useConfirmSheet()

  function load() {
    apiFetch<Order>(`/api/orders/${id}`).then(setOrder).catch(e => setError(e.message || '加载失败'))
  }
  useEffect(() => { load() }, [id])

  function ship() {
    if (!order) return
    openConfirm({
      title: `确认发货 ${order.no}?`,
      body: `${order.items.length} 件商品 · 共 ¥${Number(order.totalAmount).toLocaleString()}\n发货后会自动扣减库存, 24h 内门店未确认则自动收货.`,
      confirmLabel: '确认发货',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/orders/${order.id}/ship`, {
            method: 'PATCH',
            body: JSON.stringify({ note: shipNote.trim() || undefined }),
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
      body: `${order.items.length} 件商品 · 共 ¥${Number(order.totalAmount).toLocaleString()}\n接单后店长能看到"已接单"状态, 你需要按期望日期 ${dayjs(order.expectedDate).format('MM/DD')} 前发货.`,
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

  const step = STATUS_TO_STEP[order.status] ?? 0
  const tone = STATUS_TONE[order.status] || 'gray'

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
        <Chip tone={tone}>{STATUS_LABEL[order.status] || order.status}</Chip>
      </header>

      {/* 主信息 */}
      <div className="mx-4 mt-2 bg-white rounded-card border border-border p-4">
        <div className="text-micro text-gray3 font-num">#{order.no}</div>
        <div className="flex items-baseline justify-between mt-1">
          <span className="text-h2">{order.store.name}</span>
          <span className="font-num text-h1">¥{Number(order.totalAmount).toLocaleString()}</span>
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
      </div>

      {/* 进度条 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border p-4">
        <ProgressDots
          steps={['待接单', '已接单', '配送中', '已发货', '已完成']}
          current={step}
        />
      </div>

      {/* 商品明细 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border">
        <div className="px-3 pt-3 pb-2 flex items-center">
          <h2 className="text-h2 flex-1">商品明细 ({order.items.length})</h2>
          <span className="text-caption text-gray3 font-num">合计 ¥{Number(order.totalAmount).toLocaleString()}</span>
        </div>
        <ul className="divide-y divide-border">
          {order.items.map(it => (
            <li key={it.id} className="px-3 py-2 flex items-start gap-2 text-caption">
              <div className="flex-1 min-w-0">
                <div className="truncate">{it.product?.name || '-'}</div>
                {it.product?.spec && <div className="text-micro text-gray3">{it.product.spec}</div>}
              </div>
              <div className="text-right font-num">
                <div>{it.quantity} {it.product?.unit}</div>
                <div className="text-micro text-gray3">¥{it.unitPrice} → ¥{Number(it.amount).toLocaleString()}</div>
                {it.receivedQty != null && Number(it.receivedQty) !== Number(it.quantity) && (
                  <div className="text-micro text-red-fg">实收 {it.receivedQty}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* 报损 */}
      {(order.lossClaims?.length ?? 0) > 0 && (
        <div className="mx-4 mt-3 bg-red-bg/40 rounded-card border border-red/30 p-3">
          <div className="text-h2 text-red-fg mb-2">⚠ 报损 {order.lossClaims!.length} 条</div>
          {order.lossClaims!.map(c => (
            <div key={c.id} className="text-caption text-gray2 border-t border-red/20 pt-2 mt-2 first:border-0 first:mt-0 first:pt-0">
              <div className="flex justify-between">
                <span>#{c.no} <Chip tone={c.status === 'AGREED' ? 'green' : c.status === 'DISPUTED' ? 'orange' : 'red'}>{c.status}</Chip></span>
                <span className="font-num text-red-fg">¥{Number(c.totalLossAmount).toLocaleString()}</span>
              </div>
              {c.description && <div className="text-micro text-gray3 mt-1">{c.description}</div>}
              <ul className="mt-1 text-micro text-gray3">
                {c.items.map((ci, i) => (
                  <li key={i}>· {ci.product.name} 损 <b className="font-num text-red-fg">{ci.lossQty}</b> = ¥{Number(ci.lossAmount).toLocaleString()}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* 入库单 (收货后才有) */}
      {order.receipt && (
        <div className="mx-4 mt-3 bg-green-bg/40 rounded-card border border-green/30 p-3 text-caption text-gray2">
          ✓ 已生成入库单 <b className="font-num">{order.receipt.no}</b>
        </div>
      )}

      {/* CONFIRMED 状态: 让供应商填发货备注 */}
      {order.status === 'CONFIRMED' && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">发货备注 (选填)</label>
          <input value={shipNote} onChange={e => setShipNote(e.target.value)} maxLength={120}
            className="w-full bg-bg border border-border rounded p-2 text-body" placeholder="如: 司机张三 18800001234 / 预计 2h 到" />
        </div>
      )}

      {/* 底部固定操作栏 - 按状态显示按钮 */}
      {order.status === 'SUBMITTED' && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4 grid grid-cols-2 gap-2"
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button onClick={rejectOrder} disabled={submitting}
            className="py-3 bg-white border border-red text-red-fg rounded-cta text-button disabled:opacity-40">拒单</button>
          <button onClick={confirmOrder} disabled={submitting}
            className="py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : '接单'}
          </button>
        </div>
      )}
      {order.status === 'CONFIRMED' && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4 grid grid-cols-2 gap-2"
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button onClick={rejectOrder} disabled={submitting}
            className="py-3 bg-white border border-red text-red-fg rounded-cta text-button disabled:opacity-40">拒单</button>
          <button onClick={ship} disabled={submitting}
            className="py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : '确认发货'}
          </button>
        </div>
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
