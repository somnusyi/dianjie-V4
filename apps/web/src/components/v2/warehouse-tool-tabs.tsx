'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/v2/supply-chain/inventory', label: '库存查询' },
  { href: '/v2/supply-chain/inbound', label: '入库记录' },
  { href: '/v2/supply-chain/docs', label: '单据审核' },
] as const

const LINK_MODE_KEY = 'warehouse-linked-view'
const LINK_PRODUCT_KEY = 'warehouse-linked-product-id'

type LinkedProduct = { id: string; code: string; name: string }

export function WarehouseToolTabs({
  linkedProductId = '', product, onLinkedProductChange,
  onLinkedModeChange,
}: {
  linkedProductId?: string
  product?: LinkedProduct | null
  onLinkedProductChange?: (productId: string) => void
  onLinkedModeChange?: (linked: boolean) => void
}) {
  const pathname = usePathname() || ''
  const [linked, setLinked] = useState(false)
  const [savedProductId, setSavedProductId] = useState('')
  const restored = useRef(false)

  useEffect(() => {
    if (restored.current) return
    restored.current = true
    try {
      const savedLinked = sessionStorage.getItem(LINK_MODE_KEY) === '1'
      const savedId = sessionStorage.getItem(LINK_PRODUCT_KEY) || ''
      setLinked(savedLinked)
      onLinkedModeChange?.(savedLinked)
      setSavedProductId(savedId)
      if (savedLinked && savedId && !linkedProductId) {
        onLinkedProductChange?.(savedId)
        replaceLinkedProductInUrl(savedId)
      }
    } catch {}
  }, [linkedProductId, onLinkedModeChange, onLinkedProductChange])

  useEffect(() => {
    if (!linked) return
    const nextId = product?.id || linkedProductId
    if (!nextId || nextId === savedProductId) return
    setSavedProductId(nextId)
    onLinkedProductChange?.(nextId)
    replaceLinkedProductInUrl(nextId)
    try { sessionStorage.setItem(LINK_PRODUCT_KEY, nextId) } catch {}
  }, [linked, linkedProductId, onLinkedProductChange, product, savedProductId])

  function toggleLinked() {
    const next = !linked
    const currentProductId = product?.id || linkedProductId || savedProductId
    setLinked(next)
    onLinkedModeChange?.(next)
    try {
      if (next) {
        sessionStorage.setItem(LINK_MODE_KEY, '1')
        if (currentProductId) sessionStorage.setItem(LINK_PRODUCT_KEY, currentProductId)
      } else {
        sessionStorage.removeItem(LINK_MODE_KEY)
        sessionStorage.removeItem(LINK_PRODUCT_KEY)
      }
    } catch {}
    if (next && currentProductId) {
      setSavedProductId(currentProductId)
      onLinkedProductChange?.(currentProductId)
      replaceLinkedProductInUrl(currentProductId)
    } else if (!next) {
      setSavedProductId('')
      onLinkedProductChange?.('')
      replaceLinkedProductInUrl('')
    }
  }

  const activeProductId = linkedProductId || savedProductId
  return (
    <nav aria-label="库存与单据视图" className="mb-4 flex flex-wrap gap-2 border-b border-border pb-3">
      {TABS.map(tab => {
        const selected = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
        const href = linked && activeProductId ? `${tab.href}?linkedProductId=${encodeURIComponent(activeProductId)}` : tab.href
        return <Link key={tab.href} href={href} aria-current={selected ? 'page' : undefined}
          className={`rounded-cta px-4 py-2 text-button ${selected ? 'bg-ink text-white' : 'border border-border bg-white text-gray2'}`}
        >{tab.label}</Link>
      })}
      <div className="ml-auto inline-flex items-center gap-2 py-2">
        <span className="text-button text-gray2">关联查看{linked && (product || activeProductId) ? ` · ${product?.name || '已锁定商品'}` : ''}</span>
        <button type="button" role="switch" aria-checked={linked} aria-label="关联查看"
          title={linked ? '已开启：三个页面保持查看同一个商品' : '已关闭：三个页面独立查看'}
          onClick={toggleLinked}
          className={`relative h-5 w-9 rounded-full transition-colors ${linked ? 'bg-amber' : 'bg-gray3/35'}`}
        ><span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${linked ? 'translate-x-4' : 'translate-x-0'}`} /></button>
      </div>
    </nav>
  )
}

function replaceLinkedProductInUrl(productId: string) {
  try {
    const url = new URL(window.location.href)
    if (productId) url.searchParams.set('linkedProductId', productId)
    else url.searchParams.delete('linkedProductId')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {}
}
