'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type StockItem = {
  id: string; code: string; name: string; spec?: string | null; unit: string; inventoryUnit?: string | null
  physicalStock: number; reservedStock: number; availableStock: number; minStock: number
  nearestExpiry?: string | null; daysToExpiry?: number | null
}
type Movement = { id: string; type: string; delta: number; balanceAfter: number; reason?: string | null; createdAt: string; operator?: string | null }
type Reservation = { id: string; quantity: number; createdAt: string; order: { id: string; no: string; expectedDate: string; store: { name: string } } }
type Batch = { id: string; batchNo: string; kind: string; initialQty: number; remainingQty: number; manufactureDate?: string | null; expiryDate?: string | null; createdAt: string; source?: { reason?: string | null } | null }

const TYPE_LABEL: Record<string, string> = { INITIAL: '期初', INBOUND_MANUAL: '手工入库', INBOUND_EXCEL: 'Excel 入库', OUTBOUND_PO: '订单出库', ADJUSTMENT: '盘点调整', LOSS: '报损' }

export default function InternalStockDetailPage() {
  const productId = String((useParams() as { id: string }).id)
  const [supplierId, setSupplierId] = useState('')
  const [item, setItem] = useState<StockItem | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [error, setError] = useState('')

  useEffect(() => { setSupplierId(new URLSearchParams(window.location.search).get('supplierId') || '') }, [])
  useEffect(() => {
    if (!supplierId || !productId) return
    const scope = `supplierId=${encodeURIComponent(supplierId)}`
    Promise.all([
      apiFetch<{ items: StockItem[] }>(`/api/supplier/stock?productId=${encodeURIComponent(productId)}&page=1&pageSize=1&${scope}`),
      apiFetch<Movement[]>(`/api/supplier/stock/movements?productId=${encodeURIComponent(productId)}&limit=200&${scope}`),
      apiFetch<Reservation[]>(`/api/supplier/stock/reservations?productId=${encodeURIComponent(productId)}&${scope}`),
      apiFetch<Batch[]>(`/api/supplier/stock/batches?productId=${encodeURIComponent(productId)}&includeDepleted=true&limit=200&${scope}`),
    ]).then(([stock, movementRows, reservationRows, batchRows]) => {
      setItem(stock.items?.[0] || null)
      setMovements(movementRows || [])
      setReservations(reservationRows || [])
      setBatches(batchRows || [])
    }).catch(reason => setError(String(reason?.message || reason)))
  }, [productId, supplierId])

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="border-b border-border pb-5"><a href="/v2/supply-chain/inventory" className="text-caption text-gray2">‹ 返回仓库库存</a><div className="mt-2 flex items-center gap-2"><Chip tone="green">只读详情</Chip><span className="text-caption text-gray3">批次、有效期、预占和操作流水</span></div><h1 className="mt-2 text-h1">{item?.name || '库存详情'}</h1><p className="mt-1 text-caption text-gray3">{item ? `${item.code} · ${item.spec || '无规格'}` : '加载中…'}</p></header>
      {error && <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {item && <section className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-5"><Metric label="物理库存" value={`${item.physicalStock} ${item.inventoryUnit || item.unit}`} /><Metric label="已占用" value={String(item.reservedStock)} /><Metric label="可用库存" value={String(item.availableStock)} /><Metric label="安全线" value={String(item.minStock)} /><Metric label="最近到期" value={item.nearestExpiry || '—'} /></section>}
      <section className="grid gap-4 xl:grid-cols-2">
        <Panel title={`在库批次（${batches.length}）`}><table className="w-full text-left text-caption"><thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">批次</th><th className="px-4 py-2">来源</th><th className="px-4 py-2 text-right">初始 / 剩余</th><th className="px-4 py-2">生产 / 到期</th></tr></thead><tbody className="divide-y divide-border">{batches.map(batch => <tr key={batch.id}><td className="px-4 py-3 font-num">{batch.batchNo}</td><td className="px-4 py-3">{batch.kind}<div className="text-micro text-gray3">{batch.source?.reason}</div></td><td className="px-4 py-3 text-right font-num">{batch.initialQty} / {batch.remainingQty}</td><td className="px-4 py-3 font-num text-gray2">{batch.manufactureDate || '—'}<br />{batch.expiryDate || '—'}</td></tr>)}</tbody></table>{batches.length === 0 && <Empty text="暂无批次记录" />}</Panel>
        <Panel title={`有效预占（${reservations.length}）`}><ul className="divide-y divide-border">{reservations.map(row => <li key={row.id} className="flex items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><a className="font-num text-accent" href={`/v2/supply-chain/fulfillment/${row.order.id}`}>{row.order.no}</a><div className="text-micro text-gray3">{row.order.store.name} · 期望 {String(row.order.expectedDate).slice(0, 10)}</div></div><b className="font-num">{row.quantity}</b></li>)}</ul>{reservations.length === 0 && <Empty text="当前没有有效预占" />}</Panel>
      </section>
      <section className="mt-4"><Panel title={`库存流水（${movements.length}）`}><table className="w-full text-left text-caption"><thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">时间</th><th className="px-4 py-2">类型</th><th className="px-4 py-2 text-right">变化</th><th className="px-4 py-2 text-right">余额</th><th className="px-4 py-2">操作人 / 说明</th></tr></thead><tbody className="divide-y divide-border">{movements.map(row => <tr key={row.id}><td className="px-4 py-3 font-num text-gray2">{new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}</td><td className="px-4 py-3">{TYPE_LABEL[row.type] || row.type}</td><td className={`px-4 py-3 text-right font-num ${row.delta >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{row.delta >= 0 ? '+' : ''}{row.delta}</td><td className="px-4 py-3 text-right font-num">{row.balanceAfter}</td><td className="px-4 py-3">{row.operator || '系统'}<div className="text-micro text-gray3">{row.reason || '—'}</div></td></tr>)}</tbody></table>{movements.length === 0 && <Empty text="暂无库存流水" />}</Panel></section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className="mt-1 font-num text-h1">{value}</div></div> }
function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <div className="overflow-hidden rounded-card border border-border bg-white"><h2 className="border-b border-border px-4 py-3 text-h2">{title}</h2><div className="overflow-auto">{children}</div></div> }
function Empty({ text }: { text: string }) { return <div className="py-12 text-center text-caption text-gray3">{text}</div> }
