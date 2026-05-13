/**
 * 总厨 App · 报损 Tab  PDF: chef_director_loss_tab  Tab 4/4
 * 接真数据 · /api/loss-claims (近 30 天)
 * Hero 集团损耗率 + 各店排行 + 异常报损待督导
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BottomNav, StoreAvatar, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { apiFetch } from '@/lib/v2-auth'

type LossClaim = {
  id: string
  no: string
  totalLossAmount: string | number
  description: string
  status: 'PENDING' | 'APPROVED' | 'AUTO_APPROVED' | 'NEGOTIATING' | 'REJECTED' | 'RESOLVED'
  createdAt: string
  store?: { name: string } | null
  supplier?: { name: string } | null
  purchaseOrder?: { no: string } | null
  createdBy?: { name: string } | null
}
const STATUS_LABEL: Record<string, string> = {
  PENDING: '待处理', APPROVED: '已同意', AUTO_APPROVED: '自动批准',
  NEGOTIATING: '协商中', REJECTED: '已拒绝', RESOLVED: '已结清',
}
const STATUS_TONE: Record<string, 'gray' | 'orange' | 'green' | 'red'> = {
  PENDING: 'orange', APPROVED: 'green', AUTO_APPROVED: 'green',
  NEGOTIATING: 'orange', REJECTED: 'red', RESOLVED: 'gray',
}
function fmtDate(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function ChefDirectorLossPage() {
  const [tab] = useState('loss')
  const [items, setItems] = useState<LossClaim[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<LossClaim[]>('/api/loss-claims?limit=200')
      .then(rows => {
        // 过滤业务上线前的 seed 异常数据 (2026-04 起为真实业务)
        const cutoff = new Date('2026-04-01').getTime()
        const clean = (rows || []).filter(r => new Date(r.createdAt).getTime() >= cutoff)
        setItems(clean)
      })
      .catch(e => setError(e.message))
  }, [])

  const stats = useMemo(() => {
    if (!items) return null
    const now = Date.now()
    const week = items.filter(i => now - new Date(i.createdAt).getTime() < 7 * 86400000)
    const month = items.filter(i => now - new Date(i.createdAt).getTime() < 30 * 86400000)
    const weekTotal = week.reduce((s, i) => s + Number(i.totalLossAmount), 0)
    const monthTotal = month.reduce((s, i) => s + Number(i.totalLossAmount), 0)
    const pending = items.filter(i => i.status === 'PENDING' || i.status === 'NEGOTIATING')
    return { week, month, weekTotal, monthTotal, pending, total: items.length }
  }, [items])

  // 按店聚合排名
  const storeRank = useMemo(() => {
    if (!items) return []
    const map: Record<string, { name: string; total: number; count: number }> = {}
    items.forEach(i => {
      const name = i.store?.name || '集团'
      if (!map[name]) map[name] = { name, total: 0, count: 0 }
      map[name].total += Number(i.totalLossAmount)
      map[name].count += 1
    })
    return Object.values(map).sort((a, b) => b.total - a.total)
  }, [items])

  // 待督导异常: PENDING/NEGOTIATING + 大额 (>=200)
  const abnormal = useMemo(() => {
    if (!items) return []
    return items.filter(i =>
      i.status === 'PENDING' || i.status === 'NEGOTIATING' || Number(i.totalLossAmount) >= 200
    ).slice(0, 5)
  }, [items])

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">报损</h1>
          <p className="text-caption text-gray3">集团 · 近 30 天</p>
        </div>
      </header>

      <div className="mt-3">
        <GlanceStrip
          label="近 30 天报损金额"
          value={stats ? `¥${stats.monthTotal.toLocaleString()}` : '加载中…'}
          delta={stats && stats.weekTotal > 0
            ? { text: `本周 ¥${stats.weekTotal.toLocaleString()}`, trend: 'flat' }
            : undefined}
          meta={stats ? `共 ${stats.total} 笔 · 待我督导 ${stats.pending.length} 笔` : ''}
          stats={stats ? [
            { label: '本周笔数', value: `${stats.week.length} 笔`, tone: 'default' },
            { label: '待处理',   value: `${stats.pending.length}`, tone: stats.pending.length > 0 ? 'orange' : 'default' },
            { label: '涉及门店', value: `${storeRank.length}`,     tone: 'default' },
          ] : []}
        />
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">加载失败: {error}</div>}

      <Section title="待督导报损" right={`${abnormal.length} 项` } rightTone={abnormal.length > 0 ? 'red' : undefined}>
        {items === null && <p className="text-caption text-gray3 text-center py-6">加载中…</p>}
        {items !== null && abnormal.length === 0 && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无待督导的异常报损</p>
          </div>
        )}
        {abnormal.length > 0 && (
          <ul className="space-y-2">
            {abnormal.map(a => {
              const tone = a.status === 'PENDING' || a.status === 'NEGOTIATING'
                ? 'orange' : (Number(a.totalLossAmount) >= 200 ? 'red' : 'gray')
              return (
                <li key={a.id} className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${tone === 'red' ? 'before:bg-red' : tone === 'orange' ? 'before:bg-orange' : 'before:bg-gray4'}`}>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Chip tone={STATUS_TONE[a.status] || 'gray'}>{STATUS_LABEL[a.status] || a.status}</Chip>
                    {Number(a.totalLossAmount) >= 200 && <Chip tone="red">大额</Chip>}
                    <span className="text-micro text-gray3 ml-auto">{fmtDate(a.createdAt)} · {a.no}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-h2">{a.store?.name || '—'}</span>
                    <span className="font-num text-h2">¥{Number(a.totalLossAmount).toLocaleString()}</span>
                  </div>
                  <p className="text-caption text-gray2 mt-0.5">
                    {a.purchaseOrder?.no || '—'} · {a.supplier?.name || '—'} · {a.createdBy?.name || '—'} 发起
                  </p>
                  {a.description && <p className="text-micro text-gray3 mt-1 line-clamp-2">{a.description}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section title="各店报损排行" right={`${storeRank.length} 家店`}>
        {storeRank.length === 0 ? (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3">暂无报损数据</p>
          </div>
        ) : (
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {storeRank.slice(0, 8).map((s, i) => (
              <li key={s.name} className="px-3 py-3 flex items-center gap-3">
                <span className="font-num text-gray3 w-4 text-right text-caption">{i + 1}</span>
                <StoreAvatar name={s.name} anomaly={i === 0 && storeRank.length > 1} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-h2 truncate">{s.name}</span>
                    {i === 0 && storeRank.length > 1 && <Chip tone="red">最高</Chip>}
                  </div>
                  <p className="text-micro text-gray3">{s.count} 笔</p>
                </div>
                <span className="font-num text-h2">¥{s.total.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="说明" right="">
        <div className="bg-white rounded-card border border-border p-3 text-micro text-gray3">
          报损来源: 厨师长收货短量自动生成 + 厨师长手动报损(临期/变质等)。供应商 24h 内不响应自动转您终审。
        </div>
      </Section>

      <BottomNav
        tabs={[
          { key: 'home',     label: '工作台', icon: '⌂' },
          { key: 'review',   label: '审批',   icon: '✓' },
          { key: 'material', label: '物料',   icon: '⛁' },
          { key: 'loss',     label: '报损',   icon: '△' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')     location.href = '/v2/chef-director/home'
          if (k === 'review')   location.href = '/v2/chef-director/approvals'
          if (k === 'material') location.href = '/v2/chef-director/inventory'
        }}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
