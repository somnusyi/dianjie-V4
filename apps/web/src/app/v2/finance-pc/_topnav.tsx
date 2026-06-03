'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getUser, clearSession } from '@/lib/v2-auth'

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
      { label: '应付管理',     href: '/v2/finance-pc/payable',           desc: '按发票分次付款' },
      { label: '发票审核',     href: '/v2/finance-pc/invoices',          desc: '财务通过后解锁付款', badgeKey: 'invoicePending' },
      { label: '待开票跟踪',   href: '/v2/finance-pc/invoices-pending',  desc: '已付款但供应商没开发票, 催办主战场', badgeKey: 'pendingInvoice' },
      { label: '资本支出审批', href: '/v2/finance-pc/capital-review',    desc: '店长申请 → 老板批 → 财务付' },
    ],
  },
  {
    key: 'cost',
    label: '成本',
    matchPrefix: '/v2/finance-pc/cost-check',
    group: [
      { label: '月度成本核对',  href: '/v2/finance-pc/cost-check',           desc: '4 方核对 (门店→厨师长→供应商→财务)' },
      { label: 'B2B 平台导入',  href: '/v2/finance-pc/cost-check/import-b2b', desc: '美菜/快驴 月账单批量录入' },
      { label: '备用金管理',    href: '/v2/finance-pc/petty-cash',           desc: '店长申请 → 财务发 → 月底报账' },
      { label: '工资管理',      href: '/v2/finance-pc/payroll',              desc: 'Excel 上传 → 审批 → 发放 (自动凭证)' },
      { label: '建店成本台账',  href: '/v2/finance-pc/budget',               desc: '装修 / 设备 / 牌照 等 9 类' },
    ],
  },
  {
    key: 'vouchers',
    label: '凭证',
    group: [
      { label: '凭证管理',     href: '/v2/finance-pc/vouchers',          desc: '草稿 / 已审 / 导出', badgeKey: 'draftVouchers' },
      { label: '周期凭证模板', href: '/v2/finance-pc/voucher-templates', desc: '租金 / 折旧 / 摊销 每月自动起草' },
      { label: '月结锁账',     href: '/v2/finance-pc/period-close',      desc: '关账 / 期末结转 / 重开' },
    ],
  },
  { key: 'funds',    label: '资金', href: '/v2/finance-pc/funds',    badgeKey: 'dueThisWeek' },
  {
    key: 'reports',
    label: '报表',
    matchPrefix: '/v2/finance-pc/reports',
    group: [
      { label: '月度对账',   href: '/v2/finance-pc/reconcile',           desc: '门店净利 / 供应商收付' },
      { label: '利润中心',   href: '/v2/finance-pc/reports/profit',      desc: '月度 P&L (管理口径)' },
      { label: '现金流报表', href: '/v2/finance-pc/reports/cash-flow',   desc: '经营 / 投资 / 筹资' },
      { label: '食材成本',   href: '/v2/finance-pc/reports/food-cost',   desc: '采购 / 占比 / 损耗 / 趋势' },
      { label: '应付账龄',   href: '/v2/finance-pc/reports/aging',       desc: '未到期 / 0-30 / 30-60 / 60-90 / 90+' },
      { label: '对账自检',   href: '/v2/finance-pc/reports/recon-check', desc: '凭证 vs 流水 找漏建/金额错' },
      { label: '报税报表',   href: '/v2/finance-pc/reports/tax',         desc: '利润表 / 资产负债表' },
    ],
  },
  { key: 'stores',   label: '各店',     href: '/v2/finance-pc/stores' },
]

type Badges = { pendingReview?: number; dueThisWeek?: number; draftVouchers?: number; invoicePending?: number; pendingInvoice?: number }

export default function FinanceTopNav() {
  const pathname = usePathname() || ''
  const [user, setUser] = useState<{ name?: string; role?: string; email?: string } | null>(null)
  const [badges, setBadges] = useState<Badges>({})
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const [installPrompt, setInstallPrompt] = useState<any>(null)

  function logout() {
    clearSession()
    // PWA scope 内的 login, 不会跳出桌面 PWA 窗口
    location.href = '/v2/finance-pc/login'
  }

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
        const [pr, sch, vou, inv, pInv] = await Promise.all([
          apiFetch<{ total: number }>('/api/payment-requests?status=PENDING&pageSize=1').catch(() => ({ total: 0 })),
          apiFetch<any[]>('/api/schedules?days=7').catch(() => []),
          apiFetch<{ items: any[] }>(`/api/vouchers?from=${monthFrom}&to=${monthTo}&status=DRAFT&pageSize=200`).catch(() => ({ items: [] })),
          apiFetch<any[]>('/api/invoices?status=PENDING').catch(() => []),
          apiFetch<{ summary?: { paidCount?: number } }>('/api/invoices/pending-from-finance').catch(() => ({ summary: { paidCount: 0 } })),
        ])
        if (!alive) return
        const dueCount = Array.isArray(sch) ? sch.filter((s: any) => ['PENDING', 'APPROVED', 'NOTIFIED'].includes(s.status)).length : 0
        const draftCount = vou.items?.length || 0
        const invoicePending = Array.isArray(inv) ? inv.length : 0
        const pendingInvoice = pInv?.summary?.paidCount || 0
        setBadges({ pendingReview: pr.total || 0, dueThisWeek: dueCount, draftVouchers: draftCount, invoicePending, pendingInvoice })
      } catch { /* 静默 */ }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // 外部点击关闭 dropdown
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node
      if (dropdownRef.current && !dropdownRef.current.contains(target)) setOpenKey(null)
      if (userMenuRef.current && !userMenuRef.current.contains(target)) setUserMenuOpen(false)
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
          {/* 用户菜单 (头像点击 → 切换/退出, 都留在 PWA scope 内) */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen(o => !o)}
              className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-bg transition"
              title="点击切换账号 / 退出">
              <span className="w-9 h-9 rounded-full bg-red text-white flex items-center justify-center font-num">{initial}</span>
              <span className="text-caption">{user?.name || '加载中…'}</span>
              <span className={`text-micro text-gray3 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-60 bg-white border border-border rounded-card shadow-lg overflow-hidden z-40">
                <div className="px-4 py-3 border-b border-border">
                  <div className="text-button text-ink">{user?.name}</div>
                  <div className="text-micro text-gray3 mt-0.5">
                    {user?.role}
                    {user?.email && ` · ${user.email}`}
                  </div>
                </div>
                <button onClick={logout}
                        className="w-full text-left px-4 py-3 text-button text-gray2 hover:bg-bg transition">
                  换个账号登录
                </button>
                <button onClick={logout}
                        className="w-full text-left px-4 py-3 text-button text-red-fg hover:bg-red-bg transition border-t border-border">
                  退出登录
                </button>
              </div>
            )}
          </div>
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
