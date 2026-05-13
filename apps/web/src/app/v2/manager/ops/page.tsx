/**
 * 店长 App · 营业 Tab (P&L)  PDF: manager_operations  Tab 2/4
 * 接真数据: GET /api/profit/store/:storeId?month=YYYY-MM
 *
 * Hero 显示 GMV (顾客实际花费), P&L 区分:
 *   营业收入 (GMV)
 *     - 平台抽成 (美团 + 抖音)   ← 销售费用
 *     - 食材成本
 *     - 报损
 *     - 其他门店杂费 (LABOR/SALES/MGMT/FINANCE)
 *   = 净利润
 */
'use client'
import { useEffect, useState } from 'react'
import { BlackHero, BottomNav, PeriodPills, Chip } from '@/components/v2'
import { apiFetch, getUser } from '@/lib/v2-auth'

type Profit = {
  store: { name: string }
  month: string
  revenue: {
    total: number; net?: number; platformFee?: number
    platformFeeBreakdown?: { meituan: number; douyin: number }
    channels?: Record<string, number>
    recordCount: number
  }
  cost: {
    food: number; loss: number
    labor: { total: number }
    sales: { total: number; platformFee?: number }
    mgmt:  { total: number }
    finance: { total: number }
    totalExpense: number; totalCost: number
  }
  grossProfit: number; grossMargin: number
  netProfit: number; netMargin: number
}

