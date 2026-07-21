/**
 * 店长 App · 营业 Tab (P&L)  PDF: manager_operations  Tab 2/4
 * 接真数据: GET /api/profit/store/:storeId?month=YYYY-MM
 * 历史月结: GET /api/profit/store/:storeId/closed-months (「上月」Tab 的月份选择器数据源)
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
import { BottomNav, Chip } from '@/components/v2'
import { apiFetch, getUser } from '@/lib/v2-auth'

type Profit = {
  store: { name: string }
  month: string
  accountingClose?: {
    status: string; operatingRevenue: number; operationalRevenue: number
    reconciliationDifference: number; sourceFilename: string; confirmedAt: string
    tax: number; incomeTax: number; nonOperatingNet: number
  } | null
  revenue: {
    total: number; net?: number; platformFee?: number
    platformFeeBreakdown?: { meituan: number; douyin: number }
    channels?: Record<string, number>
    recordCount: number
    metrics?: OperatingMetrics
    comparison?: {
      label: string
      month: string
      rangeLabel: string
      metrics: OperatingMetrics
      changes: Record<'grossAmount' | 'netRevenue' | 'orders' | 'discountAmount', number | null>
    }
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

type OperatingMetrics = {
  grossAmount: number
  netRevenue: number
  orders: number
  discountAmount: number
  recordCount: number
}

function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

type ClosedMonth = {
  month: string
  confirmedAt: string | null
  sourceFilename: string
}

// 'YYYY-MM' → '6月' / '26年1月' (跨年时分歧时带两位年份)
function closedMonthLabel(month: string, latestYear: string) {
  const [year, mm] = month.split('-')
  const label = `${Number(mm)}月`
  return year === latestYear ? label : `${year.slice(2)}年${label}`
}

type ConsumptionSummary = {
  month: string
  totalCost: number
  daysWithData: number
  top: Array<{ productId: string; code: string; name: string; unit: string; qty: number; cost: number }>
}

export default function ManagerOpsPage() {
  const [selectedMonth, setSelectedMonth] = useState(thisMonth())
  const [data, setData] = useState<Profit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storeName, setStoreName] = useState('本店')
  const [storeId, setStoreId] = useState<string | null>(null)
  const [closedMonths, setClosedMonths] = useState<ClosedMonth[]>([])
  const [consumption, setConsumption] = useState<ConsumptionSummary | null>(null)

  // 挂载: 解析门店并拉取已确认月结月份列表 (失败时降级为空列表, 不影响主流程)
  useEffect(() => {
    const u = getUser()
    const sid = u?.storeId || u?.store?.id || null
    setStoreName(u?.store?.name || '本店')
    setStoreId(sid)
    if (!sid) { setError('未绑定门店'); return }
    apiFetch<{ months: ClosedMonth[] }>(`/api/profit/store/${sid}/closed-months`)
      .then(result => setClosedMonths(result.months || []))
      .catch(() => setClosedMonths([]))
  }, [])

  const activeMonth = selectedMonth

  useEffect(() => {
    if (!storeId) return
    let cancelled = false
    setData(null)
    setError(null)
    setConsumption(null)
    apiFetch<Profit>(`/api/profit/store/${storeId}?month=${activeMonth}`)
      .then(result => { if (!cancelled) setData(result) })
      .catch(e => { if (!cancelled) setError(e.message) })
    apiFetch<ConsumptionSummary>(`/api/stores/${storeId}/consumption/summary?month=${activeMonth}`)
      .then(result => { if (!cancelled) setConsumption(result) })
      .catch(() => { if (!cancelled) setConsumption(null) })
    return () => { cancelled = true }
  }, [storeId, activeMonth])

  const r = data?.revenue
  const c = data?.cost
  const platformFee = Number(r?.platformFee || 0)
  const platformBreak = r?.platformFeeBreakdown
  const operatingRevenue = Number(r?.total || 0)
  const netRev = Number(r?.net ?? operatingRevenue)
  const metrics: OperatingMetrics = r?.metrics || {
    grossAmount: operatingRevenue,
    netRevenue: operatingRevenue,
    orders: 0,
    discountAmount: 0,
    recordCount: r?.recordCount || 0,
  }
  const food = Number(c?.food || 0)
  const loss = Number(c?.loss || 0)
  const labor = Number(c?.labor?.total || 0)
  // sales 后端已含 platformFee, 减去得到"门店杂费销售类"
  const salesOnly = data?.accountingClose
    ? Number(c?.sales?.total || 0)
    : Math.max(0, Number(c?.sales?.total || 0) - platformFee)
  const mgmt = Number(c?.mgmt?.total || 0)
  const fin = Number(c?.finance?.total || 0)
  const netProfit = Number(data?.netProfit || 0)
  const pct = (n: number) => operatingRevenue > 0 ? (n / operatingRevenue * 100).toFixed(1) : '0'

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">营业</h1>
          <p className="text-caption text-gray3">{storeName} · {data?.month || thisMonth()}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/v2/manager/upload-platform" className="px-3 h-9 rounded-cta bg-amber text-white text-button flex items-center gap-1">
            <span>⇪</span><span>上传日报</span>
          </a>
          <a href="/v2/manager/expenses" className="px-3 h-9 rounded-cta bg-white border border-border text-button text-gray2 flex items-center">杂费</a>
        </div>
      </header>

      {/* 单行月份条: 本月 + 已确认月结的历史月份, 全局仅一个选中态, 超出横向滑动 */}
      <div className="px-4 mt-2">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <MonthPill
            label={`${Number(thisMonth().split('-')[1])}月·本月`}
            selected={selectedMonth === thisMonth()}
            onClick={() => setSelectedMonth(thisMonth())}
          />
          {closedMonths
            .filter(close => close.month !== thisMonth())
            .map(close => (
              <MonthPill
                key={close.month}
                label={closedMonthLabel(close.month, closedMonths[0]!.month.split('-')[0])}
                closed
                selected={selectedMonth === close.month}
                onClick={() => setSelectedMonth(close.month)}
              />
            ))}
        </div>
      </div>

      <OperatingOverview
        loading={!data && !error}
        metrics={metrics}
        comparison={r?.comparison}
      />

      <FoodCostCard
        summary={consumption}
        operatingRevenue={operatingRevenue}
        monthLabel={`${Number(activeMonth.split('-')[1])}月`}
      />

      {data?.accountingClose && (
        <div className="mx-4 mt-3 bg-green-bg border border-green-fg/20 rounded-card p-3 text-caption">
          <div className="text-green-fg font-medium">财务月结已确认</div>
          <div className="text-gray2 mt-1">
            本页 P&amp;L 采用财务收入 ¥{data.accountingClose.operatingRevenue.toLocaleString()}；
            与日报折后收入相差 {data.accountingClose.reconciliationDifference >= 0 ? '+' : ''}¥{data.accountingClose.reconciliationDifference.toLocaleString()}。
          </div>
        </div>
      )}

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">加载失败: {error}</div>}

      {/* P&L */}
      <Section title="P&L 拆解" right={data?.month || ''}>
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <Row item="营业收入" amount={operatingRevenue} pct={pct(operatingRevenue)} bold />
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
          {netRev !== operatingRevenue && <Row item="实际到账 (净)" amount={netRev} pct={pct(netRev)} tone="amber" sub />}
          <Row item={data?.accountingClose ? '主营成本' : '食材成本'} amount={-food} pct={'-' + pct(food)} controllable note={loss > 0 ? `报损参考 ¥${loss.toLocaleString()}` : undefined} />
          <Row item="人工成本" amount={-labor} pct={'-' + pct(labor)} controllable={false} />
          <Row item="销售费用 (门店)" amount={-salesOnly} pct={'-' + pct(salesOnly)} controllable note="租金/水电/营销" />
          <Row item="管理费用" amount={-mgmt} pct={'-' + pct(mgmt)} controllable={false} />
          {fin > 0 && <Row item="财务费用" amount={-fin} pct={'-' + pct(fin)} />}
          {data?.accountingClose && data.accountingClose.tax > 0 && <Row item="流转税费" amount={-data.accountingClose.tax} pct={'-' + pct(data.accountingClose.tax)} />}
          {data?.accountingClose && data.accountingClose.nonOperatingNet !== 0 && <Row item="营业外净额" amount={data.accountingClose.nonOperatingNet} pct={pct(data.accountingClose.nonOperatingNet)} />}
          {data?.accountingClose && data.accountingClose.incomeTax > 0 && <Row item="企业所得税" amount={-data.accountingClose.incomeTax} pct={'-' + pct(data.accountingClose.incomeTax)} />}
          <Row item="净利润" amount={netProfit} pct={`${data?.netMargin.toFixed(1) || 0}`} bold profit />
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
                    <div className={`h-full ${c.tone}`} style={{ width: `${Math.min(100, c.value / operatingRevenue * 100)}%` }} />
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

