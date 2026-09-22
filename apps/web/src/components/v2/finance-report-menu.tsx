'use client'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { financeReports } from '@/app/v2/supply-chain/finance-reports/report-definitions'
export function FinanceReportMenu({ selected }: { selected: boolean }) {
  const [top, setTop] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const trigger = useRef<HTMLAnchorElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const cancel = () => clearTimeout(timer.current)
  const close = () => { cancel(); timer.current = setTimeout(() => setTop(null), 150) }
  const open = () => { cancel(); const r = trigger.current?.getBoundingClientRect(); if (r) setTop(Math.max(12, Math.min(r.top, window.innerHeight - 260))) }
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { cancel(); setTop(null) } }
    const outside = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setTop(null) }
    const reposition = () => setTop(null)
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside); window.addEventListener('resize', reposition)
    return () => { cancel(); document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition) }
  }, [])
  return <>
    <Link ref={trigger} href="/v2/supply-chain/finance-reports?report=group-profit" onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close} aria-expanded={top !== null} aria-controls="finance-report-flyout" className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${selected ? 'bg-amber/10 text-amber-fg' : 'text-gray1 hover:bg-bg'}`}>
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${selected ? 'bg-amber text-white' : 'bg-bg text-gray2'}`}>¥</span><span><strong className="block text-button">财务报表</strong><span className="block text-micro text-gray3">毛利分析、物品与明细</span></span><span className="ml-auto">›</span>
    </Link>
    {top !== null && createPortal(<div ref={panel} id="finance-report-flyout" onMouseEnter={cancel} onMouseLeave={close} onFocus={cancel} onBlur={close} style={{ top, left: 246 }} className="fixed z-[80] w-80 rounded-xl border border-border bg-white p-4 shadow-xl" aria-label="财务报表导航">
      <h2 className="mb-3 border-b border-border pb-3 text-h2">财务报表</h2>
      {financeReports.map(r => <Link key={r.id} href={`/v2/supply-chain/finance-reports?report=${r.id}`} onClick={() => setTop(null)} className="block rounded-lg px-3 py-2 text-button hover:bg-bg hover:text-amber-fg">{r.title}</Link>)}

    </div>, document.body)}
  </>
}