function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function ManagerOpsPage() {
  const [period, setPeriod] = useState('month')
  const [data, setData] = useState<Profit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storeName, setStoreName] = useState('本店')
  const [storeId, setStoreId] = useState<string | null>(null)

  useEffect(() => {
    const u = getUser()
    const sid = u?.storeId || u?.store?.id || null
    setStoreId(sid); setStoreName(u?.store?.name || '本店')
    if (!sid) { setError('未绑定门店'); return }
    apiFetch<Profit>(`/api/profit/store/${sid}?month=${thisMonth()}`)
      .then(setData)
      .catch(e => setError(e.message))
  }, [])

  const r = data?.revenue
  const c = data?.cost
  const platformFee = Number(r?.platformFee || 0)
  const platformBreak = r?.platformFeeBreakdown
  const gmv = Number(r?.total || 0)
  const netRev = Number(r?.net ?? gmv)
  const food = Number(c?.food || 0)
  const loss = Number(c?.loss || 0)
  const labor = Number(c?.labor?.total || 0)
  // sales 后端已含 platformFee, 减去得到"门店杂费销售类"
  const salesOnly = Math.max(0, Number(c?.sales?.total || 0) - platformFee)
  const mgmt = Number(c?.mgmt?.total || 0)
  const fin = Number(c?.finance?.total || 0)
  const netProfit = Number(data?.netProfit || 0)
  const pct = (n: number) => gmv > 0 ? (n / gmv * 100).toFixed(1) : '0'

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">营业</h1>
          <p className="text-caption text-gray3">{storeName} · {data?.month || thisMonth()}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/v2/manager/revenue" className="px-3 h-9 rounded-cta bg-amber text-white text-button flex items-center gap-1">
            <span>＋</span><span>录营业额</span>
          </a>
          <a href="/v2/manager/expenses" className="px-3 h-9 rounded-cta bg-white border border-border text-button text-gray2 flex items-center">杂费</a>
        </div>
      </header>

      <div className="px-4 mt-2">
        <PeriodPills
          value={period} onChange={setPeriod}
          options={[
            { label: '今日', value: 'day' },
            { label: '本周', value: 'week' },
            { label: '本月', value: 'month' },
            { label: '上月', value: 'prev' },
          ]}
        />
      </div>

      <div className="px-4 mt-3">
        <BlackHero
          label="本月营收 (GMV)"
          value={data ? `¥${gmv.toLocaleString()}` : '加载中…'}
          delta={platformFee > 0 ? { text: `平台抽成 −¥${platformFee.toLocaleString()}`, trend: 'down' } : undefined}
          meta={data ? `净到账 ¥${netRev.toLocaleString()} · 录入 ${r?.recordCount || 0} 天` : ''}
          stats={data ? [
            { label: '净利润', value: `¥${netProfit.toLocaleString()}`, tone: netProfit >= 0 ? 'green' : 'red' as any },
            { label: '净利率', value: `${data.netMargin.toFixed(1)}%`, tone: 'default' as any },
            { label: '食材占比', value: `${pct(food)}%`, tone: 'default' as any },
          ] : []}
        />
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">加载失败: {error}</div>}

      {/* P&L */}
      <Section title="P&L 拆解" right={data?.month || ''}>
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <Row item="营业收入 (GMV)" amount={gmv} pct={pct(gmv)} bold />
          {platformFee > 0 && (
            <Row
              item="  平台抽成"
              amount={-platformFee}
              pct={'-' + pct(platformFee)}
              note={platformBreak ? `美团 ¥${platformBreak.meituan} · 抖音 ¥${platformBreak.douyin}` : undefined}
              tone="orange"
              indent
            />
          )}
          {netRev !== gmv && <Row item="实际到账 (净)" amount={netRev} pct={pct(netRev)} tone="amber" sub />}
          <Row item="食材成本" amount={-food} pct={'-' + pct(food)} controllable note={loss > 0 ? `含报损 ¥${loss.toLocaleString()}` : undefined} />
          <Row item="人工成本" amount={-labor} pct={'-' + pct(labor)} controllable={false} />
          <Row item="销售费用 (门店)" amount={-salesOnly} pct={'-' + pct(salesOnly)} controllable note="租金/水电/营销" />
          <Row item="管理费用" amount={-mgmt} pct={'-' + pct(mgmt)} controllable={false} />
          {fin > 0 && <Row item="财务费用" amount={-fin} pct={'-' + pct(fin)} />}
          <Row item="净利润" amount={netProfit} pct={`${data?.netMargin.toFixed(1) || 0}%`} bold profit />
        </div>
      </Section>

      <Section title="渠道分布" right="GMV 拆">
        <div className="bg-white rounded-card border border-border p-3">
          {!r?.channels || Object.keys(r.channels).length === 0 ? (
            <p className="text-caption text-gray3 text-center py-2">本月暂无渠道数据 · <a href="/v2/manager/revenue" className="text-amber-fg">去录营业额</a></p>
          ) : (
            <ul className="space-y-2">
              {channelLabels(r.channels).map(c => (
                <li key={c.key}>
                  <div className="flex items-center justify-between">
                    <span className="text-body">{c.label}</span>
                    <span className="font-num text-body">¥{c.value.toLocaleString()} <span className="text-micro text-gray3">{pct(c.value)}%</span></span>
                  </div>
                  <div className="h-1.5 bg-bg rounded-full overflow-hidden mt-1">
                    <div className={`h-full ${c.tone}`} style={{ width: `${Math.min(100, c.value / gmv * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <BottomNav
        tabs={[
          { key: 'home',     label: '工作台', icon: '⌂' },
          { key: 'ops',      label: '营业',   icon: '⛁' },
          { key: 'fab',      label: '',       icon: '+' },
          { key: 'customer', label: '客户',   icon: '★' },
          { key: 'team',     label: '团队',   icon: '◐' },
        ]}
        activeKey={'ops'}
        onChange={(k) => {
          if (k === 'home')     location.href = '/v2/manager/home'
          if (k === 'customer') location.href = '/v2/manager/customer'
          if (k === 'team')     location.href = '/v2/manager/team'
        }}
        fabKey="fab"
        onFab={() => location.href = '/v2/manager/home'}
      />
    </div>
  )
}

const CHANNEL_META: Record<string, { label: string; tone: string }> = {
  wechatMini:  { label: '微信小程序', tone: 'bg-green' },
  wechat:      { label: '微信',       tone: 'bg-green' },
  alipay:      { label: '支付宝',     tone: 'bg-blue-500' },
  cash:        { label: '现金',       tone: 'bg-amber' },
  meituanGmv:  { label: '美团/点评券', tone: 'bg-orange' },
  meituan:     { label: '美团',       tone: 'bg-orange' },
  douyinGmv:   { label: '抖音券',     tone: 'bg-red' },
  douyin:      { label: '抖音',       tone: 'bg-red' },
  other:       { label: '其他',       tone: 'bg-gray3' },
}
function channelLabels(channels: Record<string, number>) {
  const out: Array<{ key: string; label: string; value: number; tone: string }> = []
  Object.entries(channels).forEach(([k, v]) => {
    const m = CHANNEL_META[k]
    if (!m) return                                    // 跳过 net 字段(已统计在 GMV 内)
    if (k.endsWith('Net')) return
    out.push({ key: k, label: m.label, value: Number(v), tone: m.tone })
  })
  return out.sort((a, b) => b.value - a.value)
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

function Row({ item, amount, pct, bold, profit, controllable, note, tone, indent, sub }:
  { item: string; amount: number; pct: string; bold?: boolean; profit?: boolean
    controllable?: boolean; note?: string; tone?: 'orange'|'amber'; indent?: boolean; sub?: boolean }) {
  const cls = profit ? 'bg-green-bg' : sub ? 'bg-amber/5' : ''
  const valueCls = profit ? 'text-green-fg' : tone === 'orange' ? 'text-orange-fg' : tone === 'amber' ? 'text-amber-fg' : ''
  return (
    <div className={`flex items-start px-3 py-2.5 border-b border-border last:border-b-0 ${cls}`}>
      <div className={`flex-1 ${indent ? 'pl-3' : ''}`}>
        <div className="flex items-center gap-2">
          <span className={bold ? 'text-h2' : 'text-body'}>{item}</span>
          {controllable === true  && <Chip tone="gray">可控</Chip>}
          {controllable === false && <Chip tone="gray">不可控</Chip>}
          {profit && <Chip tone="green">利润</Chip>}
        </div>
        {note && <p className="text-micro text-gray3 mt-0.5">{note}</p>}
      </div>
      <div className="text-right">
        <div className={`font-num ${bold ? 'text-h2' : 'text-body'} ${valueCls}`}>
          {amount < 0 ? '−' : ''}¥{Math.abs(amount).toLocaleString()}
        </div>
        <div className="text-micro text-gray3 font-num">{pct}%</div>
      </div>
    </div>
  )
}
