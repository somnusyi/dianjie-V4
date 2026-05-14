/**
 * 财务 · 月度对账中心
 *
 * 两种视角:
 *   1. 按门店 — 每店本月: 营收 / 食材成本 / 报损 / 净利
 *   2. 按供应商 — 每家供应商本月: 交付额 / 已付 / 未付 / 报损
 *
 * 功能:
 *   - 选月份 (默认本月)
 *   - 切换视角
 *   - 导出 CSV (浏览器下载)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type StoreRow = {
  storeId: string; name: string; no: string
  revenue: number; foodCost: number; loss: number; net: number
}
type SupplierRow = {
  supplierId: string; name: string
  delivered: number; paid: number; unpaid: number; loss: number
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return '¥0'
  if (Math.abs(n) >= 10000) return `¥${(n / 10000).toFixed(2)}万`
  return `¥${Math.round(n).toLocaleString()}`
}
function downloadCsv(filename: string, rows: any[][]) {
  const csv = '﻿' + rows.map(r => r.map(c => {
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

export default function ReconcilePage() {
  const router = useRouter()
  const [view, setView] = useState<'store' | 'supplier'>('store')
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [storeData, setStoreData] = useState<StoreRow[] | null>(null)
  const [supplierData, setSupplierData] = useState<SupplierRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

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

  const currentRows = view === 'store' ? storeData : supplierData

  const totals = useMemo(() => {
    if (view === 'store' && storeData) {
      return {
        revenue: storeData.reduce((s, r) => s + r.revenue, 0),
        cost: storeData.reduce((s, r) => s + r.foodCost, 0),
        loss: storeData.reduce((s, r) => s + r.loss, 0),
        net: storeData.reduce((s, r) => s + r.net, 0),
      }
    }
    if (view === 'supplier' && supplierData) {
      return {
        delivered: supplierData.reduce((s, r) => s + r.delivered, 0),
        paid: supplierData.reduce((s, r) => s + r.paid, 0),
        unpaid: supplierData.reduce((s, r) => s + r.unpaid, 0),
        loss: supplierData.reduce((s, r) => s + r.loss, 0),
      }
    }
    return {}
  }, [view, storeData, supplierData])

  function exportCsv() {
    if (view === 'store' && storeData) {
      downloadCsv(`门店对账-${month}.csv`, [
        ['门店编号', '门店名', '本月营收', '食材成本', '报损', '净利'],
        ...storeData.map(r => [r.no, r.name, r.revenue.toFixed(2), r.foodCost.toFixed(2), r.loss.toFixed(2), r.net.toFixed(2)]),
        ['合计', '', (totals as any).revenue?.toFixed(2), (totals as any).cost?.toFixed(2), (totals as any).loss?.toFixed(2), (totals as any).net?.toFixed(2)],
      ])
    } else if (view === 'supplier' && supplierData) {
      downloadCsv(`供应商对账-${month}.csv`, [
        ['供应商', '本月交付', '已付', '未付', '报损'],
        ...supplierData.map(r => [r.name, r.delivered.toFixed(2), r.paid.toFixed(2), r.unpaid.toFixed(2), r.loss.toFixed(2)]),
        ['合计', (totals as any).delivered?.toFixed(2), (totals as any).paid?.toFixed(2), (totals as any).unpaid?.toFixed(2), (totals as any).loss?.toFixed(2)],
      ])
    }
  }

  // 月份选项 (近 12 个月)
  const months = Array.from({ length: 12 }, (_, i) => dayjs().subtract(i, 'month').format('YYYY-MM'))

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <h1 className="text-h1 flex-1">月度对账</h1>
        <button onClick={exportCsv} disabled={!currentRows || currentRows.length === 0}
                className="px-3 py-1.5 bg-ink text-white rounded-cta text-button disabled:opacity-40">⬇ 导出 CSV</button>
      </header>

      {/* 月份 + 视角 */}
      <div className="px-4 mt-2 flex items-center gap-2">
        <select value={month} onChange={e => setMonth(e.target.value)}
                className="bg-white border border-border rounded-cta px-3 py-1.5 text-button font-num">
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="flex bg-bg rounded-cta p-0.5 ml-auto">
          <button onClick={() => setView('store')}
                  className={`px-4 py-1.5 rounded-cta text-button ${view === 'store' ? 'bg-ink text-white' : 'text-gray2'}`}>按门店</button>
          <button onClick={() => setView('supplier')}
                  className={`px-4 py-1.5 rounded-cta text-button ${view === 'supplier' ? 'bg-ink text-white' : 'text-gray2'}`}>按供应商</button>
        </div>
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      {loading && <p className="mx-4 mt-6 text-center text-gray3">加载中…</p>}

      {/* 合计 hero */}
      {view === 'store' && storeData && storeData.length > 0 && (
        <div className="mx-4 mt-3 bg-white border border-border rounded-card p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-micro text-gray3">本月集团净利</div>
              <div className={`font-num text-h1 mt-0.5 ${(totals as any).net < 0 ? 'text-red-fg' : ''}`}>{fmt((totals as any).net || 0)}</div>
            </div>
            <div>
              <div className="text-micro text-gray3">本月集团营收</div>
              <div className="font-num text-h1 mt-0.5">{fmt((totals as any).revenue || 0)}</div>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 gap-2 text-caption">
            <span>食材成本: <b className="font-num">{fmt((totals as any).cost || 0)}</b></span>
            <span className="text-red-fg">报损: <b className="font-num">{fmt((totals as any).loss || 0)}</b></span>
          </div>
        </div>
      )}
      {view === 'supplier' && supplierData && supplierData.length > 0 && (
        <div className="mx-4 mt-3 bg-white border border-border rounded-card p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-micro text-gray3">本月集团已付</div>
              <div className="font-num text-h1 mt-0.5 text-green-fg">{fmt((totals as any).paid || 0)}</div>
            </div>
            <div>
              <div className="text-micro text-gray3">本月集团未付</div>
              <div className="font-num text-h1 mt-0.5 text-orange-fg">{fmt((totals as any).unpaid || 0)}</div>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 gap-2 text-caption">
            <span>本月交付: <b className="font-num">{fmt((totals as any).delivered || 0)}</b></span>
            <span className="text-red-fg">报损: <b className="font-num">{fmt((totals as any).loss || 0)}</b></span>
          </div>
        </div>
      )}

      {/* 列表 */}
      {view === 'store' && storeData && (
        <ul className="mx-4 mt-3 bg-white border border-border rounded-card divide-y divide-border">
          {storeData.length === 0 && <li className="px-4 py-8 text-center text-gray3">{month} 暂无门店数据</li>}
          {storeData.map(r => (
            <li key={r.storeId} className="px-3 py-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-h2 truncate flex-1">{r.name}</span>
                <span className="text-micro text-gray3 font-num">{r.no}</span>
                {r.net < 0 && <Chip tone="red">亏损</Chip>}
              </div>
              <div className="grid grid-cols-4 gap-2 text-caption">
                <Cell label="营收" value={fmt(r.revenue)} />
                <Cell label="食材" value={fmt(r.foodCost)} />
                <Cell label="报损" value={fmt(r.loss)} tone="red" />
                <Cell label="净利" value={fmt(r.net)} tone={r.net < 0 ? 'red' : 'green'} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {view === 'supplier' && supplierData && (
        <ul className="mx-4 mt-3 bg-white border border-border rounded-card divide-y divide-border">
          {supplierData.length === 0 && <li className="px-4 py-8 text-center text-gray3">{month} 暂无供应商数据</li>}
          {supplierData.map(r => (
            <li key={r.supplierId} className="px-3 py-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-h2 truncate flex-1">{r.name}</span>
                {r.unpaid > 0 && <Chip tone="orange">待付 {fmt(r.unpaid)}</Chip>}
              </div>
              <div className="grid grid-cols-4 gap-2 text-caption">
                <Cell label="本月交付" value={fmt(r.delivered)} />
                <Cell label="已付" value={fmt(r.paid)} tone="green" />
                <Cell label="未付" value={fmt(r.unpaid)} tone="orange" />
                <Cell label="报损" value={fmt(r.loss)} tone="red" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'red' | 'green' | 'orange' }) {
  const colorMap = { red: 'text-red-fg', green: 'text-green-fg', orange: 'text-orange-fg' }
  return (
    <div className="bg-bg rounded-cta p-2">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`font-num text-body mt-0.5 ${tone ? colorMap[tone] : ''}`}>{value}</div>
    </div>
  )
}
