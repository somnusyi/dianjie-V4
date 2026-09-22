'use client'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
export const inventoryReports = [
  { id: 'realtime', title: '实时库存查询表' }, { id: 'movements', title: '出入库明细表' }, { id: 'summary', title: '出入库汇总表' }, { id: 'other-summary', title: '其他出入库汇总表' }, { id: 'transfer-detail', title: '机构间调拨明细表' }, { id: 'transfer-summary', title: '机构间调拨汇总表' }, { id: 'stagnant', title: '库存呆滞品查询表' }, { id: 'alerts', title: '库存预警表' },
]
export function InventoryReportMenu({ selected }: { selected: boolean }) {
  const [top, setTop] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const trigger = useRef<HTMLAnchorElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const cancel = () => clearTimeout(timer.current)
  const close = () => { cancel(); timer.current = setTimeout(() => setTop(null), 150) }
  const open = () => { cancel(); const r = trigger.current?.getBoundingClientRect(); if (r) setTop(Math.max(12, Math.min(r.top, window.innerHeight - 460))) }
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { cancel(); setTop(null) } }
    const outside = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setTop(null) }
    const reposition = () => setTop(null)
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside); window.addEventListener('resize', reposition)
    return () => { cancel(); document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition) }
  }, [])
  return <>
    <Link ref={trigger} href="/v2/supply-chain/reports?report=realtime" onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close} aria-expanded={top !== null} aria-controls="inventory-report-flyout" className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${selected ? 'bg-amber/10 text-amber-fg' : 'text-gray1 hover:bg-bg'}`}>
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${selected ? 'bg-amber text-white' : 'bg-bg text-gray2'}`}>仓</span><span><strong className="block text-button">库存报表</strong><span className="block text-micro text-gray3">库存查询、明细与汇总</span></span><span className="ml-auto">›</span>
    </Link>
    {top !== null && createPortal(<div ref={panel} id="inventory-report-flyout" onMouseEnter={cancel} onMouseLeave={close} onFocus={cancel} onBlur={close} style={{ top, left: 246, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }} className="fixed z-[80] w-80 rounded-xl border border-border bg-white p-4 shadow-xl" aria-label="库存报表导航">
      <h2 className="mb-3 border-b border-border pb-3 text-h2">库存报表</h2>
      {inventoryReports.map(r => <Link key={r.id} href={`/v2/supply-chain/reports?report=${r.id}`} onClick={() => setTop(null)} className="block rounded-lg px-3 py-2 text-button hover:bg-bg hover:text-amber-fg">{r.title}</Link>)}
      <div className="mt-3 flex gap-5 border-t border-border pt-3 text-caption text-amber-fg"><Link href="/v2/supply-chain/inventory" onClick={() => setTop(null)}>库存作业</Link><Link href="/v2/supply-chain/inbound" onClick={() => setTop(null)}>入库记录</Link><Link href="/v2/supply-chain/docs" onClick={() => setTop(null)}>单据审核</Link></div>
    </div>, document.body)}
  </>
}
