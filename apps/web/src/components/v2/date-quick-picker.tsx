/**
 * 财务专用 月份/日期 选择器
 *
 * 痛点: 原生 type="month"/type="date" 虽弹日历, 但财务最常用就那几个相对日期 (本月/上月/上季),
 *       每次都点框 → 翻日历 → 点月份, 操作繁; 加一排快捷按钮可"零打字零滑动"
 *
 * 用法:
 *   <MonthPicker value={month} onChange={setMonth} />
 *   <MonthPicker value={month} onChange={setMonth} quickButtons={['thisMonth','lastMonth','lastQuarterEnd','thisYearStart']} />
 *   <DatePicker value={date} onChange={setDate} quickButtons={['today','yesterday','monthEnd']} />
 *
 * 设计语言:
 *   - 输入框 + 快捷按钮组横排, gap-2
 *   - 快捷按钮命中当前值时高亮 (active 同 PeriodPills 风格)
 *   - 默认 max=当月 (不允许选未来)
 */
'use client'
import dayjs from 'dayjs'

// ────── 月份快捷 ──────
export type MonthShortcutKey =
  | 'thisMonth' | 'lastMonth' | 'twoMonthsAgo'
  | 'lastQuarterEnd' | 'thisYearStart' | 'lastYearEnd'

const MONTH_SHORTCUTS: Record<MonthShortcutKey, { label: string; resolve: () => string }> = {
  thisMonth:      { label: '本月',   resolve: () => dayjs().format('YYYY-MM') },
  lastMonth:      { label: '上月',   resolve: () => dayjs().subtract(1, 'month').format('YYYY-MM') },
  twoMonthsAgo:   { label: '上上月', resolve: () => dayjs().subtract(2, 'month').format('YYYY-MM') },
  lastQuarterEnd: { label: '上季末', resolve: () => {
    // 上季最后一月 = (当前季首月 - 1) 月. 当前季首月 = floor((month)/3)*3+1
    const now = dayjs()
    const quarterFirstMonthZeroIdx = Math.floor(now.month() / 3) * 3  // 0=Jan
    const lastQuarterEnd = now.month(quarterFirstMonthZeroIdx).subtract(1, 'month')
    return lastQuarterEnd.format('YYYY-MM')
  }},
  thisYearStart:  { label: '本年初', resolve: () => dayjs().startOf('year').format('YYYY-MM') },
  lastYearEnd:    { label: '上年末', resolve: () => dayjs().subtract(1, 'year').endOf('year').format('YYYY-MM') },
}

const MONTH_DEFAULT_BUTTONS: MonthShortcutKey[] = ['thisMonth', 'lastMonth', 'twoMonthsAgo', 'lastQuarterEnd']

export function MonthPicker({
  value, onChange, quickButtons = MONTH_DEFAULT_BUTTONS, className = '', min, max,
}: {
  value: string
  onChange: (v: string) => void
  quickButtons?: MonthShortcutKey[]
  className?: string
  min?: string
  /** 默认本月 (不允许选未来). 传 '' 显式禁用上限 */
  max?: string
}) {
  const effectiveMax = max === undefined ? dayjs().format('YYYY-MM') : (max || undefined)
  return (
    <div className={`inline-flex items-center gap-2 flex-wrap ${className}`}>
      <input
        type="month"
        value={value}
        min={min}
        max={effectiveMax}
        onChange={e => onChange(e.target.value)}
        className="px-3 py-2 rounded-cta border border-border bg-white text-button font-num"
      />
      <div className="inline-flex bg-bg rounded-cta p-0.5">
        {quickButtons.map(k => {
          const sc = MONTH_SHORTCUTS[k]
          if (!sc) return null
          const v = sc.resolve()
          const active = v === value
          return (
            <button key={k} onClick={() => onChange(v)} type="button"
              className={`px-2.5 py-1 text-button rounded-cta transition whitespace-nowrap ${active ? 'bg-ink text-white' : 'text-gray2 hover:text-ink'}`}>
              {sc.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ────── 日期快捷 ──────
export type DateShortcutKey =
  | 'today' | 'yesterday' | 'monthEnd' | 'lastMonthEnd' | 'weekStart' | 'yearEnd'

const DATE_SHORTCUTS: Record<DateShortcutKey, { label: string; resolve: () => string }> = {
  today:        { label: '今天',   resolve: () => dayjs().format('YYYY-MM-DD') },
  yesterday:    { label: '昨天',   resolve: () => dayjs().subtract(1, 'day').format('YYYY-MM-DD') },
  monthEnd:     { label: '本月末', resolve: () => dayjs().endOf('month').format('YYYY-MM-DD') },
  lastMonthEnd: { label: '上月末', resolve: () => dayjs().subtract(1, 'month').endOf('month').format('YYYY-MM-DD') },
  weekStart:    { label: '本周一', resolve: () => {
    // dayjs.startOf('week') 默认周日为首, +1 拿周一
    const start = dayjs().startOf('week')
    return (start.day() === 0 ? start.add(1, 'day') : start).format('YYYY-MM-DD')
  }},
  yearEnd:      { label: '上年末', resolve: () => dayjs().subtract(1, 'year').endOf('year').format('YYYY-MM-DD') },
}

const DATE_DEFAULT_BUTTONS: DateShortcutKey[] = ['today', 'yesterday', 'monthEnd', 'lastMonthEnd']

export function DatePicker({
  value, onChange, quickButtons = DATE_DEFAULT_BUTTONS, className = '', min, max,
}: {
  value: string
  onChange: (v: string) => void
  quickButtons?: DateShortcutKey[]
  className?: string
  min?: string
  /** 默认今天 (不允许选未来). 传 '' 显式禁用上限 */
  max?: string
}) {
  const effectiveMax = max === undefined ? dayjs().format('YYYY-MM-DD') : (max || undefined)
  return (
    <div className={`inline-flex items-center gap-2 flex-wrap ${className}`}>
      <input
        type="date"
        value={value}
        min={min}
        max={effectiveMax}
        onChange={e => onChange(e.target.value)}
        className="px-3 py-2 rounded-cta border border-border bg-white text-button font-num"
      />
      <div className="inline-flex bg-bg rounded-cta p-0.5">
        {quickButtons.map(k => {
          const sc = DATE_SHORTCUTS[k]
          if (!sc) return null
          const v = sc.resolve()
          const active = v === value
          return (
            <button key={k} onClick={() => onChange(v)} type="button"
              className={`px-2.5 py-1 text-button rounded-cta transition whitespace-nowrap ${active ? 'bg-ink text-white' : 'text-gray2 hover:text-ink'}`}>
              {sc.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
