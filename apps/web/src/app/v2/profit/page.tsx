/**
 * 净利总览 · 多店选择 (集团视角)
 * 显示每家店本月净利 + 建店投入, 点进单店看 4 口径
 */
'use client'
import { useEffect, useState } from 'react'
import { getUser, getToken } from '@/lib/v2-auth'

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

export default function ProfitIndexPage() {
  const [u, setU] = useState<any>(null)
  const [list, setList] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const user = getUser()
    setU(user)
    if (!user) { location.replace('/v2/login'); return }
    if (!['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(user.role)) {
      location.replace('/v2/login'); return
    }
    fetch('/api/profit/group/snapshot', { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.json())
      .then(d => setList(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (!u) return null

  // 集团汇总
  const totalMonthRev = list.reduce((s, r) => s + r.monthRevenue, 0)
  const totalMonthNet = list.reduce((s, r) => s + r.monthNet, 0)
  const totalOpening = list.reduce((s, r) => s + r.openingCost, 0)

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/me" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1">净利总览</h1>
      </header>

      {/* 集团汇总 */}
      <div className="px-4 mt-2">
        <div className="bg-white rounded-card border border-border p-4">
          <div className="text-caption text-gray3">集团本月</div>
          <div className="grid grid-cols-3 gap-2 mt-2">
            <div>
              <div className="text-micro text-gray3">营收</div>
              <div className="text-h2 font-num mt-1">¥{fmtBig(totalMonthRev)}</div>
            </div>
            <div>
              <div className="text-micro text-gray3">净利</div>
              <div className={`text-h2 font-num mt-1 ${totalMonthNet < 0 ? 'text-red-fg' : 'text-amber-fg'}`}>
                {totalMonthNet < 0 ? '-' : ''}¥{fmtBig(Math.abs(totalMonthNet))}
              </div>
            </div>
            <div>
              <div className="text-micro text-gray3">建店投入</div>
              <div className="text-h2 font-num mt-1">¥{fmtBig(totalOpening)}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 mt-3 text-caption text-gray3">单店本月净利 (点进看月/季/年/累计)</div>

      <ul className="px-4 mt-2 space-y-2">
        {loading ? (
          <li className="text-caption text-gray3 text-center py-8">加载中…</li>
        ) : list.length === 0 ? (
          <li className="bg-white rounded-card border border-border p-6 text-center text-caption text-gray3">没有可见门店</li>
        ) : list.map(r => (
          <li key={r.id}>
            <a href={`/v2/profit/${r.id}`} className="block bg-white rounded-card border border-border p-3">
              <div className="flex items-center gap-2">
                <span className="text-button flex-1">{r.name}</span>
                <span className="text-micro text-gray3 font-num">{r.no}</span>
                <span className="text-micro px-1.5 py-0.5 rounded bg-bg text-gray2">{PHASE_LABEL[r.lifecyclePhase] || ''}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2">
                <div>
                  <div className="text-micro text-gray3">本月营收</div>
                  <div className="text-body font-num mt-0.5">¥{fmtBig(r.monthRevenue)}</div>
                </div>
                <div>
                  <div className="text-micro text-gray3">本月净利</div>
                  <div className={`text-body font-num mt-0.5 ${r.monthNet < 0 ? 'text-red-fg' : 'text-amber-fg'}`}>
                    {r.monthNet < 0 ? '-' : ''}¥{fmtBig(Math.abs(r.monthNet))}
                  </div>
                </div>
                <div>
                  <div className="text-micro text-gray3">建店投入</div>
                  <div className="text-body font-num mt-0.5">¥{fmtBig(r.openingCost)}</div>
                </div>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
