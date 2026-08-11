/**
 * 反馈对话页: 消息气泡 (用户右/AI 左) + 底部输入栏 + 状态 badge
 * 发送后立即落库; 每 5s 轮询刷新后台 AI 回复和 system 进度消息
 */
'use client'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
import { statusBadge } from '@/app/v2/feedback/feedback-shared'

type Msg = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string }
type Feedback = {
  id: string
  status: string
  category: string | null
  title: string | null
  reporter: { id: string; name: string }
  messages: Msg[]
}

export default function FeedbackChatPage() {
  const params = useParams()
  const id = String(params.id)
  const [fb, setFb] = useState<Feedback | null>(null)
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  async function load() {
    try {
      const data = await apiFetch<Feedback>(`/api/feedback/${id}`)
      setFb(data)
      setError('')
    } catch (e: any) {
      setError(e.message || '加载失败')
    }
  }

  useEffect(() => {
    load()
    // 简单轮询: 每 5s 刷新一次, 拿到审批进度等 system 消息
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [fb?.messages.length])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setInput('')
    try {
      await apiFetch(`/api/feedback/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      })
      await load()
    } catch (e: any) {
      setError(e.message || '发送失败，请重试')
      setInput(text)
    } finally {
      setSending(false)
    }
  }

  const badge = fb ? statusBadge(fb.status) : null
  const closed = fb ? ['REJECTED', 'RESOLVED'].includes(fb.status) : false
  const aiProcessing = fb?.status === 'CLARIFYING'
    && fb.messages.length > 0
    && fb.messages[fb.messages.length - 1]?.role === 'user'

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3 bg-bg sticky top-0 z-10 border-b border-border">
        <button onClick={() => { location.href = '/v2/feedback/mine' }} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center shrink-0">‹</button>
        <div className="flex-1 min-w-0">
          <h1 className="text-h2 truncate">{fb?.title || '反馈详情'}</h1>
        </div>
        {badge && (
          <span className={`shrink-0 text-micro px-2 py-1 rounded-full ${badge.cls}`}>{badge.label}</span>
        )}
      </header>

      <div className="flex-1 px-4 py-3 space-y-3 pb-28">
        {error && <div className="text-caption text-red-fg">{error}</div>}
        {fb?.messages.map((m) => {
          if (m.role === 'system') {
            return (
              <div key={m.id} className="flex justify-center">
                <span className="text-micro text-gray3 bg-white border border-border rounded-full px-3 py-1">
                  {m.content}
                </span>
              </div>
            )
          }
          const mine = m.role === 'user'
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] px-3 py-2 rounded-card text-body whitespace-pre-wrap ${
                mine ? 'bg-ink text-white' : 'bg-white border border-border'
              }`}>
                {!mine && <div className="text-micro text-gray3 mb-0.5">AI 助手</div>}
                {m.content}
              </div>
            </div>
          )
        })}
        {aiProcessing && (
          <div className="flex justify-start">
            <div className="max-w-[80%] px-3 py-2 rounded-card text-body bg-white border border-border text-gray2">
              <div className="text-micro text-gray3 mb-0.5">AI 助手</div>
              正在整理，请稍候…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {!closed && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border px-3 py-2 flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={1}
            maxLength={2000}
            placeholder="补充说明…"
            className="flex-1 text-body bg-bg rounded-cta px-3 py-2 outline-none resize-none placeholder:text-gray3"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="shrink-0 px-4 py-2 rounded-cta bg-ink text-white text-button disabled:opacity-50"
          >
            {sending ? '…' : '发送'}
          </button>
        </div>
      )}
    </div>
  )
}
