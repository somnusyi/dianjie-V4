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
  items: { id: string; quantity: string; shippedQty: string | null; unitPrice: string; amount: string; receivedQty: string | null; product?: { name: string; spec: string | null; unit: string; code: string } }[]
  lossClaims?: {
    id: string; no: string; status: string
    totalLossAmount: string; description: string
    evidenceImages?: string[] | null
    handlerNote?: string | null
    createdAt?: string
    items: { product: { name: string; unit?: string }; lossQty: string; lossAmount: string }[]
  }[]
  receipt?: { id: string; no: string } | null
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '待接单', CONFIRMED: '已接单 待发货', DELIVERING: '配送中 (在途)',
  PENDING_CONFIRM: '已送达 (24h 内门店未确认自动收货)', RECEIVED: '已收货', COMPLETED: '已完成',
  CANCELED: '已取消',
}
const STATUS_TONE: Record<string, 'red' | 'orange' | 'gray' | 'green'> = {
  SUBMITTED: 'red', CONFIRMED: 'orange', DELIVERING: 'orange',
  PENDING_CONFIRM: 'orange', RECEIVED: 'green', COMPLETED: 'green', CANCELED: 'gray',
}
// currentIndex = 已完成步骤数 (已完成 ✓, 当前 highlighted)
// 5 步: 已发起=步0, 接单=步1, 在途=步2, 送达=步3, 门店已收=步4
const STATUS_TO_STEP: Record<string, number> = {
  SUBMITTED: 1,        // 已发起 ✓ 接单 current
  CONFIRMED: 2,        // 接单 ✓ 在途 current
  DELIVERING: 3,       // 在途 ✓ 送达 current
  PENDING_CONFIRM: 4,  // 送达 ✓ 已收 current
  RECEIVED: 5, COMPLETED: 5,
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
  // 追加物品 picker
  const [addOpen, setAddOpen] = useState(false)
  const [catalog, setCatalog] = useState<{ id: string; name: string; unit: string; price: string; spec?: string | null; category?: string; status: string }[]>([])
  const [addQty, setAddQty] = useState<Record<string, number>>({})
  const [addSearch, setAddSearch] = useState('')
  const [confirmState, openConfirm] = useConfirmSheet()

  function load() {
    apiFetch<Order>(`/api/orders/${id}`).then(setOrder).catch(e => setError(e.message || '加载失败'))
  }
  useEffect(() => { load() }, [id])

  function ship() {
    if (!order) return
    // 计算实际发货金额 + 找出有调整的行
    const lines = order.items.map(it => {
      const orig = Number(it.quantity)
      const sq = shipQty[it.id] != null ? shipQty[it.id] : orig
      return { it, sq, changed: Math.abs(sq - orig) > 0.0001 }
    })
    const newTotal = lines.reduce((s, l) => s + l.sq * Number(l.it.unitPrice), 0)
    const changed = lines.filter(l => l.changed)
    const overLimit = lines.find(l => l.sq > Number(l.it.quantity) * 1.1 + 0.0001)
    if (overLimit) { setError(`${overLimit.it.product?.name || ''} 实发超下单 110% 上限 (最多 ${(Number(overLimit.it.quantity)*1.1).toFixed(2)})`); return }
    const itemsBody = changed.length > 0 ? lines.map(l => ({ itemId: l.it.id, shippedQty: l.sq })) : undefined

    let body = `${order.items.length} 件商品`
    if (changed.length > 0) {
      body += `\n⚠ 已调整 ${changed.length} 项: ${changed.slice(0, 3).map(l => `${l.it.product?.name || ''} ${l.it.quantity}→${l.sq}`).join(', ')}${changed.length > 3 ? ' …' : ''}`
      body += `\n实发金额 ¥${newTotal.toLocaleString()} (原 ¥${Number(order.totalAmount).toLocaleString()})`
    } else {
      body += ` · 共 ¥${Number(order.totalAmount).toLocaleString()}`
    }
    body += `\n发货后会自动扣减库存, 24h 内门店未确认则自动收货.`

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
            body: JSON.stringify({ note: shipNote.trim() || undefined, items: itemsBody }),
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

  // 打开追加 picker — 拉自家 catalog, 排除已在订单里的 SKU
  async function openAddPicker() {
    setAddOpen(true)
    setAddQty({}); setAddSearch('')
    try {
      const data = await apiFetch<any>('/api/products')
      const list = Array.isArray(data) ? data : (data?.items || [])
      const existed = new Set(order?.items.map(it => it.product as any).filter(Boolean).map((p: any) => p.id || p.code))
      // /api/products 返回的 product 对象里有 id, 但 order item.product 没暴露 id, 用 productId
      const existedProductIds = new Set(
        await apiFetch<any>(`/api/orders/${order?.id}`).then(o => (o.items || []).map((i: any) => i.productId)).catch(() => [])
      )
      setCatalog(list.filter((p: any) => p.status === 'ENABLED' && !existedProductIds.has(p.id)))
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
    if (items.length === 0) { setAddOpen(false); return }
    const total = items.reduce((s, i) => {
      const p = catalog.find(c => c.id === i.productId)
      return s + (p ? Number(p.price) * i.quantity : 0)
    }, 0)
    openConfirm({
      title: `追加 ${items.length} 项?`,
      body: `本次新增金额 +¥${total.toLocaleString()}, 厨师长 / 店长 会收到通知.`,
      confirmLabel: '追加',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch(`/api/orders/${order.id}/add-items`, { method: 'POST', body: JSON.stringify({ items }) })
          setAddOpen(false); load()
        } catch (e: any) { setError(e.message || '追加失败'); throw e }
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
          steps={['已发起', '已接单', '在途', '送达', '门店已收'].map(label => ({label}))}
          currentIndex={step}
        />
      </div>

      {/* 商品明细 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border">
        <div className="px-3 pt-3 pb-2 flex items-center gap-2">
          <h2 className="text-h2 flex-1">商品明细 ({order.items.length})</h2>
          {order.status === 'CONFIRMED' && (
            <button onClick={openAddPicker}
                    className="px-2 py-1 rounded-cta border border-amber text-amber-fg text-caption"
                    title="门店在群里追单时, 你可以代加">+ 追加</button>
          )}
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

      {/* 报损 — 显示完整明细 + 证据图 + 处理按钮(供应商) */}
      {(order.lossClaims?.length ?? 0) > 0 && (
        <div className="mx-4 mt-3 bg-red-bg/40 rounded-card border border-red/30 p-3">
          <div className="text-h2 text-red-fg mb-2">⚠ 报损 {order.lossClaims!.length} 条</div>
          {order.lossClaims!.map(c => {
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
                  <span className="text-caption text-gray3 font-num">#{c.no}</span>
                  <span className="ml-auto font-num text-h2 text-red-fg">−¥{Number(c.totalLossAmount).toLocaleString()}</span>
                </div>
                {c.description && <div className="text-caption text-gray2 mt-1">{c.description}</div>}
                <ul className="mt-2 text-micro text-gray2 space-y-0.5">
                  {c.items.map((ci, i) => (
                    <li key={i}>· {ci.product.name} 短缺 <b className="font-num text-red-fg">{ci.lossQty}{ci.product.unit || ''}</b> = ¥{Number(ci.lossAmount).toLocaleString()}</li>
                  ))}
                </ul>
                {/* 证据图 */}
                {(c.evidenceImages?.length ?? 0) > 0 && (
                  <>
                    <div className="text-micro text-gray3 mt-2 mb-1">证据 {c.evidenceImages!.length} 张 · 点击放大</div>
                    <div className="flex gap-2 overflow-x-auto">
                      {c.evidenceImages!.map((url, i) => (
                        <button key={i} type="button" onClick={() => setZoomImg(url)} className="shrink-0">
                          <img src={url} alt="" className="w-20 h-20 object-cover rounded border border-border" />
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {c.handlerNote && (
                  <p className="text-micro text-amber-fg mt-2">已处理: {c.handlerNote}</p>
                )}
                {/* 处理按钮 — 仅 PENDING 状态可操作 */}
                {c.status === 'PENDING' && (
                  <div className="flex gap-2 mt-3 pt-2 border-t border-border">
                    <button
                      onClick={() => {
                        setRejectingClaim({ id: c.id, no: c.no, amount: c.totalLossAmount })
                        setRejectNote('')
                      }}
                      className="flex-1 py-2 border border-red text-red-fg rounded-cta text-button">
                      拒绝 (送总厨仲裁)
                    </button>
                    <button
                      onClick={() => {
                        openConfirm({
                          title: `同意报损 ¥${Number(c.totalLossAmount).toFixed(2)}?`,
                          body: `通过后系统自动从应付账期里扣减, 你少收 ¥${Number(c.totalLossAmount).toFixed(2)}`,
                          confirmLabel: '同意',
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
                      同意 (扣账期)
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
          const sq = shipQty[it.id] != null ? shipQty[it.id] : orig
          return { it, orig, sq, changed: Math.abs(sq - orig) > 0.0001 }
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
                >全部按下单量</button>
              </div>
              <ul className="divide-y divide-border">
                {lines.map(l => (
                  <li key={l.it.id} className="py-2 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-body truncate">{l.it.product?.name || '-'}</div>
                      <div className="text-micro text-gray3">下单 {l.orig} {l.it.product?.unit} · ¥{l.it.unitPrice}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        type="number" inputMode="decimal" step="0.01" min="0" max={l.orig * 1.1}
                        value={l.sq}
                        onChange={e => setShipQty(prev => ({ ...prev, [l.it.id]: Math.max(0, Math.min(l.orig * 1.1, Number(e.target.value) || 0)) }))}
                        className={`w-20 text-right font-num bg-bg rounded-chip px-2 py-1 outline-none ${l.changed ? (l.sq > l.orig ? 'border border-red text-red-fg' : 'border border-amber text-amber-fg') : ''}`}
                      />
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
              <p className="text-micro text-gray3 mt-2">⚠ 数量改为 0 = 该项不发货 · 允许加量 ≤ 下单 110% (称重/库存浮动) · 超 110% 需让店长补单</p>
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
            {submitting ? '提交中…' : '确认发货 (出发)'}
          </button>
        </div>
      )}
      {/* DELIVERING (在途) — 司机到门店后填备注 + 点「确认送达」启动 24h 倒计时 */}
      {order.status === 'DELIVERING' && (
        <>
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
                openConfirm({
                  title: `确认 ${order.no} 已送达门店?`,
                  body: `提交后系统会通知门店验收, 24h 内未确认将自动收货${deliverNote ? `\n\n备注: ${deliverNote}` : ''}`,
                  confirmLabel: '确认送达',
                  tone: 'primary',
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

      {/* 追加物品 抽屉 */}
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
                <h3 className="text-h2">追加物品</h3>
                <span className="text-caption text-gray3">{filtered.length}/{catalog.length} 可选</span>
              </div>
              <p className="px-4 pb-2 text-micro text-gray3">门店在群里追单 → 你帮加 · 单价按报价表当前价 · 已在订单里的 SKU 不会出现</p>
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
                  <div className="font-num text-h2">+ ¥{selectedTotal.toFixed(2)}</div>
                </div>
                <button onClick={() => setAddOpen(false)}
                        className="px-4 py-3 rounded-cta border border-border text-button text-gray2">取消</button>
                <button onClick={submitAdd} disabled={submitting || selectedCount === 0}
                        className="px-6 py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">提交追加</button>
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
          <img src={zoomImg} alt="" className="max-w-full max-h-full object-contain rounded" />
          <button onClick={() => setZoomImg(null)}
                  className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 text-white text-h2 flex items-center justify-center">×</button>
        </div>
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
