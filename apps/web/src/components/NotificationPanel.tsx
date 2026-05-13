'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import api from '@/lib/api'

const TYPE_CONFIG: Record<string, { icon: string; link: string }> = {
  ORDER_SUBMITTED:    { icon: '🛒', link: '/orders' },
  ORDER_SHIPPED:      { icon: '🚚', link: '/receipts' },
  RECEIPT_CONFIRMED:  { icon: '📦', link: '/finance' },
  LOSS_CLAIM_CREATED: { icon: '⚠️', link: '/loss-claims' },
  LOSS_CLAIM_RESULT:  { icon: '✅', link: '/loss-claims' },
  APPROVAL_PENDING:   { icon: '🔔', link: '/approval' },
  APPROVAL_DONE:      { icon: '💰', link: '/finance' },
  DUE_REMINDER_3DAY:  { icon: '📅', link: '/finance' },
  DUE_REMINDER_1DAY:  { icon: '🚨', link: '/finance' },
}

function timeAgo(dateStr: string) {
  const d = new Date(dateStr)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

export default function NotificationPanel() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // 轮询未读数量
  useEffect(() => {
    loadCount()
    const timer = setInterval(loadCount, 30000) // 30秒轮询
    return () => clearInterval(timer)
  }, [])

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const loadCount = async () => {
    try {
      const r = await api.get('/api/notifications/unread-count')
      setUnread(r.data.count)
    } catch {}
  }

  const loadList = async () => {
    setLoading(true)
    try {
      const r = await api.get('/api/notifications?pageSize=15')
      setItems(r.data.items || [])
    } catch {}
    setLoading(false)
  }

  const toggle = () => {
    if (!open) loadList()
    setOpen(!open)
  }

  const markRead = async (id: string) => {
    try {
      await api.patch(`/api/notifications/${id}/read`)
      setItems(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
      setUnread(prev => Math.max(0, prev - 1))
    } catch {}
  }

  const markAllRead = async () => {
    try {
      await api.patch('/api/notifications/read-all')
      setItems(prev => prev.map(n => ({ ...n, read: true })))
      setUnread(0)
    } catch {}
  }

  const clickItem = (item: any) => {
    if (!item.read) markRead(item.id)
    const config = TYPE_CONFIG[item.type]
    if (config) router.push(config.link)
    setOpen(false)
  }

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      {/* 铃铛按钮 */}
      <div onClick={toggle} style={{
        cursor: 'pointer', position: 'relative', padding: '6px 10px',
        borderRadius: 8, transition: 'background .15s',
      }}
        onMouseOver={e => (e.currentTarget.style.background = '#f3f4f6')}
        onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
      >
        <span style={{ fontSize: 18 }}>🔔</span>
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 4,
            background: '#dc2626', color: '#fff', fontSize: 10, fontWeight: 700,
            borderRadius: 10, padding: '0 5px', minWidth: 16, textAlign: 'center',
            lineHeight: '16px',
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </div>

      {/* 下拉面板 */}
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6,
          width: 380, maxHeight: 480, background: '#fff',
          borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,.15)',
          border: '1px solid #e5e7eb', zIndex: 1000,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* 头部 */}
          <div style={{
            padding: '14px 16px', borderBottom: '1px solid #f3f4f6',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#0a0f0c' }}>
              通知 {unread > 0 && <span style={{ color: '#dc2626', fontSize: 12 }}>({unread}条未读)</span>}
            </span>
            {unread > 0 && (
              <span onClick={markAllRead} style={{
                fontSize: 11, color: '#156b43', cursor: 'pointer', fontWeight: 500,
              }}>全部已读</span>
            )}
          </div>

          {/* 列表 */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>加载中...</div>
            ) : items.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>暂无通知</div>
            ) : (
              items.map(item => {
                const config = TYPE_CONFIG[item.type] || { icon: '📋', link: '/dashboard' }
                return (
                  <div key={item.id} onClick={() => clickItem(item)} style={{
                    padding: '12px 16px', cursor: 'pointer',
                    borderBottom: '1px solid #f9fafb',
                    background: item.read ? '#fff' : '#f0fdf4',
                    transition: 'background .1s',
                  }}
                    onMouseOver={e => (e.currentTarget.style.background = item.read ? '#fafafa' : '#e8fbe8')}
                    onMouseOut={e => (e.currentTarget.style.background = item.read ? '#fff' : '#f0fdf4')}
                  >
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <span style={{ fontSize: 16, lineHeight: 1.2 }}>{config.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 12.5, fontWeight: item.read ? 400 : 600,
                          color: '#0a0f0c', marginBottom: 3,
                        }}>{item.title}</div>
                        <div style={{
                          fontSize: 11.5, color: '#6b7280', lineHeight: 1.4,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
                        }}>{item.body}</div>
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>{timeAgo(item.createdAt)}</div>
                      </div>
                      {!item.read && (
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%', background: '#156b43',
                          flexShrink: 0, marginTop: 4,
                        }} />
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
