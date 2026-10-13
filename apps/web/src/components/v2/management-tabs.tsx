'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { managementPages, managementHref } from '@/lib/inventory-management'
import styles from './management-tabs.module.css'
import {inventoryReports} from './inventory-report-menu'
import {financeReports} from '@/app/v2/supply-chain/finance-reports/report-definitions'

const storageKey = 'dianjie:management-open-tabs'
const tabs = [
 ...managementPages.map(page=>({id:page.id,title:page.title,href:managementHref(page)})),
 ...inventoryReports.map(page=>({id:`report:${page.id}`,title:page.title,href:`/v2/supply-chain/reports?report=${page.id}`})),
 ...financeReports.map(page=>({id:`finance:${page.id}`,title:page.title,href:`/v2/supply-chain/finance-reports?report=${page.id}`})),
]
const findTab=(id:string)=>tabs.find(tab=>tab.id===id)

export function ManagementTabs({ activeId, beforeNavigate }: { activeId: string; beforeNavigate?: () => boolean | Promise<boolean> }) {
  const router = useRouter()
  const [opened, setOpened] = useState<string[]>(findTab(activeId)?[activeId]:[])
  const activeTab = useRef<HTMLDivElement>(null)
  const save = (ids: string[]) => {
    setOpened(ids)
    try { sessionStorage.setItem(storageKey, JSON.stringify(ids)) } catch { /* Tabs still work when storage is unavailable. */ }
  }
  useEffect(() => {
    let saved: unknown
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]') } catch { saved = [] }
    const ids = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && Boolean(findTab(id))) : []
    save([...new Set([...ids, ...(findTab(activeId)?[activeId]:[])])])
  }, [activeId])
  useEffect(() => { activeTab.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [opened, activeId])
  async function close(id: string) {
    if (id === activeId && beforeNavigate && !(await beforeNavigate())) return
    const index = opened.indexOf(id)
    const remaining = opened.filter(key => key !== id)
    save(remaining)
    if (id === activeId) {
      const next = findTab(remaining[index] || remaining[index - 1])
      router.push(next ? next.href : '/v2/supply-chain/home')
    }
  }
  return <nav className={styles.tabs} aria-label="已打开的业务页面">{opened.map(id => {
    const page = findTab(id)!
    return <div key={id} ref={id === activeId ? activeTab : undefined} className={id === activeId ? styles.activeTab : ''}>
      <Link href={page.href} aria-current={id === activeId ? 'page' : undefined} onClick={event => {
        if (id === activeId || !beforeNavigate) return
        event.preventDefault()
        void Promise.resolve(beforeNavigate()).then(allowed => { if (allowed) router.push(page.href) })
      }}>{page.title}</Link>
      <button type="button" aria-label={`关闭${page.title}`} title={`关闭${page.title}`} onClick={() => void close(id)}>×</button>
    </div>
  })}</nav>
}
