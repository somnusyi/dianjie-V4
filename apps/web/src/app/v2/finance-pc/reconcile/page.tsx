/**
 * 财务 PC Web · 月度对账中心
 *
 * Phase 3 P2
 * 接 /api/finance/reconcile?month=&view=store|supplier
 *
 * PC UX:
 *   - 月份选择 + 上一月/下一月/本月
 *   - 视角切换: 按门店 / 按供应商
 *   - Hero 4 卡 (动态根据视角)
 *   - 表格视图; 合计行固定底部
 *   - CSV 导出 (浏览器下载)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type StoreRow = {
  storeId: string; name: string; no: string
  revenue: number; foodCost: number; loss: number; net: number
}
type SupplierRow = {
  supplierId: string; name: string
  delivered: number; paid: number; unpaid: number; loss: number
}

const fmtMoney = (n: number) => {
  if (!Number.isFinite(n)) return '¥0'
  return `¥${Math.round(n).toLocaleString()}`
}
const fmtWan = (n: number) => {
  if (!Number.isFinite(n) || Math.abs(n) < 10000) return fmtMoney(n)
  return `¥${(n / 10000).toFixed(2)}万`
}

function downloadCsv(filename: string, rows: any[][]) {
  const csv = '\ufeff' + rows.map(r => r.map(c => {
    const s = String(c ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export default function FinancePCReconcilePage() {
  const [view, setView] = useState<'store' | 'supplier'>('store')
  const [month, setMonth] = useState(() => {
    if (typeof window === 'undefined') return dayjs().format('YYYY-MM')
    const sp = new URLSearchParams(window.location.search)
    return sp.get('month') || dayjs().format('YYYY-MM')
  })
  const [storeData, setStoreData] = useState<StoreRow[] | null>(null)
  const [supplierData, setSupplierData] = useState<SupplierRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  function load() {
    setLoading(true); setError(null)
    const url = `/api/finance/reconcile?month=${month}&view=${view}`
    apiFetch<any>(url).then(d => {
      if (view === 'store') setStoreData(d || [])
      else setSupplierData(d || [])
    }).catch(e => setError(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [view, month])

  const shift = (delta: number) => setMonth(dayjs(month + '-01').add(delta, 'month').format('YYYY-MM'))
  const isThisMonth = month === dayjs().format('YYYY-MM')

  const storeTotals = useMemo(() => {
    if (!storeData) return { revenue: 0, foodCost: 0, loss: 0, net: 0 }
    return storeData.reduce((a, r) => ({
      revenue: a.revenue + r.revenue,
      foodCost: a.foodCost + r.foodCost,
      loss: a.loss + r.loss,
      net: a.net + r.net,
    }), { revenue: 0, foodCost: 0, loss: 0, net: 0 })
  }, [storeData])

  const supplierTotals = useMemo(() => {
    if (!supplierData) return { delivered: 0, paid: 0, unpaid: 0, loss: 0 }
    return supplierData.reduce((a, r) => ({
      delivered: a.delivered + r.delivered,
      paid:      a.paid      + r.paid,
      unpaid:    a.unpaid    + r.unpaid,
      loss:      a.loss      + r.loss,
    }), { delivered: 0, paid: 0, unpaid: 0, loss: 0 })
  }, [supplierData])

  const storeFiltered = useMemo(() => {
    if (!storeData) return []
    const q = search.trim().toLowerCase()
    if (!q) return storeData
    return storeData.filter(r => r.name.toLowerCase().includes(q) || r.no.toLowerCase().includes(q))
  }, [storeData, search])

  const supplierFiltered = useMemo(() => {
    if (!supplierData) return []
    const q = search.trim().toLowerCase()
    if (!q) return supplierData
    return supplierData.filter(r => r.name.toLowerCase().includes(q))
  }, [supplierData, search])

  function exportCsv() {
    if (view === 'store' && storeData) {
      downloadCsv(`门店对账-${month}.csv`, [
        ['门店编号', '门店名', '本月营收', '食材成本', '报损', '净利'],
        ...storeData.map(r => [r.no, r.name, r.revenue.toFixed(2), r.foodCost.toFixed(2), r.loss.toFixed(2), r.net.toFixed(2)]),
        ['合计', '', storeTotals.revenue.toFixed(2), storeTotals.foodCost.toFixed(2), storeTotals.loss.toFixed(2), storeTotals.net.toFixed(2)],
      ])
    } else if (view === 'supplier' && supplierData) {
      downloadCsv(`供应商对账-${month}.csv`, [
        ['供应商', '本月交付', '已付', '未付', '报损'],
        ...supplierData.map(r => [r.name, r.delivered.toFixed(2), r.paid.toFixed(2), r.unpaid.toFixed(2), r.loss.toFixed(2)]),
        ['合计', supplierTotals.delivered.toFixed(2), supplierTotals.paid.toFixed(2), supplierTotals.unpaid.toFixed(2), supplierTotals.loss.toFixed(2)],
      ])
    }
  }

  const currentRows = view === 'store' ? storeData : supplierData

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div>
            <h1 className="text-h1">月度对账</h1>
            <p className="text-caption text-gray3">门店净利 / 供应商收付 / 月底关账依据</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => shift(-1)} className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2">← 上月</button>
            <MonthPicker value={month} onChange={setMonth} />
            <button onClick={() => shift(1)} disabled={isThisMonth}
                    className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2 disabled:opacity-40">下月 →</button>
            {!isThisMonth && (
              <button onClick={() => setMonth(dayjs().format('YYYY-MM'))}
                      className="px-3 py-2 bg-ink text-white rounded-cta text-button">本月</button>
            )}
            <button onClick={exportCsv} disabled={!currentRows || currentRows.length === 0}
                    className="px-3 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">⬇ 导出 CSV</button>
          </div>
        </div>

        {/* 视角切换 + 搜索 */}
        <div className="flex items-center gap-3 mb-3">
          <div className="flex bg-bg rounded-cta p-0.5">
            <button onClick={() => setView('store')}
                    className={`px-4 py-1.5 rounded-cta text-button ${view === 'store' ? 'bg-ink text-white' : 'text-gray2'}`}>按门店</button>
            <button onClick={() => setView('supplier')}
                    className={`px-4 py-1.5 rounded-cta text-button ${view === 'supplier' ? 'bg-ink text-white' : 'text-gray2'}`}>按供应商</button>
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={view === 'store' ? '搜索门店' : '搜索供应商'}
            className="px-3 py-2 rounded-cta border border-border bg-white text-button w-64 ml-auto"
          />
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* Hero 4 卡 */}
        {view === 'store' && (
          <div className="grid grid-cols-4 gap-3 mb-4">
            <Stat label="本月营收" value={fmtWan(storeTotals.revenue)} tone="default" />
            <Stat label="食材成本" value={fmtWan(storeTotals.foodCost)} tone="amber" />
            <Stat label="报损" value={fmtWan(storeTotals.loss)} tone={storeTotals.loss > 0 ? 'red' : 'gray'} />
            <Stat label="净利" value={fmtWan(storeTotals.net)} tone={storeTotals.net < 0 ? 'red' : 'green'} />
          </div>
        )}
        {view === 'supplier' && (
          <div className="grid grid-cols-4 gap-3 mb-4">
            <Stat label="本月交付" value={fmtWan(supplierTotals.delivered)} tone="default" />
            <Stat label="已付" value={fmtWan(supplierTotals.paid)} tone="green" />
            <Stat label="未付" value={fmtWan(supplierTotals.unpaid)} tone={supplierTotals.unpaid > 0 ? 'amber' : 'gray'} />
            <Stat label="报损" value={fmtWan(supplierTotals.loss)} tone={supplierTotals.loss > 0 ? 'red' : 'gray'} />
          </div>
        )}

        {/* 表格 */}
        <div className="bg-white rounded-card border border-border overflow-hidden">
          {loading && <div className="px-4 py-8 text-center text-caption text-gray3">加载中…</div>}

          {view === 'store' && storeData && !loading && (
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal w-24">编号</th>
                  <th className="px-3 py-2 font-normal">门店</th>
                  <th className="px-3 py-2 font-normal text-right w-32">营收</th>
                  <th className="px-3 py-2 font-normal text-right w-32">食材成本</th>
                  <th className="px-3 py-2 font-normal text-right w-28">报损</th>
                  <th className="px-3 py-2 font-normal text-right w-32">净利</th>
                  <th className="px-3 py-2 font-normal w-20">标签</th>
                </tr>
              </thead>
              <tbody>
                {storeFiltered.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-caption text-gray3">{month} 暂无门店数据</td></tr>
                )}
                {storeFiltered.map(r => (
                  <tr key={r.storeId} className={`border-t border-border hover:bg-[#FAF8F2] ${r.net < 0 ? 'bg-red-bg/30' : ''}`}>
                    <td className="px-3 py-2.5 text-micro text-gray3 font-num">{r.no}</td>
                    <td className="px-3 py-2.5 text-body truncate">{r.name}</td>
                    <td className="px-3 py-2.5 font-num text-right">{fmtMoney(r.revenue)}</td>
                    <td className="px-3 py-2.5 font-num text-right text-amber-fg">{fmtMoney(r.foodCost)}</td>
                    <td className="px-3 py-2.5 font-num text-right text-red-fg">{fmtMoney(r.loss)}</td>
                    <td className={`px-3 py-2.5 font-num text-right text-body ${r.net < 0 ? 'text-red-fg' : 'text-green-fg'}`}>{fmtMoney(r.net)}</td>
                    <td className="px-3 py-2.5">{r.net < 0 ? <Chip tone="red">亏损</Chip> : r.revenue === 0 ? <Chip tone="gray">无营收</Chip> : <Chip tone="green">盈利</Chip>}</td>
                  </tr>
                ))}
                {storeFiltered.length > 0 && (
                  <tr className="border-t border-border bg-bg/60 font-medium">
                    <td colSpan={2} className="px-3 py-2.5 text-right text-caption text-gray2">合计</td>
                    <td className="px-3 py-2.5 font-num text-right">{fmtMoney(storeTotals.revenue)}</td>
                    <td className="px-3 py-2.5 font-num text-right text-amber-fg">{fmtMoney(storeTotals.foodCost)}</td>
                    <td className="px-3 py-2.5 font-num text-right text-red-fg">{fmtMoney(storeTotals.loss)}</td>
                    <td className={`px-3 py-2.5 font-num text-right ${storeTotals.net < 0 ? 'text-red-fg' : 'text-green-fg'}`}>{fmtMoney(storeTotals.net)}</td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {view === 'supplier' && supplierData && !loading && (
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">供应商</th>
                  <th className="px-3 py-2 font-normal text-right w-32">本月交付</th>
                  <th className="px-3 py-2 font-normal text-right w-32">已付</th>
                  <th className="px-3 py-2 font-normal text-right w-32">未付</th>
                  <th className="px-3 py-2 font-normal text-right w-32">报损</th>
                  <th className="px-3 py-2 font-normal w-32">进度</th>
                </tr>
              </thead>
              <tbody>
                {supplierFiltered.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">{month} 暂无供应商数据</td></tr>
                )}
                {supplierFiltered.map(r => {
                  const pct = r.delivered > 0 ? Math.min(100, r.paid / r.delivered * 100) : 0
                  return (
                    <tr key={r.supplierId} className={`border-t border-border hover:bg-[#FAF8F2] ${r.unpaid > 0 ? 'bg-amber/5' : ''}`}>
                      <td className="px-3 py-2.5 text-body truncate">{r.name}</td>
                      <td className="px-3 py-2.5 font-num text-right">{fmtMoney(r.delivered)}</td>
                      <td className="px-3 py-2.5 font-num text-right text-green-fg">{fmtMoney(r.paid)}</td>
                      <td className={`px-3 py-2.5 font-num text-right ${r.unpaid > 0 ? 'text-amber-fg' : ''}`}>{fmtMoney(r.unpaid)}</td>
                      <td className="px-3 py-2.5 font-num text-right text-red-fg">{fmtMoney(r.loss)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <div className="h-1.5 bg-bg rounded-full overflow-hidden flex-1">
                            <div className="h-full bg-green" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-micro font-num text-gray3 w-8 text-right">{Math.round(pct)}%</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {supplierFiltered.length > 0 && (
                  <tr className="border-t border-border bg-bg/60 font-medium">
                    <td className="px-3 py-2.5 text-right text-caption text-gray2">合计</td>
                    <td className="px-3 py-2.5 font-num text-right">{fmtMoney(supplierTotals.delivered)}</td>
                    <td className="px-3 py-2.5 font-num text-right text-green-fg">{fmtMoney(supplierTotals.paid)}</td>
                    <td className="px-3 py-2.5 font-num text-right text-amber-fg">{fmtMoney(supplierTotals.unpaid)}</td>
                    <td className="px-3 py-2.5 font-num text-right text-red-fg">{fmtMoney(supplierTotals.loss)}</td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  )
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'red' | 'green' | 'gray' | 'amber' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'green' ? 'text-green-fg' : tone === 'amber' ? 'text-amber-fg' : tone === 'gray' ? 'text-gray3' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>{value}</div>
    </div>
  )
}
