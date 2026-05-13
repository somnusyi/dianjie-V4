/**
 * PDF v1.1 核心组件库 · 10 件套
 *
 * 设计原则（CHAPTER 02）：
 * - 黑白灰为主，语义色只在数字/状态上点缀
 * - 5 阶灰是关键 — stacked bar 全用灰编码，绿色只用于净利
 * - 双形态：Mobile=单列紧凑，Desktop=多列宽松
 * - 通过 prop `density="mobile"|"desktop"` 切换；默认根据 viewport 自适应
 */
'use client'
import React, { ReactNode } from 'react'

type Density = 'mobile' | 'desktop'

// ════════════════════════════════════════════════════
// 1. BLACK HERO ─ 历史名（已废弃黑底视觉）
//    保留导出以兼容遗留页面调用；实际渲染走 GlanceStrip 暖色版。
//    新代码请直接 import GlanceStrip。
// ════════════════════════════════════════════════════
import { GlanceStrip } from './glance-strip'

export interface BlackHeroProps {
  label: string
  value: string
  delta?: { text: string; trend?: 'up' | 'down' | 'flat' }
  meta?: string
  sparkline?: ReactNode
  stats?: { label: string; value: string; tone?: 'red' | 'green' | 'orange' | 'gray' | 'default' | string }[]
  density?: Density   // 已废弃，保留签名兼容
  rightSlot?: ReactNode
}
export function BlackHero(props: BlackHeroProps) {
  const { density: _ignored, stats, ...rest } = props
  return <GlanceStrip {...rest} stats={stats as any} />
}

