/**
 * PC 端 · 反馈管理 (仅 SUPER_ADMIN): 分状态列表 + 审批(批准/驳回) + 标记已解决闭环
 * 数据: GET /api/feedback/admin/inbox?status= · GET /api/feedback/:id · POST /:id/decision · POST /:id/resolve
 */
'use client'

import { useCallback, useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Btn, Modal, Table, useToast, fmtDatetime } from '@/components/ui'
import api from '@/lib/api'

type Item = {
  id: string
  category: string | null
  status: string
  title: string | null
  summary: string | null
  proposal: { scenario?: string; expectation?: string; estimatedDays?: string | number } | null
  attachments: string[] | null
  createdAt: string
  updatedAt: string
  reporter: { id: string; name: string; role: string }
  storeName: string | null
}

type Msg = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string }
type Detail = Item & { decisionNote: string | null; messages: Msg[] }

const TABS = [
  { key: 'AWAITING_APPROVAL', label: '待审批' },
  { key: 'CLARIFYING', label: '沟通中' },
  { key: 'IN_DEV', label: '开发中' },
  { key: 'RESOLVED', label: '已解决' },
  { key: 'REJECTED', label: '已驳回' },
]

const CATEGORY_LABEL: Record<string, string> = {
  BUG_BLOCKING: '🚨 紧急故障', IMPROVEMENT: '💡 体验改进', NEW_FEATURE: '✨ 新需求', QUESTION: '❓ 操作咨询',
}

export default function PcFeedbackAdminPage() {
  const [status, setStatus] = useState('AWAITING_APPROVAL')
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [note, setNote] = useState('')
  const [acting, setActing] = useState(false)
  const { show, ToastEl } = useToast()

  const load = useCallback(() => {
    setLoading(true)
    api.get<Item[]>(`/api/feedback/admin/inbox?status=${status}`)
      .then((r) => setItems(Array.isArray(r.data) ? r.data : []))
      .catch((e) => show(e?.response?.data?.error || '加载失败', 'error'))
      .finally(() => setLoading(false))
  }, [status])

  useEffect(() => { load() }, [load])

  async function openDetail(id: string) {
    try {
      const r = await api.get<Detail>(`/api/feedback/${id}`)
      setDetail(r.data)
      setNote('')
    } catch (e: any) {
      show(e?.response?.data?.error || '加载详情失败', 'error')
    }
  }

  async function act(path: 'decision' | 'resolve', body: any, okMsg: string) {
    if (!detail) return
    setActing(true)
    try {
      await api.post(`/api/feedback/${detail.id}/${path}`, body)
      show(okMsg)
      setDetail(null)
      load()
    } catch (e: any) {
      show(e?.response?.data?.error || '操作失败，请重试', 'error')
    } finally {
      setActing(false)
    }
  }

  const pending = detail?.status === 'AWAITING_APPROVAL'
  const resolvable = detail && ['CLARIFYING', 'IN_DEV'].includes(detail.status)

  return (
    <AppLayout>
      <main className="dj-page">
        <PageHeader title="反馈管理" sub="员工反馈的 AI 分诊结果：审批立项 / 故障处理 / 闭环" />
        {ToastEl}

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setStatus(t.key)}
              style={{
                padding: '6px 16px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: status === t.key ? '1.5px solid #156b43' : '1.5px solid #e5e7eb',
                background: status === t.key ? '#edfaf3' : '#fff',
                color: status === t.key ? '#156b43' : '#6b7280',
              }}>
              {t.label}
            </button>
          ))}
        </div>

        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <Table
            loading={loading}
            data={items}
            columns={[
              { key: 'category', title: '分类', width: 110, render: (v) => CATEGORY_LABEL[v || ''] || '💬 待分诊' },
              { key: 'title', title: '标题', render: (v, row) => (
                <div>
                  <div style={{ fontWeight: 600, color: '#0a0f0c' }}>{v || '（AI 分诊中…）'}</div>
                  {row.summary && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.summary}</div>}
                </div>
              ) },
              { key: 'reporter', title: '提出人', width: 130, render: (v, row) => `${v?.name || '-'}${row.storeName ? ` · ${row.storeName}` : ''}` },
              { key: 'updatedAt', title: '更新时间', width: 150, render: (v) => fmtDatetime(v) },
              { key: 'id', title: '操作', width: 90, render: (v) => <Btn size="sm" onClick={() => openDetail(v)}>处理</Btn> },
            ]}
          />
        </Card>

        <Modal open={!!detail} title={detail?.title || '反馈详情'} onClose={() => setDetail(null)} width={680}>
          {detail && (
            <div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, fontSize: 12, color: '#6b7280' }}>
                <span>{CATEGORY_LABEL[detail.category || ''] || '💬 待分诊'}</span>
                <span>{detail.reporter?.name} 提出{detail.storeName ? ` · ${detail.storeName}` : ''}</span>
                <span>{fmtDatetime(detail.createdAt)}</span>
              </div>

              {detail.summary && (
                <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>AI 整理的方案</div>
                  {detail.summary}
                  {detail.proposal && (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 12, color: '#6b7280' }}>
                      {detail.proposal.scenario && <li>使用场景:{detail.proposal.scenario}</li>}
                      {detail.proposal.expectation && <li>期望效果:{detail.proposal.expectation}</li>}
                      {detail.proposal.estimatedDays != null && <li>初估人天:{String(detail.proposal.estimatedDays)}</li>}
                    </ul>
                  )}
                </div>
              )}

              {Array.isArray(detail.attachments) && detail.attachments.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {detail.attachments.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noreferrer">
                      <img src={url} alt={`附件${i + 1}`} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb' }} />
                    </a>
                  ))}
                </div>
              )}

              <div style={{ maxHeight: '38vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
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

              {detail.decisionNote && detail.status === 'REJECTED' && (
                <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 12 }}>驳回理由:{detail.decisionNote}</div>
              )}

              {(pending || resolvable) && (
                <div>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    maxLength={300}
                    placeholder={pending ? '驳回理由（驳回时必填）' : '给提报人的解决说明（选填）'}
                    style={{ width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 7, padding: '8px 10px', fontSize: 13, outline: 'none', resize: 'none', boxSizing: 'border-box', marginBottom: 10 }}
                  />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    {pending && (
                      <>
                        <Btn variant="primary" disabled={acting} onClick={() => act('decision', note.trim() ? { action: 'approve', note: note.trim() } : { action: 'approve' }, '已批准，进入开发')}>批准立项</Btn>
                        <Btn variant="danger" disabled={acting} onClick={() => {
                          if (!note.trim()) { show('驳回时请填写理由', 'error'); return }
                          act('decision', { action: 'reject', note: note.trim() }, '已驳回')
                        }}>驳回</Btn>
                      </>
                    )}
                    {resolvable && (
                      <Btn variant="primary" disabled={acting} onClick={() => act('resolve', note.trim() ? { note: note.trim() } : {}, '已标记解决并通知提报人')}>标记已解决</Btn>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>
      </main>
    </AppLayout>
  )
}
