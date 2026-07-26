'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

type Run = {
  id: string
  status: string
  planSummary: string | null
  diffFiles: Array<{ path: string; added: number; deleted: number }> | null
  error: string | null
  createdAt: string
  feedback: { id: string; title: string | null; summary: string | null; status: string }
}

const STATUS: Record<string, { label: string; cls: string }> = {
  RECEIVED: { label: '排队中', cls: 'bg-gray-100 text-gray2' },
  ANALYZING: { label: '定位中', cls: 'bg-blue-50 text-blue-700' },
  PATCHING: { label: '生成补丁', cls: 'bg-blue-50 text-blue-700' },
  VERIFYING: { label: '隔离验证', cls: 'bg-blue-50 text-blue-700' },
  PLAN_READY: { label: '方案完成', cls: 'bg-amber-50 text-amber-700' },
  AWAITING_APPROVAL: { label: '待审批', cls: 'bg-amber-50 text-amber-700' },
  DEPLOYING: { label: '部署中', cls: 'bg-blue-50 text-blue-700' },
  VERIFY_PROD: { label: '生产验证', cls: 'bg-blue-50 text-blue-700' },
  RESOLVED: { label: '已解决', cls: 'bg-green-50 text-green-700' },
  FAILED_ROLLBACK: { label: '失败已回滚', cls: 'bg-red-50 text-red-700' },
  ROLLED_BACK: { label: '已人工回滚', cls: 'bg-gray-100 text-gray2' },
  ESCALATED: { label: '转人工', cls: 'bg-red-50 text-red-700' },
  REJECTED: { label: '已驳回', cls: 'bg-gray-100 text-gray2' },
}

export default function AutoFixRunsPage() {
  const [items, setItems] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch<{ items: Run[] }>('/api/autofix/runs?pageSize=50')
      .then((data) => { setItems(data.items || []); setError('') })
      .catch((e) => setError(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-3 flex items-center gap-3 border-b border-border">
        <button
          onClick={() => { location.href = '/v2/boss/feedback' }}
          className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center"
        >
          ‹
        </button>
        <div>
          <h1 className="text-h1">AI 自动修复</h1>
          <p className="text-caption text-gray3">AI 先验证补丁，批准后才允许部署</p>
        </div>
      </header>

      <div className="px-4 mt-3">
        {loading && <div className="text-caption text-gray3 text-center py-8">加载中…</div>}
        {error && <div className="text-caption text-red-fg">{error}</div>}
        {!loading && !error && items.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center text-caption text-gray3">
            暂无自动修复记录
          </div>
        )}
        <ul className="space-y-2">
          {items.map((run) => {
            const status = STATUS[run.status] || { label: run.status, cls: 'bg-gray-100 text-gray2' }
            const files = Array.isArray(run.diffFiles) ? run.diffFiles : []
            return (
              <li key={run.id} className="bg-white rounded-card border border-border p-3 relative">
                <div className="flex items-center gap-2">
                  <span className={`text-micro px-2 py-1 rounded-full ${status.cls}`}>{status.label}</span>
                  <span className="text-micro text-gray3 ml-auto">
                    {new Date(run.createdAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <div className="text-h2 mt-2">{run.feedback.title || '阻断故障'}</div>
                <div className="text-caption text-gray2 mt-1 line-clamp-2">
                  {run.planSummary || run.error || run.feedback.summary || '等待 AI 分析'}
                </div>
                {files.length > 0 && (
                  <div className="text-micro text-gray3 mt-2">
                    {files.length} 个文件 · {files.reduce((sum, file) => sum + file.added + file.deleted, 0)} 行
                  </div>
                )}
                <a href={`/v2/boss/autofix/${run.id}`} className="absolute inset-0" aria-label="查看自动修复详情" />
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
