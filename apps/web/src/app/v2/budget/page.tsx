/**
 * 建店资金台账 · 门店选择
 * FINANCE/ADMIN/BOSS 进来选店, 进入单店台账页
 */
'use client'
import { useEffect, useState } from 'react'
import { getUser, getToken } from '@/lib/v2-auth'

const PHASE_LABEL: Record<string, string> = {
  PLANNING: '选址', NEGOTIATING: '合同谈判', CONSTRUCTION: '装修',
  EQUIPMENT: '设备物料', LICENSING: '证照', TRIAL: '试营业',
  OPERATING: '已开业', CLOSED: '已关店',
}

export default function BudgetIndexPage() {
  const [u, setU] = useState<any>(null)
  const [stores, setStores] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const user = getUser()
    setU(user)
    if (!user) { location.replace('/v2/login'); return }
    if (!['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'ENGINEERING'].includes(user.role)) {
      location.replace('/v2/login')
      return
    }
    fetch('/api/stores', { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.json())
      .then(d => setStores(Array.isArray(d) ? d : (d.items || [])))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (!u) return null

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/me" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1">建店资金台账</h1>
      </header>

      <div className="px-4 mt-2 text-caption text-gray3">选择一家店查看预算</div>

      <ul className="px-4 mt-2 space-y-2">
        {loading ? (
          <li className="text-caption text-gray3 text-center py-8">加载中…</li>
        ) : stores.length === 0 ? (
          <li className="bg-white rounded-card border border-border p-6 text-center text-caption text-gray3">没有可见门店</li>
        ) : stores.map((s: any) => (
          <li key={s.id}>
            <a href={`/v2/budget/${s.id}`} className="block bg-white rounded-card border border-border p-3">
              <div className="flex items-center gap-2">
                <span className="text-button flex-1">{s.name}</span>
                <span className="text-micro text-gray3 font-num">{s.no}</span>
                <span className="text-micro px-1.5 py-0.5 rounded bg-bg text-gray2">
                  {PHASE_LABEL[s.lifecyclePhase] || ''}
                </span>
              </div>
              {s.address && <div className="text-micro text-gray3 mt-1 truncate">{s.address}</div>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
