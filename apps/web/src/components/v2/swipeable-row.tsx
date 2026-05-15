/**
 * 左滑露出动作按钮 (iOS 风格 swipe-to-action)
 *
 * 用法:
 *   <SwipeableRow onAction={() => del(a)} actionLabel="停用">
 *     <YourCard />
 *   </SwipeableRow>
 *
 * 手势:
 *   左滑 ≥ 阈值 → 吸附到 actionWidth 露出按钮
 *   右滑或点其他地方 → 归零
 *   桌面端用 pointer events 同样支持鼠标拖
 *
 * 设计:
 *   - 拖动中禁用 transition (跟手), 释放后启用 (snap 动画)
 *   - touchAction='pan-y' 让纵向滚动不被劫持
 *   - 子内容里的 button 仍能正常点击 (拖动距离 < 5px 视为 tap, 不 swipe)
 */
'use client'
import { useEffect, useRef, useState } from 'react'

type Props = {
  children:     React.ReactNode
  onAction:     () => void
  actionLabel?: string       // 默认 "停用"
  actionWidth?: number       // 默认 80 (px)
  actionColor?: string       // tailwind bg 类, 默认 'bg-red'
}

export function SwipeableRow({
  children, onAction, actionLabel = '停用', actionWidth = 80, actionColor = 'bg-red',
}: Props) {
  const [offset, setOffset] = useState(0)
  const dragState = useRef<{ startX: number; startOffset: number; moved: boolean } | null>(null)
  const [animating, setAnimating] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  // 点其他地方归零
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (offset !== 0 && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setAnimating(true); setOffset(0)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('touchstart', onDocClick as any)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('touchstart', onDocClick as any)
    }
  }, [offset])

  function onPointerDown(e: React.PointerEvent) {
    // 子元素是按钮/输入等可交互元素时, 不启动 swipe 拖动
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, select, textarea, label')) return
    dragState.current = { startX: e.clientX, startOffset: offset, moved: false }
    setAnimating(false)
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragState.current) return
    const dx = e.clientX - dragState.current.startX
    if (Math.abs(dx) > 5) dragState.current.moved = true
    const next = Math.max(-actionWidth, Math.min(0, dragState.current.startOffset + dx))
    setOffset(next)
  }
  function onPointerEnd() {
    if (!dragState.current) return
    const wasMoved = dragState.current.moved
    dragState.current = null
    setAnimating(true)
    if (!wasMoved) return                  // 视作 tap, 不动
    // 吸附: 露出 > 半就完全露, 否则归零
    setOffset(offset < -actionWidth / 2 ? -actionWidth : 0)
  }

  function handleAction() {
    onAction()
    setAnimating(true); setOffset(0)
  }

  return (
    <div ref={containerRef} className="relative overflow-hidden rounded-card">
      {/* 底部右侧动作按钮 (固定位置, 卡片滑开时露出) */}
      <button
        type="button"
        onClick={handleAction}
        className={`absolute top-0 right-0 bottom-0 ${actionColor} text-white text-button flex items-center justify-center`}
        style={{ width: actionWidth }}
      >
        {actionLabel}
      </button>

      {/* 卡片内容 (拖动主体) */}
      <div
        className="relative"
        style={{
          transform: `translateX(${offset}px)`,
          transition: animating ? 'transform 200ms ease-out' : 'none',
          touchAction: 'pan-y',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {children}
      </div>
    </div>
  )
}
