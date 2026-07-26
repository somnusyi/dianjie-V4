/**
 * 超管/老板 · 反馈审批中心: 待批列表 (分类图标 / 标题 / AI 方案摘要 / 提出人)
 * 数据: GET /api/feedback/admin/inbox?status=
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { BottomNav, Chip } from '@/components/v2'
import { categoryBadge, statusBadge } from '@/app/v2/feedback/feedback-shared'

type Item = {
  id: string
  category: string | null
  status: string
  title: string | null
  summary: string | null
  createdAt: string
  reporter: { id: string; name: string; role: string }
  storeName: string | null
}

const TABS = [
  { key: 'AWAITING_APPROVAL', label: '待审批' },
  { key: 'CLARIFYING', label: '沟通中' },
  { key: 'IN_DEV', label: '开发中' },
  { key: 'RESOLVED', label: '已解决' },
  { key: 'REJECTED', label: '已驳回' },
] as const

export default function BossFeedbackPage() {
  const [status, setStatus] = useState<string>('AWAITING_APPROVAL')
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('approval')

  useEffect(() => {
    setLoading(true)
    apiFetch<Item[]>(`/api/feedback/admin/inbox?status=${status}`)
      .then((data) => { setItems(Array.isArray(data) ? data : []); setError('') })
      .catch((e) => setError(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [status])

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-h1">反馈审批</h1>
          <a
            href="/v2/boss/autofix"
            className="shrink-0 px-3 py-2 rounded-cta bg-white border border-border text-button"
          >
            AI 自动修复
          </a>
        </div>
        <p className="text-caption text-gray3 mt-0.5">
          {loading ? '加载中…' : `${items.length} 条${TABS.find((t) => t.key === status)?.label || ''}反馈`}
        </p>
      </header>

      <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`shrink-0 px-3 py-1.5 rounded-cta text-button transition ${
              status === t.key ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ul className="px-4 mt-3 space-y-2">
        {error && <li className="text-caption text-red-fg">{error}</li>}
        {!loading && !error && items.length === 0 && (
          <li className="text-caption text-gray3 text-center py-8">暂无反馈</li>
        )}
        {items.map((it) => {
          const cat = categoryBadge(it.category)
          const st = statusBadge(it.status)
          return (
            <li key={it.id} className="bg-white rounded-card border border-border p-3 relative">
              <div className="flex items-center gap-2 mb-1">
                <span aria-hidden>{cat.icon}</span>
                <Chip tone={it.category === 'BUG_BLOCKING' ? 'red' : it.category === 'NEW_FEATURE' ? 'blue' : 'amber'}>
                  {cat.label}
                </Chip>
                <span className={`text-micro px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                <span className="text-micro text-gray3 ml-auto">{timeAgo(it.createdAt)}</span>
              </div>
              <div className="text-h2 mb-0.5">{it.title || '（待 AI 整理标题）'}</div>
              {it.summary && <div className="text-caption text-gray2 mb-1 line-clamp-2">{it.summary}</div>}
              <div className="text-caption text-gray3">
                {it.reporter?.name || '—'}{it.storeName ? ` · ${it.storeName}` : ''} 提出
              </div>
              <a href={`/v2/boss/feedback/${it.id}`} className="absolute inset-0" aria-label="查看反馈详情" />
            </li>
          )
        })}
      </ul>

      <BottomNav
        tabs={[
          { key: 'home',     label: '首页', icon: '⌂' },
          { key: 'stores',   label: '门店', icon: '☷' },
          { key: 'reports',  label: '报表', icon: '⛁' },
          { key: 'approval', label: '审批', icon: '✓' },
          { key: 'me',       label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          setTab(k)
          if (k === 'home')     location.href = '/v2/boss/home'
          if (k === 'stores')   location.href = '/v2/boss/stores'
          if (k === 'reports')  location.href = '/v2/boss/reports'
          if (k === 'approval') location.href = '/v2/boss/approvals'
          if (k === 'me')       location.href = '/v2/me'
        }}
      />
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
