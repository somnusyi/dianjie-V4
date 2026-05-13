'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { key: 'home',   label: '工作台', href: '/v2/finance-pc/home', badge: '12' },
  { key: 'review', label: '初审',   href: '/v2/finance-pc/review', badge: '12' },
  { key: 'funds',  label: '资金',   href: '/v2/finance-pc/funds' },
  { key: 'stores', label: '各店',   href: '/v2/finance-pc/stores' },
]

export default function FinanceTopNav() {
  const pathname = usePathname() || ''
  return (
    <header className="bg-white border-b border-border sticky top-0 z-30">
      <div className="max-w-[1440px] mx-auto px-6 h-14 flex items-center gap-6">
        <span className="bg-red text-white text-micro px-2 py-1 rounded-chip font-num">FIN</span>
        <span className="text-h2">火锅连锁财务系统</span>
        <nav className="flex-1 flex items-center gap-4 ml-6">
          {TABS.map(t => {
            const active = pathname.startsWith(t.href)
            return (
              <Link key={t.key} href={t.href}
                className={`px-2 py-1.5 text-button transition relative ${active ? 'text-ink font-medium' : 'text-gray2 hover:text-ink'}`}>
                {t.label}
                {t.badge && <span className="ml-1 inline-flex items-center justify-center w-4 h-4 text-micro bg-red text-white rounded-full font-num">{t.badge}</span>}
                {active && <span className="absolute -bottom-[15px] left-0 right-0 h-[2px] bg-ink"></span>}
              </Link>
            )
          })}
        </nav>
        <div className="flex items-center gap-3">
          <button className="w-9 h-9 rounded-full bg-bg flex items-center justify-center" aria-label="通知">🔔</button>
          <span className="w-9 h-9 rounded-full bg-red text-white flex items-center justify-center font-num">刘</span>
          <span className="text-caption">刘财务</span>
        </div>
      </div>
    </header>
  )
}
