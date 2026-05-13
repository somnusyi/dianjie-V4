/**
 * 工程部 · 单店进度详情
 * - 阶段切换 (PLANNING → CONSTRUCTION → ... → 上线需老板批)
 * - 任务清单 (按类目分组, 可勾选完成 / 标阻塞)
 * - 初始化默认任务模板按钮 (空时显示)
 */
'use client'
import { useEffect, useState } from 'react'
import { getToken, getUser } from '@/lib/v2-auth'

const PHASE_OPTIONS = [
  { value: 'PLANNING',     label: '选址' },
  { value: 'NEGOTIATING',  label: '合同谈判' },
  { value: 'CONSTRUCTION', label: '装修' },
  { value: 'EQUIPMENT',    label: '设备物料' },
  { value: 'LICENSING',    label: '证照' },
  { value: 'TRIAL',        label: '试营业' },
  { value: 'OPERATING',    label: '已开业 (需老板批)' },
]
const CATEGORY_LABEL: Record<string, string> = {
  BUSINESS: '商务', CONSTRUCTION: '装修', EQUIPMENT: '设备物料',
  LICENSING: '证照', PREPARATION: '筹备',
}
const CATEGORY_ORDER = ['BUSINESS','CONSTRUCTION','EQUIPMENT','LICENSING','PREPARATION']
const STATUS_LABEL: Record<string, string> = {
  TODO: '待办', IN_PROGRESS: '进行中', BLOCKED: '阻塞', DONE: '完成', CANCELED: '取消',
}
const STATUS_COLOR: Record<string, string> = {
  TODO: 'bg-bg text-gray2',
  IN_PROGRESS: 'bg-amber/20 text-amber-fg',
  BLOCKED: 'bg-red-bg text-red-fg',
  DONE: 'bg-green-50 text-green-700 line-through',
  CANCELED: 'bg-gray-100 text-gray-400 line-through',
}

type Task = {
  id: string; storeId: string; category: string; name: string; description: string | null
  assigneeId: string | null
  dueDate: string | null
  status: string; priority: number; cost: number | null
  blockerNote: string | null
  completedAt: string | null
}
type StoreInfo = { id: string; no: string; name: string; lifecyclePhase: string; expectedOpenAt: string | null; engineerId: string | null }

