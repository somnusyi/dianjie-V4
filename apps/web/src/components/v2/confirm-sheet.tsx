/**
 * ConfirmSheet · 替代 window.confirm / window.prompt 的底部 Sheet
 *
 * 为什么不用 window.confirm:
 *  - native dialog 在 Capacitor / WebView 里阻塞主线程, headless 环境直接卡死
 *  - 视觉风格与产品脱节（系统弹窗）
 *  - 移动端用户大概率会下意识忽略
 *
 * 用法 (受控):
 *   const [confirm, openConfirm] = useConfirmSheet()
 *   openConfirm({ title, body, confirmLabel, tone, onConfirm, withInput })
 *   <ConfirmSheet {...confirm} />
 */
'use client'
import React, { useCallback, useState, ReactNode } from 'react'

export type ConfirmSheetState = {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 'danger' = 红 / 'primary' = 柿色 / 'default' = 墨褐 */
  tone?: 'default' | 'primary' | 'danger'
  /** withInput=true 时显示文本框, onConfirm 收到 inputValue */
  withInput?: boolean
  inputPlaceholder?: string
  inputRequired?: boolean
  onConfirm?: (inputValue?: string) => void | Promise<void>
  onCancel?: () => void
}

type OpenOptions = Omit<ConfirmSheetState, 'open'>

export function useConfirmSheet(): [ConfirmSheetState & { close: () => void }, (opts: OpenOptions) => void] {
  const [state, setState] = useState<ConfirmSheetState>({ open: false, title: '' })
  const open = useCallback((opts: OpenOptions) => setState({ ...opts, open: true }), [])
  const close = useCallback(() => setState(s => ({ ...s, open: false })), [])
  return [{ ...state, close }, open]
}

export function ConfirmSheet(props: ConfirmSheetState & { close: () => void }) {
  const {
    open, title, body, confirmLabel = '确认', cancelLabel = '取消',
    tone = 'default', withInput, inputPlaceholder, inputRequired,
    onConfirm, onCancel, close,
  } = props
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  // open 关闭时 reset
  React.useEffect(() => { if (!open) { setVal(''); setBusy(false) } }, [open])

  if (!open) return null

  const handleConfirm = async () => {
    if (withInput && inputRequired && !val.trim()) return
    try {
      setBusy(true)
      await onConfirm?.(withInput ? val.trim() : undefined)
      close()
    } catch (e: any) {
      // 错误展示交给调用方（onConfirm 内 throw 时停留）
      setBusy(false)
    }
  }
  const handleCancel = () => {
    onCancel?.()
    close()
  }

  const confirmCls =
    tone === 'danger' ? 'bg-red text-white' :
    tone === 'primary' ? 'bg-accent text-white' :
    'bg-ink text-white'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40"
      onClick={handleCancel}
    >
      <div
        className="bg-bg-card w-full max-w-md rounded-t-2xl p-5 pb-7"
        style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />
        <h3 className="text-h2 text-ink">{title}</h3>
        {body && <div className="mt-2 text-caption text-gray2 whitespace-pre-line">{body}</div>}
        {withInput && (
          <textarea
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={inputPlaceholder || '请输入'}
            rows={3}
            className="mt-3 w-full bg-bg border border-border rounded-cta p-2 text-body text-ink placeholder:text-gray3 focus:outline-none focus:border-accent"
          />
        )}
        <div className="grid grid-cols-2 gap-2 mt-5">
          <button
            onClick={handleCancel}
            disabled={busy}
            className="py-3 rounded-cta text-button bg-white border border-border text-gray2 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy || (withInput && inputRequired && !val.trim())}
            className={`py-3 rounded-cta text-button ${confirmCls} disabled:opacity-50`}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
