/**
 * v2 单店净利总览
 * 4 口径: 月度 / 季度 / 年度 / 开店以来 (含建店成本)
 * 老板 / 财务 可见
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
const fmtPct = (n: number | null | undefined) => {
  if (n == null || isNaN(Number(n))) return '—'
  return `${Number(n).toFixed(1)}%`
}

type Bucket = {
  label: string
  revenue: number; foodCost: number; expensesTotal: number; platformFee: number
  openingCost?: number; openingPaid?: number
  netProfit: number; netMargin: number
}
type Snapshot = {
  store: { id: string; name: string; no: string }
  month: Bucket
  quarter: Bucket
  year: Bucket
  sinceOpen: Bucket & { startedAt: string }
}

export default function ProfitPage({ params }: { params: { storeId: string } }) {
  const { storeId } = params
  const [u, setU] = useState<any>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'month' | 'quarter' | 'year' | 'sinceOpen'>('month')

  useEffect(() => {
    setU(getUser())
    fetch(`/api/profit/store/${storeId}/snapshot`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || '加载失败')
        setSnap(d)
      })
      .catch(e => setError(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [storeId])

  if (!u) return null
  if (loading) return <div className="min-h-screen bg-bg flex items-center justify-center text-caption text-gray3">加载中…</div>
  if (error) return <div className="min-h-screen bg-bg p-4"><div className="bg-red-bg text-red-fg rounded-card p-4">{error}</div></div>
  if (!snap) return null

  const cur = snap[tab]
  const TABS: Array<[typeof tab, string, string]> = [
    ['month', '本月', snap.month.label],
    ['quarter', '本季', snap.quarter.label],
    ['year', '本年', snap.year.label],
    ['sinceOpen', '开店以来', snap.sinceOpen.label],
  ]
  const sinceStartDate = snap.sinceOpen.startedAt ? new Date(snap.sinceOpen.startedAt) : null

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/me" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <div className="flex-1 min-w-0">
          <h1 className="text-h1 truncate">净利总览</h1>
          <p className="text-caption text-gray3 mt-0.5 truncate">{snap.store.name}</p>
        </div>
      </header>

      {/* 4 口径切换 */}
      <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {TABS.map(([k, label, sub]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`shrink-0 px-3 py-2 rounded-cta text-button transition ${
              tab === k ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'
            }`}>
            <div>{label}</div>
            <div className={`text-micro mt-0.5 ${tab === k ? 'text-white/70' : 'text-gray3'}`}>{sub}</div>
          </button>
        ))}
      </div>

      {/* 主数字 */}
      <div className="px-4 mt-3">
        <div className="bg-white rounded-card border border-border p-4">
          <div className="text-caption text-gray3">{TABS.find(t => t[0] === tab)?.[1]}净利</div>
          <div className={`text-h1 font-num mt-1 ${cur.netProfit < 0 ? 'text-red-fg' : 'text-amber-fg'}`}>
            {cur.netProfit < 0 ? '-' : ''}¥{fmtBig(Math.abs(cur.netProfit))}
          </div>
          <div className="text-caption text-gray3 mt-0.5">净利率 {fmtPct(cur.netMargin)}</div>
        </div>
      </div>

      {/* 收入 / 成本拆分 */}
      <div className="px-4 mt-3">
        <div className="bg-white rounded-card border border-border divide-y divide-border">
          <Row label="营业额 (GMV)"  value={cur.revenue} tone="default" />
          {cur.platformFee > 0 && <Row label="└ 平台抽成" value={-cur.platformFee} tone="gray" indent />}
          <Row label="食材成本"      value={-cur.foodCost} tone="red" />
          <Row label="经营杂费"      value={-cur.expensesTotal} tone="red" sub="人工/水电/物业/管理 等" />
          {tab === 'sinceOpen' && cur.openingCost ? (
            <Row label="建店成本 (一次性)" value={-cur.openingCost} tone="red"
              sub={cur.openingPaid !== cur.openingCost ? `已付 ¥${fmtBig(cur.openingPaid)}, 未付 ¥${fmtBig((cur.openingCost || 0) - (cur.openingPaid || 0))}` : undefined} />
          ) : null}
          <Row label={`= 净利`} value={cur.netProfit} tone={cur.netProfit < 0 ? 'red' : 'amber'} bold />
        </div>
      </div>

      {/* sinceOpen 额外: 回本进度 */}
      {tab === 'sinceOpen' && cur.openingCost && cur.openingCost > 0 && (
        <div className="px-4 mt-3">
          <div className="bg-bg-warm rounded-card border border-border p-4">
            <div className="text-caption text-gray3">回本进度</div>
            {(() => {
              const recovered = cur.revenue - cur.foodCost - cur.expensesTotal  // 经营性净利
              const pct = recovered > 0 ? Math.min(100, (recovered / cur.openingCost) * 100) : 0
              return (
                <>
                  <div className="flex items-center mt-1">
                    <span className="text-h2 font-num">{pct.toFixed(1)}%</span>
                    <span className="ml-2 text-caption text-gray2">
                      经营净利 ¥{fmtBig(recovered)} / 建店 ¥{fmtBig(cur.openingCost)}
                    </span>
                  </div>
                  <div className="h-2 bg-bg rounded mt-2">
                    <div className={`h-full rounded transition-all ${pct >= 100 ? 'bg-emerald-500' : 'bg-amber'}`}
                         style={{ width: `${pct}%` }}></div>
                  </div>
                  {sinceStartDate && (
                    <div className="text-micro text-gray3 mt-2">
                      自 {sinceStartDate.toLocaleDateString('zh-CN')} 开业 · 共 {Math.ceil((Date.now() - sinceStartDate.getTime()) / 86400000)} 天
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}

      <div className="px-4 mt-3 text-micro text-gray3">
        说明: 本月/季/年净利仅含日常经营; 「开店以来」额外扣除建店一次性投入 (来源: 建店资金台账 实付/合同 列)
      </div>
    </div>
  )
}

function Row({ label, value, tone = 'default', sub, indent, bold }: {
  label: string; value: number
  tone?: 'default' | 'red' | 'amber' | 'gray'
  sub?: string
  indent?: boolean
  bold?: boolean
}) {
  const isNeg = value < 0
  const color = tone === 'red' ? 'text-red-fg'
    : tone === 'amber' ? 'text-amber-fg'
    : tone === 'gray' ? 'text-gray3'
    : 'text-ink'
  return (
    <div className={`flex items-start p-3 ${indent ? 'pl-8' : ''}`}>
      <div className="flex-1">
        <div className={`text-body ${bold ? 'font-medium' : ''} ${tone === 'gray' ? 'text-gray3' : ''}`}>{label}</div>
        {sub && <div className="text-micro text-gray3 mt-0.5">{sub}</div>}
      </div>
      <div className={`font-num ${bold ? 'text-h2 font-medium' : 'text-body'} ${color}`}>
        {isNeg ? '-' : ''}¥{fmtBig(Math.abs(value))}
      </div>
    </div>
  )
}

const fmtBigMoney = fmtBig
