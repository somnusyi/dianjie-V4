'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { DateRangeCalendar } from '@/components/v2/date-range-calendar'
import { WarehouseToolTabs } from '@/components/v2/warehouse-tool-tabs'
import { apiFetch } from '@/lib/v2-auth'
import { readWarehouseViewState, useWarehouseScrollRestoration, writeWarehouseViewState } from '@/lib/warehouse-view-state'

type UpstreamSupplier = {
  id: string
  no: string
  name: string
}

type InboundRecord = {
  id: string
  type: string
  sourceType: string
  sourceId: string
  effectiveAt: string
  recordedAt: string
  product: { id: string; code: string; name: string; category?: string | null }
  supplier: { id: string; no: string; name: string } | null
  sourceName: string | null
  note: string | null
  originalQuantity: number
  originalUnit: string
  inventoryQuantity: number
  inventoryUnit: string
  inventoryUnitCost: number
  amount: number
  batchNo: string | null
  expiryDate: string | null
  reversed: boolean
  doc: { id: string; docNo: string; status: 'POSTED' | 'CONFIRMED' } | null
}

type InboundResponse = {
  total: number
  totalAmount?: number
  page: number
  pageSize: number
  items: InboundRecord[]
  matchedProduct?: { id: string; code: string; name: string } | null
}

type UnclaimedSource = {
  sourceName: string
  rowCount: number
  lastUsedAt: string | null
  multi: boolean
}

const SOURCE_LABEL: Record<string, string> = {
  WarehouseManualInbound: '手工入库',
  WarehouseBatchManualInbound: '批量入库',
  MeituanDailyPackage: '美团数据包',
}

const SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  { value: 'manual', label: '手工入库' },
  { value: 'batch', label: '批量入库' },
  { value: 'package', label: '美团数据包' },
  { value: 'opening', label: '期初建账' },
] as const

function money(value: number) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function qty(value: number, digits = 3) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: digits })
}

