'use client'
import { Children, Fragment, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react'

type Element = ReactElement<{ children?: ReactNode; colSpan?: number; className?: string }>
function elements(children: ReactNode): Element[] {
  return Children.toArray(children).flatMap(child => isValidElement(child) ? child.type === Fragment ? elements((child as Element).props.children) : [child as Element] : [])
}
/** One set of cells/actions, two semantic presentations; only the visible form is mounted. */
export function ResponsiveDataTable({ children, desktopOnly = false, label = '单据明细' }: { children: Element; desktopOnly?: boolean; label?: string }) {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    if (desktopOnly || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setMobile(media.matches)
    update()
    if (media.addEventListener) { media.addEventListener('change', update); return () => media.removeEventListener('change', update) }
    media.addListener(update); return () => media.removeListener(update)
  }, [desktopOnly])
  if (desktopOnly || !mobile) return children
  const sections = elements(children.props.children)
  const headings = elements(elements(sections.find(section => section.type === 'thead')?.props.children)[0]?.props.children).map(cell => cell.props.children)
  const rows = sections.filter(section => section.type === 'tbody').flatMap(section => elements(section.props.children))
  const footers = sections.filter(section => section.type === 'tfoot').flatMap(section => elements(section.props.children))
  return <div aria-label={`${label}卡片`} className="space-y-3 bg-bg p-3 text-caption" data-mobile-cards="true">
    <ul className="space-y-3">{rows.map((row, index) => {
      const cells = elements(row.props.children)
      if (cells.length === 1 && (cells[0].props.colSpan || 1) > 1) return <li key={row.key || index} className="rounded-card bg-white p-4 text-center text-gray2">{cells[0].props.children}</li>
      return <li key={row.key || index} className={`min-w-0 rounded-card border border-border bg-white p-3 ${row.props.className?.includes('opacity-50') ? 'opacity-50' : ''}`}><dl className="space-y-3">{cells.map((cell, column) => <div key={cell.key || column} className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3"><dt className="text-gray3">{headings[column] || '操作'}</dt><dd className="min-w-0 break-words [&_input]:max-w-full [&_select]:max-w-full [&_textarea]:max-w-full [&_.whitespace-nowrap]:whitespace-normal [&_button]:min-h-10 [&_a]:inline-block [&_a]:py-1">{cell.props.children}</dd></div>)}</dl></li>
    })}</ul>
    {footers.length > 0 && <div className="flex flex-wrap items-center justify-end gap-3 rounded-card border border-border bg-white p-3 font-semibold" aria-label="汇总">{footers.flatMap(row => elements(row.props.children)).map((cell, index) => <span key={index}>{cell.props.children}</span>)}</div>}
  </div>
}
