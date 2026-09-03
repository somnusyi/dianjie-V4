'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Horizontal table viewport used only by the order-center query pages.
 * The bottom range control stays visible even when the current viewport does
 * not overflow, and mirrors native horizontal scrolling in both directions.
 */
export function OrderCenterHorizontalTable({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(0)
  const [maximum, setMaximum] = useState(0)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const measure = () => {
      const nextMaximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      setMaximum(nextMaximum)
      setPosition(Math.min(viewport.scrollLeft, nextMaximum))
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(viewport)
    if (viewport.firstElementChild) observer?.observe(viewport.firstElementChild)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [children])

  return (
    <div>
      <div
        ref={viewportRef}
        onScroll={event => setPosition(event.currentTarget.scrollLeft)}
        className="overflow-x-auto overscroll-x-contain"
      >
        {children}
      </div>
      <div className="border-t border-border bg-bg/80 px-4 py-3">
        <div className="mb-1.5 flex items-center justify-between text-micro text-gray3">
          <span>左右拖动查看完整表格</span>
          <span className="font-num">{maximum > 0 ? `${Math.round(position / maximum * 100)}%` : '完整显示'}</span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(1, maximum)}
          step={1}
          value={maximum > 0 ? position : 0}
          disabled={maximum === 0}
          onChange={event => {
            const next = Number(event.target.value)
            setPosition(next)
            viewportRef.current?.scrollTo({ left: next, behavior: 'auto' })
          }}
          aria-label="横向拖动查看完整表格"
          className="block h-3 w-full cursor-ew-resize touch-pan-x accent-ink disabled:cursor-default disabled:opacity-40"
        />
      </div>
    </div>
  )
}
