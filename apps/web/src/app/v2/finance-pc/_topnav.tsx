'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'

type Tab =
  | { key: string; label: string; href: string; badgeKey?: keyof Badges }
  | { key: string; label: string; group: SubItem[]; matchPrefix?: string; badgeKey?: keyof Badges }

type SubItem = { label: string; href: string; desc?: string; badgeKey?: keyof Badges }

const TABS: Tab[] = [
  { key: 'home',     label: '工作台',   href: '/v2/finance-pc/home',             badgeKey: 'pendingReview' },
  { key: 'review',   label: '初审',     href: '/v2/finance-pc/review',           badgeKey: 'pendingReview' },
  { key: 'payreq',   label: '付款申请', href: '/v2/finance-pc/payment-requests', badgeKey: 'pendingReview' },
  {
    key: 'ap',
    label: '应付',
    matchPrefix: '/v2/finance-pc/payable',
    group: [
      { label: '应付管理',     href: '/v2/finance-pc/payable',        desc: '按发票分次付款' },
      { label: '发票审核',     href: '/v2/finance-pc/invoices',       desc: '财务通过后解锁付款', badgeKey: 'invoicePending' },
      { label: '资本支出审批', href: '/v2/finance-pc/capital-review', desc: '店长申请 → 老板批 → 财务付' },
    ],
  },
  {
    key: 'vouchers',
    label: '凭证',
    group: [
      { label: '凭证管理', href: '/v2/finance-pc/vouchers',     desc: '草稿 / 已审 / 导出', badgeKey: 'draftVouchers' },
      { label: '月结锁账', href: '/v2/finance-pc/period-close', desc: '关账 / 期末结转 / 重开' },
    ],
  },
  { key: 'funds',    label: '资金', href: '/v2/finance-pc/funds',    badgeKey: 'dueThisWeek' },
  {
    key: 'reports',
    label: '报表',
    matchPrefix: '/v2/finance-pc/reports',
    group: [
      { label: '月度对账',   href: '/v2/finance-pc/reconcile',         desc: '门店净利 / 供应商收付' },
      { label: '利润中心',   href: '/v2/finance-pc/reports/profit',    desc: '月度 P&L (管理口径)' },
      { label: '现金流报表', href: '/v2/finance-pc/reports/cash-flow', desc: '经营 / 投资 / 筹资' },
      { label: '报税报表',   href: '/v2/finance-pc/reports/tax',       desc: '利润表 / 资产负债表' },
    ],
  },
  { key: 'stores',   label: '各店',     href: '/v2/finance-pc/stores' },
]

type Badges = { pendingReview?: number; dueThisWeek?: number; draftVouchers?: number; invoicePending?: number }