function day(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function recordSourceLabel(row: InboundRecord) {
  if (row.type === 'OPENING_BALANCE') return '期初建账'
  return SOURCE_LABEL[row.sourceType] || row.sourceType
}

function supplierCell(row: InboundRecord) {
  if (row.supplier) return { text: row.supplier.name, tone: 'normal' as const }
  const text = row.sourceName || '—'
  if (text.includes('、')) return { text: `${text}（多供应商）`, tone: 'muted' as const }
  if (text !== '—') return { text: `${text}（待认领）`, tone: 'warn' as const }
  return { text, tone: 'muted' as const }
}

export default function InboundRecordsPage() {
  const [suppliers, setSuppliers] = useState<UpstreamSupplier[]>([])
  const [unclaimed, setUnclaimed] = useState<UnclaimedSource[]>([])
  const [claimTarget, setClaimTarget] = useState<Record<string, string>>({})
  const [claiming, setClaiming] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [source, setSource] = useState('all')
  const [q, setQ] = useState('')
  const [linkedProductId, setLinkedProductId] = useState('')
  const [linkedMode, setLinkedMode] = useState(false)
  const [linkSearchOverride, setLinkSearchOverride] = useState(false)
  const [restored, setRestored] = useState(false)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<InboundResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadUnclaimed = useCallback(async () => {
    try {
      const result = await apiFetch<{ items: UnclaimedSource[] }>('/api/supplier-aliases/unclaimed')
      setUnclaimed(result.items || [])
    } catch {
      setUnclaimed([])
    }
  }, [])

  const load = useCallback(async (pageNo: number) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(pageNo), pageSize: '50', source })
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (supplierId) params.set('supplierId', supplierId)
      if (linkedMode && linkedProductId && !linkSearchOverride) params.set('productId', linkedProductId)
      else if (q.trim()) params.set('q', q.trim())
      const result = await apiFetch<InboundResponse>(`/api/warehouse-inventory/inbound-records?${params}`)
      setData(result)
      setPage(result.page)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setLoading(false)
    }
  }, [from, to, supplierId, source, q, linkedProductId, linkedMode, linkSearchOverride])

  useEffect(() => {
    apiFetch<UpstreamSupplier[]>('/api/suppliers?businessScope=WAREHOUSE_UPSTREAM')
      .then(rows => setSuppliers(Array.isArray(rows) ? rows : []))
      .catch(() => setSuppliers([]))
    loadUnclaimed()
  }, [loadUnclaimed])

  useEffect(() => { if (restored) load(page) }, [load, page, restored])

  useEffect(() => {
    const saved = readWarehouseViewState('warehouse-inbound-view', { from: '', to: '', supplierId: '', source: 'all', q: '', page: 1 })
    setFrom(saved.from); setTo(saved.to); setSupplierId(saved.supplierId); setSource(saved.source); setQ(saved.q); setPage(saved.page)
    setLinkedProductId(new URLSearchParams(window.location.search).get('linkedProductId') || '')
    setRestored(true)
  }, [])
  useEffect(() => { if (restored) writeWarehouseViewState('warehouse-inbound-view', { from, to, supplierId, source, q, page }) }, [from, to, supplierId, source, q, page, restored])
  useWarehouseScrollRestoration('warehouse-inbound-view')

  async function claim(item: UnclaimedSource) {
    const target = claimTarget[item.sourceName]
    if (!target) {
      setError('请先选择要归并到的供应商')
      return
    }
    setClaiming(item.sourceName)
    setError('')
    try {
      const result = await apiFetch<{ ok: boolean; backfilled: number }>('/api/supplier-aliases', {
        method: 'POST',
        body: JSON.stringify({ supplierId: target, alias: item.sourceName, backfill: true }),
      })
      setNotice(`已认领「${item.sourceName}」并回填 ${result.backfilled} 行历史台账；以后该名称自动归属此供应商`)
      await Promise.all([loadUnclaimed(), load(page)])
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setClaiming('')
    }
  }

  const items = data?.items || []
  const exactSearchProduct = data?.matchedProduct || null
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="mx-auto max-w-7xl p-4 pb-24">
      <WarehouseToolTabs linkedProductId={linkedProductId} product={!linkedMode || linkSearchOverride ? exactSearchProduct : null} onLinkedProductChange={id => { setLinkedProductId(id); setLinkSearchOverride(false) }} onLinkedModeChange={mode => { setLinkedMode(mode); setLinkSearchOverride(false) }} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1">入库记录</h1>
          <p className="mt-1 text-caption text-gray3">总仓全部入库流水：手工、批量、美团数据包与期初建账 · 按供应商归集</p>
        </div>
        <Link href="/v2/supply-chain/relations" className="rounded-cta border border-border bg-white px-4 py-2 text-button text-gray2">供货关系 →</Link>
      </div>

      {notice && <div className="mt-4 rounded-card border border-green/30 bg-green/10 p-3 text-caption text-green-fg">{notice}</div>}
      {error && <div className="mt-4 rounded-card border border-red/30 bg-red/10 p-3 text-caption text-red-fg">{error}</div>}

      {unclaimed.length > 0 && <section className="mt-4 overflow-hidden rounded-card border border-amber/40 bg-white">
        <div className="border-b border-border bg-amber/5 px-4 py-3">
          <h2 className="text-h2 text-amber-fg">待认领来源（{unclaimed.length}）</h2>
          <p className="mt-1 text-micro text-gray3">历史/数据包里的供应商文本还没对应到供应商档案。认领一次后自动记住，历史台账同步回填。</p>
        </div>
        <ul className="divide-y divide-border">
          {unclaimed.map(item => <li key={item.sourceName} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <b className="text-body">{item.sourceName}</b>
              {item.multi && <span className="ml-2 rounded bg-gray-bg px-2 py-0.5 text-micro text-gray2">多供应商拼合，不可认领</span>}
              <div className="mt-0.5 text-micro text-gray3">{item.rowCount} 行流水 · 最近 {day(item.lastUsedAt)}</div>
            </div>
            {!item.multi && <>
              <select
                aria-label={`${item.sourceName}认领到供应商`}
                value={claimTarget[item.sourceName] || ''}
                onChange={event => setClaimTarget(current => ({ ...current, [item.sourceName]: event.target.value }))}
                className="h-10 rounded-cta border border-border bg-white px-3 text-caption"
              >
                <option value="">归并到供应商…</option>
                {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.no} · {supplier.name}</option>)}
              </select>
              <button
                onClick={() => claim(item)}
                disabled={claiming === item.sourceName || !claimTarget[item.sourceName]}
                className="h-10 rounded-cta bg-accent px-4 text-button text-white disabled:opacity-40"
              >{claiming === item.sourceName ? '认领中…' : '认领并回填'}</button>
            </>}
          </li>)}
        </ul>
      </section>}

      <section className="mt-4 rounded-card border border-border bg-white p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="sm:col-span-2"><DateRangeCalendar value={{ from, to }} onChange={range => { setFrom(range.from); setTo(range.to); setPage(1) }} /></div>
          <label><span className="mb-1 block text-micro text-gray3">供应商</span><select value={supplierId} onChange={event => { setSupplierId(event.target.value); setPage(1) }} className="h-11 w-full rounded-cta border border-border bg-white px-3"><option value="">全部供应商</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.no} · {supplier.name}</option>)}</select></label>
          <label><span className="mb-1 block text-micro text-gray3">来源类型</span><select value={source} onChange={event => { setSource(event.target.value); setPage(1) }} className="h-11 w-full rounded-cta border border-border bg-white px-3">{SOURCE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="lg:col-span-2"><span className="mb-1 block text-micro text-gray3">商品</span><input value={q} onChange={event => { setQ(event.target.value); setPage(1); if (linkedMode) setLinkSearchOverride(Boolean(event.target.value.trim())) }} placeholder={linkedMode ? '输入精确名称/编码可更换关联商品' : '编码 / 名称'} className="h-11 w-full rounded-cta border border-border px-3" /></label>
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-card border border-border bg-white">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-h2">入库流水{data ? `（共 ${data.total} 行）` : ''}</h2>
          <div className="flex items-center gap-3">
            {data && data.totalAmount !== undefined && <span className="text-caption font-semibold text-accent">合计 ¥{data.totalAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
            <span className="text-micro text-gray3">金额为含税入库金额 · 单价按库存单位</span>
          </div>
        </div>
        <div className="overflow-auto">
          {items.length > 0 && <table className="w-full min-w-[1080px] text-left text-caption">
            <thead className="bg-bg text-gray3"><tr>
              <th className="px-3 py-3">日期</th><th className="px-3 py-3">商品</th><th className="px-3 py-3 text-right">入库数量</th>
              <th className="px-3 py-3 text-right">单价</th><th className="px-3 py-3 text-right">金额</th>
              <th className="px-3 py-3">供应商</th><th className="px-3 py-3">来源</th><th className="px-3 py-3">批次/效期</th>
              <th className="px-3 py-3">单据</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {items.map(row => {
                const supplier = supplierCell(row)
                return <tr key={row.id} className={row.reversed ? 'opacity-50' : ''}>
                  <td className="whitespace-nowrap px-3 py-3 font-num text-gray2">{day(row.effectiveAt)}</td>
                  <td className="px-3 py-3"><b>{row.product.name}</b>
                    <div className="text-micro text-gray3">{row.product.code}{row.product.category ? ` · ${row.product.category}` : ''}{row.reversed ? ' · 已冲销' : ''}</div></td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-num">{qty(row.originalQuantity)} {row.originalUnit}
                    <div className="text-micro text-gray3">{qty(row.inventoryQuantity)} {row.inventoryUnit}</div></td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-num">{money(row.inventoryUnitCost)}/{row.inventoryUnit}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-num"><b>{money(row.amount)}</b></td>
                  <td className={`px-3 py-3 ${supplier.tone === 'warn' ? 'text-amber-fg' : supplier.tone === 'muted' ? 'text-gray3' : ''}`}>{supplier.text}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-gray2">{recordSourceLabel(row)}</td>
                  <td className="px-3 py-3 text-micro text-gray3">{row.batchNo || '—'}{row.expiryDate ? <div>效期 {String(row.expiryDate).slice(0, 10)}</div> : null}</td>
                  <td className="whitespace-nowrap px-3 py-3">
                    {row.doc ? (
                      <a
                        href={`/v2/supply-chain/docs?doc=${row.doc.id}${linkedProductId ? `&linkedProductId=${encodeURIComponent(linkedProductId)}` : ''}`}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-micro ${row.doc.status === 'POSTED' ? 'border-amber bg-amber-50 text-amber-fg hover:bg-amber-100' : 'border-border bg-bg text-gray2 hover:border-accent'}`}
                        title={row.doc.status === 'POSTED' ? '未审核，可点击改单' : '已审核，点击查看'}
                      >
                        {row.doc.status === 'POSTED' ? `✏️ 改单 ${row.doc.docNo}` : `✓ ${row.doc.docNo}`}
                      </a>
                    ) : <span className="text-gray3">—</span>}
                  </td>
                </tr>
              })}
            </tbody>
          </table>}
          {!loading && items.length === 0 && <div className="py-12 text-center text-caption text-gray3">当前筛选条件下没有入库记录</div>}
          {loading && <div className="py-12 text-center text-caption text-gray3">正在加载…</div>}
        </div>
        {data && data.total > data.pageSize && <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-micro text-gray3">第 {page} / {totalPages} 页</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(page - 1)} disabled={loading || page <= 1} className="rounded-cta border border-border bg-white px-4 py-2 text-button text-gray2 disabled:opacity-40">上一页</button>
            <button onClick={() => setPage(page + 1)} disabled={loading || page >= totalPages} className="rounded-cta border border-border bg-white px-4 py-2 text-button text-gray2 disabled:opacity-40">下一页</button>
          </div>
        </div>}
      </section>
    </div>
  )
}
