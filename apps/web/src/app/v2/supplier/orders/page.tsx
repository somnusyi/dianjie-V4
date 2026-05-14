/**
 * 供应商 App · 订单 Tab  PDF: supplier_order_list_and_detail
 * 接真实 GET /api/orders (后端按 supplierId 自动过滤)
 * 「发货」按钮 → PATCH /api/orders/:id/ship
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip, ProgressDots } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Order = {
  id: string; no: string; status: string
  totalAmount: string
  expectedDate: string; createdAt: string
  shippedAt: string | null
  store: { id: string; name: string }
  items: { id: string; quantity: string; unitPrice: string; product?: { name: string; unit: string } }[]
  lossClaims?: { id: string; status: string; totalLossAmount: string }[]
}

const STATUS_TO_STEP: Record<string, number> = {
  SUBMITTED: 0, CONFIRMED: 1, DELIVERING: 2,
  PENDING_CONFIRM: 3, RECEIVED: 4, COMPLETED: 4,
}
const STATUS_TONE: Record<string, 'red' | 'orange' | 'gray' | 'green'> = {
  SUBMITTED: 'red', CONFIRMED: 'orange', DELIVERING: 'orange',
  PENDING_CONFIRM: 'orange', RECEIVED: 'green', COMPLETED: 'green',
}

type LossClaim = {
  id: string; no: string; status: string
  totalLossAmount: string; description: string; createdAt: string
  store: { name: string }
  purchaseOrder: { id: string; no: string; totalAmount?: string }
  purchaseOrderId?: string
  items: { product: { name: string; unit: string }; orderedQty: string; receivedQty: string; lossQty: string; lossAmount: string }[]
}

export default function SupplierOrdersPage() {
  const [tab, setTab] = useState('orders')
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [claims, setClaims] = useState<LossClaim[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [filter, setFilter] = useState<'待接单' | '待发货' | '运送中' | '报损' | '已完成'>('待接单')
  const [confirmState, openConfirm] = useConfirmSheet()

  async function load() {
    try {
      const [o, c] = await Promise.all([
        apiFetch<{ items: Order[] }>('/api/orders?pageSize=50'),
        apiFetch<{ items: LossClaim[] }>('/api/loss-claims?pageSize=20').catch(() => ({ items: [] as LossClaim[] })),
      ])
      setOrders((o as any).items || (o as any) || [])
      setClaims((c as any).items || (c as any) || [])
    } catch (e: any) { setError(e.message || '加载失败') }
  }
  useEffect(() => { load() }, [])

  function ship(o: Order) {
    if (submitting) return
    openConfirm({
      title: `确认 ${o.store.name} 已发货？`,
      body: `订单 #${o.no} · 金额 ¥${Number(o.totalAmount).toLocaleString()}\n发货后 24h 内餐厅未确认将自动收货。`,
      confirmLabel: '确认发货',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(o.id)
        try {
          await apiFetch(`/api/orders/${o.id}/ship`, {
            method: 'PATCH',
            body: JSON.stringify({ note: '已按时发出' }),
          })
          await load()
        } catch (e: any) {
          alert(e.message || '发货失败')
          throw e
        } finally {
          setSubmitting(null)
        }
      },
    })
  }

  function handleClaim(c: LossClaim, action: 'approve' | 'reject') {
    if (submitting) return
    if (action === 'reject') {
      openConfirm({
        title: `拒绝报损 ${c.no}`,
        body: '请简述拒绝原因，将通知餐厅。',
        confirmLabel: '拒绝',
        tone: 'danger',
        withInput: true,
        inputRequired: true,
        inputPlaceholder: '例如：包装完好，疑非物流问题…',
        onConfirm: async (note) => {
          setSubmitting(c.id)
          try {
            await apiFetch(`/api/loss-claims/${c.id}/handle`, {
              method: 'PATCH',
              body: JSON.stringify({ action: 'reject', note }),
            })
            await load()
          } catch (e: any) {
            alert(e.message || '操作失败')
            throw e
          } finally {
            setSubmitting(null)
          }
        },
      })
    } else {
      openConfirm({
        title: `同意扣款 ¥${Number(c.totalLossAmount).toFixed(2)}`,
        body: '此金额将从下次账期中扣减。',
        confirmLabel: '同意扣款',
        tone: 'primary',
        onConfirm: async () => {
          setSubmitting(c.id)
          try {
            await apiFetch(`/api/loss-claims/${c.id}/handle`, {
              method: 'PATCH',
              body: JSON.stringify({ action: 'approve', note: '已确认报损属实' }),
            })
            await load()
          } catch (e: any) {
            alert(e.message || '操作失败')
            throw e
          } finally {
            setSubmitting(null)
          }
        },
      })
    }
  }

  const pendingClaims = (claims || []).filter(c => c.status === 'PENDING')

  function statusInTab(s: string, f: string) {
    if (f === '待接单') return s === 'SUBMITTED'
    if (f === '待发货') return s === 'CONFIRMED'
    if (f === '运送中') return s === 'PENDING_CONFIRM' || s === 'DELIVERING'   // DELIVERING 兼容老数据
    if (f === '已完成') return ['RECEIVED', 'COMPLETED', 'CANCELLED'].includes(s)
    return false
  }
  const visible = (orders || []).filter(o => statusInTab(o.status, filter))

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">订单</h1>
          <p className="text-caption text-gray3">{orders === null ? '加载中…' : `${orders.length} 单`}</p>
        </div>
      </header>

      {/* 报损待处理 banner（仅 PENDING 数量 > 0 时显示，强制提醒）*/}
      {pendingClaims.length > 0 && filter !== '报损' && (
        <button
          onClick={() => setFilter('报损')}
          className="mx-4 mt-2 w-[calc(100%-32px)] bg-red-bg border border-red/30 rounded-card p-3 flex items-center gap-3 text-left"
        >
          <span className="w-9 h-9 rounded-md bg-red text-white flex items-center justify-center text-h2">⚠</span>
          <div className="flex-1">
            <div className="text-h2 text-red-fg">{pendingClaims.length} 笔报损待处理</div>
            <p className="text-micro text-red-fg">总损失 ¥{pendingClaims.reduce((s, c) => s + Number(c.totalLossAmount || 0), 0).toFixed(2)} · 24h 未响应自动同意</p>
          </div>
          <span className="text-red-fg">›</span>
        </button>
      )}

      <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {(['待接单', '待发货', '运送中', '报损', '已完成'] as const).map((f) => {
          const cnt = f === '报损'
            ? pendingClaims.length
            : (orders || []).filter(o => statusInTab(o.status, f)).length
          const isUrgent = (f === '待接单' || f === '报损') && cnt > 0
          return (
            <button key={f} onClick={() => setFilter(f)}
              className={`shrink-0 px-3 py-1.5 rounded-cta text-button relative ${filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              <span>{f}</span>
              {cnt > 0 && <span className={`font-num ml-1 ${filter === f ? '' : isUrgent ? 'text-red-fg' : 'text-gray3'}`}>{cnt}</span>}
              {isUrgent && filter !== f && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red rounded-full" />}
            </button>
          )
        })}
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {/* 报损 tab 内容 */}
      {filter === '报损' && (
        <ul className="px-4 mt-3 space-y-2">
          {pendingClaims.length === 0 && (
            <li className="text-caption text-gray3 text-center py-12">暂无待处理报损</li>
          )}
          {pendingClaims.map(c => (
            <li key={c.id} className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-red">
              {/* 信息区可点击进订单详情 (含证据图等) */}
              <a href={`/v2/supplier/orders/${c.purchaseOrder.id || c.purchaseOrderId}`} className="block">
                <div className="flex items-center gap-2 mb-1">
                  <Chip tone="red">报损待处理</Chip>
                  <span className="text-micro text-gray3 ml-auto">{timeAgo(c.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-h2">{c.store.name} <span className="text-micro text-gray3 font-num">#{c.purchaseOrder.no}</span></span>
                  <span className="font-num text-h2 text-red-fg">−¥{Number(c.totalLossAmount).toFixed(2)}</span>
                </div>
                <p className="text-caption text-gray2 mt-0.5">{c.description}</p>
                <ul className="mt-2 text-micro text-gray2 space-y-0.5">
                  {(c.items || []).map((it, idx) => (
                    <li key={idx}>· {it.product?.name}: 下 {it.orderedQty} 收 {it.receivedQty}{it.product?.unit || ''} · 损 ¥{Number(it.lossAmount).toFixed(2)}</li>
                  ))}
                </ul>
                <p className="text-micro text-amber-fg mt-2">查看证据图 / 完整明细 ›</p>
              </a>
              {/* 操作按钮 — 直接处理, 不需进详情 */}
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button
                  onClick={() => handleClaim(c, 'reject')}
                  disabled={submitting === c.id}
                  className="py-2 border border-red text-red rounded-cta text-button disabled:opacity-40"
                >拒绝</button>
                <button
                  onClick={() => handleClaim(c, 'approve')}
                  disabled={submitting === c.id}
                  className="py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40"
                >{submitting === c.id ? '提交中…' : `同意扣款 · ¥${Number(c.totalLossAmount).toFixed(2)}`}</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 普通订单 tabs 内容 */}
      {filter !== '报损' && (
      <ul className="px-4 mt-3 space-y-2">
        {visible.length === 0 && orders !== null && (
          <li className="text-caption text-gray3 text-center py-12">暂无{filter}订单</li>
        )}
        {visible.map(o => {
          const tone = STATUS_TONE[o.status] || 'gray'
          const stepIdx = STATUS_TO_STEP[o.status] ?? 0
          const isToShip = o.status === 'SUBMITTED' || o.status === 'CONFIRMED'
          return (
            <li key={o.id}
                onClick={() => location.href = `/v2/supplier/orders/${o.id}`}
                className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${tone === 'red' ? 'before:bg-red' : tone === 'orange' ? 'before:bg-orange' : 'before:bg-gray4'} cursor-pointer hover:bg-bg-warm transition-colors`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={tone}>{statusLabel(o.status)}</Chip>
                {isToShip && <Chip tone="red">需即办</Chip>}
                {/* 已完成 tab 内的报损标识 */}
                {(o.status === 'RECEIVED' || o.status === 'COMPLETED') && (o.lossClaims?.length ?? 0) > 0 && (
                  <Chip tone="orange">含报损 ¥{Math.round(o.lossClaims!.reduce((s, c) => s + Number(c.totalLossAmount || 0), 0)).toLocaleString()}</Chip>
                )}
                <span className="text-micro text-gray3 ml-auto">{timeAgo(o.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-h2">{o.store.name} <span className="text-micro text-gray3 font-num">#{o.no}</span></span>
                <span className="font-num text-h2">¥{Number(o.totalAmount).toLocaleString()}</span>
              </div>
              <p className="text-caption text-gray2 mt-0.5">
                {o.items.length} 项 · 期望 {dayjs(o.expectedDate).format('MM/DD')}
              </p>
              {!isToShip && (
                <div className="mt-3">
                  <ProgressDots
                    steps={[
                      { label: '已接' }, { label: '备货' }, { label: '在途' },
                      { label: '验收' }, { label: '完成' },
                    ]}
                    currentIndex={stepIdx}
                  />
                </div>
              )}
              {/* SUBMITTED 状态: 整卡已可点跳详情, 这里只放紧急快捷按钮 (接/拒) */}
              {o.status === 'SUBMITTED' && (
                <div className="grid grid-cols-2 gap-2 mt-3" onClick={e => e.stopPropagation()}>
                  <a href={`/v2/supplier/orders/${o.id}`} className="py-2 bg-white border border-red text-caption text-red-fg rounded-cta text-center">拒单</a>
                  <a href={`/v2/supplier/orders/${o.id}`} className="py-2 bg-ink text-white rounded-cta text-caption text-center">接单</a>
                </div>
              )}
              {o.status === 'CONFIRMED' && (
                <div className="mt-3" onClick={e => e.stopPropagation()}>
                  <button onClick={() => ship(o)} disabled={submitting === o.id}
                    className="w-full py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                    {submitting === o.id ? '提交中…' : '确认发货'}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      )}

      <BottomNav
        tabs={[
          { key: 'home', label: '首页', icon: '⌂' },
          { key: 'orders', label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me', label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')      location.href = '/v2/supplier/home'
          if (k === 'inventory') location.href = '/v2/supplier/inventory'
          if (k === 'billing')   location.href = '/v2/supplier/billing'
          if (k === 'me')        location.href = '/v2/supplier/history'
        }}
      />

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function statusLabel(s: string) {
  return ({
    SUBMITTED: '待接单', CONFIRMED: '已接单',
    DELIVERING: '配送中', PENDING_CONFIRM: '已送达',
    RECEIVED: '已收货', COMPLETED: '已完成', CANCELLED: '已取消',
  } as Record<string, string>)[s] || s
}
function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
