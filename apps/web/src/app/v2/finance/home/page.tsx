/**
 * 财务 App · 工作台  PDF: finance_workbench  Tab 1/4
 * Hero "待我初审 12" 对称结构 · 财务铁三角 月现金流净/预收待结/应付待结 · "凭证待补" 红字 · 各店财务健康度
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
    id: string; no: string; type: string; title: string; amount: string | number | null
    isOverThreshold: boolean
    store?: { name: string } | null
    initiator?: { name: string; role: string } | null
    createdAt: string
  }
}
type Invoice = {
  id: string; invoiceNo: string; amount: string | number; status: string
  supplier: { name: string }
}
type DueSchedule = {
  id: string; amount: string | number; dueAt: string; status: string
  supplier: { name: string }
  receipt: { no: string; store?: { name: string } | null }
}

const TYPE_LABEL: Record<string, string> = {
  PETTY_CASH: '备用金', REIMBURSEMENT: '报销',
  PURCHASE_FOOD_REGULAR: '食材采购', PURCHASE_FOOD_OVER: '食材采购·超阈',
  PURCHASE_NON_FOOD: '采购', CONTRACT: '合同',
  STORE_TRANSFER: '调拨', MARKETING_BUDGET: '营销预算',
  PERSONNEL_PAY: '调薪',
}
function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

export default function FinanceHomePage() {
  const [tab, setTab] = useState('home')
  const { data, error } = useDashboard()
  const [inbox, setInbox] = useState<InboxItem[] | null>(null)
  const [pendingInv, setPendingInv] = useState<Invoice[] | null>(null)
  const [dueToday, setDueToday] = useState<DueSchedule[] | null>(null)
  useEffect(() => {
    apiFetch<InboxItem[]>('/api/documents/inbox')
      .then(d => setInbox(Array.isArray(d) ? d : []))
      .catch(() => setInbox([]))
    apiFetch<Invoice[]>('/api/invoices?status=PENDING')
      .then(d => setPendingInv(Array.isArray(d) ? d : []))
      .catch(() => setPendingInv([]))
    // 拉今日 + 已逾期的应付
    apiFetch<DueSchedule[]>('/api/schedules?days=1')
      .then(d => setDueToday(Array.isArray(d) ? d : []))
      .catch(() => setDueToday([]))
  }, [])
  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />
  const { greeting, today } = greetingFor(data.user?.name)
  const todoCount = (inbox?.length || 0) + (pendingInv?.length || 0)
  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <p className="text-caption text-gray2">{greeting}</p>
          <h1 className="text-h1">财务工作台</h1>
          <p className="text-caption text-gray3 mt-0.5">集团 · {today}</p>
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

      {/* 今日待付清单 — 财务最常用功能, 一键看 / 一键付 */}
      {dueToday !== null && dueToday.length > 0 && (
        <Section title="今日 + 逾期应付" right={`${dueToday.length} 笔 · ¥${Math.round(dueToday.reduce((s,d) => s + Number(d.amount), 0)).toLocaleString()}`} rightTone="red">
          <ul className="space-y-2">
            {dueToday.slice(0, 5).map(d => {
              const isOverdue = new Date(d.dueAt) < new Date(new Date().setHours(0,0,0,0))
              return (
                <li key={d.id} className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${isOverdue ? 'before:bg-red' : 'before:bg-amber'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Chip tone={isOverdue ? 'red' : 'orange'}>{isOverdue ? '逾期' : '今日到期'}</Chip>
                    <span className="text-micro text-gray3">{new Date(d.dueAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span>
                    <span className="ml-auto font-num text-h2">¥{Math.round(Number(d.amount)).toLocaleString()}</span>
                  </div>
                  <div className="text-h2 truncate">{d.supplier?.name}</div>
                  <p className="text-caption text-gray2 mt-0.5 truncate">{d.receipt?.store?.name} · #{d.receipt?.no}</p>
                </li>
              )
            })}
          </ul>
          {dueToday.length > 5 && (
            <a href="/v2/finance/payable" className="block text-center mt-2 py-2 text-caption text-amber-fg">查看全部 ›</a>
          )}
        </Section>
      )}

      {/* 快捷入口 — 5 grid */}
      <div className="px-4 mt-4 grid grid-cols-5 gap-2">
        <a href="/v2/finance/review" className="bg-white rounded-card border border-border p-2.5 text-center">
          <div className="text-button">✓</div>
          <div className="text-micro text-gray2 mt-1">初审</div>
        </a>
        <a href="/v2/finance/invoices" className="bg-white rounded-card border border-border p-2.5 text-center">
          <div className="text-button">📃</div>
          <div className="text-micro text-gray2 mt-1">发票</div>
        </a>
        <a href="/v2/finance/payable" className="bg-amber/10 rounded-card border border-amber/30 p-2.5 text-center">
          <div className="text-button">¥</div>
          <div className="text-micro text-amber-fg mt-1">应付</div>
        </a>
        <a href="/v2/finance/funds" className="bg-white rounded-card border border-border p-2.5 text-center">
          <div className="text-button">⛁</div>
          <div className="text-micro text-gray2 mt-1">资金</div>
        </a>
        <a href="/v2/finance/vouchers" className="bg-white rounded-card border border-border p-2.5 text-center">
          <div className="text-button">📋</div>
          <div className="text-micro text-gray2 mt-1">凭证</div>
        </a>
      </div>

      {/* 管理报表 — 利润 + 账龄 */}
      <div className="px-4 mt-3 grid grid-cols-2 gap-2">
        <a href="/v2/finance/reports/profit" className="block bg-white rounded-card border border-border p-3">
          <div className="text-button">📈 利润中心</div>
          <div className="text-micro text-gray3 mt-0.5">店利润 · 损益占比 · 渠道</div>
        </a>
        <a href="/v2/finance/reports/aging" className="block bg-white rounded-card border border-border p-3">
          <div className="text-button">⏳ 账龄分析</div>
          <div className="text-micro text-gray3 mt-0.5">应付账期 · 逾期预警</div>
        </a>
      </div>

      {/* 月度对账 + 净利总览 — 月末高频 */}
      <div className="px-4 mt-3 grid grid-cols-2 gap-2">
        <a href="/v2/finance/reconcile" className="block bg-white rounded-card border border-border p-3">
          <div className="text-button">📊 月度对账</div>
          <div className="text-micro text-gray3 mt-0.5">按门店 / 供应商 · 导 Excel</div>
        </a>
        <a href="/v2/profit" className="block bg-white rounded-card border border-border p-3">
          <div className="text-button">⛁ 净利总览</div>
          <div className="text-micro text-gray3 mt-0.5">月/季/年/累计</div>
        </a>
      </div>

      <Section title="财务待办" right={todoCount > 0 ? `${todoCount} 项` : undefined} rightTone={todoCount > 0 ? 'red' : undefined}>
        {(inbox === null && pendingInv === null) && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {todoCount === 0 && inbox !== null && pendingInv !== null && (
          <p className="text-caption text-gray3 text-center py-4">✓ 无待办 · 全部已处理</p>
        )}
        <ul className="space-y-2">
          {(inbox || []).slice(0, 3).map(it => (
            <li key={it.stepId} className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-orange">
              <div className="flex items-center gap-2 mb-1">
                <Chip tone="orange">{TYPE_LABEL[it.document.type] || '审批'}</Chip>
                {it.document.isOverThreshold && <Chip tone="red">大额</Chip>}
                <span className="text-micro text-gray3 ml-auto">{timeAgo(it.document.createdAt)}</span>
              </div>
              <a href="/v2/finance/review" className="block">
                <div className="text-h2">{it.document.title}</div>
                <p className="text-caption text-gray2 mt-0.5">
                  {it.document.store?.name && `${it.document.store.name} · `}
                  {it.document.initiator?.name && `${it.document.initiator.name} 发起`}
                  {it.document.amount != null && ` · ¥${Math.round(Number(it.document.amount)).toLocaleString()}`}
                </p>
              </a>
            </li>
          ))}
          {(pendingInv || []).slice(0, 2).map(inv => (
            <li key={inv.id} className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-amber">
              <div className="flex items-center gap-2 mb-1">
                <Chip tone="orange">发票审核</Chip>
                <span className="ml-auto font-num text-h2">¥{Math.round(Number(inv.amount)).toLocaleString()}</span>
              </div>
              <a href="/v2/finance/invoices" className="block">
                <div className="text-h2">{inv.supplier.name}</div>
                <p className="text-caption text-gray2 mt-0.5 font-num">#{inv.invoiceNo}</p>
              </a>
            </li>
          ))}
        </ul>
        {todoCount > 0 && (
          <a href="/v2/finance/review" className="block text-center w-full mt-2 py-3 bg-white border border-border rounded-cta text-button text-gray2">查看全部 ›</a>
        )}
      </Section>

      <BottomNav
        tabs={[
          { key: 'home',   label: '工作台', icon: '⌂' },
          { key: 'review', label: '初审',   icon: '✓' },
          { key: 'funds',  label: '资金',   icon: '⛁' },
          { key: 'stores', label: '各店',   icon: '↗' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'review') location.href = '/v2/finance/review'
          if (k === 'funds')  location.href = '/v2/finance/funds'
          if (k === 'stores') location.href = '/v2/finance/stores'
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
