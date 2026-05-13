/**
 * GlanceStrip · 替代 BlackHero 的轻量首屏数据条
 *
 * 设计理念（PM 视角）：
 * - 餐饮 SaaS 工具页, 用户每次打开是来"处理事"不是"看广告"。
 *   黑色大卡占 30% 视觉重量是过度品牌化。
 * - 用 "无卡片 + 大数字 + 暖色 accent + 末端 sparkline" 替代,
 *   让首屏从"仪表盘"变"信息流", 直接接下来的待办/列表。
 * - 黑色降级为辅助 (BottomNav active dot / chip / 强对比 CTA)。
 */
'use client'
import React, { ReactNode } from 'react'

export interface GlanceStripProps {
  label: string                     // "今日集团营业额"
  value: string                     // "¥71,280"
  delta?: { text: string; trend?: 'up' | 'down' | 'flat' }
  meta?: string
  sparkline?: ReactNode             // 末端细线趋势图
  stats?: { label: string; value: string; tone?: 'red' | 'orange' | 'green' | 'accent' | 'default' }[]
  rightSlot?: ReactNode
}

export function GlanceStrip({ label, value, delta, meta, sparkline, stats, rightSlot }: GlanceStripProps) {
  return (
    <section className="px-4">
      {/* 主数据：无卡片，直接贴页面 */}
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between text-micro text-gray3 mb-1">
            <span>{label}</span>
            {rightSlot && <span>{rightSlot}</span>}
          </div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="font-num text-hero text-ink leading-none">{value}</span>
            {delta && (
              <span className={`text-caption font-num ${
                delta.trend === 'up' ? 'text-green-fg' :
                delta.trend === 'down' ? 'text-red-fg' :
                'text-gray3'
              }`}>{delta.text}</span>
            )}
          </div>
          {meta && <p className="text-caption text-gray3 mt-1.5">{meta}</p>}
        </div>
        {/* sparkline 右侧浮起，约占宽 35% */}
        {sparkline && (
          <div className="w-[38%] max-w-[160px] -mb-1 opacity-90">
            {sparkline}
          </div>
        )}
      </div>

      {/* 横向 metric 带：无卡片，靠细分割线分段 */}
      {stats && stats.length > 0 && (
        <div className="mt-4 flex items-stretch border-t border-border pt-3">
          {stats.map((s, i) => (
            <div
              key={i}
              className={`flex-1 px-1 ${i > 0 ? 'border-l border-border' : ''}`}
            >
              <div className="text-micro text-gray3 truncate">{s.label}</div>
              <div className={`font-num text-h2 mt-0.5 ${
                s.tone === 'red' ? 'text-red-fg' :
                s.tone === 'orange' ? 'text-orange-fg' :
                s.tone === 'green' ? 'text-green-fg' :
                s.tone === 'accent' ? 'text-accent' :
                'text-ink'
              }`}>
                {s.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
