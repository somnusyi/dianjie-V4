'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

export type DateRangeValue = { from: string; to: string }

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function iso(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function startMonth(date: Date) { return new Date(date.getFullYear(), date.getMonth(), 1) }
function addMonths(date: Date, amount: number) { return new Date(date.getFullYear(), date.getMonth() + amount, 1) }
function parse(value: string) {
  const [y, m, d] = value.split('-').map(Number)
  return y && m && d ? new Date(y, m - 1, d) : null
}

function monthDays(month: Date) {
  const first = startMonth(month)
  const startOffset = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - startOffset)
  return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index))
}

function DoubleChevron({ direction }: { direction: 'left' | 'right' }) {
  const points = direction === 'left' ? '13 4 7 10 13 16' : '7 4 13 10 7 16'
  return <span className="relative block h-5 w-5" aria-hidden="true">
    <svg viewBox="0 0 20 20" className="absolute left-0 top-0 h-5 w-5 fill-none stroke-current"><polyline points={points} strokeWidth="1.5" /></svg>
    <svg viewBox="0 0 20 20" className={`absolute top-0 h-5 w-5 fill-none stroke-current ${direction === 'left' ? 'left-1.5' : '-left-1.5'}`}><polyline points={points} strokeWidth="1.5" /></svg>
  </span>
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  const points = direction === 'left' ? '12 4 6 10 12 16' : '8 4 14 10 8 16'
  return <svg viewBox="0 0 20 20" className="h-5 w-5 fill-none stroke-current" aria-hidden="true"><polyline points={points} strokeWidth="1.5" /></svg>
}

export function DateRangeCalendar({ value, onChange, label = '日期范围' }: {
  value: DateRangeValue
  onChange: (value: DateRangeValue) => void
  label?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(() => startMonth(parse(value.from) || new Date()))
  const selectingEnd = Boolean(value.from && !value.to)

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  function select(day: Date) {
    const picked = iso(day)
    if (!selectingEnd) {
      onChange({ from: picked, to: '' })
      return
    }
    if (picked < value.from) onChange({ from: picked, to: value.from })
    else onChange({ from: value.from, to: picked })
    setOpen(false)
  }

  function preset(key: string) {
    const today = new Date()
    let from = today
    let to = today
    if (key === 'yesterday') from = to = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
    if (key === 'recent7') from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)
    if (key === 'lastMonth') {
      from = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      to = new Date(today.getFullYear(), today.getMonth(), 0)
    }
    if (key === 'thisMonth') from = new Date(today.getFullYear(), today.getMonth(), 1)
    if (key === 'thisYear') from = new Date(today.getFullYear(), 0, 1)
    onChange({ from: iso(from), to: iso(to) })
    setCursor(startMonth(from))
    setOpen(false)
  }

  const months = useMemo(() => [cursor, addMonths(cursor, 1)], [cursor])
  const display = value.from ? `${value.from}${value.to ? `  ~  ${value.to}` : '  ~  请选择结束日期'}` : '请选择日期范围'

  return <div ref={rootRef} className="relative">
    <label className="block text-micro text-gray3">{label}</label>
    <button type="button" onClick={() => setOpen(current => !current)} aria-expanded={open}
      className="mt-1 flex h-11 w-full min-w-56 items-center justify-between rounded-cta border border-border bg-white px-3 text-left text-caption">
      <span className={value.from ? 'text-ink' : 'text-gray3'}>{display}</span><span className="text-gray3">▣</span>
    </button>
    {open && <div className="absolute left-0 z-50 mt-1 w-[min(94vw,680px)] rounded-card border border-border bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-gray2">
        <div className="flex"><button type="button" aria-label="上一年" onClick={() => setCursor(addMonths(cursor, -12))} className="p-1"><DoubleChevron direction="left" /></button><button type="button" aria-label="上个月" onClick={() => setCursor(addMonths(cursor, -1))} className="p-1"><Chevron direction="left" /></button></div>
        <span className="text-caption">先点开始日期，再点结束日期</span>
        <div className="flex"><button type="button" aria-label="下个月" onClick={() => setCursor(addMonths(cursor, 1))} className="p-1"><Chevron direction="right" /></button><button type="button" aria-label="下一年" onClick={() => setCursor(addMonths(cursor, 12))} className="p-1"><DoubleChevron direction="right" /></button></div>
      </div>
      <div className="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2">
        {months.map((month, monthIndex) => <div key={iso(month)} className={monthIndex ? 'hidden sm:block' : ''}>
          <div className="mb-2 text-center text-button">{month.getFullYear()}年 {month.getMonth() + 1}月</div>
          <div className="grid grid-cols-7 text-center text-micro text-gray3">{WEEKDAYS.map(day => <span key={day} className="py-1">{day}</span>)}</div>
          <div className="grid grid-cols-7 text-center">{monthDays(month).map(day => {
            const key = iso(day)
            const outside = day.getMonth() !== month.getMonth()
            const selected = key === value.from || key === value.to
            const inRange = Boolean(value.from && value.to && key > value.from && key < value.to)
            return <button key={key} type="button" aria-label={key} onClick={() => select(day)}
              className={`h-9 text-caption ${outside ? 'text-gray4' : 'text-gray1'} ${inRange ? 'bg-amber/10' : ''} ${selected ? 'rounded bg-amber text-white' : 'hover:bg-bg'}`}>{day.getDate()}</button>
          })}</div>
        </div>)}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
        {[["today","今天"],["yesterday","昨天"],["recent7","近7天"],["lastMonth","上月"],["thisMonth","本月"],["thisYear","今年"]].map(([key, text]) => <button key={key} type="button" onClick={() => preset(key)} className="rounded border border-amber/30 bg-amber/10 px-3 py-1 text-micro text-amber-fg">{text}</button>)}
      </div>
    </div>}
  </div>
}
