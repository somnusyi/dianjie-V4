/**
 * 财务 App · 各店 Tab
 * 真实数据: /api/profit/group/snapshot (本月营收 / 本月净利 / 建店投入)
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, StoreAvatar, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { getToken } from '@/lib/v2-auth'

const fmtBig = (n: number | null | undefined) => {
  if (n == null || isNaN(Number(n))) return '0'
  const v = Number(n)
  if (Math.abs(v) >= 100000000) return (v / 100000000).toFixed(2) + '亿'
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + '万'
  return Math.round(v).toLocaleString('zh-CN')
}

const PHASE_LABEL: Record<string, string> = {
  PLANNING: '选址', NEGOTIATING: '合同', CONSTRUCTION: '装修',
  EQUIPMENT: '设备', LICENSING: '证照', TRIAL: '试营业',
  OPERATING: '运营中', CLOSED: '已关',
}

type Row = {
  id: string; no: string; name: string
  lifecyclePhase: string
  monthRevenue: number; monthNet: number
  openingCost: number
}

export default function FinanceStoresPage() {
  const [list, setList] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/profit/group/snapshot', { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || '加载失败')
        setList(Array.isArray(d) ? d : [])
      })
      .catch(e => setError(e.message || '加载失败'))
  }, [])

  const totalRev = (list || []).reduce((s, r) => s + (r.monthRevenue || 0), 0)
  const totalNet = (list || []).reduce((s, r) => s + (r.monthNet || 0), 0)
  const totalOpening = (list || []).reduce((s, r) => s + (r.openingCost || 0), 0)
  const operating = (list || []).filter(r => r.lifecyclePhase === 'OPERATING')
  const planning  = (list || []).filter(r => r.lifecyclePhase !== 'OPERATING' && r.lifecyclePhase !== 'CLOSED')
  const anomalies = operating.filter(r => r.monthRevenue > 0 && r.monthNet < 0)
  const margin = totalRev > 0 ? (totalNet / totalRev * 100) : 0
  const monthLabel = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit' })

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">各店</h1>
        <p className="text-caption text-gray3">
          {list === null ? '加载中…' : `${list.length} 家 · ${monthLabel} · 财务视角`}
        </p>
      </header>

      {error && <div className="mx-4 mt-2 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <div className="px-4 mt-2">
        <GlanceStrip
          label="集团本月净利"
          value={`${totalNet < 0 ? '-' : ''}¥${fmtBig(Math.abs(totalNet))}`}
          delta={totalRev > 0 ? { text: `${margin.toFixed(1)}% 净利率`, trend: totalNet >= 0 ? 'up' as const : 'down' as const } : undefined}
          meta={`营收 ¥${fmtBig(totalRev)} · 建店累计 ¥${fmtBig(totalOpening)}`}
          rightSlot={monthLabel}
          stats={[
            { label: '运营中',     value: `${operating.length} 家`, tone: 'default' as const },
            { label: '筹建中',     value: `${planning.length} 家`, tone: 'default' as const },
            { label: '本月异常',   value: `${anomalies.length} 家`, tone: anomalies.length > 0 ? 'red' as const : 'default' as const },
          ]}
        />
      </div>

      {anomalies.length > 0 && (
        <div className="px-4 mt-3">
          <div className="text-caption text-gray3 mb-2">异常 · 本月净利亏损</div>
          {anomalies.map(r => (
            <a key={r.id} href={`/v2/profit/${r.id}`}
              className="block bg-red-bg border border-red/30 rounded-card p-3 mb-2">
              <div className="flex items-center gap-3 mb-2">
                <StoreAvatar name={r.name} anomaly />
                <div className="flex-1">
                  <div className="text-h2">{r.name}</div>
                  <div className="text-micro text-gray2 font-num">{r.no}</div>
                </div>
                <Chip tone="red">异常</Chip>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Metric label="本月营收" value={`¥${fmtBig(r.monthRevenue)}`} />
                <Metric label="本月净利" value={`-¥${fmtBig(Math.abs(r.monthNet))}`} red />
                <Metric label="建店投入" value={`¥${fmtBig(r.openingCost)}`} />
              </div>
            </a>
          ))}
        </div>
      )}

      {operating.length > 0 && (
        <div className="px-4 mt-3">
          <div className="text-caption text-gray3 mb-2">运营中 ({operating.length} 家)</div>
          <ul className="space-y-2">
            {operating.filter(r => !anomalies.find(a => a.id === r.id)).map(r => (
              <li key={r.id}>
                <a href={`/v2/profit/${r.id}`} className="block bg-white border border-border rounded-card p-3">
                  <div className="flex items-center gap-3">
                    <StoreAvatar name={r.name} />
                    <div className="flex-1">
                      <div className="text-button">{r.name}</div>
                      <div className="text-micro text-gray3 font-num">{r.no}</div>
                    </div>
                    <div className="text-right">
                      <div className={`font-num text-button ${r.monthNet < 0 ? 'text-red-fg' : r.monthRevenue > 0 ? 'text-amber-fg' : 'text-gray3'}`}>
                        {r.monthNet < 0 ? '-' : ''}¥{fmtBig(Math.abs(r.monthNet))}
                      </div>
                      <div className="text-micro text-gray3 font-num">营收 ¥{fmtBig(r.monthRevenue)}</div>
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {planning.length > 0 && (
        <div className="px-4 mt-3">
          <div className="text-caption text-gray3 mb-2">筹建中 ({planning.length} 家)</div>
          <ul className="space-y-2">
            {planning.map(r => (
              <li key={r.id}>
                <a href={`/v2/profit/${r.id}`} className="block bg-bg-warm border border-border/60 rounded-card p-3">
                  <div className="flex items-center gap-3">
                    <StoreAvatar name={r.name} />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-button">{r.name}</span>
                        <span className="text-micro px-1.5 py-0.5 rounded bg-bg text-gray2">
                          {PHASE_LABEL[r.lifecyclePhase] || r.lifecyclePhase}
                        </span>
                      </div>
                      <div className="text-micro text-gray3 font-num">{r.no}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-micro text-gray3">建店投入</div>
                      <div className="font-num text-button">¥{fmtBig(r.openingCost)}</div>
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {list !== null && list.length === 0 && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-8 text-center text-caption text-gray3">
          没有可见门店
        </div>
      )}

      <BottomNav
        tabs={[
          { key: 'home',   label: '工作台', icon: '⌂' },
          { key: 'review', label: '初审',   icon: '✓' },
          { key: 'funds',  label: '资金',   icon: '⛁' },
          { key: 'stores', label: '各店',   icon: '◧' },
        ]}
        activeKey="stores"
        onChange={(k) => {
          const map: Record<string, string> = {
            home: '/v2/finance/home',
            review: '/v2/finance/review',
            funds: '/v2/finance/funds',
            stores: '/v2/finance/stores',
          }
          if (map[k]) location.href = map[k]
        }}
      />
    </div>
  )
}

function Metric({ label, value, red }: { label: string; value: string; red?: boolean }) {
  return (
    <div>
      <div className="text-micro text-gray3">{label}</div>
      <div className={`font-num text-body mt-0.5 ${red ? 'text-red-fg' : ''}`}>{value}</div>
    </div>
  )
}
