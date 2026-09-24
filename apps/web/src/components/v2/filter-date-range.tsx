'use client'
import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState } from 'react'
import styles from './filter-date-range.module.css'

export type FilterDateValue = { start: string; end: string }
const iso = (date: Date) => date.toISOString().slice(0, 10)
const parse = (value: string) => new Date(`${value}T00:00:00Z`)
const monthOf = (value: string) => `${value.slice(0, 7)}-01`
const shiftMonth = (value: string, amount: number) => { const date = parse(value); return iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1))) }
const businessToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
const shiftDay = (value: string, amount: number) => iso(new Date(parse(value).getTime() + amount * 86400000))
const presets = ['今天', '昨天', '近7天', '上月', '本月', '今年']

export function FilterDateRange({ value, onChange, label = '日期范围' }: {
  value: FilterDateValue; onChange: (value: FilterDateValue) => void; label?: string
}) {
  const today = businessToday()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState('')
  const [anchor, setAnchor] = useState('')
  const [hovered, setHovered] = useState('')
  const [position, setPosition] = useState({ top: 0, left: 0, width: 560 })
  const close = () => { setOpen(false); setAnchor(''); setHovered('') }
  function show() {
    setCursor(monthOf(value.start || businessToday())); setAnchor(''); setHovered(''); setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(560, window.innerWidth - 16)
      const height = panel.current?.offsetHeight || 350
      setPosition({ width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: Math.max(8, rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 4 : rect.top - height - 4) })
    }
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); trigger.current?.focus() } }
    place()
    panel.current?.focus()
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  // External reset or page changes cancel an unfinished selection.
  useEffect(() => { close() }, [value.start, value.end])
  function commit(start: string, end: string) { onChange({ start, end }); close(); trigger.current?.focus() }
  function pick(day: string) {
    if (!anchor) { setAnchor(day); setHovered(day); return }
    commit(day < anchor ? day : anchor, day < anchor ? anchor : day)
  }
  function preset(name: string) {
    const today = businessToday(); const month = monthOf(today)
    const start = name === '昨天' ? shiftDay(today, -1) : name === '近7天' ? shiftDay(today, -6) : name === '上月' ? shiftMonth(month, -1) : name === '本月' ? month : name === '今年' ? `${today.slice(0, 4)}-01-01` : today
    const end = name === '昨天' ? start : name === '上月' ? shiftDay(month, -1) : today
    commit(start, end)
  }
  const from = anchor ? [anchor, hovered || anchor].sort()[0] : value.start
  const to = anchor ? [anchor, hovered || anchor].sort()[1] : value.end
  return <div className={styles.control}>
    <button ref={trigger} type="button" className={styles.trigger} aria-label={`选择${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => open ? close() : show()}>
      <span className={!value.start ? styles.placeholder : ''}>{value.start.replaceAll('-', '/') || '开始日期'}</span><span className={styles.separator}>~</span><span className={!value.end ? styles.placeholder : ''}>{value.end.replaceAll('-', '/') || '结束日期'}</span><span aria-hidden="true">▦</span>
    </button>
    {(value.start || value.end) && <button type="button" className={styles.clear} aria-label={`清空${label}`} onClick={() => commit('', '')}>×</button>}
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={`${label}选择器`} tabIndex={-1} className={styles.panel} style={position} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !trigger.current?.contains(event.relatedTarget)) close() }}>
      <div className={styles.months}>{[cursor, shiftMonth(cursor, 1)].map((month, index) => {
        const date = parse(month); const year = date.getUTCFullYear(); const monthIndex = date.getUTCMonth()
        const offset = (date.getUTCDay() + 6) % 7
        const years = Array.from({ length: 41 }, (_, i) => year - 20 + i)
        return <section key={index} aria-label={`${year}年${monthIndex + 1}月`} className={styles.month}>
          <header>
            <div className={styles.arrows}>{index === 0 && <><button type="button" aria-label="上一年" onClick={() => setCursor(shiftMonth(cursor, -12))}>«</button><button type="button" aria-label="上个月" onClick={() => setCursor(shiftMonth(cursor, -1))}>‹</button></>}</div>
            <div className={styles.monthTitle}><select aria-label={`${index === 0 ? '左侧' : '右侧'}年份`} value={year} onChange={e => setCursor(shiftMonth(iso(new Date(Date.UTC(Number(e.target.value), monthIndex, 1))), -index))}>{years.map(y => <option key={y} value={y}>{y}年</option>)}</select><select aria-label={`${index === 0 ? '左侧' : '右侧'}月份`} value={monthIndex} onChange={e => setCursor(shiftMonth(iso(new Date(Date.UTC(year, Number(e.target.value), 1))), -index))}>{Array.from({ length: 12 }, (_, m) => <option key={m} value={m}>{m + 1}月</option>)}</select></div>
            <div className={styles.arrows}>{index === 1 && <><button type="button" aria-label="下个月" onClick={() => setCursor(shiftMonth(cursor, 1))}>›</button><button type="button" aria-label="下一年" onClick={() => setCursor(shiftMonth(cursor, 12))}>»</button></>}</div>
          </header>
          <div className={styles.week}>{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
          <div className={styles.days}>{Array.from({ length: 42 }, (_, i) => {
            const day = shiftDay(month, i - offset); const dayDate = parse(day); const outside = day.slice(0, 7) !== month.slice(0, 7)
            const selected = day === from || day === to; const between = !!from && !!to && day > from && day < to
            return <button type="button" key={day} aria-label={`${day}${outside ? '（相邻月份）' : ''}`} aria-pressed={selected} className={`${outside ? styles.outside : ''} ${between ? styles.between : ''} ${selected ? styles.selected : ''} ${day === today ? styles.today : ''}`} onMouseEnter={() => anchor && setHovered(day)} onFocus={() => anchor && setHovered(day)} onClick={() => pick(day)}>{dayDate.getUTCDate()}</button>
          })}</div>
        </section>
      })}</div>
      <footer><div>{presets.map(name => <button type="button" key={name} onClick={() => preset(name)}>{name}</button>)}</div><span role="status">{anchor ? '请选择结束日期' : '请选择开始日期'}</span></footer>
    </div>, document.body)}
  </div>
}