function MonthPill({ label, closed, selected, onClick }: {
  label: string
  closed?: boolean
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 px-3 py-1 text-button rounded-cta transition flex items-center ${
        selected ? 'bg-ink text-white' : 'bg-bg text-gray2 hover:text-ink'
      }`}
    >
      {label}
      {closed && (
        <span
          title="财务月结已确认"
          className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-green"
        />
      )}
    </button>
  )
}

/** 食材成本卡: 当前选中月份的 BOM/报损消耗口径 (与 P&L 的食材成本不同源) */
function FoodCostCard({ summary, operatingRevenue, monthLabel }: {
  summary: ConsumptionSummary | null
  operatingRevenue: number
  monthLabel: string
}) {
  const total = Number(summary?.totalCost || 0)
  const days = summary?.daysWithData ?? 0
  const costRate = operatingRevenue > 0 ? (total / operatingRevenue * 100).toFixed(1) : null

  return (
    <Section title="食材成本" right={summary && days > 0 ? `有数据 ${days} 天` : ''}>
      <div className="bg-white rounded-card border border-border p-3">
        {!summary ? (
          <p className="text-caption text-gray3 text-center py-2">加载中…</p>
        ) : days === 0 ? (
          <p className="text-caption text-gray3 text-center py-2">{monthLabel}日报未确认，暂无消耗数据</p>
        ) : (
          <>
            <div className="flex items-end justify-between">
              <div>
                <div className="text-caption text-gray2">消耗总金额</div>
                <div className="font-num text-[22px] leading-tight font-semibold tracking-tight mt-1">
                  ¥{formatMoney(total)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-caption text-gray2">食材成本率</div>
                <div className="font-num text-[22px] leading-tight font-semibold tracking-tight mt-1">
                  {costRate === null ? '—' : `${costRate}%`}
                </div>
              </div>
            </div>
            {summary.top.length > 0 && (
              <ul className="mt-3 pt-3 border-t border-border space-y-1.5">
                {summary.top.map((item, index) => (
                  <li key={item.productId} className="flex items-center gap-2">
                    <span className="w-4 text-micro text-gray3 font-num">{index + 1}</span>
                    <span className="flex-1 min-w-0 text-body truncate">{item.name}</span>
                    <span className="text-micro text-gray3 font-num shrink-0">{item.qty} {item.unit}</span>
                    <span className="font-num text-body shrink-0 w-20 text-right">¥{formatMoney(item.cost)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <p className="text-micro text-gray3 mt-3 pt-2 border-t border-border">
          消耗仅含已发布 BOM 的菜品扣减与门店报损；日报未确认的日期无数据
        </p>
      </div>
    </Section>
  )
}

function OperatingOverview({ loading, metrics, comparison }: {
  loading: boolean
  metrics: OperatingMetrics
  comparison?: Profit['revenue']['comparison']
}) {
  const cards = [
    {
      key: 'grossAmount' as const,
      label: '营业额',
      hint: '折前',
      value: metrics.grossAmount,
      previous: comparison?.metrics.grossAmount,
      change: comparison?.changes.grossAmount,
      kind: 'money' as const,
    },
    {
      key: 'netRevenue' as const,
      label: '营业收入',
      hint: '折后',
      value: metrics.netRevenue,
      previous: comparison?.metrics.netRevenue,
      change: comparison?.changes.netRevenue,
      kind: 'money' as const,
    },
    {
      key: 'orders' as const,
      label: '订单量',
      hint: '成交订单',
      value: metrics.orders,
      previous: comparison?.metrics.orders,
      change: comparison?.changes.orders,
      kind: 'count' as const,
    },
    {
      key: 'discountAmount' as const,
      label: '优惠金额',
      hint: '折扣让利',
      value: metrics.discountAmount,
      previous: comparison?.metrics.discountAmount,
      change: comparison?.changes.discountAmount,
      kind: 'money' as const,
      inverse: true,
    },
  ]

  return (
    <section className="px-4 mt-3">
      <div className="flex items-end justify-between mb-2 gap-3">
        <div>
          <h2 className="text-h2">经营概览</h2>
          <p className="text-micro text-gray3 mt-0.5">
            {comparison?.rangeLabel || '营业数据加载中'}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-bg-warm px-2 py-1 text-micro text-gray2">
          {comparison?.label || '时间对比'}
        </span>
      </div>

      <div className="grid grid-cols-2 bg-white rounded-card border border-border overflow-hidden">
        {cards.map((card, index) => {
          const { key, ...metricProps } = card
          return (
            <OperatingMetricCard
              key={key}
              {...metricProps}
              loading={loading}
              compareLabel={comparison?.label || '较上期'}
              className={`${index % 2 === 0 ? 'border-r' : ''} ${index < 2 ? 'border-b' : ''} border-border`}
            />
          )
        })}
      </div>
    </section>
  )
}

function OperatingMetricCard({
  label, hint, value, previous, change, kind, inverse, loading, compareLabel, className,
}: {
  label: string
  hint: string
  value: number
  previous?: number
  change?: number | null
  kind: 'money' | 'count'
  inverse?: boolean
  loading: boolean
  compareLabel: string
  className?: string
}) {
  const hasComparison = change !== null && change !== undefined
  const improved = hasComparison && (inverse ? change <= 0 : change >= 0)
  const changeTone = !hasComparison || change === 0
    ? 'text-gray3'
    : improved ? 'text-green-fg' : 'text-red-fg'
  const displayValue = loading
    ? '—'
    : kind === 'money'
      ? `¥${formatMoney(value)}`
      : `${Math.round(value).toLocaleString('zh-CN')} 单`
  const previousValue = previous === undefined
    ? '—'
    : kind === 'money'
      ? `¥${formatMoney(previous)}`
      : `${Math.round(previous).toLocaleString('zh-CN')} 单`

  return (
    <div className={`min-w-0 p-3.5 ${className || ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption text-gray2">{label}</span>
        <span className="text-micro text-gray3">{hint}</span>
      </div>
      <div className="font-num text-[22px] leading-tight font-semibold tracking-tight mt-2 truncate">
        {displayValue}
      </div>
      <div className={`text-micro mt-2 font-medium ${changeTone}`}>
        {hasComparison
          ? `${compareLabel} ${change! > 0 ? '+' : ''}${change!.toFixed(1)}% ${change! > 0 ? '↑' : change! < 0 ? '↓' : '→'}`
          : `${compareLabel} 暂无可比`}
      </div>
      <div className="text-micro text-gray3 mt-1 truncate">上期 {previousValue}</div>
    </div>
  )
}

function formatMoney(value: number) {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
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
