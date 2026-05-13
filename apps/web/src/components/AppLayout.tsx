'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuthStore } from '@/store/auth'
import NotificationPanel from './NotificationPanel'

const NAV: any[] = [
  { type: 'item', key: 'dashboard', label: '经营看板', desc: '老板 / 店长工作台', icon: '▦', path: '/dashboard' },

  { type: 'divider', label: '运营链路' },
  { type: 'item', key: 'orders',      label: '采购订单', desc: '发起 / 供应商确认', icon: '购', path: '/orders' },
  { type: 'item', key: 'receipts',    label: '入库管理', desc: '收货 / 对账起点', icon: '入', path: '/receipts' },
  { type: 'item', key: 'loss-claims', label: '报损管理', desc: '损耗 / 供应商协同', icon: '损', path: '/loss-claims' },
  { type: 'item', key: 'inventory',   label: '库存管理', desc: '安全库存 / 预警', icon: '库', path: '/inventory' },

  { type: 'divider', label: '财务中心' },
  { type: 'item', key: 'finance',   label: '财务中心', desc: '账期 / 应付', icon: '财', path: '/finance' },
  { type: 'item', key: 'cashbook', label: '资金台账', desc: '收入支出流水', icon: '账', path: '/cashbook', roles: ['ADMIN','FINANCE','SUPER_ADMIN'] },
  { type: 'item', key: 'revenue',  label: '营业额',   desc: '门店收入录入', icon: '营', path: '/revenue' },
  { type: 'item', key: 'approval', label: '付款审批', desc: '阈值 / 凭证 / 终审', icon: '审', path: '/approval', roles: ['ADMIN','FINANCE','SUPER_ADMIN'] },

  { type: 'divider', label: '基础数据', roles: ['ADMIN','SUPER_ADMIN','FINANCE'] },
  { type: 'item', key: 'suppliers', label: '供应商',   desc: '账期 / 银行信息', icon: '供', path: '/suppliers', roles: ['ADMIN','FINANCE','SUPER_ADMIN'] },
  { type: 'item', key: 'products',  label: '商品中心', desc: 'SKU / 价格', icon: '品', path: '/products',  roles: ['ADMIN','SUPER_ADMIN'] },
  { type: 'item', key: 'stores',    label: '门店管理', desc: '门店档案', icon: '店', path: '/stores',    roles: ['ADMIN','SUPER_ADMIN'] },
  { type: 'item', key: 'users',     label: '用户管理', desc: '账号 / 权限', icon: '人', path: '/users',     roles: ['ADMIN','SUPER_ADMIN'] },
  { type: 'item', key: 'logs',      label: '操作日志', desc: '审计留痕', icon: '记', path: '/logs',      roles: ['ADMIN','SUPER_ADMIN'] },
]

const SUPPLIER_KEYS = ['orders', 'loss-claims']
const MANAGER_HIDDEN = ['suppliers', 'products', 'stores', 'logs', 'finance', 'approval']
const ROLE_LABEL: Record<string, string> = {
  ADMIN: '老板 / 管理员',
  FINANCE: '财务',
  MANAGER: '店长',
  PURCHASER: '采购',
  SUPER_ADMIN: '超管',
  SUPPLIER_STAFF: '供应商',
  CHEF: '总厨',
}

const ROLE_HINT: Record<string, string> = {
  ADMIN: '集团经营 · 审批 · 财务总览',
  SUPER_ADMIN: '集团经营 · 系统权限',
  FINANCE: '账期把关 · 付款审批',
  MANAGER: '门店运营 · 入库报损',
  SUPPLIER_STAFF: '订单履约 · 报损处理',
}

