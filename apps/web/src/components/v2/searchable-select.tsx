'use client'

import { Children, Fragment, cloneElement, isValidElement, useId, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react'

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  searchLabel: string
  searchPlaceholder?: string
  /** Short fixed lists retain their original compact native select. */
  searchWhenLong?: boolean
}

function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode; label?: string }>(child)
    ? `${child.props.label || ''} ${textOf(child.props.children)}`
    : typeof child === 'string' || typeof child === 'number' ? String(child) : '').join(' ')
}

/** Search for checkbox/button lists; filtering never changes checked state or the caller's data. */
export function SearchableList({ children, searchLabel, className = '', listAs: List = 'div', listLabel }: { children: ReactNode; searchLabel: string; className?: string; listAs?: 'div' | 'ul' | 'nav'; listLabel?: string }) {
  const [query, setQuery] = useState('')
  const nodes = Children.toArray(children)
  if (nodes.length <= 6) return <List className={className} aria-label={listLabel}>{children}</List>
  const terms = query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = nodes.filter(node => (isValidElement<{ 'data-search-pinned'?: boolean }>(node) && node.props['data-search-pinned']) || terms.every(term => textOf(node).normalize('NFKC').toLowerCase().includes(term)))
  const matches = filtered.filter(node => !(isValidElement<{ 'data-search-pinned'?: boolean }>(node) && node.props['data-search-pinned'])).length
  return <div className="min-w-0 space-y-2">
    <input type="search" aria-label={searchLabel} placeholder="输入名称 / 编号搜索" value={query} maxLength={100}
      onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault() }}
      className="h-9 w-full min-w-0 rounded-cta border border-border bg-white px-3 text-caption outline-none focus:border-accent" />
    {query && <div role="status" className="flex items-center justify-between text-micro text-gray3"><span>{matches ? `找到 ${matches} 项` : '未找到匹配项'}</span><button type="button" onClick={() => setQuery('')}>清除搜索</button></div>}
    <List className={className} aria-label={listLabel}>{filtered}</List>
  </div>
}

/** Filters only the options already authorized and loaded by the caller. Never changes its selection. */
export function SearchableSelect({ children, searchLabel, searchPlaceholder = '输入名称 / 编号搜索', searchWhenLong = false, ...selectProps }: Props) {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
  const statusId = useId()
  const panelId = useId()
  function closeSearch() {
    setQuery('')
    setSearchOpen(false)
  }
  const terms = query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const selected = new Set([selectProps.value ?? selectProps.defaultValue].flat().filter(value => value != null && String(value) !== '').map(String))
  let matches = 0
  let total = 0
  function filter(nodes: ReactNode, groupLabel = ''): ReactNode {
    return Children.map(nodes, child => {
      if (!isValidElement<{ value?: string | number; label?: string; children?: ReactNode; 'data-search'?: string }>(child)) return child
      if (child.type === Fragment || child.type === 'optgroup') {
        return cloneElement(child, {}, filter(child.props.children, child.props.label || groupLabel))
      }
      if (child.type !== 'option') return child
      const value = String(child.props.value ?? textOf(child.props.children))
      if (value === '') return child
      total++
      const haystack = `${groupLabel} ${child.props.label || ''} ${textOf(child.props.children)} ${child.props['data-search'] || ''}`.normalize('NFKC').toLowerCase()
      const matched = terms.every(term => haystack.includes(term))
      if (matched) matches++
      return matched || selected.has(value) ? child : null
    })
  }
  const options = filter(children)
  if (searchWhenLong && total <= 6) return <select {...selectProps}>{children}</select>
  return <span className="block min-w-0 flex-1" style={{ flex: '1 1 0%', minWidth: 0, whiteSpace: 'normal' }}
    onKeyDown={event => { if (event.key === 'Escape' && searchOpen) { event.preventDefault(); event.stopPropagation(); closeSearch(); searchButton.current?.focus() } }}>
    <span className="grid items-center gap-1" style={{ gridTemplateColumns: 'minmax(0, 1fr) 2rem' }}>
      <select {...selectProps} aria-label={selectProps['aria-label'] || searchLabel.replace(/^搜索/, '')} style={{ width: '100%', minWidth: 0, ...selectProps.style }} onChange={event => { selectProps.onChange?.(event); closeSearch() }}>{options}</select>
      <button ref={searchButton} type="button" disabled={selectProps.disabled} aria-label={`${searchOpen ? '收起' : '展开'}${searchLabel}`}
        title={searchOpen ? '收起搜索' : '搜索'} aria-expanded={searchOpen} aria-controls={searchOpen ? panelId : undefined}
        onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true) }}
        className="flex h-8 w-8 items-center justify-center rounded text-gray2 hover:bg-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
      </button>
    </span>
    {searchOpen && <span id={panelId} className="mt-1.5 block">
    <span className="relative block">
      <input type="search" aria-label={searchLabel} aria-describedby={query ? statusId : undefined}
        placeholder={searchPlaceholder} value={query} disabled={selectProps.disabled} maxLength={100}
        autoFocus autoComplete="off" style={{ width: '100%' }} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault() }}
        className="h-9 w-full min-w-0 rounded-cta border border-border bg-white px-3 pr-14 text-caption text-ink outline-none focus:border-accent disabled:bg-bg disabled:opacity-60" />
      {query && <button type="button" disabled={selectProps.disabled} aria-label={`清除${searchLabel}`}
        onClick={() => setQuery('')} className="absolute inset-y-0 right-2 text-caption text-gray2 disabled:opacity-40">清除</button>}
    </span>
    {query && <span id={statusId} role="status" className="block text-micro text-gray3">
      {matches ? `找到 ${matches} 项` : '未找到匹配项'}{!matches && selected.size > 0 ? '，当前选择保留' : ''}
    </span>}
    </span>}
  </span>
}
