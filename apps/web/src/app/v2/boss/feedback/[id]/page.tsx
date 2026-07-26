/**
 * 超管/老板 · 反馈审批详情: 完整对话 (只读) + AI 方案 + 批准/驳回
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { categoryBadge, statusBadge } from '@/app/v2/feedback/feedback-shared'

type Msg = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string }
type Detail = {
  id: string
  status: string
  category: string | null
  title: string | null
  summary: string | null
  proposal: { scenario?: string; expectation?: string; estimatedDays?: string | number } | null
  attachments: string[] | null
  decisionNote: string | null
  reporter: { id: string; name: string; role: string }
  messages: Msg[]
}

export default function BossFeedbackDetailPage() {
  const params = useParams()
  const id = String(params.id)
  const [fb, setFb] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [rejectNote, setRejectNote] = useState('')
  const [resolveNote, setResolveNote] = useState('')
  const [acting, setActing] = useState(false)
  const [confirmState, openConfirm] = useConfirmSheet()

  useEffect(() => {
    apiFetch<Detail>(`/api/feedback/${id}`)
      .then(setFb)
      .catch((e) => setError(e.message || '加载失败'))
  }, [id])

  async function decide(action: 'approve' | 'reject', note?: string) {
    setActing(true)
    try {
      await apiFetch(`/api/feedback/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify(note ? { action, note } : { action }),
      })
      location.href = '/v2/boss/feedback'
    } catch (e: any) {
      setError(e.message || '操作失败，请重试')
      setActing(false)
    }
  }

  async function resolveFb(note?: string) {
    setActing(true)
    try {
      await apiFetch(`/api/feedback/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify(note ? { note } : {}),
      })
      location.href = '/v2/boss/feedback'
    } catch (e: any) {
      setError(e.message || '操作失败，请重试')
      setActing(false)
    }
  }

  function onResolve() {
    openConfirm({
      title: '标记该反馈已解决?',
      body: '标记后反馈闭环，提报人会在消息中心收到「已解决」通知。',
      confirmLabel: '标记已解决',
      onConfirm: () => resolveFb(resolveNote.trim() || undefined),
    })
  }

  function onApprove() {
    openConfirm({
      title: '批准该方案?',
      body: '批准后反馈进入「开发中」状态，提报人会在消息中心收到通知。',
      confirmLabel: '批准',
      onConfirm: () => decide('approve'),
    })
  }

  function onReject() {
    if (!rejectNote.trim()) { setError('驳回时请填写理由'); return }
    openConfirm({
      title: '驳回该反馈?',
      body: `理由：${rejectNote.trim()}`,
      confirmLabel: '驳回',
      tone: 'danger',
      onConfirm: () => decide('reject', rejectNote.trim()),
    })
  }

  if (error && !fb) {
    return (
      <div className="min-h-screen bg-bg px-4 pt-4">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="text-caption text-red-fg mt-4">{error}</div>
      </div>
    )
  }
  if (!fb) return <div className="min-h-screen bg-bg flex items-center justify-center"><span className="text-caption text-gray3">加载中…</span></div>

  const cat = categoryBadge(fb.category)
  const st = statusBadge(fb.status)
  const pending = fb.status === 'AWAITING_APPROVAL'
  const resolvable = ['CLARIFYING', 'IN_DEV'].includes(fb.status)

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3 border-b border-border">
        <button onClick={() => { location.href = '/v2/boss/feedback' }} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center shrink-0">‹</button>
        <div className="flex-1 min-w-0">
          <h1 className="text-h2 truncate">{fb.title || '反馈详情'}</h1>
          <p className="text-caption text-gray3 mt-0.5">{fb.reporter?.name} 提出 · {cat.icon} {cat.label}</p>
        </div>
        <span className={`shrink-0 text-micro px-2 py-1 rounded-full ${st.cls}`}>{st.label}</span>
      </header>

      <div className="px-4 mt-3 space-y-3">
        {/* AI 整理的方案 */}
        {(fb.summary || fb.proposal) && (
          <div className="bg-white rounded-card border border-border p-3">
            <div className="text-caption text-gray3 mb-1">AI 整理的方案</div>
            {fb.summary && <div className="text-body">{fb.summary}</div>}
            {fb.proposal && (
              <ul className="mt-2 space-y-1 text-caption text-gray2">
                {fb.proposal.scenario && <li>· 使用场景：{fb.proposal.scenario}</li>}
                {fb.proposal.expectation && <li>· 期望效果：{fb.proposal.expectation}</li>}
                {fb.proposal.estimatedDays != null && <li>· 初估人天：{String(fb.proposal.estimatedDays)}</li>}
              </ul>
            )}
          </div>
        )}

        {/* 附件 */}
        {Array.isArray(fb.attachments) && fb.attachments.length > 0 && (
          <div className="bg-white rounded-card border border-border p-3">
            <div className="text-caption text-gray3 mb-2">附件截图</div>
            <div className="flex flex-wrap gap-2">
              {fb.attachments.map((url, i) => (
                <a key={i} href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt={`附件${i + 1}`} className="w-20 h-20 object-cover rounded-md border border-border" />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* 完整对话 (只读) */}
        <div className="bg-white rounded-card border border-border p-3">
          <div className="text-caption text-gray3 mb-2">完整对话</div>
          <div className="space-y-2">
            {fb.messages.map((m) => {
              if (m.role === 'system') {
                return (
                  <div key={m.id} className="flex justify-center">
                    <span className="text-micro text-gray3 bg-bg rounded-full px-3 py-1">{m.content}</span>
                  </div>
                )
              }
              const mine = m.role === 'user'
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-3 py-2 rounded-card text-body whitespace-pre-wrap ${
                    mine ? 'bg-ink text-white' : 'bg-bg'
                  }`}>
                    {!mine && <div className="text-micro text-gray3 mb-0.5">AI 助手</div>}
                    {m.content}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 决策结果 */}
        {!pending && fb.decisionNote && (
          <div className="bg-white rounded-card border border-border p-3 text-caption text-gray2">
            驳回理由：{fb.decisionNote}
          </div>
        )}

        {/* 审批操作 */}
        {pending && (
          <div className="bg-white rounded-card border border-border p-3 space-y-2">
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder="驳回理由（驳回时必填）"
              className="w-full text-body bg-bg rounded-cta px-3 py-2 outline-none resize-none placeholder:text-gray3"
            />
            {error && <div className="text-caption text-red-fg">{error}</div>}
            <div className="flex gap-2">
              <button
                onClick={onApprove}
                disabled={acting}
                className="flex-1 py-3 rounded-cta bg-ink text-white text-button disabled:opacity-50"
              >
                批准
              </button>
              <button
                onClick={onReject}
                disabled={acting}
                className="flex-1 py-3 rounded-cta bg-white border border-border text-button text-red-fg disabled:opacity-50"
              >
                驳回
              </button>
            </div>
          </div>
        )}
        {/* 标记已解决 (BUG 沟通中 / 开发中 → 闭环) */}
        {resolvable && (
          <div className="bg-white rounded-card border border-border p-3 space-y-2">
            <textarea
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder="给提报人的解决说明（选填）"
              className="w-full text-body bg-bg rounded-cta px-3 py-2 outline-none resize-none placeholder:text-gray3"
            />
            {error && <div className="text-caption text-red-fg">{error}</div>}
            <button
              onClick={onResolve}
              disabled={acting}
              className="w-full py-3 rounded-cta bg-ink text-white text-button disabled:opacity-50"
            >
              标记已解决
            </button>
          </div>
        )}
      </div>

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
