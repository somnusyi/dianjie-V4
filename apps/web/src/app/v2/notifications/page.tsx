/**
 * 消息中心 · 当前用户的所有通知
 * GET    /api/notifications?page=&pageSize=&unreadOnly=
 * PATCH  /api/notifications/:id/read
 * PATCH  /api/notifications/read-all
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

type Notif = {
  id: string
  type: string
  title: string
  body: string
  refType: string | null
  refId: string | null
  read: boolean
  createdAt: string
}

const TYPE_LABEL: Record<string, string> = {
  ORDER_SUBMITTED: '新订单',
  ORDER_SHIPPED: '已发货',
  RECEIPT_CONFIRMED: '已收货',
  LOSS_CLAIM_RESULT: '报损',
  APPROVAL_PENDING: '待审批',
  APPROVAL_DONE: '审批完成',
  PAYMENT_DONE: '付款',
}

function refLink(n: Notif): string | null {
  if (!n.refType || !n.refId) return null
  if (n.refType === 'PurchaseOrder')   return `/v2/chef/purchase/${n.refId}`
  if (n.refType === 'LossClaim')       return `/v2/supplier/orders` // TODO: 详情页
  if (n.refType === 'Document')        return `/v2/chef-director/approvals`
  if (n.refType === 'PaymentSchedule') return `/v2/finance/home`
  return null
}

function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export default function NotificationsPage() {
  const [items, setItems] = useState<Notif[] | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const d = await apiFetch<{ items: Notif[] }>(`/api/notifications?pageSize=50${unreadOnly ? '&unreadOnly=true' : ''}`)
      setItems(d.items || [])
    } catch (e: any) { setError(e.message) }
  }
  useEffect(() => { load() }, [unreadOnly])

  async function readAll() {
    await apiFetch('/api/notifications/read-all', { method: 'PATCH' }).catch(() => {})
    load()
  }
  async function open(n: Notif) {
    if (!n.read) {
      apiFetch(`/api/notifications/${n.id}/read`, { method: 'PATCH' }).catch(() => {})
      setItems(arr => arr ? arr.map(x => x.id === n.id ? { ...x, read: true } : x) : arr)
    }
    const link = refLink(n)
    if (link) location.href = link
  }

  const unreadCount = items ? items.filter(n => !n.read).length : 0

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">消息</h1>
          <p className="text-caption text-gray3">{items === null ? '加载中…' : `${items.length} 条 · 未读 ${unreadCount}`}</p>
        </div>
        {unreadCount > 0 && (
          <button onClick={readAll} className="px-3 h-9 rounded-cta bg-white border border-border text-button text-gray2">全部已读</button>
        )}
      </header>

      <div className="px-4 mt-2 flex gap-2">
        <button onClick={() => setUnreadOnly(false)}
                className={`px-3 py-1.5 rounded-cta text-button ${!unreadOnly ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>全部</button>
        <button onClick={() => setUnreadOnly(true)}
                className={`px-3 py-1.5 rounded-cta text-button ${unreadOnly ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>仅未读</button>
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <ul className="px-4 mt-3 space-y-2">
        {items?.length === 0 && (
          <li className="text-caption text-gray3 text-center py-12">{unreadOnly ? '没有未读消息' : '暂无消息'}</li>
        )}
        {items?.map(n => (
          <li key={n.id}
              onClick={() => open(n)}
              className={`relative bg-white rounded-card border border-border p-3 cursor-pointer ${!n.read ? 'before:content-[\'\'] before:absolute before:left-2 before:top-3.5 before:w-1.5 before:h-1.5 before:rounded-full before:bg-amber' : ''} ${!n.read ? 'pl-5' : ''}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-micro text-gray3">{TYPE_LABEL[n.type] || n.type}</span>
              <span className="text-micro text-gray4 ml-auto">{timeAgo(n.createdAt)}</span>
            </div>
            <div className={`text-h2 ${!n.read ? '' : 'text-gray2'}`}>{n.title}</div>
            <p className="text-caption text-gray2 mt-0.5 line-clamp-2">{n.body}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
