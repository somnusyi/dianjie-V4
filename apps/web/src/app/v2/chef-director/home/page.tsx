/**
 * 总厨 App · 工作台  PDF: chef_director_workbench  Tab 1/4
 * Hero "待审批 7" 对称老板/财务模板 · 集团损耗率 / 异常店 / 库存总值 铁三角 · 各店物料健康度
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, StoreAvatar, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { Sparkline } from '@/components/v2/sparkline'
import { UserMenu } from '@/components/v2/user-menu'
import { useDashboard, LoadingScreen, ErrorScreen, greetingFor } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type InboxItem = {
  stepId: string; seq: number
  document: {
    id: string; no: string; type: string; title: string
    amount: string | number | null
    store?: { name: string } | null
    initiator?: { name: string; role: string } | null
    createdAt: string
  }
}
type LossClaim = {
  id: string; no: string; status: string
  totalLossAmount: string | number
  isManual?: boolean
  store?: { name: string } | null
  supplier?: { name: string } | null
}

const TYPE_LABEL: Record<string, string> = {
  PRICE_ADJUSTMENT: '调价', NEW_SUPPLIER: '新供应商', NEW_DISH: '新菜品',
  CONTRACT: '合同',
}
function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

export default function ChefDirectorHomePage() {
  const [tab, setTab] = useState('home')
  const { data, error } = useDashboard()
  const [inbox, setInbox] = useState<InboxItem[] | null>(null)
  const [losses, setLosses] = useState<LossClaim[] | null>(null)
  useEffect(() => {
    apiFetch<InboxItem[]>('/api/documents/inbox')
      .then(d => setInbox(Array.isArray(d) ? d : []))
      .catch(() => setInbox([]))
    apiFetch<LossClaim[]>('/api/loss-claims?limit=50')
      .then(d => setLosses(Array.isArray(d) ? d : []))
      .catch(() => setLosses([]))
  }, [])
  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />
  const { greeting, today } = greetingFor(data.user?.name)

  // 各店报损聚合
  const storeMap: Record<string, { name: string; pendingCount: number; totalLoss: number }> = {}
  ;(losses || []).forEach(l => {
    const name = l.store?.name || '集团'
    if (!storeMap[name]) storeMap[name] = { name, pendingCount: 0, totalLoss: 0 }
    if (l.status === 'PENDING' || l.status === 'NEGOTIATING') storeMap[name].pendingCount++
    storeMap[name].totalLoss += Number(l.totalLossAmount)
  })
  const storeRank = Object.values(storeMap).sort((a, b) => b.totalLoss - a.totalLoss)
  const anomalyCount = storeRank.filter(s => s.totalLoss > 500).length
  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <p className="text-caption text-gray2">{greeting}</p>
          <h1 className="text-h1">集团总厨工作台</h1>
          <p className="text-caption text-gray3 mt-0.5">集团督导 · {today}</p>
        </div>
        <UserMenu />
      </header>

      <div className="mt-3">
        <GlanceStrip
          {...(data.hero as any)}
          sparkline={data.hero?.revenue7d && data.hero.revenue7d.length > 1
            ? <Sparkline data={data.hero.revenue7d} />
            : undefined}
        />
      </div>

      <Section title="待我处理" right={(inbox?.length || 0) > 0 ? `${inbox?.length} 项` : undefined} rightTone="orange">
        {inbox === null && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {inbox !== null && inbox.length === 0 && (
          <p className="text-caption text-gray3 text-center py-4">✓ 无待审批</p>
        )}
        <ul className="space-y-2">
          {(inbox || []).slice(0, 5).map(it => (
            <li key={it.stepId} className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-orange">
              <div className="flex gap-2 items-center mb-1">
                <Chip tone="orange">{TYPE_LABEL[it.document.type] || '审批'}</Chip>
                <span className="text-micro text-gray3 ml-auto">{timeAgo(it.document.createdAt)}</span>
              </div>
              <a href="/v2/chef-director/approvals" className="block">
                <div className="text-h2">{it.document.title}</div>
                <p className="text-caption text-gray2 mt-0.5">
                  {it.document.store?.name && `${it.document.store.name} · `}
                  {it.document.initiator?.name && `${it.document.initiator.name} 发起`}
                </p>
              </a>
            </li>
          ))}
        </ul>
        {(inbox?.length || 0) > 0 && (
          <a href="/v2/chef-director/approvals" className="block text-center w-full mt-2 py-3 bg-white border border-border rounded-cta text-button text-gray2">查看全部 ›</a>
        )}
      </Section>

      {/* 报损争议仲裁入口 (供应商拒赔后到这) */}
      <Section title="报损争议" right={(losses || []).filter(l => l.status === 'REJECTED').length > 0 ? `${(losses || []).filter(l => l.status === 'REJECTED').length} 待裁` : ''} rightTone="red">
        <a href="/v2/chef-director/disputes" className="block bg-white rounded-card border border-border p-3">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-md bg-red-bg text-red-fg flex items-center justify-center text-h2">⚖</span>
            <div className="flex-1">
              <div className="text-h2">争议报损仲裁</div>
              <p className="text-caption text-gray2 mt-0.5">供应商拒绝的报损 → 你拍板最终扣减</p>
            </div>
            <span className="text-gray3">›</span>
          </div>
        </a>
      </Section>

      {/* 代店下单入口 — 跨店调度 / 紧急补货 / 厨师长不在线时支援 */}
      <Section title="代店下单">
        <a href="/v2/chef-director/purchase/new" className="block bg-white rounded-card border border-border p-3">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-md bg-amber-bg text-amber-fg flex items-center justify-center text-h2">📦</span>
            <div className="flex-1">
              <div className="text-h2">为门店代下采购单</div>
              <p className="text-caption text-gray2 mt-0.5">跨店调度 / 紧急补货 · 操作记录会标「总厨代下」</p>
            </div>
            <span className="text-gray3">›</span>
          </div>
        </a>
      </Section>

      <Section title="各店报损排行" right={`${storeRank.length} 家店 · ${anomalyCount} 异常`} rightTone={anomalyCount > 0 ? 'orange' : undefined}>
        {losses === null && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {losses !== null && storeRank.length === 0 && (
          <p className="text-caption text-gray3 text-center py-4">✓ 暂无报损 · 库存健康</p>
        )}
        <ul className="space-y-2">
          {storeRank.slice(0, 5).map((s, i) => {
            const isAnomaly = s.totalLoss > 500
            return (
              <li key={s.name} className={`relative rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${isAnomaly ? 'before:bg-red bg-red-bg' : 'before:bg-gray4 bg-white'}`}>
                <a href="/v2/chef-director/loss" className="flex items-center gap-3">
                  <StoreAvatar name={s.name} anomaly={isAnomaly} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-h2 truncate">{s.name}</span>
                      {isAnomaly && <Chip tone="red">异常</Chip>}
                    </div>
                    <p className="text-caption text-gray2 mt-0.5">
                      累计损失 ¥{Math.round(s.totalLoss).toLocaleString()}
                      {s.pendingCount > 0 && ` · ${s.pendingCount} 笔待处理`}
                    </p>
                  </div>
                  <span className="text-gray3">›</span>
                </a>
              </li>
            )
          })}
        </ul>
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
          if (k === 'review')   location.href = '/v2/chef-director/approvals'
          if (k === 'material') location.href = '/v2/chef-director/inventory'
          if (k === 'loss')     location.href = '/v2/chef-director/loss'
        }}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red' | 'orange'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'orange' ? 'text-orange-fg' : rightTone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