// ════════════════════════════════════════════════════
// 2. PERIOD PILLS ─ 时间窗 segmented chip（本周/本月/YTD）
// ════════════════════════════════════════════════════
export function PeriodPills({ value, options, onChange }: {
  value: string
  options: { label: string; value: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="inline-flex bg-bg rounded-cta p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 text-button rounded-cta transition ${
            o.value === value ? 'bg-ink text-white' : 'text-gray2 hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════
// 3. TODO CARD ─ 3px 左色条 + 类型 chip + 双按钮
// ════════════════════════════════════════════════════
export type TodoTone = 'immediate' | 'today' | 'routine'  // 红/橙/灰
const TODO_BAR: Record<TodoTone, string> = {
  immediate: 'before:bg-red',
  today:     'before:bg-orange',
  routine:   'before:bg-gray4',
}
export function TodoCard({
  tone, chips, title, sub, primary, secondary, onClick,
}: {
  tone: TodoTone
  chips?: { label: string; tone?: 'red' | 'orange' | 'green' | 'gray' }[]
  title: string
  sub?: string
  primary?: { label: string; onClick: () => void }
  secondary?: { label: string; onClick: () => void }
  onClick?: () => void
}) {
  return (
    <div
      className={`relative bg-white rounded-card p-3 pl-4 border border-border ${TODO_BAR[tone]}
                  before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full
                  ${onClick ? 'cursor-pointer hover:bg-bg/40' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {chips && (
            <div className="flex gap-1 flex-wrap mb-1">
              {chips.map((c, i) => <Chip key={i} tone={c.tone}>{c.label}</Chip>)}
            </div>
          )}
          <div className="text-h2 truncate">{title}</div>
          {sub && <div className="text-caption text-gray2 mt-0.5">{sub}</div>}
        </div>
        {(primary || secondary) && (
          <div className="flex gap-2 shrink-0">
            {secondary && <ActionButton variant="secondary" onClick={secondary.onClick}>{secondary.label}</ActionButton>}
            {primary && <ActionButton variant="primary" onClick={primary.onClick}>{primary.label}</ActionButton>}
          </div>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════
// 4. METRIC TILE ─ 白底圆角 KPI 块 (2x2 网格用)
// ════════════════════════════════════════════════════
export function MetricTile({ label, value, delta, tone, hint }: {
  label: string
  value: string
  delta?: string
  tone?: 'red' | 'green' | 'orange' | 'default'
  hint?: string
}) {
  const valColor = tone === 'red' ? 'text-red' : tone === 'green' ? 'text-green' : tone === 'orange' ? 'text-orange' : ''
  return (
    <div className="bg-white rounded-card p-3 border border-border">
      <div className="text-caption text-gray2">{label}</div>
      <div className={`font-num text-h1 mt-1 ${valColor}`}>{value}</div>
      {delta && <div className={`text-micro mt-1 ${tone === 'green' ? 'text-green-fg' : tone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{delta}</div>}
      {hint && <div className="text-micro text-gray3 mt-1">{hint}</div>}
    </div>
  )
}

// ════════════════════════════════════════════════════
// 5. STACKED BAR ─ 5 阶灰横条，可加第 6 段绿色"净利"
// ════════════════════════════════════════════════════
export function StackedBar({ segments, height = 12, showProfit }: {
  segments: { label: string; pct: number; deltaPp?: number }[]  // pct 总和应为 100
  height?: number
  showProfit?: { label: string; pct: number; deltaPp?: number }   // 第 6 段绿色，单独传
}) {
  const grays = ['bg-gray1', 'bg-gray2', 'bg-gray3', 'bg-gray4', 'bg-gray5']
  return (
    <div>
      <div className="flex w-full overflow-hidden rounded-chip" style={{ height }}>
        {segments.slice(0, 5).map((s, i) => (
          <div key={i} className={grays[i]} style={{ width: `${s.pct}%` }} />
        ))}
        {showProfit && <div className="bg-green" style={{ width: `${showProfit.pct}%` }} />}
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2 text-micro">
        {[...segments, ...(showProfit ? [showProfit] : [])].map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-sm ${i < 5 ? grays[i] : 'bg-green'}`} />
            <span className="text-gray2">{s.label}</span>
            <span className="font-num text-ink">{s.pct}%</span>
            {s.deltaPp != null && (
              <span className={`text-micro ${s.deltaPp > 0 ? 'text-red-fg' : s.deltaPp < 0 ? 'text-green-fg' : 'text-gray3'}`}>
                {s.deltaPp > 0 ? '↑' : s.deltaPp < 0 ? '↓' : ''}{Math.abs(s.deltaPp)}pp
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════
// 6. PROGRESS DOTS ─ 5 段流程链路（采购/配送）
// ════════════════════════════════════════════════════
export function ProgressDots({ steps, currentIndex }: {
  steps: { label: string }[]
  currentIndex: number      // 0-based, < currentIndex 已完成
}) {
  return (
    <div className="flex items-center w-full">
      {steps.map((s, i) => {
        const done = i < currentIndex
        const active = i === currentIndex
        const tone = done ? 'bg-green' : active ? 'bg-blue' : 'bg-gray5'
        return (
          <React.Fragment key={i}>
            <div className="flex flex-col items-center shrink-0">
              <div className={`w-3 h-3 rounded-full ${tone} ${active ? 'ring-2 ring-blue/30' : ''}`}>
                {done && <span className="text-white text-[8px] flex items-center justify-center h-full leading-none">✓</span>}
              </div>
              <span className={`text-micro mt-1 ${active ? 'text-ink' : 'text-gray3'}`}>{s.label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-px mx-1 ${i < currentIndex ? 'bg-green' : 'bg-gray5'}`} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

// ════════════════════════════════════════════════════
// 7. APPROVAL ROUTING ─ 头像链 + 状态 dot（跨角色可视化）
// ════════════════════════════════════════════════════
export function ApprovalRouting({ steps }: {
  steps: { name: string; role: string; status: 'done' | 'current' | 'waiting' | 'skipped'; meta?: string }[]
}) {
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => {
        const initial = s.name.charAt(0)
        const ringTone =
          s.status === 'done'    ? 'border-green' :
          s.status === 'current' ? 'border-orange ring-2 ring-orange/20' :
          s.status === 'skipped' ? 'border-gray4 opacity-50' :
          'border-gray5'
        return (
          <React.Fragment key={i}>
            <div className="flex flex-col items-center">
              <div className={`relative w-8 h-8 rounded-full border-2 ${ringTone} bg-bg flex items-center justify-center font-num text-button`}>
                {initial}
                {s.status === 'done' && <span className="absolute -bottom-1 -right-1 bg-green text-white text-[8px] w-3 h-3 rounded-full flex items-center justify-center">✓</span>}
              </div>
              <div className="text-micro text-gray2 mt-1">{s.role}</div>
              {s.meta && <div className="text-micro text-gray3">{s.meta}</div>}
            </div>
            {i < steps.length - 1 && <div className={`flex-1 h-px ${s.status === 'done' ? 'bg-green' : 'bg-gray5'}`} />}
          </React.Fragment>
        )
      })}
    </div>
  )
}

// ════════════════════════════════════════════════════
// 8. BOTTOM NAV ─ 4-5 Tab，店长 5 Tab 中央 ⊕ FAB
// ════════════════════════════════════════════════════
export function BottomNav({ tabs, activeKey, onChange, fabKey, onFab }: {
  tabs: { key: string; label: string; icon?: ReactNode }[]
  activeKey: string
  onChange: (k: string) => void
  fabKey?: string                  // 中央 FAB 的 key（出现在 tabs 中间）
  onFab?: () => void
}) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-border flex items-stretch h-16 z-40"
         style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {tabs.map((t) => {
        const active = t.key === activeKey
        const isFab = t.key === fabKey
        if (isFab) {
          return (
            <button
              key={t.key}
              onClick={onFab}
              className="flex-1 flex flex-col items-center justify-center"
            >
              <span className="w-12 h-12 rounded-full bg-amber text-white flex items-center justify-center text-h1 shadow-fab -mt-3 ring-4 ring-bg">
                {t.icon ?? '+'}
              </span>
            </button>
          )
        }
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 ${active ? 'text-ink' : 'text-gray3'}`}
          >
            <span className="text-lg">{t.icon ?? '·'}</span>
            <span className="text-micro">{t.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

// ════════════════════════════════════════════════════
// 9. ACTION BUTTON PAIR ─ 白次按钮 + 黑主按钮（带金额）
// ════════════════════════════════════════════════════
export function ActionButton({ children, variant = 'primary', onClick, disabled, amount }: {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
  onClick?: () => void
  disabled?: boolean
  amount?: string                  // "¥18,000" 显示在主按钮上防误操作
}) {
  const cls =
    variant === 'primary' ? 'bg-ink text-white hover:bg-gray1' :
    variant === 'danger'  ? 'border border-red text-red hover:bg-red-bg' :
    'bg-white border border-border text-ink hover:bg-bg'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-cta text-button transition disabled:opacity-40 disabled:cursor-not-allowed ${cls}`}
    >
      {children}
      {amount && <span className="font-num ml-2">· {amount}</span>}
    </button>
  )
}

export function ActionButtonPair({
  primary, secondary, sticky,
}: {
  primary: { label: string; onClick: () => void; amount?: string; disabled?: boolean }
  secondary?: { label: string; onClick: () => void; danger?: boolean }
  sticky?: boolean                 // 底部固定（审批详情用）
}) {
  return (
    <div className={`flex gap-3 ${sticky ? 'fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 z-30' : ''}`}>
      {secondary && <ActionButton variant={secondary.danger ? 'danger' : 'secondary'} onClick={secondary.onClick}>{secondary.label}</ActionButton>}
      <ActionButton variant="primary" onClick={primary.onClick} disabled={primary.disabled} amount={primary.amount}>
        {primary.label}
      </ActionButton>
    </div>
  )
}

// ════════════════════════════════════════════════════
// 10. STORE AVATAR ─ 圆角方形头像（单字 + 异常时染红）
// ════════════════════════════════════════════════════
export function StoreAvatar({ name, anomaly, size = 'md' }: {
  name: string                     // "国贸店" → "国"
  anomaly?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  const px = size === 'sm' ? 'w-7 h-7 text-caption' : size === 'lg' ? 'w-11 h-11 text-h2' : 'w-9 h-9 text-button'
  const tone = anomaly ? 'bg-red-bg text-red-fg' : 'bg-bg text-gray1'
  const initial = name.charAt(0)
  return (
    <span className={`inline-flex items-center justify-center rounded-md font-medium shrink-0 ${px} ${tone}`}>
      {initial}
    </span>
  )
}

// ════════════════════════════════════════════════════
// 辅助：CHIP（在 PDF 第 02 章颜色系统）
// ════════════════════════════════════════════════════
export function Chip({ children, tone = 'gray' }: { children: ReactNode; tone?: 'red' | 'orange' | 'green' | 'gray' | 'blue' }) {
  const cls =
    tone === 'red'    ? 'bg-red-bg text-red-fg' :
    tone === 'orange' ? 'bg-orange-bg text-orange-fg' :
    tone === 'green'  ? 'bg-green-bg text-green-fg' :
    tone === 'blue'   ? 'bg-bg text-blue' :
    'bg-bg text-gray2'
  return <span className={`inline-block px-1.5 py-0.5 text-micro rounded-chip ${cls}`}>{children}</span>
}
