'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { managementPages, managementHref } from '@/lib/inventory-management'
import styles from './management-workspace.module.css'

const storageKey = 'dianjie:management-open-tabs'

export function ManagementTabs({ activeId }: { activeId: string }) {
  const router = useRouter()
  const [opened, setOpened] = useState<string[]>([activeId])
  const activeTab = useRef<HTMLDivElement>(null)
  const save = (ids: string[]) => {
    setOpened(ids)
    try { sessionStorage.setItem(storageKey, JSON.stringify(ids)) } catch { /* Tabs still work when storage is unavailable. */ }
  }
  useEffect(() => {
    let saved: unknown
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]') } catch { saved = [] }
    const ids = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && managementPages.some(page => page.id === id)) : []
    save([...new Set([...ids, activeId])])
  }, [activeId])
  useEffect(() => { activeTab.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [opened, activeId])
  function close(id: string) {
    const index = opened.indexOf(id)
    const remaining = opened.filter(key => key !== id)
    save(remaining)
    if (id === activeId) {
      const next = managementPages.find(page => page.id === (remaining[index] || remaining[index - 1]))
      router.push(next ? managementHref(next) : '/v2/supply-chain/home')
    }
  }
  return <nav className={styles.tabs} aria-label="已打开的库存与盘点页面">{opened.map(id => {
    const page = managementPages.find(item => item.id === id)!
    return <div key={id} ref={id === activeId ? activeTab : undefined} className={id === activeId ? styles.activeTab : ''}>
      <Link href={managementHref(page)} aria-current={id === activeId ? 'page' : undefined}>{page.title}</Link>
      <button type="button" aria-label={`关闭${page.title}`} title={`关闭${page.title}`} onClick={() => close(id)}>×</button>
    </div>
  })}</nav>
}
