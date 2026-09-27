'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { getUser } from '@/lib/v2-auth'
import { BottomNav } from '@/components/v2'
import CentralDrawer from '../manager/_drawer'
export default function ChefWorkspaceLayout({ children }: { children: ReactNode }) {
  const [manager, setManager] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => { setManager(getUser()?.role === 'MANAGER') }, [])
  if (!manager) return <>{children}</>
  return <><style jsx global>{`.manager-purchase-context [data-bottom-nav="true"] { display: none; }`}</style><div className="manager-purchase-context pb-16"><div className="bg-bg px-4 py-2 text-caption"><a href="/v2/manager/home" className="underline">店长工作台</a> / 食材采购与验收</div>{children}</div><BottomNav tabs={[{ key: 'home', label: '工作台', icon: '⌂' }, { key: 'ops', label: '营业', icon: '⛁' }, { key: 'fab', label: '', icon: '+' }, { key: 'customer', label: '客户', icon: '★' }, { key: 'team', label: '团队', icon: '◐' }]} activeKey="" onChange={key => { window.location.href = `/v2/manager/${key}` }} fabKey="fab" onFab={() => setDrawerOpen(true)} />{drawerOpen && <CentralDrawer onClose={() => setDrawerOpen(false)} />}</>
}
