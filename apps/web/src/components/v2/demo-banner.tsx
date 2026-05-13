/**
 * 「演示数据」横幅 · 用于尚未接真实 API 的页面 / 板块
 * 文案精简, 不打扰主任务
 */
'use client'

export function DemoBanner({ note }: { note?: string }) {
  return (
    <div className="mx-4 mt-3 bg-amber/10 border border-amber/30 rounded-card px-3 py-2 flex items-start gap-2">
      <span className="text-amber-fg text-button shrink-0 mt-0.5">⚠</span>
      <div className="flex-1 text-caption text-gray2">
        <span className="text-amber-fg">演示数据</span>
        {note ? <span className="text-gray3"> · {note}</span> : <span className="text-gray3"> · 等待真实数据接入</span>}
      </div>
    </div>
  )
}
