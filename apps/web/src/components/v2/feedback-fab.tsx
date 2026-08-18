/**
 * 全局悬浮反馈按钮（可拖动，位置保存在当前浏览器）
 * 登录 / 申请 / 邀请 / 企微中转 / 反馈提交页 不显示
 * 点击跳 /v2/feedback/new, 并把来源页面带过去做上下文快照
 */
'use client'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

const HIDE_PREFIXES = ['/v2/login', '/v2/apply', '/v2/invite/', '/v2/wecom-bridge', '/v2/feedback/new']
const STORAGE_KEY = 'dianjie:feedback-fab-position'
const EDGE_GAP = 8
const DEFAULT_RIGHT = 16
const DEFAULT_BOTTOM = 96
const DRAG_THRESHOLD = 6

type Position = { x: number; y: number }

export function clampFeedbackPosition(
  position: Position,
  viewport: { width: number; height: number },
  button: { width: number; height: number },
): Position {
  return {
    x: Math.min(Math.max(position.x, EDGE_GAP), Math.max(EDGE_GAP, viewport.width - button.width - EDGE_GAP)),
    y: Math.min(Math.max(position.y, EDGE_GAP), Math.max(EDGE_GAP, viewport.height - button.height - EDGE_GAP)),
  }
}

function readSavedPosition(): Position | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
    return Number.isFinite(value?.x) && Number.isFinite(value?.y)
      ? { x: Number(value.x), y: Number(value.y) }
      : null
  } catch {
    return null
  }
}

function savePosition(position: Position) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(position))
  } catch {
    // Private browsing/storage denial must not hide the feedback entry.
  }
}

export function FeedbackFab() {
  const pathname = usePathname() || ''
  const buttonRef = useRef<HTMLAnchorElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: Position
    dragged: boolean
    current: Position
  } | null>(null)
  const suppressClickRef = useRef(false)
  const [position, setPosition] = useState<Position | null>(null)

  useEffect(() => {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const saved = readSavedPosition()
    const initial = saved || {
      x: window.innerWidth - rect.width - DEFAULT_RIGHT,
      y: window.innerHeight - rect.height - DEFAULT_BOTTOM,
    }
    setPosition(clampFeedbackPosition(
      initial,
      { width: window.innerWidth, height: window.innerHeight },
      { width: rect.width, height: rect.height },
    ))

    const handleResize = () => {
      const currentButton = buttonRef.current
      if (!currentButton) return
      const currentRect = currentButton.getBoundingClientRect()
      setPosition((current) => {
        if (!current) return current
        const next = clampFeedbackPosition(
          current,
          { width: window.innerWidth, height: window.innerHeight },
          { width: currentRect.width, height: currentRect.height },
        )
        savePosition(next)
        return next
      })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [pathname])

  if (HIDE_PREFIXES.some((p) => pathname.startsWith(p))) return null
  return (
    <a
      ref={buttonRef}
      href={`/v2/feedback/new?from=${encodeURIComponent(pathname)}`}
      aria-label="提交反馈，可拖动调整位置"
      title="点击提交反馈，拖动可调整位置"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const rect = event.currentTarget.getBoundingClientRect()
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          origin: position || { x: rect.left, y: rect.top },
          dragged: false,
          current: position || { x: rect.left, y: rect.top },
        }
        suppressClickRef.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        const deltaX = event.clientX - drag.startX
        const deltaY = event.clientY - drag.startY
        if (!drag.dragged && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return
        drag.dragged = true
        const rect = event.currentTarget.getBoundingClientRect()
        drag.current = clampFeedbackPosition(
          { x: drag.origin.x + deltaX, y: drag.origin.y + deltaY },
          { width: window.innerWidth, height: window.innerHeight },
          { width: rect.width, height: rect.height },
        )
        setPosition(drag.current)
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (drag.dragged) {
          suppressClickRef.current = true
          savePosition(drag.current)
        }
        dragRef.current = null
      }}
      onPointerCancel={() => { dragRef.current = null }}
      onClick={(event) => {
        if (!suppressClickRef.current) return
        event.preventDefault()
        suppressClickRef.current = false
      }}
      style={position ? { left: position.x, top: position.y, touchAction: 'none' } : undefined}
      className={`fixed z-50 flex select-none items-center gap-1.5 rounded-full bg-ink py-2.5 pl-3 pr-3.5 text-button text-white shadow-lg ${
        position ? '' : 'right-4 bottom-24'
      }`}
    >
      <span aria-hidden>✉</span>
      反馈
    </a>
  )
}