function safeParseUser() {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem('dj_user')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    localStorage.removeItem('dj_user')
    return null
  }
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { user, hydrate, logout: storeLogout } = useAuthStore()
  const [badges, setBadges] = useState<Record<string, number>>({})
  const [localUser, setLocalUser] = useState<any>(null)

  useEffect(() => {
    hydrate()
    const parsed = safeParseUser()
    setLocalUser(parsed)
    if (!parsed) {
      router.push('/login')
      return
    }
    loadBadges(parsed)
  }, [pathname])

  const currentUser = user || localUser

  const loadBadges = async (u: any) => {
    const token = localStorage.getItem('dj_token')
    const headers = { Authorization: `Bearer ${token}` }
    const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'
    const b: Record<string, number> = {}
    try {
      if (u.role === 'SUPPLIER_STAFF') {
        const [r1, r2] = await Promise.all([
          fetch(`${base}/api/orders?status=SUBMITTED`, { headers }),
          fetch(`${base}/api/loss-claims?status=PENDING`, { headers }),
        ])
        const [d1, d2] = await Promise.all([r1.json(), r2.json()])
        if (Array.isArray(d1)) b.orders = d1.length
        if (Array.isArray(d2)) b['loss-claims'] = d2.length
      }
      if (['MANAGER','ADMIN','SUPER_ADMIN'].includes(u.role)) {
        const r = await fetch(`${base}/api/receipts?status=PENDING_CONFIRM`, { headers })
        const d = await r.json()
        const items = Array.isArray(d) ? d : d.items
        if (Array.isArray(items)) b.receipts = items.length
      }
      if (['ADMIN','FINANCE','SUPER_ADMIN'].includes(u.role)) {
        const r = await fetch(`${base}/api/schedules/pending-approval`, { headers })
        const d = await r.json()
        if (Array.isArray(d) && d.length > 0) b.approval = d.length
      }
    } catch {}
    setBadges(b)
  }

  const isVisible = (item: any) => {
    if (!currentUser) return false
    const role = currentUser.role
    if (role === 'SUPPLIER_STAFF') return item.type === 'divider' ? false : SUPPLIER_KEYS.includes(item.key)
    if (role === 'MANAGER') {
      if (item.type === 'divider') return item.label === '运营链路'
      return !MANAGER_HIDDEN.includes(item.key)
    }
    if (item.roles) return item.roles.includes(role)
    return true
  }

  const activeItem = useMemo(() => {
    return NAV.find(item => item.type === 'item' && (pathname === item.path || pathname.startsWith(item.path + '/')))
  }, [pathname])

  const logout = () => storeLogout()

  return (
    <div className="dj-app-layout">
      <aside className="dj-sidebar">
        <div className="dj-brand">
          <div className="dj-brand-mark">滇</div>
          <div>
            <strong>滇界云管</strong>
            <span>连锁餐饮经营系统</span>
          </div>
        </div>

        {currentUser && (
          <div className="dj-role-card">
            <span>{ROLE_LABEL[currentUser.role] || currentUser.role}</span>
            <strong>{currentUser.name}</strong>
            <em>{currentUser.store ? currentUser.store.name?.replace('滇界·', '') : ROLE_HINT[currentUser.role] || '经营管理'}</em>
          </div>
        )}

        <nav className="dj-nav">
          {NAV.filter(isVisible).map((item, idx) => {
            if (item.type === 'divider') {
              return <div className="dj-nav-divider" key={`div-${idx}`}>{item.label}</div>
            }

            const active = pathname === item.path || pathname.startsWith(item.path + '/')
            const badge = badges[item.key] || 0

            return (
              <button className={active ? 'dj-nav-item active' : 'dj-nav-item'} key={item.key} onClick={() => router.push(item.path)} type="button">
                <span className="dj-nav-icon">{item.icon}</span>
                <span className="dj-nav-copy">
                  <strong>{item.label}</strong>
                  <em>{item.desc}</em>
                </span>
                {badge > 0 && <span className="dj-nav-badge">{badge > 99 ? '99+' : badge}</span>}
              </button>
            )
          })}
        </nav>

        {currentUser && (
          <div className="dj-sidebar-footer">
            <button onClick={logout} type="button">退出登录</button>
          </div>
        )}
      </aside>

      <main className="dj-main">
        {currentUser && (
          <header className="dj-global-topbar">
            <div>
              <span>{activeItem?.desc || '实时经营数据'}</span>
              <strong>{activeItem?.label || '工作台'}</strong>
            </div>
            <NotificationPanel />
          </header>
        )}
        {children}
      </main>
    </div>
  )
}
