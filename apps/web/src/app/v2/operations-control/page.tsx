'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch, getUser, routeForRole } from '@/lib/v2-auth'

type ControlRow = {
  businessDate: string
  state: 'CONFIRMED' | 'PREVIEWED' | 'CONFIRMING' | 'PENDING' | 'OVERDUE' | 'SUPERSEDED'
  revision: number | null
  correctionPending: boolean
  metrics: { grossAmount: number; discountAmount: number; netRevenue: number; orderCount: number } | null
  dishSaleCount: number
  consumptionSkuCount: number
  deferredBom: { pending: number; backfilled: number; superseded: number }
  issueCount: number
  warningCount: number
  confirmedAt: string | null
}

type ControlCenter = {
  generatedAt: string
  expectedBusinessDate: string
  dueAt: string
  summary: {
    storeCount: number
    missingDays: number
    overdueDays: number
    pendingBomTasks: number
    negativeStockSkus: number
    baselineIssueStores: number
  }
  stores: Array<{
    store: { id: string; name: string; no: string }
    inventory: {
      status: 'AVAILABLE' | 'NO_BASELINE'
      asOf: string | null
      itemCount: number
      unmatchedCount: number
      normalizationPendingCount: number
      lowStockCount: number
      negativeStockCount: number
      expiringCount: number
    }
    rows: ControlRow[]
  }>
}

const STATE: Record<ControlRow['state'], { label: string; className: string }> = {
  CONFIRMED: { label: '已确认', className: 'bg-green-bg text-green-fg' },
  PREVIEWED: { label: '待确认', className: 'bg-amber-bg text-amber-fg' },
  CONFIRMING: { label: '确认中', className: 'bg-blue/10 text-blue-fg' },
  PENDING: { label: '待上传', className: 'bg-bg text-gray2' },
  OVERDUE: { label: '已逾期', className: 'bg-red-bg text-red-fg' },
  SUPERSEDED: { label: '已替换', className: 'bg-bg text-gray3' },
}

const money = (value: number) => `¥${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`

export default function OperationsControlPage() {
  const [role, setRole] = useState<string | null | undefined>(undefined)
  const [days, setDays] = useState(7)
  const [refreshTick, setRefreshTick] = useState(0)
  const [data, setData] = useState<ControlCenter | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const allowed = role != null && ['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN', 'BOSS'].includes(role)
  const back = role ? routeForRole(role) : '/v2/login'

  useEffect(() => {
    setRole(getUser()?.role || null)
  }, [])

  useEffect(() => {
    if (!allowed) return
    setLoading(true)
    setError('')
    apiFetch<ControlCenter>(`/api/daily-business-imports/control-center?days=${days}`)
      .then(setData)
      .catch(error => setError(error?.message || '运营状态加载失败'))
      .finally(() => setLoading(false))
  }, [allowed, days, refreshTick])

  const attention = useMemo(() => data
    ? data.summary.overdueDays + data.summary.pendingBomTasks + data.summary.negativeStockSkus + data.summary.baselineIssueStores
    : 0, [data])

  if (role === undefined) return <div className="min-h-screen bg-bg flex items-center justify-center text-caption text-gray3">正在核验权限…</div>
  if (!allowed) return (
    <div className="min-h-screen bg-bg px-4 py-12">
      <div className="max-w-md mx-auto rounded-card bg-white border border-border p-6 text-center">
        <h1 className="text-h2">当前角色无权查看运营控制中心</h1>
        <p className="text-caption text-gray3 mt-2">该页面仅向门店经营及集团管理角色开放。</p>
        <a href={back} className="block mt-5 rounded-cta bg-ink text-white py-3 text-button">返回工作台</a>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-bg pb-10">
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border">‹</button>
          <div className="flex-1">
            <h1 className="text-h1">每日运营控制中心</h1>
            <p className="text-micro text-gray3">日报、BOM 与门店库存统一核对</p>
          </div>
          <span className={`px-2 py-1 rounded-chip text-micro ${attention > 0 ? 'bg-red-bg text-red-fg' : 'bg-green-bg text-green-fg'}`}>
            {attention > 0 ? `${attention} 项关注` : '运行正常'}
          </span>
        </div>
      </header>

      <main className="px-4">
        <div className="mt-4 flex gap-2">
          {[7, 14, 30].map(value => (
            <button key={value} onClick={() => setDays(value)}
              className={`px-4 py-2 rounded-chip text-caption border ${days === value ? 'bg-ink text-white border-ink' : 'bg-white text-gray2 border-border'}`}>
              近 {value} 天
            </button>
          ))}
          <button onClick={() => setRefreshTick(value => value + 1)} className="ml-auto text-caption text-amber-fg" disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>

        {error && <div className="mt-4 rounded-card bg-red-bg text-red-fg p-3 text-caption">{error}</div>}
        {loading && !data && <div className="mt-8 text-center text-caption text-gray3">正在汇总运营状态…</div>}

        {data && (
          <>
            <section className="mt-4 grid grid-cols-2 gap-2">
              <Summary label="逾期日报" value={data.summary.overdueDays} tone={data.summary.overdueDays > 0 ? 'red' : 'green'} />
              <Summary label="BOM 待处理" value={data.summary.pendingBomTasks} tone={data.summary.pendingBomTasks > 0 ? 'amber' : 'green'} />
              <Summary label="负库存 SKU" value={data.summary.negativeStockSkus} tone={data.summary.negativeStockSkus > 0 ? 'red' : 'green'} />
              <Summary label="盘点基准异常门店" value={data.summary.baselineIssueStores} tone={data.summary.baselineIssueStores > 0 ? 'amber' : 'green'} />
            </section>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <a href="/v2/manager/upload-platform" className="rounded-cta bg-amber text-white py-3 text-center text-button">上传营业双表</a>
              <a href="/v2/chef-director/bom" className="rounded-cta bg-white border border-border py-3 text-center text-button">处理 BOM 待办</a>
            </div>

            {data.stores.map(store => (
              <section key={store.store.id} className="mt-5">
                <div className="flex items-end justify-between mb-2">
                  <div>
                    <h2 className="text-h2">{store.store.name}</h2>
                    <p className="text-micro text-gray3">{store.store.no} · 营业截至 {data.expectedBusinessDate}</p>
                  </div>
                  <a href="/v2/chef/inventory" className="text-caption text-amber-fg">查看库存 ›</a>
                </div>

                <div className="rounded-card bg-white border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-button">门店预计库存</span>
                    <span className={`text-micro px-2 py-1 rounded-chip ${store.inventory.status === 'AVAILABLE' ? 'bg-green-bg text-green-fg' : 'bg-red-bg text-red-fg'}`}>
                      {store.inventory.status === 'AVAILABLE' ? `基准 ${store.inventory.asOf}` : '缺少盘点基准'}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 mt-3 divide-x divide-border text-center">
                    <Mini label="SKU" value={store.inventory.itemCount} />
                    <Mini label="低库存" value={store.inventory.lowStockCount} warn={store.inventory.lowStockCount > 0} />
                    <Mini label="负库存" value={store.inventory.negativeStockCount} warn={store.inventory.negativeStockCount > 0} />
                    <Mini label="待匹配" value={store.inventory.unmatchedCount + store.inventory.normalizationPendingCount} warn={store.inventory.unmatchedCount + store.inventory.normalizationPendingCount > 0} />
                  </div>
                </div>

                <div className="mt-2 space-y-2">
                  {store.rows.map(row => <DailyRow key={row.businessDate} row={row} />)}
                </div>
              </section>
            ))}
            <p className="text-micro text-gray3 text-center mt-5">生成于 {new Date(data.generatedAt).toLocaleString('zh-CN')}</p>
          </>
        )}
      </main>
    </div>
  )
}

