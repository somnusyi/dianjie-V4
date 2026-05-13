'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

export type DashboardData = {
  role: string
  user?: { id: string; name: string; role: string; store?: any; supplier?: any }
  store?: { id: string; name: string; no: string } | null
  supplier?: { id: string; name: string } | null
  hero?: {
    label: string; value: string; meta?: string; rightSlot?: string
    delta?: { text: string; trend: 'up' | 'down' | 'flat' }
    stats: { label: string; value: string; tone?: 'red' | 'orange' | 'green' | 'default' }[]
    /** 过去 7 日营业额，最早 → 最新；BOSS=集团合计，MANAGER=本店 */
    revenue7d?: number[]
  }
  approvals?: { total: number; totalAmount: string; byType: { type: string; n: number; tone: any }[] }
  storesOverview?: { id: string; rank: number; name: string; revenue: string; growth: string; anomaly: boolean }[]
  monthlyMetrics?: { label: string; value: string; delta?: string; tone?: any }[]
  pendingReviewCount?: number
  pendingApprovalCount?: number
}

export function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)
  useEffect(() => {
    let alive = true
    const tick = () => {
      apiFetch<DashboardData>('/api/v2/dashboard/me')
        .then(d => { if (alive) { setData(d); setRefreshedAt(new Date()) } })
        .catch(e => { if (alive) setError(String(e?.message || e)) })
    }
    tick()
    // 每 60s 静默刷一次, 让"今日营业额"接近实时
    // (Sprint B 后接入 SSE/WebSocket → 改为推送)
    const id = setInterval(tick, 60000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return { data, error, refreshedAt }
}

/** "刚刚 / X 分钟前 / HH:MM" 友好相对时间 */
export function fmtRefreshed(d: Date | null): string {
  if (!d) return ''
  const sec = Math.round((Date.now() - d.getTime()) / 1000)
  if (sec < 30) return '刚刚'
  if (sec < 60) return `${sec} 秒前`
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} 分钟前`
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

export function LoadingScreen() {
  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="px-4 pt-4 pb-2">
        <div className="h-3 w-16 bg-gray5 rounded mb-2 animate-pulse" />
        <div className="h-7 w-32 bg-gray5 rounded animate-pulse" />
      </div>
      <div className="px-4 mt-3">
        <div className="bg-ink rounded-card p-4">
          <div className="h-3 w-20 bg-white/10 rounded animate-pulse mb-3" />
          <div className="h-9 w-32 bg-white/15 rounded animate-pulse mb-3" />
          <div className="h-3 w-40 bg-white/10 rounded animate-pulse mb-4" />
          <div className="border-t border-white/10 pt-3 flex gap-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex-1">
                <div className="h-2.5 w-12 bg-white/10 rounded mb-1.5 animate-pulse" />
                <div className="h-5 w-16 bg-white/15 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="px-4 mt-5 space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-white rounded-card border border-border p-3">
            <div className="h-3 w-16 bg-gray5 rounded mb-2 animate-pulse" />
            <div className="h-5 w-3/4 bg-gray5 rounded mb-2 animate-pulse" />
            <div className="h-3 w-1/2 bg-gray5 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ErrorScreen({ message }: { message: string }) {
  // 把 "路由不存在" 之类 raw error 转成用户友好文案
  const isRoute = message?.includes('路由不存在') || message?.includes('Not Found')
  const isAuth = message?.includes('未登录') || message?.includes('401')
  const friendly = isRoute
    ? '此功能仍在部署中, 请稍后再试'
    : isAuth
      ? '登录已过期, 即将跳转登录'
      : message?.replace(/^Error:\s*/, '') || '出错了'
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="bg-amber/10 border border-amber/30 rounded-card p-6 text-center max-w-sm">
        <div className="text-[40px] mb-2 opacity-50">⚠</div>
        <p className="text-body text-gray2">{friendly}</p>
        <p className="text-micro text-gray4 mt-1 break-all">{message}</p>
        <button onClick={() => location.reload()}
                className="mt-4 px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">
          刷新重试
        </button>
      </div>
    </div>
  )
}

/** 当前问候语 + 中文星期 + 月日 */
export function greetingFor(name: string | undefined): { greeting: string; today: string } {
  const today = new Date()
  const w = ['日', '一', '二', '三', '四', '五', '六'][today.getDay()]
  const md = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`
  return {
    greeting: `早上好，${name || '用户'}`,
    today: `周${w} · ${md}`,
  }
}
