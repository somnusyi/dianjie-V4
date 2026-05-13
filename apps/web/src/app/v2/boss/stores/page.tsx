/**
 * 老板 App · 门店列表  Tab 2/5
 * 接 /api/v2/dashboard/me → storesOverview (本月真实营收)
 *
 * 净利字段 (net / netRate) 暂未从后端返回，先隐藏；
 * 后续后端有 /api/profit/group 之类批量端点再补齐。
 */
'use client'
import { useState, useEffect } from 'react'
import { BottomNav, StoreAvatar, Chip, PeriodPills } from '@/components/v2'
import { EmptyState, SkeletonCard, FriendlyError } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'

type StoreRow = {
  id: string
  rank: number
  name: string
  revenue: string
  revenueRaw: number
  growth: string
  anomaly: boolean
}

export default function BossStoresPage() {
  const [period, setPeriod] = useState('month')
  const [tab, setTab] = useState('stores')
  const [sortBy, setSortBy] = useState<'revenue' | 'anomaly'>('revenue')
  const [stores, setStores] = useState<StoreRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<any>('/api/v2/dashboard/me')
      .then(d => setStores((d.storesOverview as StoreRow[]) || []))
      .catch(e => setError(String(e?.message || e)))
  }, [])

  const sorted = (stores || []).slice().sort((a, b) => {
    if (sortBy === 'revenue') return b.revenueRaw - a.revenueRaw
    return Number(b.anomaly) - Number(a.anomaly)
  })
  const max = Math.max(...sorted.map(s => s.revenueRaw), 1)
  const totalActive = sorted.filter(s => s.revenueRaw > 0).length

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">门店</h1>
          <p className="text-caption text-gray3">
            {stores
              ? `${stores.length} 家店 · 本月 · ${totalActive} 家有营收`
              : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/v2/boss/stores/new" className="px-3 h-9 rounded-full bg-amber text-white flex items-center text-button" aria-label="新建门店">+ 新建</a>
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center" aria-label="搜索">⌕</button>
        </div>
      </header>

      <div className="px-4 mt-2">
        <PeriodPills
          value={period} onChange={setPeriod}
          options={[
            { label: '本周', value: 'week' },
            { label: '本月', value: 'month' },
            { label: 'YTD',  value: 'ytd' },
          ]}
        />
        <p className="text-micro text-gray3 mt-1">时间窗切换接入中, 当前固定本月</p>
      </div>

      <div className="px-4 mt-3 flex items-center justify-between text-caption">
        <span className="text-gray2">按{sortBy === 'revenue' ? '营收' : '异常'}排序</span>
        <div className="flex gap-1">
          {(['revenue','anomaly'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`px-2 py-0.5 rounded-chip text-micro ${sortBy === s ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}
            >
              {s === 'revenue' ? '营收 ↓' : '异常'}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="px-4 mt-2"><FriendlyError message={error} /></div>
      ) : !stores ? (
        <div className="px-4 mt-2 space-y-2">
          {[1,2,3,4].map(i => <SkeletonCard key={i} />)}
        </div>
      ) : sorted.length === 0 ? (
        <div className="px-4 mt-4">
          <EmptyState icon="🏪" title="还没有门店" hint="点右上角「+ 新建」创建第一家店" />
        </div>
      ) : (
        <ul className="px-4 mt-2 space-y-2">
          {sorted.map((s) => (
            <li key={s.id}>
              <a href={`/v2/boss/stores/${encodeURIComponent(s.id)}`} className="block bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-3">
                  <span className="font-num text-gray3 w-4 text-right text-caption">{s.rank}</span>
                  <StoreAvatar name={s.name} anomaly={s.anomaly} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-h2 truncate">{s.name}</span>
                      {s.anomaly && <Chip tone="red">异常</Chip>}
                    </div>
                    <p className={`text-caption mt-0.5 ${s.anomaly ? 'text-red-fg' : 'text-gray2'}`}>{s.growth}</p>
                  </div>
                  <div className="text-right">
                    <div className="font-num text-h2">{s.revenue}</div>
                    <div className="text-caption text-gray3">本月</div>
                  </div>
                </div>
                {/* mini bar */}
                <div className="mt-2 h-1 bg-bg rounded-full overflow-hidden">
                  <div className={`h-full ${s.anomaly ? 'bg-red' : 'bg-gray2'}`} style={{ width: `${(s.revenueRaw / max) * 100}%` }} />
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}

      <BottomNav
        tabs={[
          { key: 'home', label: '首页', icon: '⌂' },
          { key: 'stores', label: '门店', icon: '☷' },
          { key: 'reports', label: '报表', icon: '⛁' },
          { key: 'approval', label: '审批', icon: '✓' },
          { key: 'me', label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          setTab(k)
          if (k === 'home') location.href = '/v2/boss/home'
          if (k === 'approval') location.href = '/v2/boss/approvals'
          if (k === 'reports') location.href = '/v2/boss/reports'
          if (k === 'me') location.href = '/v2/me'
        }}
      />
    </div>
  )
}
