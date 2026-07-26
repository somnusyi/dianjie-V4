/**
 * PC 端 · 问题反馈 (全角色): 提交反馈 (AI 即时回复) + 我的反馈列表 + 对话追问
 * 数据: POST /api/feedback · GET /api/feedback/mine · GET /api/feedback/:id · POST /api/feedback/:id/messages
 */
'use client'

import { useCallback, useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Btn, Modal, Empty, useToast, fmtDatetime } from '@/components/ui'
import api from '@/lib/api'

type MineItem = {
  id: string
  category: string | null
  status: string
  title: string | null
  summary: string | null
  createdAt: string
  updatedAt: string
  _count: { messages: number }
}

type Msg = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string }
type Detail = MineItem & { reporter: { id: string; name: string; role: string }; messages: Msg[] }

const STATUS_LABEL: Record<string, string> = {
  CLARIFYING: '沟通中', AWAITING_APPROVAL: '待审批', APPROVED: '已批准',
  IN_DEV: '开发中', RESOLVED: '已解决', REJECTED: '已驳回', CLOSED: '已闭环',
}
const STATUS_COLOR: Record<string, { bg: string; color: string }> = {
  CLARIFYING: { bg: '#eff6ff', color: '#2563eb' },
  AWAITING_APPROVAL: { bg: '#fffbeb', color: '#d97706' },
  APPROVED: { bg: '#edfaf3', color: '#156b43' },
  IN_DEV: { bg: '#edfaf3', color: '#156b43' },
  RESOLVED: { bg: '#edfaf3', color: '#156b43' },
  REJECTED: { bg: '#fef2f2', color: '#dc2626' },
  CLOSED: { bg: '#f3f4f6', color: '#6b7280' },
}
const CATEGORY_LABEL: Record<string, string> = {
  BUG_BLOCKING: '🚨 紧急故障', IMPROVEMENT: '💡 体验改进', NEW_FEATURE: '✨ 新需求', QUESTION: '❓ 操作咨询',
}

function StatusChip({ status }: { status: string }) {
  const s = STATUS_COLOR[status] || { bg: '#f3f4f6', color: '#6b7280' }
  return <span style={{ padding: '2px 9px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color }}>{STATUS_LABEL[status] || status}</span>
}

export default function PcFeedbackPage() {
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [list, setList] = useState<MineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)
  const { show, ToastEl } = useToast()

  const load = useCallback(() => {
    api.get<MineItem[]>('/api/feedback/mine')
      .then((r) => setList(Array.isArray(r.data) ? r.data : []))
      .catch(() => show('加载反馈列表失败', 'error'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function submit() {
    const text = content.trim()
    if (!text) { show('请描述你遇到的问题或建议', 'error'); return }
    setSubmitting(true)
    try {
      const r = await api.post('/api/feedback', { content: text, context: { path: '/feedback' } })
      setContent('')
      show('已提交，AI 助手已回复')
      if (r.data?.reply) {
        // 提交成功后直接刷新列表，AI 首轮回复在对话里可见
      }
      load()
    } catch (e: any) {
      show(e?.response?.data?.error || '提交失败，请重试', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function openDetail(id: string) {
    try {
      const r = await api.get<Detail>(`/api/feedback/${id}`)
      setDetail(r.data)
      setReplyText('')
    } catch (e: any) {
      show(e?.response?.data?.error || '加载详情失败', 'error')
    }
  }

  async function sendReply() {
    const text = replyText.trim()
    if (!text || !detail) return
    setReplying(true)
    try {
      await api.post(`/api/feedback/${detail.id}/messages`, { content: text })
      const r = await api.get<Detail>(`/api/feedback/${detail.id}`)
      setDetail(r.data)
      setReplyText('')
      load()
    } catch (e: any) {
      show(e?.response?.data?.error || '发送失败，请重试', 'error')
    } finally {
      setReplying(false)
    }
  }

  const ended = detail && ['RESOLVED', 'REJECTED'].includes(detail.status)

  return (
    <AppLayout>
      <main className="dj-page">
        <PageHeader title="问题反馈" sub="使用中遇到的问题、优化建议、新需求都可以提，AI 助手会即时响应" />
        {ToastEl}

        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>提交新反馈</div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="描述你遇到的问题或建议，越具体越好（哪个页面、做了什么操作、期望什么样）"
            style={{ width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 7, padding: '8px 10px', fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <Btn variant="primary" onClick={submit} disabled={submitting}>{submitting ? 'AI 响应中…' : '提交反馈'}</Btn>
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>我的反馈</div>
          {loading ? <div style={{ color: '#9ca3af', fontSize: 13 }}>加载中…</div> : list.length === 0 ? <Empty text="还没有提交过反馈" /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {list.map((f) => (
                <div key={f.id} onClick={() => openDetail(f.id)}
                  style={{ border: '1px solid #f3f4f6', borderRadius: 8, padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0a0f0c' }}>{f.title || '（AI 分诊中…）'}</div>
                    {f.summary && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.summary}</div>}
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                      {CATEGORY_LABEL[f.category || ''] || '💬 待分诊'} · {fmtDatetime(f.createdAt)} · {f._count.messages} 条对话
                    </div>
                  </div>
                  <StatusChip status={f.status} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Modal open={!!detail} title={detail?.title || '反馈详情'} onClose={() => setDetail(null)} width={640}>
          {detail && (
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, fontSize: 12, color: '#6b7280' }}>
                <StatusChip status={detail.status} />
                <span>{CATEGORY_LABEL[detail.category || ''] || '💬 待分诊'}</span>
                <span>{fmtDatetime(detail.createdAt)}</span>
              </div>
              <div style={{ maxHeight: '45vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                {detail.messages.map((m) => {
                  if (m.role === 'system') {
                    return <div key={m.id} style={{ textAlign: 'center' }}><span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', borderRadius: 999, padding: '3px 12px' }}>{m.content}</span></div>
                  }
                  const mine = m.role === 'user'
                  return (
                    <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                      <div style={{ maxWidth: '85%', padding: '8px 12px', borderRadius: 10, fontSize: 13, whiteSpace: 'pre-wrap', background: mine ? '#0a0f0c' : '#f3f4f6', color: mine ? '#fff' : '#374151' }}>
                        {!mine && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>AI 助手</div>}
                        {m.content}
                      </div>
                    </div>
                  )
                })}
              </div>
              {!ended ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendReply()}
                    placeholder="补充说明或回复 AI 助手…"
                    style={{ flex: 1, border: '1.5px solid #e5e7eb', borderRadius: 7, padding: '8px 10px', fontSize: 13, outline: 'none' }}
                  />
                  <Btn variant="primary" onClick={sendReply} disabled={replying}>{replying ? '发送中…' : '发送'}</Btn>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>该反馈已结束，如有新问题请重新提交</div>
              )}
            </div>
          )}
        </Modal>
      </main>
    </AppLayout>
  )
}