export default function FinanceTopNav() {
  const pathname = usePathname() || ''
  const [user, setUser] = useState<{ name?: string } | null>(null)
  const [badges, setBadges] = useState<Badges>({})
  const [openKey, setOpenKey] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [installPrompt, setInstallPrompt] = useState<any>(null)

  // PWA 安装支持: 浏览器认为可装时 (Chrome/Edge 桌面) 才弹按钮
  useEffect(() => {
    if (typeof window === 'undefined') return
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    if (isStandalone) return  // 已在 PWA 模式内, 不显示
    const handler = (e: any) => {
      e.preventDefault()
      setInstallPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)
    const installed = () => setInstallPrompt(null)
    window.addEventListener('appinstalled', installed)
    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('appinstalled', installed)
    }
  }, [])

  async function handleInstall() {
    if (!installPrompt) return
    installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') setInstallPrompt(null)
  }

  useEffect(() => {
    setUser(getUser())
    let alive = true
    const load = async () => {
      try {
        const monthFrom = `${new Date().toISOString().slice(0, 7)}-01`
        const monthTo   = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10)
        const [pr, sch, vou, inv] = await Promise.all([
          apiFetch<{ total: number }>('/api/payment-requests?status=PENDING&pageSize=1').catch(() => ({ total: 0 })),
          apiFetch<any[]>('/api/schedules?days=7').catch(() => []),
          apiFetch<{ items: any[] }>(`/api/vouchers?from=${monthFrom}&to=${monthTo}&status=DRAFT&pageSize=200`).catch(() => ({ items: [] })),
          apiFetch<any[]>('/api/invoices?status=PENDING').catch(() => []),
        ])
        if (!alive) return
        const dueCount = Array.isArray(sch) ? sch.filter((s: any) => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status)).length : 0
        const draftCount = vou.items?.length || 0
        const invoicePending = Array.isArray(inv) ? inv.length : 0
        setBadges({ pendingReview: pr.total || 0, dueThisWeek: dueCount, draftVouchers: draftCount, invoicePending })
      } catch { /* 静默 */ }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // 外部点击关闭 dropdown
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!dropdownRef.current) return
      if (!dropdownRef.current.contains(e.target as Node)) setOpenKey(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const initial = (user?.name || '财').slice(0, 1)

  return (
    <header className="bg-white border-b border-border sticky top-0 z-30">
      <div className="max-w-[1440px] mx-auto px-6 h-14 flex items-center gap-6" ref={dropdownRef}>
        <span className="bg-red text-white text-micro px-2 py-1 rounded-chip font-num">FIN</span>
        <span className="text-h2">滇界 · 财务系统</span>
        <nav className="flex-1 flex items-center gap-3 ml-6">
          {TABS.map(t => {
            const isGroup = 'group' in t
            const groupActive = isGroup
              ? (t.matchPrefix
                  ? pathname.startsWith(t.matchPrefix)
                  : (t as any).group.some((s: SubItem) => pathname.startsWith(s.href)))
                || (t as any).group.some((s: SubItem) => pathname.startsWith(s.href))
              : pathname.startsWith((t as any).href)
            const badgeKey = t.badgeKey
            const badge: number | undefined = badgeKey ? (badges as any)[badgeKey] : undefined
            // group: 显示总数 = 所有 sub badge 之和
            const groupBadge = isGroup
              ? (t as any).group.reduce((acc: number, s: SubItem) => acc + (s.badgeKey ? (badges as any)[s.badgeKey] || 0 : 0), 0)
              : 0

            if (!isGroup) {
              return (
                <Link key={t.key} href={(t as any).href}
                  className={`px-2 py-1.5 text-button transition relative ${groupActive ? 'text-ink font-medium' : 'text-gray2 hover:text-ink'}`}>
                  {t.label}
                  {badge != null && badge > 0 && <BadgePill n={badge} />}
                  {groupActive && <span className="absolute -bottom-[15px] left-0 right-0 h-[2px] bg-ink"></span>}
                </Link>
              )
            }

            // dropdown
            const isOpen = openKey === t.key
            return (
              <div key={t.key} className="relative">
                <button onClick={() => setOpenKey(isOpen ? null : t.key)}
                  className={`px-2 py-1.5 text-button transition relative flex items-center gap-1 ${groupActive ? 'text-ink font-medium' : 'text-gray2 hover:text-ink'}`}>
                  {t.label}
                  <span className={`text-micro transition-transform ${isOpen ? 'rotate-180' : ''}`}>▾</span>
                  {groupBadge > 0 && <BadgePill n={groupBadge} />}
                  {groupActive && <span className="absolute -bottom-[15px] left-0 right-0 h-[2px] bg-ink"></span>}
                </button>
                {isOpen && (
                  <div className="absolute left-0 top-full mt-3 w-72 bg-white border border-border rounded-card shadow-lg overflow-hidden z-40">
                    {(t as any).group.map((s: SubItem) => {
                      const subActive = pathname.startsWith(s.href)
                      const sbadge = s.badgeKey ? (badges as any)[s.badgeKey] : undefined
                      return (
                        <Link key={s.href} href={s.href} onClick={() => setOpenKey(null)}
                          className={`flex items-start justify-between gap-2 px-4 py-3 hover:bg-bg ${subActive ? 'bg-amber/10' : ''}`}>
                          <div>
                            <div className={`text-button ${subActive ? 'text-ink font-medium' : 'text-ink'}`}>{s.label}</div>
                            {s.desc && <div className="text-micro text-gray3 mt-0.5">{s.desc}</div>}
                          </div>
                          {sbadge != null && sbadge > 0 && <BadgePill n={sbadge} />}
                        </Link>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
        <div className="flex items-center gap-3">
          {installPrompt && (
            <button onClick={handleInstall}
                    className="px-3 py-1.5 bg-amber/15 hover:bg-amber/25 text-amber-fg rounded-cta text-button border border-amber/30 transition flex items-center gap-1"
                    title="把财务工作台装到桌面, 双击图标直接打开">
              <span>⬇</span>装到桌面
            </button>
          )}
          <button className="w-9 h-9 rounded-full bg-bg flex items-center justify-center" aria-label="通知">🔔</button>
          <span className="w-9 h-9 rounded-full bg-red text-white flex items-center justify-center font-num">{initial}</span>
          <span className="text-caption">{user?.name || '加载中…'}</span>
        </div>
      </div>
    </header>
  )
}

function BadgePill({ n }: { n: number }) {
  return (
    <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-micro bg-red text-white rounded-full font-num">
      {n > 99 ? '99+' : n}
    </span>
  )
}
