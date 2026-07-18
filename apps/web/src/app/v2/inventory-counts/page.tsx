'use client'

import { useEffect, useState } from 'react'
import { apiFetch, getUser, routeForRole } from '@/lib/v2-auth'

type CountRow = {
  id: string; no: string; countDate: string; revision: number; status: string
  itemCount: number; countedCount: number; differenceCount: number
  totalDifferenceValue: number; rowVersion: number
  recordType?: 'ONLINE_COUNT' | 'IMPORTED_BASELINE'
  sourceFilename?: string | null
  store: { id: string; no: string; name: string }
}

const STATUS: Record<string, { label: string; style: string }> = {
  DRAFT: { label: '待开始', style: 'bg-bg text-gray2' },
  COUNTING: { label: '盘点中', style: 'bg-amber-bg text-amber-fg' },
  REVIEWING: { label: '待确认', style: 'bg-blue/10 text-blue-fg' },
  CONFIRMED: { label: '已确认', style: 'bg-green-bg text-green-fg' },
  CANCELLED: { label: '已取消', style: 'bg-bg text-gray3' },
  REVERSED: { label: '已冲销', style: 'bg-red-bg text-red-fg' },
  BASELINE: { label: '历史基准', style: 'bg-blue/10 text-blue-fg' },
}

function yesterday() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000)
  shifted.setUTCDate(shifted.getUTCDate() - 1)
  return shifted.toISOString().slice(0, 10)
}

export default function InventoryCountsPage() {
  const [role, setRole] = useState<string | null | undefined>(undefined)
  const [rows, setRows] = useState<CountRow[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [countDate, setCountDate] = useState(yesterday())
  const user = getUser()
  const back = user ? routeForRole(user.role) : '/v2/login'
  const allowed = role != null && ['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN', 'BOSS'].includes(role)

  const load = () => apiFetch<CountRow[]>('/api/inventory-counts').then(setRows).catch(error => setError(error.message))
  useEffect(() => { setRole(getUser()?.role || null) }, [])
  useEffect(() => { if (allowed) load() }, [allowed])

  const create = async () => {
    setBusy(true); setError('')
    try {
      const created = await apiFetch<CountRow>('/api/inventory-counts', {
        method: 'POST', body: JSON.stringify({ countDate }),
      })
      const started = await apiFetch<CountRow>(`/api/inventory-counts/${created.id}/start`, {
        method: 'POST', body: JSON.stringify({ rowVersion: created.rowVersion }),
      })
      location.href = `/v2/inventory-counts/${started.id}`
    } catch (error: any) {
      setError(error.message || '创建失败')
      await load()
    } finally { setBusy(false) }
  }

  if (role === undefined) return <div className="min-h-screen bg-bg flex items-center justify-center text-caption text-gray3">正在核验权限…</div>
  if (!allowed) return (
    <div className="min-h-screen bg-bg px-4 py-12">
      <div className="max-w-md mx-auto rounded-card bg-white border border-border p-6 text-center">
        <h1 className="text-h2">当前角色无权使用门店盘点</h1>
        <p className="text-caption text-gray3 mt-2">门店盘点仅向店长、厨师长、总厨及管理角色开放。</p>
        <a href={back} className="block mt-5 rounded-cta bg-ink text-white py-3 text-button">返回工作台</a>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-bg pb-10">
      <header className="px-4 py-3 border-b border-border flex items-center gap-3">
        <a href={back} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <div><h1 className="text-h1">门店在线盘点</h1><p className="text-micro text-gray3">全品项闭店盘点 · 与供应商账完全独立</p></div>
      </header>
      <main className="px-4">
        <section className="mt-4 rounded-card bg-white border border-border p-4">
          <div className="text-button">新建盘点单</div>
          <p className="text-caption text-gray2 mt-1">创建时冻结当前启用食材和账面预计数量；零库存也必须填 0。</p>
          <div className="flex gap-2 mt-3">
            <input type="date" value={countDate} max={new Date().toISOString().slice(0, 10)} onChange={event => setCountDate(event.target.value)}
              className="flex-1 rounded-cta border border-border bg-bg px-3 py-3 text-body" />
            <button onClick={create} disabled={busy || !countDate} className="px-5 rounded-cta bg-ink text-white text-button disabled:opacity-35">
              {busy ? '创建中…' : '开始盘点'}
            </button>
          </div>
        </section>

        {error && <div className="mt-3 rounded-card bg-red-bg text-red-fg p-3 text-caption">{error}</div>}

        <section className="mt-5">
          <div className="flex items-baseline justify-between mb-2"><h2 className="text-h2">盘点历史记录</h2><button onClick={load} className="text-caption text-amber-fg">刷新</button></div>
          <div className="space-y-2">
            {rows === null && <div className="text-caption text-gray3 text-center py-8">加载中…</div>}
            {rows?.length === 0 && <div className="rounded-card bg-white border border-border p-6 text-caption text-gray3 text-center">暂无盘点单</div>}
            {rows?.map(row => {
              const status = STATUS[row.status] || STATUS.DRAFT
              const card = (
                <>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-button truncate">{row.store.name} · {row.countDate}</div>
                      <div className="text-micro text-gray3 mt-1">
                        {row.recordType === 'IMPORTED_BASELINE'
                          ? `${row.sourceFilename || row.no} · ${row.itemCount} 个品项`
                          : `${row.no} · 第 ${row.revision} 版 · 已盘 ${row.countedCount}/${row.itemCount}`}
                      </div>
                    </div>
                    <span className={`text-micro rounded-chip px-2 py-1 ${status.style}`}>{status.label}</span>
                    {row.recordType !== 'IMPORTED_BASELINE' && <span className="text-gray3">›</span>}
                  </div>
                  {(row.status === 'REVIEWING' || row.status === 'CONFIRMED') && (
                    <div className="mt-2 pt-2 border-t border-border flex justify-between text-caption"><span className="text-gray3">差异 {row.differenceCount} 项</span><span className={row.totalDifferenceValue < 0 ? 'text-red-fg' : 'text-green-fg'}>¥{row.totalDifferenceValue.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</span></div>
                  )}
                </>
              )
              return row.recordType === 'IMPORTED_BASELINE'
                ? <div key={row.id} className="rounded-card bg-white border border-border p-3">{card}</div>
                : <a key={row.id} href={`/v2/inventory-counts/${row.id}`} className="block rounded-card bg-white border border-border p-3">{card}</a>
            })}
          </div>
        </section>
      </main>
    </div>
  )
}
