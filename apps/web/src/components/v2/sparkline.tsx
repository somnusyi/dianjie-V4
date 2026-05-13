/**
 * Sparkline · 黑卡内嵌的轻量趋势线
 * 设计：纯 SVG 折线 + 渐变填充 + 末点高亮，支持 dark/light 反色
 *
 * 使用：
 *   <Sparkline data={[60720, 58080, ...]} />
 *
 * 渲染：
 *   - 自适应宽度（默认 100% / 高度 36px）
 *   - 平滑 monotone-ish 路径（简单两段控制）
 *   - 末日数值高亮成琥珀色小圆点（与 BlackHero 顶部 1px 暖色高光呼应）
 *   - 数据全 0 → 渲染暗淡占位线（不让 hero 显得空）
 */
'use client'
import React from 'react'

export interface SparklineProps {
  data: number[]
  height?: number
  /** 折线和填充色 — 默认白色（用在黑底 hero） */
  stroke?: string
  fillFrom?: string
  /** 末点高亮色 */
  accent?: string
  /** 自动隐藏数据全 0 时的占位（默认 false） */
  hideWhenEmpty?: boolean
  className?: string
}

export function Sparkline({
  data,
  height = 36,
  // 默认走"亮底"配色（GlanceStrip 用），柿色折线 + 浅柿渐变填充
  stroke = '#E07A3C',
  fillFrom = 'rgba(224,122,60,0.18)',
  accent = '#E07A3C',
  hideWhenEmpty = false,
  className = '',
}: SparklineProps) {
  const allZero = data.every(v => !v)
  if (allZero && hideWhenEmpty) return null
  const W = 100 // viewBox width (相对单位)
  const H = height
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const padY = 4
  const drawH = H - padY * 2
  const stepX = data.length > 1 ? W / (data.length - 1) : 0

  const points = data.map((v, i) => {
    const x = i * stepX
    const y = padY + drawH - ((v - min) / range) * drawH
    return [x, y] as const
  })

  // 折线 path
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ')
  // 填充 path（首尾连到底边）
  const areaPath = `${linePath} L ${W} ${H} L 0 ${H} Z`

  const last = points[points.length - 1]

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%" height={H}
      className={`block ${className}`}
      role="img"
      aria-label="过去 7 日营业额走势"
    >
      <defs>
        <linearGradient id="dj-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fillFrom} />
          <stop offset="100%" stopColor={fillFrom} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#dj-spark-fill)" />
      <path
        d={linePath}
        fill="none"
        stroke={allZero ? 'rgba(42,34,24,0.18)' : stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {!allZero && last && (
        <circle cx={last[0]} cy={last[1]} r="2.2" fill={accent} />
      )}
    </svg>
  )
}