export default function EngineerStoreDetailPage({ params }: { params: { id: string } }) {
  const { id } = params
  const [store, setStore] = useState<StoreInfo | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [summary, setSummary] = useState<{ total:number; done:number; blocked:number; percent:number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)
  const [me, setMe] = useState<any>(null)
  const [editingPhase, setEditingPhase] = useState(false)
  const [phaseDraft, setPhaseDraft] = useState('')

  // 添加任务
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ category: 'BUSINESS', name: '', description: '' })

  // 阻塞 / 编辑
  const [blockerTarget, setBlockerTarget] = useState<Task | null>(null)
  const [blockerText, setBlockerText] = useState('')

  useEffect(() => {
    setMe(getUser())
    refresh()
  }, [id])

  async function refresh() {
    setLoading(true); setError(null)
    try {
      const t = getToken()
      const r = await fetch(`/api/opening-tasks/progress/${id}`, { headers: { Authorization: `Bearer ${t}` } })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '加载失败')
      setStore(d.store)
      setTasks(d.tasks)
      setSummary(d.summary)
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  async function seedTemplate() {
    setSeeding(true)
    try {
      const t = getToken()
      const r = await fetch(`/api/opening-tasks/seed-template/${id}`, {
        method: 'POST', headers: { Authorization: `Bearer ${t}` },
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '初始化失败')
      refresh()
    } catch (e: any) {
      setError(e.message || '初始化失败')
    } finally {
      setSeeding(false)
    }
  }

  async function patchTask(taskId: string, body: any) {
    const t = getToken()
    const r = await fetch(`/api/opening-tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || '更新失败')
    refresh()
  }

  async function changePhase(newPhase: string) {
    setError(null)
    try {
      const t = getToken()
      const r = await fetch(`/api/stores/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ lifecyclePhase: newPhase }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '切换失败')
      setEditingPhase(false)
      refresh()
    } catch (e: any) {
      setError(e.message || '切换失败')
    }
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault()
    if (!addForm.name.trim()) return
    try {
      const t = getToken()
      const r = await fetch('/api/opening-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          storeId: id,
          category: addForm.category,
          name: addForm.name.trim(),
          description: addForm.description.trim() || undefined,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '创建失败')
      setAddForm({ category: 'BUSINESS', name: '', description: '' })
      setShowAdd(false)
      refresh()
    } catch (e: any) {
      setError(e.message || '创建失败')
    }
  }

  async function submitBlocker() {
    if (!blockerTarget) return
    try {
      await patchTask(blockerTarget.id, { status: 'BLOCKED', blockerNote: blockerText.trim() || null })
      setBlockerTarget(null); setBlockerText('')
    } catch (e: any) {
      setError(e.message || '更新失败')
    }
  }

  if (loading) return <div className="min-h-screen bg-bg flex items-center justify-center text-caption text-gray3">加载中…</div>
  if (!store) return <div className="min-h-screen bg-bg flex items-center justify-center text-caption text-red-fg">{error || '门店不存在'}</div>

  // 按类目分组
  const grouped: Record<string, Task[]> = {}
  for (const cat of CATEGORY_ORDER) grouped[cat] = []
  for (const t of tasks) (grouped[t.category] || (grouped[t.category] = [])).push(t)

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/engineer/home" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1 truncate">{store.name}</h1>
        <a href={`/v2/budget/${id}`} className="text-button text-amber-fg">资金台账</a>
      </header>

      <div className="px-4 mt-2 space-y-3">
        {/* 阶段切换 */}
        <section className="bg-white rounded-card border border-border p-3">
          <div className="flex items-center">
            <div className="flex-1">
              <div className="text-caption text-gray3">当前阶段</div>
              <div className="text-h2 mt-0.5">{PHASE_OPTIONS.find(p => p.value === store.lifecyclePhase)?.label || store.lifecyclePhase}</div>
            </div>
            <button onClick={() => { setEditingPhase(!editingPhase); setPhaseDraft(store.lifecyclePhase) }}
              className="text-button text-amber-fg">
              {editingPhase ? '取消' : '推进'}
            </button>
          </div>
          {editingPhase && (
            <div className="mt-3 space-y-2">
              <select value={phaseDraft} onChange={e => setPhaseDraft(e.target.value)}
                className="w-full bg-bg rounded p-2 outline-none text-body">
                {PHASE_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              <button onClick={() => changePhase(phaseDraft)}
                className="w-full py-2 bg-amber text-white rounded-cta text-button">
                确认推进到「{PHASE_OPTIONS.find(p => p.value === phaseDraft)?.label}」
              </button>
              {phaseDraft === 'OPERATING' && (
                <p className="text-micro text-gray3">⚠ 上线需老板审批, 你提交后后台返回 403 是预期行为</p>
              )}
            </div>
          )}
        </section>

        {/* 进度 */}
        {summary && summary.total > 0 && (
          <section className="bg-white rounded-card border border-border p-3">
            <div className="flex items-center text-caption mb-1">
              <span className="text-gray2">任务进度</span>
              <span className="ml-auto font-num">{summary.done}/{summary.total} · {summary.percent}%</span>
            </div>
            <div className="h-2 bg-bg rounded">
              <div className="h-full bg-amber rounded transition-all" style={{ width: `${summary.percent}%` }}></div>
            </div>
            {summary.blocked > 0 && (
              <div className="text-caption text-red-fg mt-2">{summary.blocked} 项阻塞中, 优先处理</div>
            )}
          </section>
        )}

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

        {/* 任务清单 */}
        <section>
          <div className="flex items-center mb-2">
            <h2 className="text-h2 flex-1">任务清单</h2>
            <button onClick={() => setShowAdd(true)}
              className="text-button text-amber-fg">+ 新增</button>
          </div>

          {tasks.length === 0 ? (
            <div className="bg-white rounded-card border border-border p-6 text-center">
              <div className="text-caption text-gray3 mb-3">还没有任务清单</div>
              <button onClick={seedTemplate} disabled={seeding}
                className="px-4 py-2 bg-amber text-white rounded-cta text-button disabled:opacity-40">
                {seeding ? '生成中…' : '使用默认模板 (30 项)'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {CATEGORY_ORDER.map(cat => {
                const list = grouped[cat] || []
                if (list.length === 0) return null
                const doneCount = list.filter(t => t.status === 'DONE').length
                return (
                  <div key={cat} className="bg-white rounded-card border border-border">
                    <div className="px-3 py-2 border-b border-border flex items-center">
                      <span className="text-button">{CATEGORY_LABEL[cat]}</span>
                      <span className="ml-auto text-micro text-gray3 font-num">{doneCount}/{list.length}</span>
                    </div>
                    <ul className="divide-y divide-border">
                      {list.map(t => (
                        <li key={t.id} className="p-3">
                          <div className="flex items-start gap-2">
                            <button
                              onClick={() => patchTask(t.id, { status: t.status === 'DONE' ? 'TODO' : 'DONE' })}
                              className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                                t.status === 'DONE' ? 'bg-amber border-amber text-white' : 'border-border'
                              }`}>
                              {t.status === 'DONE' && '✓'}
                            </button>
                            <div className="flex-1 min-w-0">
                              <div className={`text-body ${t.status === 'DONE' ? 'line-through text-gray3' : ''}`}>
                                {t.name}
                              </div>
                              {t.description && <div className="text-micro text-gray3 mt-0.5">{t.description}</div>}
                              <div className="flex items-center gap-2 mt-1.5">
                                <span className={`text-micro px-1.5 py-0.5 rounded ${STATUS_COLOR[t.status]}`}>
                                  {STATUS_LABEL[t.status]}
                                </span>
                                {t.cost != null && (
                                  <span className="text-micro text-gray3 font-num">¥{Number(t.cost).toLocaleString()}</span>
                                )}
                                {t.blockerNote && (
                                  <span className="text-micro text-red-fg truncate">⚠ {t.blockerNote}</span>
                                )}
                              </div>
                            </div>
                            {t.status !== 'DONE' && t.status !== 'CANCELED' && (
                              <button
                                onClick={() => { setBlockerTarget(t); setBlockerText(t.blockerNote || '') }}
                                className="text-micro text-gray3">
                                ⚠
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {/* 添加任务 sheet */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setShowAdd(false)}>
          <div className="w-full bg-white rounded-t-2xl p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">新增任务</h2>
              <button onClick={() => setShowAdd(false)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <form onSubmit={addTask} className="space-y-3">
              <select value={addForm.category} onChange={e => setAddForm({...addForm, category: e.target.value})}
                className="w-full bg-bg rounded p-2 outline-none text-body">
                {CATEGORY_ORDER.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
              <input value={addForm.name} onChange={e => setAddForm({...addForm, name: e.target.value})}
                className="w-full bg-bg rounded p-2 outline-none text-body"
                placeholder="任务名称, 例如「招牌灯箱安装」" />
              <textarea value={addForm.description} onChange={e => setAddForm({...addForm, description: e.target.value})}
                rows={2} className="w-full bg-bg rounded p-2 outline-none text-body resize-none"
                placeholder="备注 (选填)" />
              <button type="submit" className="w-full py-3 bg-amber text-white rounded-cta text-button">
                创建任务
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 阻塞 sheet */}
      {blockerTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setBlockerTarget(null)}>
          <div className="w-full bg-white rounded-t-2xl p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">标记阻塞 · {blockerTarget.name}</h2>
              <button onClick={() => setBlockerTarget(null)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <textarea value={blockerText} onChange={e => setBlockerText(e.target.value)}
              rows={3} maxLength={300}
              className="w-full bg-bg rounded p-2 outline-none text-body resize-none mb-3"
              placeholder="说明卡住原因, 老板能看到" />
            <button onClick={submitBlocker}
              className="w-full py-3 bg-red-fg text-white rounded-cta text-button">
              确认阻塞
            </button>
            {blockerTarget.status === 'BLOCKED' && (
              <button onClick={async () => {
                await patchTask(blockerTarget.id, { status: 'IN_PROGRESS', blockerNote: null })
                setBlockerTarget(null)
              }} className="w-full py-2 mt-2 text-button text-amber-fg">
                解除阻塞
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
