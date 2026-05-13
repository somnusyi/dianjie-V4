/**
 * 工程部 · 我的任务 (跨店)
 */
'use client'
import { useEffect, useState } from 'react'
import { getToken } from '@/lib/v2-auth'
import { BottomNav } from '@/components/v2'

const ENGINEER_TABS = [
  { key: 'home',   label: '看板', icon: '⌂' },
  { key: 'tasks',  label: '任务', icon: '☰' },
  { key: 'me',     label: '我的', icon: '○' },
]
const STATUS_LABEL: Record<string, string> = {
  TODO: '待办', IN_PROGRESS: '进行中', BLOCKED: '阻塞', DONE: '完成', CANCELED: '取消',
}
const STATUS_COLOR: Record<string, string> = {
  TODO: 'bg-bg text-gray2',
  IN_PROGRESS: 'bg-amber/20 text-amber-fg',
  BLOCKED: 'bg-red-bg text-red-fg',
  DONE: 'bg-green-50 text-green-700',
  CANCELED: 'bg-gray-100 text-gray-400',
}
const CATEGORY_LABEL: Record<string, string> = {
  BUSINESS: '商务', CONSTRUCTION: '装修', EQUIPMENT: '设备物料',
  LICENSING: '证照', PREPARATION: '筹备',
}

type Task = {
  id: string; storeId: string; category: string; name: string
  status: string; priority: number
  blockerNote: string | null
  dueDate: string | null
}

export default function EngineerTasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [filter, setFilter] = useState<'open' | 'all' | 'blocked'>('open')
  const [storeMap, setStoreMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => { refresh() }, [])

  async function refresh() {
    setLoading(true)
    try {
      const t = getToken()
      const headers = { Authorization: `Bearer ${t}` }
      const list = await fetch('/api/opening-tasks?assignee=me', { headers }).then(r => r.json())
      const arr: Task[] = Array.isArray(list) ? list : []
      setTasks(arr)
      // 加载门店名称
      const ids = [...new Set(arr.map(t => t.storeId))]
      if (ids.length > 0) {
        const stores = await fetch('/api/stores', { headers }).then(r => r.json())
        const arrS = Array.isArray(stores) ? stores : []
        setStoreMap(Object.fromEntries(arrS.map((s: any) => [s.id, s.name])))
      }
    } finally {
      setLoading(false)
    }
  }

  async function patch(id: string, body: any) {
    const t = getToken()
    await fetch(`/api/opening-tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    })
    refresh()
  }

  const visible = tasks.filter(t => {
    if (filter === 'open') return t.status === 'TODO' || t.status === 'IN_PROGRESS'
    if (filter === 'blocked') return t.status === 'BLOCKED'
    return true
  })

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">我的任务</h1>
        <p className="text-caption text-gray3 mt-0.5">
          {loading ? '加载中…' : `进行 ${tasks.filter(t => t.status === 'TODO' || t.status === 'IN_PROGRESS').length} · 阻塞 ${tasks.filter(t => t.status === 'BLOCKED').length} · 总 ${tasks.length}`}
        </p>
      </header>

      <div className="px-4 mt-2 flex gap-2">
        {(['open', 'blocked', 'all'] as const).map(k => (
          <button key={k} onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-cta text-button ${filter === k ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {k === 'open' ? '进行中' : k === 'blocked' ? '阻塞' : '全部'}
          </button>
        ))}
      </div>

      <ul className="px-4 mt-3 space-y-2">
        {visible.length === 0 ? (
          <li className="text-caption text-gray3 text-center py-8">{filter === 'open' ? '没有进行中的任务 🎉' : '无任务'}</li>
        ) : visible.map(t => (
          <li key={t.id} className="bg-white rounded-card border border-border p-3">
            <div className="flex items-start gap-2">
              <button
                onClick={() => patch(t.id, { status: t.status === 'DONE' ? 'TODO' : 'DONE' })}
                className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                  t.status === 'DONE' ? 'bg-amber border-amber text-white' : 'border-border'
                }`}>
                {t.status === 'DONE' && '✓'}
              </button>
              <div className="flex-1 min-w-0">
                <div className={`text-body ${t.status === 'DONE' ? 'line-through text-gray3' : ''}`}>{t.name}</div>
                <div className="flex items-center gap-2 mt-1 text-micro">
                  <a href={`/v2/engineer/stores/${t.storeId}`}
                    className="text-amber-fg truncate max-w-[40%]">{storeMap[t.storeId] || '门店'}</a>
                  <span className="text-gray3">·</span>
                  <span className="text-gray3">{CATEGORY_LABEL[t.category]}</span>
                  <span className={`ml-auto px-1.5 py-0.5 rounded ${STATUS_COLOR[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                </div>
                {t.blockerNote && <div className="text-micro text-red-fg mt-1">⚠ {t.blockerNote}</div>}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <BottomNav
        tabs={ENGINEER_TABS}
        activeKey="tasks"
        onChange={(k) => {
          if (k === 'home') location.href = '/v2/engineer/home'
          if (k === 'me') location.href = '/v2/me'
        }}
      />
    </div>
  )
}