function Summary({ label, value, tone }: { label: string; value: number; tone: 'red' | 'amber' | 'green' }) {
  const color = tone === 'red' ? 'text-red-fg' : tone === 'amber' ? 'text-amber-fg' : 'text-green-fg'
  return <div className="rounded-card bg-white border border-border p-3"><div className="text-micro text-gray3">{label}</div><div className={`text-[28px] font-num mt-1 ${color}`}>{value}</div></div>
}

function Mini({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return <div><div className="text-micro text-gray3">{label}</div><div className={`text-h2 font-num mt-1 ${warn ? 'text-red-fg' : ''}`}>{value}</div></div>
}

function DailyRow({ row }: { row: ControlRow }) {
  const meta = STATE[row.state]
  return (
    <details className="rounded-card bg-white border border-border overflow-hidden" open={row.state !== 'CONFIRMED' || row.deferredBom.pending > 0 || row.correctionPending}>
      <summary className="list-none px-3 py-3 flex items-center gap-3 cursor-pointer">
        <div className="flex-1">
          <div className="text-button">{row.businessDate}</div>
          <div className="text-micro text-gray3 mt-0.5">
            {row.metrics ? `${row.metrics.orderCount} 笔 · ${money(row.metrics.netRevenue)}` : '尚未形成可信营业数据'}
          </div>
        </div>
        {row.correctionPending && <span className="text-micro text-amber-fg">更正版待确认</span>}
        {row.deferredBom.pending > 0 && <span className="text-micro text-amber-fg">BOM {row.deferredBom.pending}</span>}
        <span className={`text-micro px-2 py-1 rounded-chip ${meta.className}`}>{meta.label}</span>
      </summary>
      <div className="border-t border-border px-3 py-3">
        {row.metrics ? (
          <div className="grid grid-cols-2 gap-y-2 text-caption">
            <span className="text-gray3">营业额</span><span className="text-right font-num">{money(row.metrics.grossAmount)}</span>
            <span className="text-gray3">优惠金额</span><span className="text-right font-num">{money(row.metrics.discountAmount)}</span>
            <span className="text-gray3">销售 / 扣减</span><span className="text-right">{row.dishSaleCount} 菜品 / {row.consumptionSkuCount} SKU</span>
            <span className="text-gray3">BOM 回补</span><span className="text-right">待处理 {row.deferredBom.pending} · 已回补 {row.deferredBom.backfilled}</span>
          </div>
        ) : (
          <a href="/v2/manager/upload-platform" className="block rounded-cta bg-amber text-white text-center py-2.5 text-button">去上传并确认</a>
        )}
      </div>
    </details>
  )
}
