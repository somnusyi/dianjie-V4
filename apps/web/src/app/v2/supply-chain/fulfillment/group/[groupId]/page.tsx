'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import { clientRequestId } from '@/lib/client-id'

type GroupMember = {
  id: string
  no: string
  deliveryNo?: string | null
  createdAt: string
  submittedAt?: string | null
  expectedDate?: string | null
  status?: string | null
  store?: { id?: string; name?: string; no?: string } | null
  supplier?: { id?: string; name?: string } | null
  items?: Array<{ productId: string; name: string; spec: string | null; unit: string; quantity: string; amount: string }>
}

type GroupLine = {
  id: string
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: string
  amount: string
  sourceOrderNos: string[]
}

type GroupDetail = {
  source: 'pending' | 'accepted'
  group: {
    id: string
    storeId: string
    supplierId: string
    expectedDate: string
    memberOrderIds: string[]
    memberOrderNos: string[]
    memberCount: number
    firstCreatedAt: string
    lastCreatedAt: string
    isEligible?: boolean
    blockedOrderIds?: string[]
  }
  orders: GroupMember[]
  mergedItems: GroupLine[]
  totals: { quantity: string; amount: string }
}

function dateText(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function shortDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN')
}

/**
 * Internal supply-chain group detail. A group is an operation view over the
 * original orders, so this page never invents an order number or writes an
 * aggregate order row. The only mutation is the explicit atomic batch-confirm
 * action. Pre-acceptance edits are written directly to the latest source order
 * by the internal operation-group revision path.
 */
