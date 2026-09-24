'use client'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'

type MenuLink = { title: string; href: string }

/** Shared two-column preview for the supply-chain workspaces. */
export function WorkspaceMenu({ id, title, description, icon, selected, href, items, shortcuts = [], pathname }: {
  id: string; title: string; description: string; icon: string; selected: boolean; href: string
  items: MenuLink[]; shortcuts?: MenuLink[]; pathname?: string
}) {
  const [top, setTop] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const trigger = useRef<HTMLAnchorElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const cancel = () => clearTimeout(timer.current)
  const close = () => { cancel(); timer.current = setTimeout(() => setTop(null), 150) }
  const open = () => {
    cancel()
    const rect = trigger.current?.getBoundingClientRect()
    const height = Math.ceil(items.length / 2) * 44 + (shortcuts.length ? 140 : 90)
    if (rect) setTop(Math.max(12, Math.min(rect.top, window.innerHeight - height - 12)))
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (panel.current?.contains(document.activeElement)) trigger.current?.focus()
        cancel(); setTop(null)
      }
    }
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) { cancel(); setTop(null) }
    }
    const reposition = () => setTop(null)
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside); window.addEventListener('resize', reposition)
    return () => { cancel(); document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition) }
  }, [])
  return <>
    <Link ref={trigger} href={href} onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close} onClick={() => setTop(null)} aria-expanded={top !== null} aria-controls={id} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${selected ? 'bg-amber/10 text-amber-fg' : 'text-gray1 hover:bg-bg'}`}>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-amber text-white' : 'bg-bg text-gray2'}`}>{icon}</span>
      <span className="min-w-0"><strong className="block text-button">{title}</strong><span className="block truncate text-micro text-gray3">{description}</span></span><span className="ml-auto">›</span>
    </Link>
    {top !== null && createPortal(<div ref={panel} id={id} onMouseEnter={cancel} onMouseLeave={close} onFocus={cancel} onBlur={close} style={{ top, left: 246, width: 500, maxWidth: 'calc(100vw - 258px)', maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto' }} className="fixed z-[80] rounded-xl border border-border bg-white p-4 shadow-xl" aria-label={`${title}导航`}>
      <h2 className="mb-3 border-b border-border pb-3 text-h2">{title}</h2>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">{items.map(item => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined} onClick={() => setTop(null)} className={`block rounded-lg px-3 py-2.5 text-button hover:bg-bg hover:text-amber-fg ${pathname === item.href ? 'bg-amber/10 text-amber-fg' : ''}`}>{item.title}</Link>)}</div>
      {!!shortcuts.length && <div className="mt-3 flex flex-wrap gap-5 border-t border-border pt-3 text-caption text-amber-fg">{shortcuts.map(item => <Link key={item.href} href={item.href} onClick={() => setTop(null)}>{item.title}</Link>)}</div>}
    </div>, document.body)}
  </>
}
