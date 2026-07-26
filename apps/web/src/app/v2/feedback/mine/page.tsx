/**
 * 我的反馈列表: 状态 / 分类 / 时间, 点进对话页
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { categoryBadge, statusBadge } from '@/app/v2/feedback/feedback-shared'

type Item = {
  id: string
  category: string | null
  status: string
  title: string | null
  summary: string | null
  createdAt: string
  _count: { messages: number }
}

export default function FeedbackMinePage() {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch<Item[]>('/api/feedback/mine')
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch((e) => setError(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">我的反馈</h1>
          <p className="text-caption text-gray3 mt-0.5">{loading ? '加载中…' : `共 ${items.length} 条`}</p>
        </div>
        <a href="/v2/feedback/new" className="shrink-0 px-3 py-1.5 rounded-cta bg-ink text-white text-button">+ 新反馈</a>
      </header>

      <ul className="px-4 mt-3 space-y-2">
        {error && <li className="text-caption text-red-fg">{error}</li>}
        {!loading && !error && items.length === 0 && (
          <li className="text-caption text-gray3 text-center py-10">
            还没有反馈。点右上角「新反馈」告诉我们你的想法。
          </li>
        )}
        {items.map((it) => {
          const st = statusBadge(it.status)
          const cat = categoryBadge(it.category)
          return (
            <li key={it.id} className="bg-white rounded-card border border-border p-3 relative">
              <div className="flex items-center gap-2 mb-1">
                <span aria-hidden>{cat.icon}</span>
                <span className="text-caption text-gray2">{cat.label}</span>
                <span className={`text-micro px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                <span className="text-micro text-gray3 ml-auto">{timeAgo(it.createdAt)}</span>
              </div>
              <div className="text-h2">{it.title || '（沟通中，待 AI 整理标题）'}</div>
              {it.summary && <div className="text-caption text-gray2 mt-0.5 line-clamp-2">{it.summary}</div>}
              <div className="text-micro text-gray3 mt-1 font-num">{it._count.messages} 条对话</div>
              <a href={`/v2/feedback/${it.id}`} className="absolute inset-0" aria-label="查看对话" />
            </li>
          )
        })}
      </ul>
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
