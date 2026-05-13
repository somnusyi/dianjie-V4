/**
 * 工程部 · 筹建看板 (主页)
 * 我负责的所有筹建中门店, 显示当前阶段 / 任务进度 / 待办
 */
'use client'
import { useEffect, useState } from 'react'
import { getUser, getToken } from '@/lib/v2-auth'
import { BottomNav } from '@/components/v2'

const ENGINEER_TABS = [
  { key: 'home',   label: '看板', icon: '⌂' },
  { key: 'tasks',  label: '任务', icon: '☰' },
  { key: 'me',     label: '我的', icon: '○' },
]

const PHASE_LABEL: Record<string, string> = {
  PLANNING: '选址', NEGOTIATING: '合同谈判', CONSTRUCTION: '装修',
  EQUIPMENT: '设备物料', LICENSING: '证照', TRIAL: '试营业',
  OPERATING: '已开业', CLOSED: '已关店',
}
const PHASE_COLOR: Record<string, string> = {
  PLANNING: 'bg-gray-100 text-gray-700',
  NEGOTIATING: 'bg-blue-50 text-blue-700',
  CONSTRUCTION: 'bg-amber/20 text-amber-fg',
  EQUIPMENT: 'bg-orange-50 text-orange-700',
  LICENSING: 'bg-purple-50 text-purple-700',
  TRIAL: 'bg-green-50 text-green-700',
  OPERATING: 'bg-emerald-50 text-emerald-700',
  CLOSED: 'bg-red-bg text-red-fg',
}

type Store = {
  id: string; no: string; name: string
  lifecyclePhase: string
  expectedOpenAt?: string | null
  address?: string | null
}
type ProgressInfo = { total: number; done: number; blocked: number; percent: number }

export default function EngineerHomePage() {
  const [u, setU] = useState<any>(null)
  const [stores, setStores] = useState<Store[]>([])
  const [progress, setProgress] = useState<Record<string, ProgressInfo>>({})
  const [myTaskCount, setMyTaskCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const user = getUser()
    setU(user)
    if (!user) { location.replace('/v2/login'); return }
    refresh()
  }, [])

  async function refresh() {
    setLoading(true)
    const t = getToken()
    const headers = { Authorization: `Bearer ${t}` }
    try {
      const list = await fetch('/api/stores', { headers }).then(r => r.json())
      const arr: Store[] = Array.isArray(list) ? list : (list.items || [])
      // 过滤掉 OPERATING / CLOSED
      const active = arr.filter(s => s.lifecyclePhase !== 'OPERATING' && s.lifecyclePhase !== 'CLOSED')
      setStores(active)
      // 各店进度
      const prog: Record<string, ProgressInfo> = {}
      await Promise.all(active.map(async s => {
        try {
          const r = await fetch(`/api/opening-tasks/progress/${s.id}`, { headers })
          if (r.ok) {
            const d = await r.json()
            prog[s.id] = d.summary
          }
        } catch {}
      }))
      setProgress(prog)
      // 我的待办数
      try {
        const my = await fetch('/api/opening-tasks?assignee=me&status=TODO', { headers }).then(r => r.json())
        const my2 = await fetch('/api/opening-tasks?assignee=me&status=IN_PROGRESS', { headers }).then(r => r.json())
        setMyTaskCount((Array.isArray(my) ? my.length : 0) + (Array.isArray(my2) ? my2.length : 0))
      } catch {}
    } finally {
      setLoading(false)
    }
  }

  if (!u) return null

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-h1">筹建看板</h1>
          <p className="text-caption text-gray3 mt-0.5">
            {loading ? '加载中…' : `${stores.length} 家筹建中 · 待办 ${myTaskCount}`}
          </p>
        </div>
        <a href="/v2/me" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">{u?.name?.[0] || '?'}</a>
      </header>

      <div className="px-4 mt-2 grid grid-cols-2 gap-2">
        <a href="/v2/engineer/tasks" className="bg-white rounded-card border border-border p-3">
          <div className="text-caption text-gray3">我的待办</div>
          <div className="text-h1 font-num mt-1">{myTaskCount}</div>
        </a>
        <a href="/v2/boss/stores/new" className="bg-amber/10 rounded-card border border-amber/30 p-3 flex items-center justify-center text-amber-fg text-button">
          + 新建筹建店
        </a>
      </div>

      <div className="px-4 mt-4">
        <h2 className="text-h2 mb-2">我负责的门店</h2>
        {loading ? (
          <div className="text-caption text-gray3 py-8 text-center">加载中…</div>
        ) : stores.length === 0 ? (
          <div className="bg-white rounded-card border border-border p-8 text-center text-caption text-gray3">
            还没有筹建中的门店。点上面「+ 新建筹建店」开始。
          </div>
        ) : (
          <ul className="space-y-2">
            {stores.map(s => {
              const p = progress[s.id]
              const exp = s.expectedOpenAt ? new Date(s.expectedOpenAt) : null
              return (
                <li key={s.id}>
                  <a href={`/v2/engineer/stores/${s.id}`} className="block bg-white rounded-card border border-border p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-button flex-1">{s.name}</span>
                      <span className="text-micro text-gray3 font-num">{s.no}</span>
                      <span className={`text-micro px-1.5 py-0.5 rounded ${PHASE_COLOR[s.lifecyclePhase] || ''}`}>
                        {PHASE_LABEL[s.lifecyclePhase] || s.lifecyclePhase}
                      </span>
                    </div>
                    {s.address && <div className="text-micro text-gray3 mt-1 truncate">{s.address}</div>}
                    {p && p.total > 0 ? (
                      <div className="mt-2">
                        <div className="flex items-center text-micro mb-1">
                          <span className="text-gray2">任务 {p.done}/{p.total}</span>
                          {p.blocked > 0 && <span className="ml-2 text-red-fg">阻塞 {p.blocked}</span>}
                          <span className="ml-auto font-num text-gray2">{p.percent}%</span>
                        </div>
                        <div className="h-1.5 bg-bg rounded">
                          <div className="h-full bg-amber rounded transition-all"
                               style={{ width: `${p.percent}%` }}></div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-micro text-gray3 mt-2">未初始化任务清单 →</div>
                    )}
                    {exp && (
                      <div className="text-micro text-gray3 mt-1">预计开业 {exp.toLocaleDateString('zh-CN')}</div>
                    )}
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <BottomNav
        tabs={ENGINEER_TABS}
        activeKey="home"
        onChange={(k) => {
          if (k === 'tasks') location.href = '/v2/engineer/tasks'
          if (k === 'me') location.href = '/v2/me'
        }}
      />
    </div>
  )
}
