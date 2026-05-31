/**
 * 总厨 · 门店订货详情 (物流签收时间轴 + 商品明细)
 *
 * - 别人下的单 → 只读
 * - 自己下的单 (createdById === me.id) 且 status=SUBMITTED → 显示"撤单"按钮
 *   后端 PATCH /api/orders/:id/cancel 已限定 CHEF_DIRECTOR 必须是 createdById
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Chip, ProgressDots } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch, getUser } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Product = { id: string; name: string; unit: string; spec?: string | null }
type Item    = { id: string; productId: string; quantity: string | number; unitPrice: string | number; product?: Product }
type Order = {
  id: string; no: string; status: string
  storeId: string; supplierId: string
  expectedDate: string; createdAt: string
  totalAmount: string | number
  note?: string | null
  shippedAt?: string | null; shippedNote?: string | null
  deliveredAt?: string | null; deliveredNote?: string | null
  receivedAt?: string | null; autoConfirmed?: boolean
  // 厨师验收单 (DELIVERING 期间厨师发给供应商, 总厨只读)
  chefAckAt?: string | null
  chefAckImages?: string[]
  chefAckNote?: string | null
  store?: { id: string; name: string; no?: string | null }
  supplier?: { id: string; name: string }
  createdBy?: { id: string; name: string; role: string }
  items?: Item[]
}

const STATUS_TO_STEP: Record<string, number> = {
  DRAFT: 0, SUBMITTED: 1, CONFIRMED: 2, DELIVERING: 3,
  PENDING_CONFIRM: 4, RECEIVED: 5, COMPLETED: 5, CANCELLED: -1,
}
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿', SUBMITTED: '待接单', CONFIRMED: '已接单',
  DELIVERING: '配送中', PENDING_CONFIRM: '待签收',
  RECEIVED: '已签收', COMPLETED: '已完成', CANCELLED: '已取消',
}
function toneFor(s: string): 'gray' | 'amber' | 'green' | 'red' {
  if (s === 'CANCELLED') return 'gray'
  if (s === 'PENDING_CONFIRM') return 'red'
  if (s === 'DELIVERING' || s === 'CONFIRMED') return 'amber'
  if (s === 'COMPLETED' || s === 'RECEIVED') return 'green'
  return 'gray'
}

function fmt(ts: string | null | undefined): string {
  return ts ? dayjs(ts).format('MM-DD HH:mm') : '—'
}

export default function ChefDirectorOrderDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = String((params as any)?.id || '')
  const me = typeof window !== 'undefined' ? getUser() : null
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()
  // 验收单照片全屏放大 (target="_blank" 在 WebView 不工作, 走页内 lightbox)
  const [zoomImg, setZoomImg] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    apiFetch<Order>(`/api/orders/${id}`)
      .then(setOrder)
      .catch(e => setError(String(e?.message || e)))
  }, [id])

  async function doCancel(reason: string) {
    setCancelling(true)
    try {
      await apiFetch(`/api/orders/${id}/cancel`, {
        method: 'PATCH',
        body: JSON.stringify({ reason }),
      })
      // 刷新数据
      const fresh = await apiFetch<Order>(`/api/orders/${id}`)
      setOrder(fresh)
    } catch (e: any) {
      setError(e?.message || '撤单失败')
    } finally {
      setCancelling(false)
    }
  }

  if (error) return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="bg-red-bg text-red-fg rounded-card p-4">{error}</div>
    </div>
  )
  if (!order) return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <p className="text-caption text-gray3">加载中…</p>
    </div>
  )

  const stepIdx = STATUS_TO_STEP[order.status] ?? 1
  const tone = toneFor(order.status)
  const isMine = !!(me && order.createdBy && order.createdBy.id === me.id)
  // 2026-05-29 客户反馈: 撤回放宽到供应商发货前 (SUBMITTED + CONFIRMED)
  const canCancel = isMine && ['SUBMITTED', 'CONFIRMED'].includes(order.status)
  const cancelHint = order.status === 'CONFIRMED'
    ? '⚠ 该单供应商已接单, 撤回后会通知供应商"立即停止备货". 请填写撤回原因.'
    : '撤回后供应商会收到通知, 此操作不可恢复. 请填写撤回原因.'
  const total = Number(order.totalAmount || 0)

  // 时间轴节点 (跟 ProgressDots 对齐: 已发起 / 接单 / 在途 / 送达 / 签收)
  const timeline: Array<{ label: string; ts: string | null | undefined; note?: string | null }> = [
    { label: '已发起', ts: order.createdAt },
    { label: '已接单', ts: order.status === 'DRAFT' || order.status === 'SUBMITTED' ? null : order.createdAt /* 接单时间 schema 未单列, 用 createdAt 兜底; 后续可扩展 confirmedAt */ },
    { label: '在途',   ts: order.shippedAt,   note: order.shippedNote },
    { label: '已送达', ts: order.deliveredAt, note: order.deliveredNote },
    { label: '已签收', ts: order.receivedAt,  note: order.autoConfirmed ? '24h 超时自动签收' : undefined },
  ]

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">订单详情</h1>
      </header>

      {/* 顶部摘要卡 */}
      <div className="mx-4 mt-2 bg-white rounded-card border border-border p-3">
        <div className="flex items-center justify-between mb-2 gap-2">
          <span className="text-h2 flex items-center gap-1 min-w-0 flex-wrap">
            <span className="truncate">{order.supplier?.name || '未知供应商'}</span>
            {order.createdBy?.role === 'CHEF_DIRECTOR' && (
              <Chip tone={isMine ? 'amber' : 'gray'}>{isMine ? '我代下' : '总厨代下'}</Chip>
            )}
          </span>
          <span className="font-num text-h2 shrink-0">¥{total.toLocaleString()}</span>
        </div>
        <div className="text-micro font-num text-gray3 mb-2">#{order.no}</div>
        <div className="flex items-center gap-2 mb-2">
          <Chip tone={tone}>{STATUS_LABEL[order.status] || order.status}</Chip>
          <span className="text-caption text-gray2 truncate">{order.store?.name || '未知门店'}</span>
        </div>
        {stepIdx >= 0 && (
          <ProgressDots
            steps={[
              { label: '已发起' }, { label: '接单' }, { label: '在途' },
              { label: '送达' }, { label: '签收' },
            ]}
            currentIndex={stepIdx}
          />
        )}
      </div>

      {/* 物流时间轴 */}
      <section className="px-4 mt-4">
        <h2 className="text-h2 mb-2">物流签收时间</h2>
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {timeline.map((t, i) => (
            <li key={i} className="px-3 py-2.5 flex items-start gap-3">
              <span className={`w-2 h-2 rounded-full mt-1.5 ${t.ts ? 'bg-amber' : 'bg-gray5'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className={`text-body ${t.ts ? '' : 'text-gray3'}`}>{t.label}</span>
                  <span className="font-num text-micro text-gray3">{fmt(t.ts)}</span>
                </div>
                {t.note && <p className="text-micro text-gray3 mt-0.5 truncate">{t.note}</p>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* 厨师验收单 (DELIVERING 期间厨师发给供应商, 总厨只读)
          2026-05-31 客户反馈: 总厨也要能看到验收单 */}
      {order.chefAckAt && (
        <section className="px-4 mt-4">
          <h2 className="text-h2 mb-2">厨师验收单</h2>
          <div className="bg-white rounded-card border border-border p-3">
            <div className="text-micro text-gray3 mb-2">
              由 {order.createdBy?.name || '厨师长'} 发于 {dayjs(order.chefAckAt).format('MM-DD HH:mm')}
              {(order.chefAckImages?.length || 0) > 0 && ` · ${order.chefAckImages?.length} 张照片 · 点击放大`}
            </div>
            {(order.chefAckImages?.length || 0) > 0 && (
              <div className="flex gap-2 overflow-x-auto mb-2">
                {(order.chefAckImages || []).map((url, i) => (
                  <button key={i} type="button" onClick={() => setZoomImg(url)} className="shrink-0">
                    <img src={url} alt={`验收照 ${i + 1}`} className="w-20 h-20 object-cover rounded border border-border" />
                  </button>
                ))}
              </div>
            )}
            {order.chefAckNote && (
              <div className="text-caption text-gray2 bg-bg rounded p-2">
                <span className="text-micro text-gray3">备注: </span>
                {order.chefAckNote}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 元信息 */}
      <section className="px-4 mt-4">
        <h2 className="text-h2 mb-2">订单信息</h2>
        <div className="bg-white rounded-card border border-border divide-y divide-border text-caption">
          <Row k="期望到货" v={dayjs(order.expectedDate).format('YYYY-MM-DD')} />
          <Row k="发起人"   v={`${order.createdBy?.name || '—'}${order.createdBy?.role === 'CHEF_DIRECTOR' ? ' (总厨)' : ''}`} />
          <Row k="发起时间" v={dayjs(order.createdAt).format('YYYY-MM-DD HH:mm')} />
          {order.note && <Row k="备注" v={order.note} />}
        </div>
      </section>

      {/* 商品明细 */}
      <section className="px-4 mt-4">
        <h2 className="text-h2 mb-2">商品明细 ({order.items?.length || 0})</h2>
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {(order.items || []).map(it => (
            <li key={it.id} className="px-3 py-2.5 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-body truncate">
                  {it.product?.name || it.productId}
                  {it.product?.spec && <span className="text-micro text-gray3 ml-1">· {it.product.spec}</span>}
                </div>
                <div className="text-micro text-gray3 font-num">
                  ¥{Number(it.unitPrice).toFixed(2)} / {it.product?.unit || '件'} ×{' '}
                  <span>{Number(it.quantity)}</span>
                </div>
              </div>
              <span className="font-num text-body whitespace-nowrap">
                ¥{(Number(it.quantity) * Number(it.unitPrice)).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-2 px-3 py-2 bg-bg-warm rounded-card border border-border flex items-center justify-between">
          <span className="text-h2">合计</span>
          <span className="font-num text-h2">¥{total.toLocaleString()}</span>
        </div>
      </section>

      {/* 撤单按钮 — 仅自己代下 + 供应商发货前 (SUBMITTED + CONFIRMED) */}
      {canCancel && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3">
          <button
            type="button"
            disabled={cancelling}
            onClick={() => openConfirm({
              title: '撤回订单?',
              body: <span>{cancelHint}</span>,
              confirmLabel: cancelling ? '撤回中…' : '撤回订单',
              cancelLabel: '不撤了',
              tone: 'danger',
              withInput: true,
              inputPlaceholder: '例: 数量错误 / 联系不上供应商 / 已重复下单',
              inputRequired: true,
              onConfirm: (reason?: string) => doCancel((reason || '').trim() || '总厨撤回'),
            })}
            className="w-full py-3 bg-red text-white rounded-cta text-button disabled:opacity-40"
          >
            {cancelling ? '撤回中…' : `撤回订单 (供应商发货前可撤${order.status === 'CONFIRMED' ? ', 已接单需立即撤' : ''})`}
          </button>
        </div>
      )}

      <ConfirmSheet {...confirm} />

      {/* 图片全屏 lightbox — 验收单照片点击放大 */}
      {zoomImg && (
        <div className="fixed inset-0 z-50 bg-ink/90 flex items-center justify-center p-4"
             onClick={() => setZoomImg(null)}>
          <img src={zoomImg} alt="" className="max-w-full max-h-full object-contain rounded" />
          <button onClick={() => setZoomImg(null)}
                  className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 text-white text-h2 flex items-center justify-center">×</button>
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="px-3 py-2 flex items-center gap-3">
      <span className="text-gray3 w-20 shrink-0">{k}</span>
      <span className="text-body flex-1 break-all">{v}</span>
    </div>
  )
}
