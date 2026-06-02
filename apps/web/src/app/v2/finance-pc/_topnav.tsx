'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'

const TABS = [
  { key: 'home',   label: '工作台', href: '/v2/finance-pc/home',   badgeKey: 'pendingReview' as const },
  { key: 'review', label: '初审',   href: '/v2/finance-pc/review', badgeKey: 'pendingReview' as const },
  { key: 'funds',  label: '资金',   href: '/v2/finance-pc/funds',  badgeKey: 'dueThisWeek'   as const },
  { key: 'stores', label: '各店',   href: '/v2/finance-pc/stores' },
] as const

type Badges = { pendingReview?: number; dueThisWeek?: number }

export default function FinanceTopNav() {
  const pathname = usePathname() || ''
  const [user, setUser] = useState<{ name?: string } | null>(null)
  const [badges, setBadges] = useState<Badges>({})

  useEffect(() => {
    // 用户信息 (登录态本地缓存的)
    setUser(getUser())
    // badges 实时拉 (待初审单数 + 本周到期付款数), 60s 轮询
    let alive = true
    const load = async () => {
      try {
        const [pr, sch] = await Promise.all([
          apiFetch<{ total: number }>('/api/payment-requests?status=PENDING&pageSize=1').catch(() => ({ total: 0 })),
          apiFetch<any[]>('/api/schedules?days=7').catch(() => []),
        ])
        if (!alive) return
        const dueCount = Array.isArray(sch) ? sch.filter((s: any) => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status)).length : 0
        setBadges({ pendingReview: pr.total || 0, dueThisWeek: dueCount })
      } catch { /* 静默, badge 缺数据不阻断 */ }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const initial = (user?.name || '财').slice(0, 1)
  return (
    <header className="bg-white border-b border-border sticky top-0 z-30">
      <div className="max-w-[1440px] mx-auto px-6 h-14 flex items-center gap-6">
        <span className="bg-red text-white text-micro px-2 py-1 rounded-chip font-num">FIN</span>
        <span className="text-h2">滇界 · 财务系统</span>
        <nav className="flex-1 flex items-center gap-4 ml-6">
          {TABS.map(t => {
            const active = pathname.startsWith(t.href)
            const badgeKey = 'badgeKey' in t ? t.badgeKey : undefined
            const badge = badgeKey ? badges[badgeKey] : undefined
            return (
              <Link key={t.key} href={t.href}
                className={`px-2 py-1.5 text-button transition relative ${active ? 'text-ink font-medium' : 'text-gray2 hover:text-ink'}`}>
                {t.label}
                {badge != null && badge > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-micro bg-red text-white rounded-full font-num">{badge > 99 ? '99+' : badge}</span>
                )}
                {active && <span className="absolute -bottom-[15px] left-0 right-0 h-[2px] bg-ink"></span>}
              </Link>
            )
          })}
        </nav>
        <div className="flex items-center gap-3">
          <button className="w-9 h-9 rounded-full bg-bg flex items-center justify-center" aria-label="通知">🔔</button>
          <span className="w-9 h-9 rounded-full bg-red text-white flex items-center justify-center font-num">{initial}</span>
          <span className="text-caption">{user?.name || '加载中…'}</span>
        </div>
      </div>
    </header>
  )
}
