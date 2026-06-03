/**
 * 财务 PC · 月度成本核对工作台 (P1-1)
 *
 * 真实业务: 每月按 3 类数据源核对各店成本 (财务基本业务清单 #2)
 *   1. 总仓 (何姐数据)
 *   2. 美菜/快驴 (B2B 平台账单)
 *   3. 散户 (微信群直接对接)
 *   每条入库需 4 方核对 ✓: 门店 → 厨师长 → 供应商 → 财务
 *
 * UX:
 *   - 月份选择 + 总进度
 *   - 4 列: 总仓 / B2B / 散户 / 未分类 (财务给供应商打标)
 *   - 每行展示 4 个核对点, 点开展开供应商/财务核对操作
 *   - 右上 '+ 导入 B2B 账单' 跳 P1-2 页
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type Verification = { done: boolean; at?: string | null }
type Receipt = {
  id: string; no: string; totalAmount: string | number; deliveryDate: string
  status: string
  note?: string | null
  supplier: { id: string; name: string; sourceType?: string | null; category?: string | null }
  store: { id: string; name: string }
  paymentSchedule?: { status: string; paidAt?: string | null } | null
  verifications: { store: Verification; chef: Verification; supplier: Verification; finance: Verification }
  allVerified: boolean
  doneCount: number
}
type GroupKey = 'HEADQ_WAREHOUSE' | 'B2B_PLATFORM' | 'SCATTERED' | 'UNCATEGORIZED'
type Group = {
  label: string
  items: Receipt[]
  summary: {
    count: number
    totalAmount: number
    allVerifiedCount: number
    pendingChefCount: number
    pendingSupplierCount: number
    pendingFinanceCount: number
  }
}
type Data = {
  month: string
  groups: Record<GroupKey, Group>
  total: Group['summary']
}

const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`
const fmtKMoney = (n: number) => n >= 1000 ? `¥${(n / 1000).toFixed(1)}K` : `¥${Math.round(n)}`

const GROUP_ORDER: GroupKey[] = ['HEADQ_WAREHOUSE', 'B2B_PLATFORM', 'SCATTERED', 'UNCATEGORIZED']
const GROUP_COLORS: Record<GroupKey, string> = {
  HEADQ_WAREHOUSE: 'bg-[#FAF8F2]',
  B2B_PLATFORM: 'bg-amber/10',
  SCATTERED: 'bg-green-bg/30',
  UNCATEGORIZED: 'bg-red-bg/30',
}

export default function FinancePCCostCheckPage() {
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    setData(null); setError(null)
    try {
      const d = await apiFetch<Data>(`/api/finance/cost-check?month=${month}`)
      setData(d)
    } catch (e: any) { setError(e?.message || String(e)) }
  }
  useEffect(() => { void load() }, [month])

  async function verify(r: Receipt, actor: 'supplier' | 'finance') {
    if (busy) return
    setBusy(true)
    try {
      await apiFetch(`/api/receipts/${r.id}/verify`, { method: 'PATCH', body: JSON.stringify({ actor }) })
      await load()
    } catch (e: any) { alert(e?.message || '核对失败') }
    finally { setBusy(false) }
  }

  async function revoke(r: Receipt, actor: 'supplier' | 'finance') {
    if (busy) return
    if (!confirm(`确定撤销${actor === 'supplier' ? '供应商' : '财务'}核对? 撤销供应商会级联撤销财务.`)) return
    setBusy(true)
    try {
      await apiFetch(`/api/receipts/${r.id}/verify/revoke`, { method: 'PATCH', body: JSON.stringify({ actor }) })
      await load()
    } catch (e: any) { alert(e?.message || '撤销失败') }
    finally { setBusy(false) }
  }

  async function setSourceType(supplierId: string, sourceType: GroupKey | null) {
    if (busy) return
    setBusy(true)
    try {
      await apiFetch(`/api/finance/cost-check/suppliers/${supplierId}/source-type`, {
        method: 'PATCH', body: JSON.stringify({ sourceType: sourceType === 'UNCATEGORIZED' ? null : sourceType }),
      })
      await load()
    } catch (e: any) { alert(e?.message || '失败') }
    finally { setBusy(false) }
  }

  const overall = data?.total
  const overallPct = overall && overall.count > 0 ? (overall.allVerifiedCount / overall.count * 100) : 0

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1600px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-h1">月度成本核对</h1>
            <p className="text-caption text-gray3">3 类数据源 · 4 方核对 (门店 → 厨师长 → 供应商 → 财务) → 入账</p>
          </div>
          <div className="flex items-center gap-2">
            <MonthPicker value={month} onChange={setMonth} />
            <a href="/v2/finance-pc/cost-check/import-b2b"
               className="px-4 py-2 bg-amber text-white rounded-cta text-button">+ 导入 B2B 账单</a>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* 总进度 */}
        {overall && (
          <section className="bg-white rounded-card border border-border p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-h2">{month} 本月对账总进度</h2>
                <p className="text-caption text-gray2">
                  共 {overall.count} 笔 · 累计 {fmtMoney(overall.totalAmount)} · 已对完 {overall.allVerifiedCount} 笔
                </p>
              </div>
              <div className="text-right">
                <div className="text-hero font-num">{overallPct.toFixed(0)}%</div>
                <div className="text-micro text-gray3">已对账</div>
              </div>
            </div>
            <div className="h-2 bg-bg rounded-full overflow-hidden">
              <div className={`h-full ${overallPct === 100 ? 'bg-green-fg' : overallPct > 50 ? 'bg-amber' : 'bg-orange'}`}
                   style={{ width: `${overallPct}%` }} />
            </div>
          </section>
        )}

        {/* 4 列卡片 */}
        <div className="grid grid-cols-4 gap-4">
          {GROUP_ORDER.map(gKey => {
            const g = data?.groups[gKey]
            const items = g?.items || []
            const filteredItems = items
            return (
              <section key={gKey} className={`rounded-card border border-border overflow-hidden ${GROUP_COLORS[gKey]}`}>
                <header className="px-3 py-2.5 border-b border-border bg-white/60 backdrop-blur sticky top-0 z-10">
                  <div className="flex items-center justify-between">
                    <h3 className="text-button">{g?.label || gKey}</h3>
                    <span className="text-micro text-gray3 font-num">{g?.summary.count || 0} 笔 · {fmtKMoney(g?.summary.totalAmount || 0)}</span>
                  </div>
                  {g && g.summary.count > 0 && (
                    <div className="flex items-center gap-1 mt-1 text-micro text-gray3 flex-wrap">
                      <Chip tone={g.summary.allVerifiedCount === g.summary.count ? 'green' : 'gray'}>已完 {g.summary.allVerifiedCount}</Chip>
                      {g.summary.pendingChefCount > 0 && <Chip tone="orange">厨待 {g.summary.pendingChefCount}</Chip>}
                      {g.summary.pendingSupplierCount > 0 && <Chip tone="amber">供待 {g.summary.pendingSupplierCount}</Chip>}
                      {g.summary.pendingFinanceCount > 0 && <Chip tone="red">财待 {g.summary.pendingFinanceCount}</Chip>}
                    </div>
                  )}
                </header>
                <div className="divide-y divide-border max-h-[700px] overflow-auto">
                  {filteredItems.length === 0 && (
                    <div className="px-3 py-6 text-center text-caption text-gray3">
                      {gKey === 'UNCATEGORIZED'
                        ? '✓ 所有供应商已分类'
                        : '本月无该类入库'}
                    </div>
                  )}
                  {filteredItems.map(r => {
                    const isExpanded = expandedId === r.id
                    return (
                      <div key={r.id} className="bg-white">
                        <button onClick={() => setExpandedId(isExpanded ? null : r.id)}
                                className="w-full px-3 py-2.5 text-left hover:bg-bg/40 transition">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-button truncate flex-1">{r.supplier.name}</div>
                            <span className="font-num text-button shrink-0">{fmtKMoney(Number(r.totalAmount))}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-micro text-gray3 font-num">{r.no}</span>
                            <span className="text-micro text-gray3">{dayjs(r.deliveryDate).format('MM/DD')}</span>
                          </div>
                          {/* 4 方核对点 */}
                          <div className="flex items-center gap-1 mt-1.5">
                            <VerifyDot label="店" done={r.verifications.store.done} />
                            <VerifyDot label="厨" done={r.verifications.chef.done} />
                            <VerifyDot label="供" done={r.verifications.supplier.done} />
                            <VerifyDot label="财" done={r.verifications.finance.done} />
                            {r.allVerified && <Chip tone="green">✓ 已对账</Chip>}
                          </div>
                        </button>
                        {isExpanded && (
                          <div className="px-3 py-3 bg-bg/40 border-t border-border space-y-2">
                            {r.note && <p className="text-micro text-gray3">{r.note}</p>}
                            <div className="grid grid-cols-2 gap-2 text-micro">
                              <div>门店: {r.store.name}</div>
                              <div>状态: {r.status}</div>
                            </div>
                            {/* 操作按钮 */}
                            <div className="space-y-1">
                              {!r.verifications.supplier.done && r.verifications.chef.done && (
                                <button onClick={() => verify(r, 'supplier')} disabled={busy}
                                        className="w-full py-1.5 bg-amber text-white rounded-cta text-button disabled:opacity-40">
                                  供应商已核对 ✓
                                </button>
                              )}
                              {r.verifications.supplier.done && !r.verifications.finance.done && (
                                <button onClick={() => verify(r, 'finance')} disabled={busy}
                                        className="w-full py-1.5 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                                  财务核对完毕 (入账)
                                </button>
                              )}
                              {!r.verifications.chef.done && (
                                <div className="text-micro text-gray3 text-center py-1">等厨师长确认</div>
                              )}
                              {r.allVerified && (
                                <div className="flex gap-1">
                                  <button onClick={() => revoke(r, 'finance')} disabled={busy}
                                          className="flex-1 py-1.5 bg-white border border-border rounded text-caption text-gray2">撤财务</button>
                                  <button onClick={() => revoke(r, 'supplier')} disabled={busy}
                                          className="flex-1 py-1.5 bg-white border border-border rounded text-caption text-gray2">撤供应商</button>
                                </div>
                              )}
                            </div>
                            {/* 未分类: 给供应商打标 */}
                            {gKey === 'UNCATEGORIZED' && (
                              <div className="border-t border-border pt-2">
                                <div className="text-micro text-gray3 mb-1">给该供应商打标:</div>
                                <div className="flex gap-1 flex-wrap">
                                  <button onClick={() => setSourceType(r.supplier.id, 'HEADQ_WAREHOUSE')}
                                          className="px-2 py-1 bg-[#FAF8F2] border border-border rounded text-micro">总仓</button>
                                  <button onClick={() => setSourceType(r.supplier.id, 'B2B_PLATFORM')}
                                          className="px-2 py-1 bg-amber/10 border border-amber/30 rounded text-micro">B2B</button>
                                  <button onClick={() => setSourceType(r.supplier.id, 'SCATTERED')}
                                          className="px-2 py-1 bg-green-bg/30 border border-green/30 rounded text-micro">散户</button>
                                </div>
                              </div>
                            )}
                            {/* 已分类: 显示当前分类 + 改 */}
                            {gKey !== 'UNCATEGORIZED' && (
                              <div className="border-t border-border pt-2 text-micro text-gray3">
                                供应商分类: {r.supplier.sourceType}
                                <button onClick={() => setSourceType(r.supplier.id, null)}
                                        className="ml-2 text-amber-fg">改分类 →</button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>

        <div className="mt-4 text-caption text-gray3">
          💡 流程: <b>门店建单 → 厨师长 confirm → 供应商核对 (与门店三方对账无误) → 财务核对入账</b>
          (4 方都打 ✓ 才视为本笔已对账)
        </div>
      </main>
    </div>
  )
}

function VerifyDot({ label, done }: { label: string; done: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-micro ${done ? 'bg-green-bg text-green-fg' : 'bg-bg text-gray3'}`}
          title={done ? '已核对' : '待核对'}>
      {done ? '✓' : label}
    </span>
  )
}
