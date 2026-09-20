'use client'

/**
 * UAT 灰度专用：页面批注层（图钉 + 涂鸦）
 *
 * - 一个页面一个共享图层：pageKey=当前路由，同页所有白名单账号看到同一份批注
 * - 业务页面零改动：组件只挂在 /v2 布局，视图经 portal 挂到 body 文档坐标
 * - 不在批注模式时整层穿透点击，页面照常操作；图钉只有小点本身可点
 * - 白名单由服务端控制（/config 404 即本账号无此功能，前端整体不渲染）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { apiFetch, getToken } from '@/lib/v2-auth'

type Annotation = {
  id: string
  kind: 'PIN' | 'STROKE'
  payload: { text?: string; x?: number; y?: number; points?: Array<[number, number]>; width?: number }
  authorId: string
  authorName: string
  authorPhone: string
  createdAt: string
  mine: boolean
  deletable: boolean
}

const RED = '#dc2626'
const DOT = 14

function ssGet(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback
  const raw = window.sessionStorage.getItem(key)
  return raw === null ? fallback : raw === '1'
}
function ssSet(key: string, value: boolean) {
  if (typeof window !== 'undefined') window.sessionStorage.setItem(key, value ? '1' : '0')
}

export function AnnotationLayer() {
  const pathname = usePathname() || '/'
  const [mounted, setMounted] = useState(false)
  const [config, setConfig] = useState<{ admin: boolean } | null>(null)
  const [items, setItems] = useState<Annotation[]>([])
  const [mode, setMode] = useState<null | 'pin' | 'draw'>(null)
  const [visible, setVisible] = useState(() => ssGet('anno.visible', true))
  const [closed, setClosed] = useState(() => ssGet('anno.closed', false))
  const [docSize, setDocSize] = useState({ w: 0, h: 0 })
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null)
  const [draftText, setDraftText] = useState('')
  const [viewId, setViewId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [busy, setBusy] = useState(false)
  const [bar, setBar] = useState<{ x: number; y: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef<Array<[number, number]> | null>(null)
  const lastKeyBRef = useRef(0)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  const pageKey = pathname.split('?')[0] || '/'

  /* ── 初始化：探测本账号是否有批注功能（白名单外 404 → 整体不渲染）── */
  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    if (!mounted) return
    let alive = true
    apiFetch<{ enabled: boolean; admin: boolean }>('/api/page-annotations/config')
      .then(data => { if (alive && data?.enabled) setConfig({ admin: !!data.admin }) })
      .catch(() => { /* 无此功能或未登录：保持 null，页面完全不受影响 */ })
    return () => { alive = false }
  }, [mounted])

  /* ── 换页面 = 换图层：加载当前页共享批注；15s 轮询让同页其他人新增的批注自动出现 ── */
  const load = useCallback(() => {
    apiFetch<Annotation[]>(`/api/page-annotations?pageKey=${encodeURIComponent(pageKey)}`)
      .then(rows => setItems(Array.isArray(rows) ? rows : []))
      .catch(() => setItems([]))
  }, [pageKey])
  useEffect(() => {
    if (!config) return
    load()
    const timer = window.setInterval(() => {
      if (!drawingRef.current) load() // 正在落笔时跳过本轮，避免画布闪动
    }, 15000)
    return () => window.clearInterval(timer)
  }, [config, load])

  /* ── 文档尺寸：涂鸦画布铺满整页并跟随滚动 ── */
  useEffect(() => {
    if (!config) return
    const measure = () => {
      const el = document.documentElement
      setDocSize({ w: el.scrollWidth, h: el.scrollHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    const timer = window.setInterval(measure, 1500) // 页面内容动态增高时兜底
    return () => { window.removeEventListener('resize', measure); window.clearInterval(timer) }
  }, [config])

  /* ── 涂鸦渲染：已有笔迹 + 正在画的一笔 ── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !docSize.w) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = docSize.w * dpr
    canvas.height = docSize.h * dpr
    canvas.style.width = `${docSize.w}px`
    canvas.style.height = `${docSize.h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = RED
    const drawStroke = (points: Array<[number, number]>, width: number) => {
      if (points.length < 2) return
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(points[0][0], points[0][1])
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1])
      ctx.stroke()
    }
    for (const item of items) {
      if (item.kind === 'STROKE' && item.payload?.points) {
        drawStroke(item.payload.points, item.payload.width || 3)
      }
    }
    if (drawingRef.current) drawStroke(drawingRef.current, 3)
  }, [items, docSize, mode])

  /* ── 双击 B 唤回 / Esc 退出模式 ── */
  useEffect(() => {
    if (!config) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) return
      if (event.key === 'Escape') { setMode(null); setDraft(null); setViewId(null); return }
      if (event.key === 'b' || event.key === 'B') {
        const now = Date.now()
        if (now - lastKeyBRef.current < 500) { setClosed(false); ssSet('anno.closed', false) }
        lastKeyBRef.current = now
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [config])

  /* ── 画笔：pointer 事件统一鼠标/触摸，坐标为文档坐标（跟随滚动）── */
  const pagePoint = (event: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return [event.clientX + window.scrollX, event.clientY + window.scrollY]
    return [event.clientX - rect.left, event.clientY - rect.top]
  }
  const onCanvasDown = (event: React.PointerEvent) => {
    if (mode !== 'draw' || drawingRef.current) return
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
    drawingRef.current = [pagePoint(event)]
  }
  const onCanvasMove = (event: React.PointerEvent) => {
    if (mode !== 'draw' || !drawingRef.current) return
    drawingRef.current.push(pagePoint(event))
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas && ctx) {
      const pts = drawingRef.current
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const last = pts[pts.length - 1]
      const prev = pts[pts.length - 2] || last
      ctx.lineCap = 'round'
      ctx.strokeStyle = RED
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(prev[0], prev[1])
      ctx.lineTo(last[0], last[1])
      ctx.stroke()
    }
  }
  const onCanvasUp = async () => {
    const points = drawingRef.current
    drawingRef.current = null
    if (!points || points.length < 2) return
    setBusy(true)
    try {
      const row = await apiFetch<Annotation>('/api/page-annotations', {
        method: 'POST',
        body: JSON.stringify({ pageKey, kind: 'STROKE', payload: { points, width: 3 } }),
      })
      setItems(current => [...current, row])
    } catch { /* 保存失败：擦掉这一笔 */ load() }
    finally { setBusy(false) }
  }

  /* ── 图钉：落点 → 小输入框 → 保存 ── */
  const onPatcherClick = (event: React.MouseEvent) => {
    setDraft({ x: event.pageX, y: event.pageY })
    setDraftText('')
  }
  const saveDraft = async () => {
    const text = draftText.trim()
    if (!draft || !text) return
    setBusy(true)
    try {
      const row = await apiFetch<Annotation>('/api/page-annotations', {
        method: 'POST',
        body: JSON.stringify({ pageKey, kind: 'PIN', payload: { text, x: draft.x, y: draft.y } }),
      })
      setItems(current => [...current, row])
      setDraft(null); setDraftText(''); setMode(null)
    } catch (reason: any) { window.alert(reason?.message || '保存失败，请重试') }
    finally { setBusy(false) }
  }

  /* ── 删除（作者删自己的；管理员可删任意）/ 撤销上一笔 ── */
  const removeItem = async (id: string) => {
    setBusy(true)
    try {
      await apiFetch(`/api/page-annotations/${id}`, { method: 'DELETE' })
      setItems(current => current.filter(item => item.id !== id))
      setViewId(null)
    } catch (reason: any) { window.alert(reason?.message || '删除失败') }
    finally { setBusy(false) }
  }
  const undoLastStroke = async () => {
    const target = [...items].reverse().find(item => item.kind === 'STROKE' && item.deletable)
    if (target) await removeItem(target.id)
  }

  /* ── 图钉文字编辑（仅作者）── */
  const saveEdit = async (id: string) => {
    const text = editText.trim()
    if (!text) return
    const row = items.find(item => item.id === id)
    if (!row?.payload) return
    setBusy(true)
    try {
      const updated = await apiFetch<Annotation>(`/api/page-annotations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ payload: { text, x: row.payload.x, y: row.payload.y } }),
      })
      setItems(current => current.map(item => (item.id === id ? updated : item)))
      setViewId(null)
    } catch (reason: any) { window.alert(reason?.message || '保存失败') }
    finally { setBusy(false) }
  }

  /* ── 管理员导出：按页面分组的 Markdown ── */
  const exportMarkdown = async () => {
    try {
      const token = getToken()
      const res = await fetch('/api/page-annotations/export', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      if (!res.ok) throw new Error('导出失败')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `页面批注清单-${new Date().toISOString().slice(0, 10)}.md`
      link.click()
      URL.revokeObjectURL(url)
    } catch (reason: any) { window.alert(reason?.message || '导出失败') }
  }

  /* ── 工具条拖动（贴边跟随，桌面/手机一致）── */
  const onBarDragStart = (event: React.PointerEvent) => {
    const rect = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }
  const onBarDragMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return
    const x = Math.min(Math.max(event.clientX - dragRef.current.dx, 4), window.innerWidth - 60)
    const y = Math.min(Math.max(event.clientY - dragRef.current.dy, 4), window.innerHeight - 60)
    setBar({ x, y })
  }

  /* ── 显/隐：显示时可增删改；隐藏时锁定（退出模式、按钮置灰），页面回到原生状态 ── */
  const toggleVisible = () => {
    const next = !visible
    setVisible(next)
    ssSet('anno.visible', next)
    if (!next) { setMode(null); setDraft(null); setViewId(null) }
  }

  if (!mounted || !config || closed) return null

  const barStyle = bar ? { left: bar.x, top: bar.y } : undefined
  const popoverLeft = (x: number) => Math.max(8, Math.min(x, docSize.w - 280))
  const viewItem = items.find(item => item.id === viewId && item.kind === 'PIN') || null

  return createPortal(
    <>
      {/* 共享图层：一个页面一层，默认整层穿透 */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: docSize.w || '100%', height: docSize.h || '100%', zIndex: 35, pointerEvents: 'none', display: visible ? undefined : 'none' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onCanvasDown}
          onPointerMove={onCanvasMove}
          onPointerUp={onCanvasUp}
          onPointerCancel={onCanvasUp}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: mode === 'draw' ? 'auto' : 'none', touchAction: 'none', cursor: 'crosshair' }}
        />
        {mode === 'pin' && (
          <div
            onClick={onPatcherClick}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: 'copy' }}
          />
        )}
        {/* 图钉：只有小点本身可点 */}
        {!draft && mode !== 'pin' && items.filter(item => item.kind === 'PIN' && item.payload?.x != null).map(item => (
          <button
            key={item.id}
            onClick={() => { setViewId(viewId === item.id ? null : item.id); setEditText(item.payload?.text || '') }}
            style={{ position: 'absolute', left: (item.payload?.x || 0) - DOT / 2, top: (item.payload?.y || 0) - DOT / 2, width: DOT, height: DOT, borderRadius: '50%', background: RED, border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.35)', pointerEvents: 'auto', cursor: 'pointer', zIndex: 2 }}
            aria-label="批注图钉"
          />
        ))}
        {/* 落点输入框 */}
        {draft && (
          <div style={{ position: 'absolute', left: popoverLeft(draft.x), top: draft.y + 12, width: 264, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.18)', padding: 10, pointerEvents: 'auto', zIndex: 3 }}>
            <textarea
              autoFocus
              value={draftText}
              onChange={event => setDraftText(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void saveDraft() }}
              placeholder="写点什么…（Ctrl/⌘+Enter 保存）"
              style={{ width: '100%', minHeight: 64, border: '1px solid #ddd6c9', borderRadius: 8, padding: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button onClick={() => { setDraft(null); setMode(null) }} style={ghostBtn}>取消</button>
              <button onClick={() => void saveDraft()} disabled={busy || !draftText.trim()} style={mainBtn}>保存</button>
            </div>
          </div>
        )}
        {/* 图钉查看 / 编辑 / 删除 */}
        {viewItem && (
          <div style={{ position: 'absolute', left: popoverLeft(viewItem.payload?.x || 0), top: (viewItem.payload?.y || 0) + 16, width: 264, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.18)', padding: 10, pointerEvents: 'auto', zIndex: 3 }}>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>
              {viewItem.authorName} · {new Date(viewItem.createdAt).toLocaleString('zh-CN')}{viewItem.mine ? ' · 我' : ''}
            </div>
            <textarea
              value={editText}
              onChange={event => setEditText(event.target.value)}
              disabled={!viewItem.mine}
              style={{ width: '100%', minHeight: 56, border: '1px solid #ddd6c9', borderRadius: 8, padding: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              {viewItem.deletable && <button onClick={() => void removeItem(viewItem.id)} style={{ ...ghostBtn, color: '#dc2626', borderColor: '#fecaca' }}>删除</button>}
              {viewItem.mine && <button onClick={() => void saveEdit(viewItem.id)} disabled={busy} style={mainBtn}>保存修改</button>}
              <button onClick={() => setViewId(null)} style={ghostBtn}>关闭</button>
            </div>
          </div>
        )}
      </div>

      {/* 批注模式提示条 */}
      {mode && (
        <div style={{ position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 46, background: '#111827', color: '#fff', borderRadius: 999, padding: '6px 14px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 4px 12px rgba(0,0,0,.25)' }}>
          <span>批注模式中：{mode === 'pin' ? '点页面放图钉' : '直接在页面上画'}</span>
          {mode === 'draw' && <button onClick={() => void undoLastStroke()} disabled={busy} style={{ background: 'transparent', color: '#fbbf24', border: 'none', fontSize: 13, cursor: 'pointer' }}>撤销上一笔</button>}
          <button onClick={() => { setMode(null); setDraft(null) }} style={{ background: 'transparent', color: '#fff', border: '1px solid #4b5563', borderRadius: 6, fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}>退出</button>
        </div>
      )}

      {/* 悬浮工具条 */}
      <div style={{ position: 'fixed', right: bar ? undefined : 16, bottom: bar ? undefined : 88, zIndex: 45, ...barStyle, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, boxShadow: '0 6px 20px rgba(0,0,0,.16)', padding: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
        <div
          onPointerDown={onBarDragStart}
          onPointerMove={onBarDragMove}
          onPointerUp={() => { dragRef.current = null }}
          style={{ cursor: 'grab', padding: '8px 4px', color: '#c4b5a0', fontSize: 12, userSelect: 'none', touchAction: 'none' }}
          aria-label="拖动工具条"
        >
          ⠿
        </div>
        <ToolButton active={mode === 'pin'} disabled={!visible} title="图钉：点页面任意位置写批注" onClick={() => { setMode(mode === 'pin' ? null : 'pin'); setDraft(null); setViewId(null) }}>📌</ToolButton>
        <ToolButton active={mode === 'draw'} disabled={!visible} title="涂鸦：在页面上圈画（红笔）" onClick={() => { setMode(mode === 'draw' ? null : 'draw'); setDraft(null); setViewId(null) }}>✏️</ToolButton>
        <button
          onClick={toggleVisible}
          title={visible ? '隐藏后页面恢复原样，且不能增删改批注' : '恢复显示本页全部批注'}
          style={{
            height: 40, padding: '0 12px', borderRadius: 12, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
            border: visible ? '1px solid #e5e7eb' : '1.5px solid #dc2626',
            background: visible ? '#f9fafb' : '#fef2f2',
            color: visible ? '#374151' : '#dc2626',
          }}
        >{visible ? '隐藏批注' : '显示批注'}</button>
        {config.admin && <ToolButton title="导出全部页面批注清单（Markdown）" onClick={() => void exportMarkdown()}>⬇️</ToolButton>}
        <ToolButton title="关闭工具条（连按两次 B 唤回）" onClick={() => { setClosed(true); ssSet('anno.closed', true) }}>✕</ToolButton>
      </div>
    </>,
    document.body,
  )
}

function ToolButton({ children, title, active, disabled, onClick }: { children: React.ReactNode; title: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        width: 40, height: 40, borderRadius: 12, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 17,
        background: active ? '#fef2f2' : 'transparent', boxShadow: active ? 'inset 0 0 0 2px #dc2626' : undefined,
        opacity: disabled ? 0.35 : 1,
      }}
    >{children}</button>
  )
}

const mainBtn: React.CSSProperties = {
  background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer',
}
const ghostBtn: React.CSSProperties = {
  background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer',
}
