/**
 * 超管 · AI 助手聊天: 老板在手机上直接指挥服务器 AI 开发
 * 数据: GET/POST /api/boss-chat/messages, POST /api/boss-chat/deploy/:runId
 * 流程: 发指令 → AI 定位/开发/自测(异步) → 回复改动摘要 → 点「批准部署」→ 安全发布
 */
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

type Msg = {
  id: string
  role: string // user / assistant / system
  content: string
  runId: string | null
  runStatus: string | null
  createdAt: string
}

export default function BossAssistantPage() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [deploying, setDeploying] = useState<string | null>(null)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    apiFetch<{ messages: Msg[] }>('/api/boss-chat/messages')
      .then((data) => { setMessages(data.messages || []); setError('') })
      .catch((e) => setError(e.message || '加载失败'))
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const send = async () => {
    const content = input.trim()
    if (!content || sending) return
    setSending(true)
    setError('')
    try {
      await apiFetch('/api/boss-chat/messages', {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
      setInput('')
      load()
    } catch (e: any) {
      setError(e.message || '发送失败')
    } finally {
      setSending(false)
    }
  }

  const deploy = async (runId: string) => {
    if (deploying) return
    setDeploying(runId)
    setError('')
    try {
      await apiFetch(`/api/boss-chat/deploy/${runId}`, { method: 'POST' })
      load()
    } catch (e: any) {
      setError(e.message || '部署失败')
    } finally {
      setDeploying(null)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      <header className="px-4 pt-4 pb-2 bg-white border-b border-border">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-h1">AI 助手</h1>
          <a
            href="/v2/boss/feedback"
            className="shrink-0 px-3 py-2 rounded-cta bg-white border border-border text-button"
          >
            反馈审批
          </a>
        </div>
        <p className="text-caption text-gray3 mt-0.5">
          直接告诉我要改什么，我开发测试好后给你批准上线
        </p>
      </header>

      <div className="flex-1 px-4 py-3 space-y-3 overflow-y-auto">
        {error && <div className="text-caption text-red-fg">{error}</div>}
        {messages.length === 0 && !error && (
          <div className="text-caption text-gray3 text-center py-10">
            还没有对话。试试: 「把登录页的标语改成 …」
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-card px-3 py-2 text-body whitespace-pre-wrap break-words ${
                m.role === 'user'
                  ? 'bg-ink text-white'
                  : m.role === 'system'
                    ? 'bg-white border border-border text-gray3 text-caption'
                    : 'bg-white border border-border'
              }`}
            >
              {m.content}
              {m.role === 'assistant' && m.runId && m.runStatus === 'DEPLOY_REVIEW' && (
                <button
                  onClick={() => deploy(m.runId!)}
                  disabled={deploying === m.runId}
                  className="mt-2 w-full px-3 py-2 rounded-cta bg-ink text-white text-button disabled:opacity-50"
                >
                  {deploying === m.runId ? '发布中…' : '批准部署上线'}
                </button>
              )}
              {m.role === 'assistant' && m.runId && (m.runStatus === 'DEPLOYING' || m.runStatus === 'VERIFY_PROD') && (
                <div className="mt-2 text-caption text-gray3">发布中，生产验证通过后我会再回复…</div>
              )}
              {m.role === 'assistant' && m.runId && m.runStatus === 'RESOLVED' && (
                <div className="mt-2 text-caption text-green-fg">✓ 已上线</div>
              )}
              <div className={`text-micro mt-1 ${m.role === 'user' ? 'text-white/60' : 'text-gray3'}`}>
                {timeAgo(m.createdAt)}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 bg-white border-t border-border px-4 py-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入开发指令…"
            rows={2}
            className="flex-1 resize-none rounded-card border border-border px-3 py-2 text-body focus:outline-none focus:border-ink"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="self-end shrink-0 px-4 py-2 rounded-cta bg-ink text-white text-button disabled:opacity-40"
          >
            {sending ? '发送中' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}

function timeAgo(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
