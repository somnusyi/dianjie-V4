'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'

const MINIMUM_THUMB_WIDTH = 44

type ScrollMetrics = {
  maximum: number
  position: number
  thumbOffset: number
  thumbWidth: number
}

const EMPTY_METRICS: ScrollMetrics = {
  maximum: 0,
  position: 0,
  thumbOffset: 0,
  thumbWidth: 0,
}

function clamp(value: number, maximum: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), maximum)
}

function calculateMetrics(viewport: HTMLDivElement, track: HTMLDivElement): ScrollMetrics {
  const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
  const position = clamp(viewport.scrollLeft, maximum)
  const trackWidth = Math.max(0, track.clientWidth)
  const visibleRatio = viewport.scrollWidth > 0
    ? Math.min(1, viewport.clientWidth / viewport.scrollWidth)
    : 1
  const thumbWidth = maximum > 0
    ? Math.min(trackWidth, Math.max(MINIMUM_THUMB_WIDTH, trackWidth * visibleRatio))
    : trackWidth
  const travel = Math.max(0, trackWidth - thumbWidth)
  const thumbOffset = maximum > 0 ? travel * position / maximum : 0

  return { maximum, position, thumbOffset, thumbWidth }
}

function sameMetrics(left: ScrollMetrics, right: ScrollMetrics) {
  return left.maximum === right.maximum
    && left.position === right.position
    && left.thumbOffset === right.thumbOffset
    && left.thumbWidth === right.thumbWidth
}

/**
 * A permanently visible, conventional track-and-thumb scrollbar for the wide
 * order-centre tables. The real scrolling viewport remains responsible for
 * wheel and touch scrolling; this visual scrollbar mirrors that native state
 * without relying on macOS's auto-hiding system scrollbar.
 */
export function OrderCenterHorizontalTable({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startClientX: number; startScrollLeft: number } | null>(null)
  const viewportId = useId()
  const [metrics, setMetrics] = useState<ScrollMetrics>(EMPTY_METRICS)

  const measure = useCallback(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track) return

    const next = calculateMetrics(viewport, track)
    if (viewport.scrollLeft !== next.position) viewport.scrollLeft = next.position
    setMetrics(current => sameMetrics(current, next) ? current : next)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track) return

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(viewport)
    observer?.observe(track)
    if (viewport.firstElementChild) observer?.observe(viewport.firstElementChild)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [children, measure])

  const moveTo = useCallback((nextPosition: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    viewport.scrollLeft = clamp(nextPosition, maximum)
    measure()
  }, [measure])

  const handleTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const track = trackRef.current
    if (!track || metrics.maximum <= 0) return

    event.preventDefault()
    const bounds = track.getBoundingClientRect()
    const travel = Math.max(0, track.clientWidth - metrics.thumbWidth)
    if (travel <= 0) return
    const desiredOffset = clamp(event.clientX - bounds.left - metrics.thumbWidth / 2, travel)
    moveTo(desiredOffset / travel * metrics.maximum)
  }

  const handleThumbPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (metrics.maximum <= 0) return

    event.preventDefault()
    event.stopPropagation()
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startScrollLeft: metrics.position,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handleThumbPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const track = trackRef.current
    if (!drag || drag.pointerId !== event.pointerId || !track) return

    event.preventDefault()
    const travel = Math.max(0, track.clientWidth - metrics.thumbWidth)
    if (travel <= 0) return
    moveTo(drag.startScrollLeft + (event.clientX - drag.startClientX) / travel * metrics.maximum)
  }

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    if (!viewport || metrics.maximum <= 0) return

    const smallStep = Math.max(40, viewport.clientWidth * 0.1)
    const largeStep = Math.max(80, viewport.clientWidth * 0.8)
    let nextPosition: number | null = null
    if (event.key === 'ArrowLeft') nextPosition = metrics.position - smallStep
    if (event.key === 'ArrowRight') nextPosition = metrics.position + smallStep
    if (event.key === 'PageUp') nextPosition = metrics.position - largeStep
    if (event.key === 'PageDown') nextPosition = metrics.position + largeStep
    if (event.key === 'Home') nextPosition = 0
    if (event.key === 'End') nextPosition = metrics.maximum
    if (nextPosition === null) return

    event.preventDefault()
    moveTo(nextPosition)
  }

  const canScroll = metrics.maximum > 0

  return (
    <div className="relative min-w-0">
      <div
        id={viewportId}
        ref={viewportRef}
        onScroll={measure}
        className="overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      <div className="sticky bottom-0 z-10 border-t border-border bg-white px-3 py-2">
        <div
          ref={trackRef}
          role="scrollbar"
          aria-label="横向滚动表格"
          aria-controls={viewportId}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(metrics.maximum)}
          aria-valuenow={Math.round(metrics.position)}
          aria-disabled={!canScroll}
          tabIndex={canScroll ? 0 : -1}
          onPointerDown={handleTrackPointerDown}
          onKeyDown={handleKeyDown}
          className={`relative h-3 w-full select-none rounded-full bg-gray5/80 outline-none ring-accent/30 focus-visible:ring-2 ${canScroll ? 'cursor-pointer touch-none' : 'cursor-default'}`}
        >
          <div
            data-scrollbar-thumb=""
            onPointerDown={handleThumbPointerDown}
            onPointerMove={handleThumbPointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onLostPointerCapture={() => { dragRef.current = null }}
            className={`absolute inset-y-0 left-0 rounded-full bg-gray3 shadow-sm transition-colors hover:bg-gray2 ${canScroll ? 'cursor-grab active:cursor-grabbing' : 'cursor-default opacity-70'}`}
            style={{
              width: metrics.thumbWidth || '100%',
              transform: `translate3d(${metrics.thumbOffset}px, 0, 0)`,
            }}
          />
        </div>
      </div>
    </div>
  )
}
