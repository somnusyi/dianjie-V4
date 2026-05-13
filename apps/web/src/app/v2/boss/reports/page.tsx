/**
 * 老板 App · 报表 Tab  PDF: boss_reports  Tab 3/5
 * 真实数据: 近 6 月集团营收 (并行 6 次 /api/revenue/summary)
 * 柱状图 layout 修复 (h-32 容器内 bar 用 absolute 高度避免被 label 挤压)
 * 类目分布暂保 mock, 标记「演示数据」
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BottomNav, StackedBar, PeriodPills } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { apiFetch } from '@/lib/v2-auth'

const CATEGORIES = [
  { name: '锅底',  rev: 575, pct: 28 },
  { name: '肉类',  rev: 494, pct: 24 },
  { name: '海鲜',  rev: 369, pct: 18 },
  { name: '蔬菜',  rev: 287, pct: 14 },
  { name: '饮品',  rev: 226, pct: 11 },
  { name: '小吃',  rev: 104, pct:  5 },
]

type MonthRow = { month: string; label: string; revK: number; current: boolean }

// 业务真实数据起点 — 早于此月份是 seed 错位数据, 数据 fetch 时跳过(显示 ¥0)
const BUSINESS_START = '2026-04'

function recentMonths(n: number): { ym: string; label: string; preBiz: boolean }[] {
  const out: { ym: string; label: string; preBiz: boolean }[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    out.push({ ym, label: `${String(d.getMonth() + 1).padStart(2, '0')}月`, preBiz: ym < BUSINESS_START })
  }
  return out
}

export default function BossReportsPage() {
  const [period, setPeriod] = useState('month')
  const [tab] = useState('reports')
  const [months, setMonths] = useState<MonthRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const list = recentMonths(6)
    Promise.all(
      list.map(m => m.preBiz
        ? Promise.resolve({ total: 0 })
        : apiFetch<any>(`/api/revenue/summary?month=${m.ym}`).catch(() => ({ total: 0 }))
      )
    ).then(rs => {
      const cur = list[list.length - 1].ym
      setMonths(rs.map((r, i) => ({
        month: list[i].ym,
        label: list[i].label,
        revK: Math.round(Number(r?.total || 0) / 1000),
        current: list[i].ym === cur,
      })))
    }).catch(e => setError(e.message))
  }, [])

  const maxRev = useMemo(() => {
    if (!months || months.length === 0) return 1
    return Math.max(1, ...months.map(m => m.revK))
  }, [months])
  const cur = months?.[months.length - 1]
  const prev = months?.[months.length - 2]
  const delta = cur && prev && prev.revK > 0
    ? Math.round((cur.revK - prev.revK) / prev.revK * 100)
    : null

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">报表</h1>
          <p className="text-caption text-gray3">集团 · {cur?.label || '本月'} 报告</p>
        </div>
        <button className="px-3 py-1.5 rounded-cta bg-white border border-border text-button text-gray2 opacity-50">导出 PDF ⤓</button>
      </header>

      <div className="px-4 mt-2 flex items-center gap-2">
        <PeriodPills
          value={period} onChange={setPeriod}
          options={[
            { label: '日报', value: 'day' },
            { label: '周报', value: 'week' },
            { label: '月报', value: 'month' },
            { label: '季报', value: 'quarter' },
          ]}
        />
      </div>

      <div className="mt-3">
        <GlanceStrip
          label={`${cur?.label || '本月'} 集团营收`}
          value={cur ? `¥${cur.revK.toLocaleString()}K` : '加载中…'}
          delta={delta != null
            ? { text: `${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}% 较 ${prev?.label}`, trend: delta >= 0 ? 'up' : 'down' }
            : undefined}
          meta={cur ? `近 6 月累计 ¥${months!.reduce((s, m) => s + m.revK, 0).toLocaleString()}K` : ''}
        />
      </div>

      <Section title="月度营收(近 6 月)" right="单位 K">
        <div className="bg-white rounded-card border border-border p-4">
          {months === null ? (
            <p className="text-caption text-gray3 text-center py-8">加载中…</p>
          ) : (
            <div className="flex items-end gap-2" style={{ height: 140 }}>
              {months.map((m) => {
                const h = m.revK > 0 ? Math.max(8, (m.revK / maxRev) * 100) : 0
                return (
                  <div key={m.month} className="flex-1 flex flex-col items-center" style={{ height: '100%' }}>
                    <span className="text-micro font-num mb-1">{m.revK}</span>
                    <div className="flex-1 w-full flex items-end">
                      <div
                        className={`w-full rounded-t transition-all ${m.current ? 'bg-ink' : 'bg-gray4'}`}
                        style={{ height: `${h}%`, minHeight: m.revK > 0 ? 4 : 0 }}
                      />
                    </div>
                    <span className="text-micro text-gray3 mt-1">{m.label}</span>
                  </div>
                )
              })}
            </div>
          )}
          {error && <p className="text-caption text-red-fg mt-2">加载失败: {error}</p>}
        </div>
      </Section>

      <Section title="集团成本结构(本月)" right="vs 上月">
        <div className="bg-white rounded-card border border-border p-4">
          <StackedBar
            segments={[
              { label: '食材', pct: 28, deltaPp: -1 },
              { label: '人工', pct: 24, deltaPp:  1 },
              { label: '租金', pct: 18, deltaPp:  0 },
              { label: '其他', pct: 14, deltaPp:  1 },
              { label: '水电营销', pct: 8, deltaPp:  0 },
            ]}
            showProfit={{ label: '净利', pct: 7.7, deltaPp: 0.3 }}
          />
          <p className="text-micro text-gray3 mt-3">⚠️ 演示比例 · 待集团成本聚合接口接入</p>
        </div>
      </Section>

      <Section title="营收类目分布" right="演示">
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {CATEGORIES.map((c) => (
            <li key={c.name} className="px-3 py-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-h2">{c.name}</span>
                <span className="font-num text-h2">¥{c.rev}K <span className="text-gray3 text-caption font-normal">{c.pct}%</span></span>
              </div>
              <div className="h-1.5 bg-bg rounded-full overflow-hidden">
                <div className="h-full bg-gray2" style={{ width: `${c.pct}%` }} />
              </div>
            </li>
          ))}
        </ul>
        <p className="px-1 mt-2 text-micro text-gray3">⚠️ 演示数据 · 接 POS 后替换为真实菜品销售</p>
      </Section>

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
          if (k === 'home')     location.href = '/v2/boss/home'
          if (k === 'stores')   location.href = '/v2/boss/stores'
          if (k === 'approval') location.href = '/v2/boss/approvals'
          if (k === 'me')       location.href = '/v2/me'
        }}
      />
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className="text-caption text-gray3">{right}</span>}
      </div>
      {children}
    </section>
  )
}
