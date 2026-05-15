/**
 * 老板 App · 首页 (Glance 总览)  PDF: boss_home
 * Tab 1/5
 *
 * Hero ¥168,500 + sparkline + 底栏铁三角(待审批/异常店/月净利预估)
 * + 待审批入口（数字+类型 chips）
 * + 门店概览（5 大门店 + 3 家折叠）
 * + 集团关键指标 4 metric
 * + 底部 5 Tab
 */
'use client'
import { useEffect, useState } from 'react'
import {
  MetricTile, BottomNav, StoreAvatar, Chip,
} from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { Sparkline } from '@/components/v2/sparkline'
import { UserMenu } from '@/components/v2/user-menu'
import { useDashboard, LoadingScreen, ErrorScreen, greetingFor } from '@/components/v2/use-dashboard'
import { BankAccountCard } from '@/components/v2/bank-account-card'
import { apiFetch } from '@/lib/v2-auth'

// 招行实时账户从 cashbook/accounts 拉, 财务在 finance/funds 页可增删, 老板这里只读显示
type BankAcct = {
  id: string; name: string; bankName?: string; note?: string
  cmbBindAccount?: string | null
}

export default function BossHomePage() {
  const [tab, setTab] = useState('home')
  const [bankAccts, setBankAccts] = useState<BankAcct[]>([])
  const { data, error } = useDashboard()

  // 拉招行账户列表 (cmbBindAccount 非空的才显示成实时卡片)
  useEffect(() => {
    apiFetch<BankAcct[]>('/api/cashbook/accounts')
      .then(rows => setBankAccts((rows || []).filter(a => a.cmbBindAccount)))
      .catch(() => { /* 无权限或网络挂了, 不阻塞 dashboard */ })
  }, [])

  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />
  const { greeting, today } = greetingFor(data.user?.name)
  const storeCount = data.storesOverview?.length ?? 0
  const storesOpen = `集团 · ${storeCount} 家店 · ${today}`
  return (
    <div className="min-h-screen bg-bg pb-20">
      {/* 顶部问候 */}
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <p className="text-caption text-gray2">{greeting}</p>
          <h1 className="text-h1">老板首页</h1>
          <p className="text-caption text-gray3 mt-0.5">{storesOpen}</p>
        </div>
        <UserMenu />   {/* UserMenu 内置 NotificationBell + 头像 */}
      </header>

      {/* Glance — 取消黑底 Hero, 改"无卡片大数字 + sparkline + metric 横条" */}
      <div className="mt-3">
        <GlanceStrip
          {...(data.hero as any)}
          sparkline={data.hero?.revenue7d && data.hero.revenue7d.length > 1
            ? <Sparkline data={data.hero.revenue7d} />
            : undefined}
        />
      </div>

      {/* 净利总览 + 建店资金 快捷入口 */}
      <div className="px-4 mt-3 grid grid-cols-2 gap-2">
        <a href="/v2/profit" className="block bg-amber/10 border border-amber/30 rounded-card p-3">
          <div className="text-button text-amber-fg">⛁ 净利总览</div>
          <div className="text-micro text-gray2 mt-0.5">月/季/年/累计</div>
        </a>
        <a href="/v2/budget" className="block bg-white border border-border rounded-card p-3">
          <div className="text-button">¥ 建店资金</div>
          <div className="text-micro text-gray3 mt-0.5">各店建店投入台账</div>
        </a>
      </div>

      {/* 招行实时账户 — 老板只读, 财务在「资金」页管理(增删) */}
      {bankAccts.length > 0 && (
        <Section title="招行实时账户" right={`${bankAccts.length} 个 · 实时`}>
          <div className="space-y-3">
            {bankAccts.map(a => (
              <BankAccountCard key={a.id} config={{
                account:     a.cmbBindAccount!,
                label:       '招行实时',
                accountName: a.name,
                bankName:    a.bankName || '招商银行',
                accountType: a.note || undefined,
              }} />
            ))}
          </div>
        </Section>
      )}

      {/* 待审批 */}
      {data.approvals && (
        <Section title="待审批" right={`${data.approvals.total} 项 · ${data.approvals.totalAmount}`} rightTone={data.approvals.total > 0 ? 'red' : undefined}>
          <a href="/v2/boss/approvals" className="block bg-white rounded-card p-3 border border-border flex items-center justify-between">
            <div className="flex gap-2 flex-wrap">
              {data.approvals.byType.length > 0 ? (
                data.approvals.byType.map((t: any) => (
                  <Chip key={t.type} tone={t.tone}>{t.type} {t.n}</Chip>
                ))
              ) : (
                <span className="text-caption text-gray3">暂无待审批</span>
              )}
            </div>
            <span className="text-gray3">›</span>
          </a>
        </Section>
      )}

      {/* 门店概览 — 把"未录入数据"折叠成一个柔和卡片，不让首屏全是 ¥0 */}
      {data.storesOverview?.length > 0 && (() => {
        // 划分：有营收的 vs 无营收的
        const active   = data.storesOverview.filter((s: any) => Number(s.revenueRaw || 0) > 0)
        const inactive = data.storesOverview.filter((s: any) => Number(s.revenueRaw || 0) === 0)
        // 2×2 网格首屏只露 4 张，多的折叠
        const showActive = active.slice(0, 4)
        const collapsedActive = active.slice(4)
        return (
          <Section title="门店概览" right={`${active.length} 家有营收 · ${inactive.length} 家未录入`}>
            {/* 2×2 卡片网格 — 比列表更有视觉冲击，rank 角标 + 大数字 */}
            <div className="grid grid-cols-2 gap-2">
              {showActive.map((s: any, i: number) => (
                <a
                  key={s.id}
                  href={`/v2/boss/stores`}
                  className="relative bg-white rounded-card border border-border p-3 flex flex-col gap-2 active:scale-[0.98] transition"
                >
                  <span className="absolute top-2 right-2 font-num text-micro text-gray4">#{i + 1}</span>
                  <div className="flex items-center gap-2 pr-5">
                    <StoreAvatar name={s.name} anomaly={s.anomaly} size="sm" />
                    <span className="text-button truncate flex-1">{s.name}</span>
                  </div>
                  <div className="font-num text-h1 leading-none">{s.revenue}</div>
                  <div className="flex items-center justify-between">
                    <span className={`text-micro ${s.anomaly ? 'text-red-fg' : 'text-gray3'}`}>{s.growth}</span>
                    {s.anomaly && <Chip tone="red">异常</Chip>}
                  </div>
                </a>
              ))}
            </div>
            {/* 其他活跃店折叠 (>4 家时) */}
            {collapsedActive.length > 0 && (
              <a href="/v2/boss/stores" className="mt-2 block bg-white rounded-card border border-border p-3 flex items-center gap-3">
                <div className="flex -space-x-2">
                  {collapsedActive.slice(0, 3).map((s: any) => (
                    <StoreAvatar key={s.id} name={s.name} size="sm" />
                  ))}
                </div>
                <div className="flex-1">
                  <div className="text-caption">还有 {collapsedActive.length} 家店 · 共 ¥{collapsedActive.reduce((sum: number, s: any) => sum + Number(s.revenueRaw || 0), 0).toLocaleString()}</div>
                  <div className="text-micro text-gray3">查看全部</div>
                </div>
                <span className="text-gray3">›</span>
              </a>
            )}
            {/* 未录入的店折叠成柔和暖色提示 */}
            {inactive.length > 0 && (
              <a href="/v2/boss/stores" className="mt-2 block bg-bg-warm rounded-card border border-border/60 p-3 flex items-center gap-3">
                <div className="flex -space-x-2 opacity-60">
                  {inactive.slice(0, 3).map((s: any) => (
                    <StoreAvatar key={s.id} name={s.name} size="sm" />
                  ))}
                </div>
                <div className="flex-1">
                  <div className="text-caption text-gray2">{inactive.length} 家店本月暂未录入营业额</div>
                  <div className="text-micro text-amber-fg">提醒店长录入</div>
                </div>
                <span className="text-gray3">›</span>
              </a>
            )}
            {active.length === 0 && inactive.length === 0 && (
              <div className="text-caption text-gray3 text-center py-6">暂无门店数据</div>
            )}
          </Section>
        )
      })()}
      {/* 集团关键指标 (后端 groupKpi 真数据) */}
      <Section title="集团关键指标" right={today}>
        <div className="grid grid-cols-2 gap-2">
          <MetricTile label="月营收" value={data.hero?.stats?.find((s: any) => s.label === '本月累计' || s.label === '月营收')?.value || '—'} delta="本月累计" tone="default" />
          {((data.hero as any)?.groupKpi || []).map((k: any) => <MetricTile key={k.label} {...k} />)}
        </div>
      </Section>

      {/* 底部 5 Tab */}
      <BottomNav
        tabs={[
          { key: 'home',     label: '首页',  icon: '⌂' },
          { key: 'stores',   label: '门店',  icon: '☷' },
          { key: 'reports',  label: '报表',  icon: '⛁' },
          { key: 'approval', label: '审批',  icon: '✓' },
          { key: 'me',       label: '我的',  icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          setTab(k)
          if (k === 'stores')   location.href = '/v2/boss/stores'
          if (k === 'reports')  location.href = '/v2/boss/reports'
          if (k === 'approval') location.href = '/v2/boss/approvals'
          if (k === 'me')       location.href = '/v2/me'
        }}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red' | 'orange' | 'gray'; children: React.ReactNode }) {
  const cls = rightTone === 'red' ? 'text-red-fg' : rightTone === 'orange' ? 'text-orange-fg' : 'text-gray3'
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${cls}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}