export default function InternalOperationGroupDetailPage() {
  const router = useRouter()
  const params = useParams() as { groupId?: string }
  const groupId = String(params.groupId || '')
  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function load() {
    if (!groupId) {
      setError('集合标识无效')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<GroupDetail>(`/api/orders/operation-groups/${encodeURIComponent(groupId)}`)
      setDetail(data)
    } catch (reason: any) {
      setError(reason?.message || '集合加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [groupId])

  const latestOrder = useMemo(() => {
    if (!detail?.orders?.length) return null
    return [...detail.orders].sort((a, b) => {
      const aTime = Date.parse(a.submittedAt || a.createdAt)
      const bTime = Date.parse(b.submittedAt || b.createdAt)
      return bTime - aTime || b.id.localeCompare(a.id)
    })[0]
  }, [detail])

  const canBatchConfirm = Boolean(
    detail
      && detail.source === 'pending'
      && detail.group.isEligible === true
      && !(detail.group.blockedOrderIds || []).length,
  )

  async function confirmGroup() {
    if (!detail || !canBatchConfirm || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch(`/api/orders/operation-groups/${encodeURIComponent(detail.group.id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          orderIds: detail.group.memberOrderIds,
          idempotencyKey: clientRequestId(),
        }),
      })
      setConfirmOpen(false)
      await load()
    } catch (reason: any) {
      setError(reason?.message || '批量接单失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-bg p-5 text-center text-caption text-gray3">集合加载中…</div>
    )
  }

  if (error || !detail) {
    return (
      <div className="min-h-screen bg-bg p-4">
        <button type="button" onClick={() => router.back()} className="text-caption text-gray2">‹ 返回</button>
        <div className="mt-6 rounded-card border border-red/30 bg-red-bg p-4 text-caption text-red-fg">{error || '集合不存在或已失效'}</div>
      </div>
    )
  }

  const first = detail.orders[0]
  const storeName = first?.store?.name || '未知门店'
  const supplierName = first?.supplier?.name || '未分配供应商'
  const addProductHref = latestOrder
    ? `/v2/supply-chain/fulfillment/${encodeURIComponent(latestOrder.id)}?operationGroup=${encodeURIComponent(detail.group.id)}&groupAdd=1`
    : null

  return (
    <div className="min-h-screen bg-bg pb-8">
      <header className="flex items-center gap-3 border-b border-border bg-white px-4 py-4 lg:px-8">
        <button type="button" onClick={() => router.back()} className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-white">‹</button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-h1">订单详情</h1>
            <Chip tone={detail.source === 'pending' ? 'orange' : 'green'}>
              {detail.source === 'pending' ? '待接单集合' : '已接单集合'}
            </Chip>
          </div>
          <p className="mt-1 text-caption text-gray2">{storeName} · {detail.group.memberCount} 张原订单</p>
        </div>
        <Link
          href={`/v2/supply-chain/fulfillment/${encodeURIComponent(detail.group.id)}/delivery-note`}
          className="shrink-0 rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2"
        >🖨 送货单</Link>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4 lg:px-8">
        <section className="rounded-card border border-amber/40 bg-white p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-micro text-gray3">合并订单</div>
              <h2 className="mt-1 text-h2">{storeName}</h2>
              <p className="mt-1 text-caption text-gray2">供应商：{supplierName}</p>
              <p className="mt-1 text-caption text-gray2">期望到货：{shortDate(detail.group.expectedDate)}</p>
              <p className="mt-1 text-micro text-gray3">
                下单时间：{dateText(detail.group.firstCreatedAt)}{detail.group.firstCreatedAt !== detail.group.lastCreatedAt ? ` — ${dateText(detail.group.lastCreatedAt)}` : ''}
              </p>
            </div>
            <div className="rounded-cta bg-bg px-4 py-3 text-right">
              <div className="text-micro text-gray3">合并商品合计</div>
              <div className="mt-1 font-num text-h1">¥{Number(detail.totals.amount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
              <div className="mt-1 text-micro text-gray3">{detail.mergedItems.length} 类 · {detail.totals.quantity} 件</div>
            </div>
          </div>
          {(detail.group.blockedOrderIds || []).length > 0 && (
            <div className="mt-3 rounded-cta border border-amber/30 bg-amber/10 p-3 text-caption text-amber-fg">
              集合内有历史未完成改单，暂不能批量接单。可先进入下方改单页处理。
            </div>
          )}
        </section>

        <section className="mt-3 rounded-card border border-border bg-white">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-h2">商品明细（合并后）</h2>
            <p className="mt-1 text-micro text-gray3">同一商品按冻结的名称、规格和单位合并；原订单仍保留在下方。</p>
          </div>
          <ul className="divide-y divide-border">
            {detail.mergedItems.map(item => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-body">{item.name}</div>
                  <div className="mt-0.5 text-micro text-gray3">{item.spec || '—'}</div>
                </div>
                <div className="text-right">
                  <div className="font-num text-body">{item.quantity} {item.unit}</div>
                  <div className="mt-0.5 font-num text-caption text-gray2">¥{Number(item.amount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
                </div>
              </li>
            ))}
            {detail.mergedItems.length === 0 && <li className="px-4 py-10 text-center text-caption text-gray3">暂无可展示商品</li>}
          </ul>
        </section>

        <section className="mt-3 rounded-card border border-border bg-white">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-h2">集合内订单</h2>
            <p className="mt-1 text-micro text-gray3">每个原订单一行，仅保留单号和下单日期用于核对。</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-caption">
              <thead className="bg-bg text-gray2">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">送货单号</th>
                  <th className="px-4 py-2 text-left font-medium">下单日期</th>
                </tr>
              </thead>
              <tbody>
                {detail.orders.map(order => (
                  <tr key={order.id} className="border-t border-border">
                    <td className="px-4 py-3 font-num text-ink">{order.deliveryNo || order.no}</td>
                    <td className="px-4 py-3 text-gray2">{dateText(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {canBatchConfirm ? (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={submitting}
              className="rounded-cta bg-ink px-4 py-3 text-center text-button text-white disabled:opacity-50"
            >批量接单</button>
          ) : (
            <div className="rounded-cta border border-border bg-bg px-4 py-3 text-center text-button text-gray3">
              {detail.source === 'accepted' ? '集合已接单' : '当前不可批量接单'}
            </div>
          )}
          {addProductHref && detail.source === 'pending' && latestOrder?.status === 'SUBMITTED' && (
            <Link href={addProductHref} className="rounded-cta border border-amber/50 bg-amber/5 px-4 py-3 text-center text-button text-amber-fg">
              接单前修改（数量 / 商品）
            </Link>
          )}
          <Link href={`/v2/supply-chain/fulfillment/${encodeURIComponent(detail.group.id)}/delivery-note`} className="rounded-cta border border-border bg-white px-4 py-3 text-center text-button text-gray2 sm:col-span-2">
            🖨 打印集合送货单（一个集合一张）
          </Link>
        </div>
      </main>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-card bg-white p-4">
            <h2 className="text-h2">确认批量接单？</h2>
            <p className="mt-2 whitespace-pre-line text-caption text-gray2">将一次接单 {detail.group.memberCount} 张原订单。不会创建新订单号，也不会改写原订单历史。</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} disabled={submitting} className="rounded-cta border border-border px-4 py-2.5 text-button text-gray2">取消</button>
              <button type="button" onClick={() => void confirmGroup()} disabled={submitting} className="rounded-cta bg-ink px-4 py-2.5 text-button text-white disabled:opacity-50">{submitting ? '提交中…' : '确认批量接单'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
