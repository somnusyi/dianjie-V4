/**
 * Skeleton 骨架屏 + 友好错误/空状态组件
 *
 * 替代各页面的"加载中…"文字 + raw error message
 */
'use client'

export function SkeletonLine({ className = '' }: { className?: string }) {
  return <div className={`bg-gray5 rounded animate-pulse ${className}`} />
}

export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-white rounded-card border border-border p-3 ${className}`}>
      <div className="flex items-center gap-2 mb-2">
        <SkeletonLine className="h-3 w-12" />
        <SkeletonLine className="h-3 w-20" />
      </div>
      <SkeletonLine className="h-5 w-3/4 mb-2" />
      <SkeletonLine className="h-3 w-1/2" />
    </div>
  )
}

export function SkeletonHero() {
  return (
    <div className="bg-ink rounded-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="h-3 w-20 bg-white/10 rounded animate-pulse" />
        <div className="h-3 w-12 bg-white/10 rounded animate-pulse" />
      </div>
      <div className="h-9 w-32 bg-white/15 rounded animate-pulse mb-3" />
      <div className="h-3 w-40 bg-white/10 rounded animate-pulse mb-4" />
      <div className="border-t border-white/10 pt-3 flex gap-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex-1">
            <div className="h-2.5 w-12 bg-white/10 rounded mb-1.5 animate-pulse" />
            <div className="h-5 w-16 bg-white/15 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  )
}

/**
 * 友好错误状态(替代 raw "路由不存在: /api/...")
 */
export function FriendlyError({
  message,
  onRetry,
  hint,
}: { message?: string; onRetry?: () => void; hint?: string }) {
  // 把"路由不存在: /api/xxx"转成友好文案
  const isRouteNotFound = message?.includes('路由不存在') || message?.includes('Not Found')
  const friendly = isRouteNotFound
    ? '此功能仍在部署中, 请稍后再试'
    : message?.replace(/^Error:\s*/, '') || '加载失败'

  return (
    <div className="bg-amber/10 border border-amber/30 rounded-card p-4 text-center">
      <div className="text-h2 mb-1">⚠</div>
      <p className="text-body text-gray2">{friendly}</p>
      {hint && <p className="text-caption text-gray3 mt-1">{hint}</p>}
      {onRetry && (
        <button onClick={onRetry}
                className="mt-3 px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">
          重试
        </button>
      )}
    </div>
  )
}

/**
 * 友好空状态 (替代"暂无数据"placeholder)
 */
export function EmptyState({
  icon = '📋',
  title,
  hint,
  cta,
}: {
  icon?: string
  title: string
  hint?: string
  cta?: { label: string; href?: string; onClick?: () => void }
}) {
  return (
    <div className="bg-white rounded-card border border-border p-8 text-center">
      <div className="text-[40px] opacity-40 mb-2">{icon}</div>
      <p className="text-body text-gray2">{title}</p>
      {hint && <p className="text-caption text-gray3 mt-1">{hint}</p>}
      {cta && (
        cta.href
          ? <a href={cta.href} className="inline-block mt-3 px-4 py-2 bg-ink text-white rounded-cta text-button">{cta.label}</a>
          : <button onClick={cta.onClick} className="inline-block mt-3 px-4 py-2 bg-ink text-white rounded-cta text-button">{cta.label}</button>
      )}
    </div>
  )
}
