/** PDF: 老板 PC Web 顶栏 (替代移动 BottomNav) */
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Chip } from '@/components/v2'

const TABS = [
  { key: 'home',      label: '首页',     href: '/v2/boss-pc/home' },
  { key: 'stores',    label: '门店',     href: '/v2/boss-pc/stores' },
  { key: 'reports',   label: '报表',     href: '/v2/boss-pc/reports' },
  { key: 'approvals', label: '审批',     href: '/v2/boss-pc/approvals', badge: '12' },
  { key: 'personnel', label: '人员',     href: '/v2/boss-pc/personnel' },
  { key: 'settings',  label: '设置',     href: '#' },
]

export default function BossTopNav() {
  const pathname = usePathname() || ''
  return (
    <header className="bg-white border-b border-border sticky top-0 z-30">
      <div className="max-w-[1440px] mx-auto px-6 h-14 flex items-center gap-6">
        <span className="bg-ink text-white text-micro px-2 py-1 rounded-chip font-num">BOSS</span>
        <span className="text-h2">火锅连锁管理系统</span>
        <nav className="flex-1 flex items-center gap-4 ml-6">
          {TABS.map(t => {
            const active = pathname.startsWith(t.href) && t.href !== '#'
            return (
              <Link
                key={t.key}
                href={t.href}
                className={`px-2 py-1.5 text-button transition relative ${active ? 'text-ink font-medium' : 'text-gray2 hover:text-ink'}`}
              >
                {t.label}
                {t.badge && <span className="ml-1 inline-flex items-center justify-center w-4 h-4 text-micro bg-red text-white rounded-full font-num">{t.badge}</span>}
                {active && <span className="absolute -bottom-[15px] left-0 right-0 h-[2px] bg-ink"></span>}
              </Link>
            )
          })}
        </nav>
        <div className="flex items-center gap-3">
          <button className="w-9 h-9 rounded-full bg-bg flex items-center justify-center relative" aria-label="通知">
            🔔
            <span className="absolute top-0 right-0 w-2 h-2 bg-red rounded-full"></span>
          </button>
          <span className="w-9 h-9 rounded-full bg-ink text-white flex items-center justify-center font-num">王</span>
          <span className="text-caption">王总</span>
        </div>
      </div>
    </header>
  )
}
