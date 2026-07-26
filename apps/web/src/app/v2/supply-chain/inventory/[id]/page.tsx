'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import {
  assertRealWarehouseResponse,
  withSupplierWarehouseParams,
} from '@/lib/supplier-default-warehouse'

type StockItem = {
  id: string; code: string; name: string; spec?: string | null; unit: string; inventoryUnit?: string | null
  physicalStock: number; reservedStock: number; availableStock: number; minStock: number
  nearestExpiry?: string | null; daysToExpiry?: number | null
}
type Movement = { id: string; type: string; delta: number; balanceAfter: number; reason?: string | null; createdAt: string; operator?: string | null }
type Reservation = { id: string; quantity: number; createdAt: string; order: { id: string; no: string; expectedDate: string; store: { name: string } } }
type Batch = { id: string; batchNo: string; kind: string; initialQty: number; remainingQty: number; manufactureDate?: string | null; expiryDate?: string | null; createdAt: string; source?: { reason?: string | null } | null }

const TYPE_LABEL: Record<string, string> = { INITIAL: '期初', INBOUND_MANUAL: '手工入库', INBOUND_EXCEL: 'Excel 入库', OUTBOUND_PO: '订单出库', ADJUSTMENT: '盘点调整', LOSS: '报损' }

type SheetMode = 'adjust' | 'loss' | null

function displayUnit(item: StockItem | null): string {
  return item?.inventoryUnit || item?.unit || ''
}

function isValidQty(value: string, allowZero: boolean): { ok: false; message: string } | { ok: true; n: number } {
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, message: '请填写数量' }
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return { ok: false, message: '请输入有效数字' }
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false, message: '请输入最多两位小数的有效数字' }
  if (n < 0) return { ok: false, message: '数量不能为负数' }
  if (!allowZero && n === 0) return { ok: false, message: '数量必须大于 0' }
  return { ok: true, n }
}

export default function InternalStockDetailPage() {
  const productId = String((useParams() as { id: string }).id)
  const [supplierId, setSupplierId] = useState('')
  const [item, setItem] = useState<StockItem | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [sheet, setSheet] = useState<SheetMode>(null)
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => { setSupplierId(new URLSearchParams(window.location.search).get('supplierId') || '') }, [])

  function load() {
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
  }

  useEffect(() => { load() }, [productId, supplierId])

  function openSheet(mode: Extract<SheetMode, 'adjust' | 'loss'>) {
    setSheet(mode)
    setQty(mode === 'adjust' ? String(item?.physicalStock ?? '') : '')
    setReason('')
    setError('')
    setNotice('')
  }

  function closeSheet() {
    setSheet(null)
    setQty('')
    setReason('')
    setSubmitting(false)
  }

  async function submit() {
    setError('')
    setNotice('')
    if (!supplierId) {
      setError('缺少供应商信息，无法提交')
      return
    }
    const reasonText = reason.trim()
    if (!reasonText) {
      setError('请填写原因')
      return
    }
    if (reasonText.length > 120) {
      setError('原因不能超过 120 字')
      return
    }
    const validation = isValidQty(qty, sheet === 'adjust')
    if (!validation.ok) {
      setError(validation.message)
      return
    }

    const body = sheet === 'adjust'
      ? { productId, newQty: validation.n, reason: reasonText }
      : { productId, qty: validation.n, reason: reasonText }

    setSubmitting(true)
    try {
      const res = await apiFetch<any>(
        withSupplierWarehouseParams(`/api/supplier/stock/${sheet}`, supplierId),
        { method: 'POST', body: JSON.stringify(body) },
      )
      const { warehouseName } = assertRealWarehouseResponse(res)
      const actionLabel = sheet === 'adjust' ? '盘点调整' : '报损登记'
      closeSheet()
      setNotice(`${actionLabel}成功（${warehouseName}），库存与流水已同步更新`)
      load()
    } catch (reasonValue: any) {
      setError(String(reasonValue?.message || reasonValue))
    } finally {
      setSubmitting(false)
    }
  }

  const unit = displayUnit(item)

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="border-b border-border pb-5">
        <a href="/v2/supply-chain/inventory" className="text-caption text-gray2">‹ 返回仓库库存</a>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Chip tone="green">内部可操作</Chip>
          <span className="text-caption text-gray3">批次、有效期、预占和操作流水</span>
        </div>
        <h1 className="mt-2 text-h1">{item?.name || '库存详情'}</h1>
        <p className="mt-1 text-caption text-gray3">{item ? `${item.code} · ${item.spec || '无规格'}` : '加载中…'}</p>
        {item && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => openSheet('adjust')}
              disabled={!supplierId}
              className="h-10 rounded-cta border border-border bg-white px-4 text-button disabled:opacity-40"
            >⇄ 盘点调整</button>
            <button
              onClick={() => openSheet('loss')}
              disabled={!supplierId}
              className="h-10 rounded-cta border border-border bg-white px-4 text-button text-red-fg disabled:opacity-40"
            >⊖ 报损登记</button>
          </div>
        )}
      </header>

      {error && !sheet && <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {notice && <div className="mt-4 rounded-card border border-green/30 bg-green/10 p-3 text-caption text-green-fg">{notice}</div>}

      {item && <section className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-5"><Metric label="物理库存" value={`${item.physicalStock} ${unit}`} /><Metric label="已占用" value={`${item.reservedStock} ${unit}`} /><Metric label="可用库存" value={`${item.availableStock} ${unit}`} /><Metric label="安全线" value={`${item.minStock} ${unit}`} /><Metric label="最近到期" value={item.nearestExpiry || '—'} /></section>}
      <section className="grid gap-4 xl:grid-cols-2">
        <Panel title={`在库批次（${batches.length}）`}><table className="w-full text-left text-caption"><thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">批次</th><th className="px-4 py-2">来源</th><th className="px-4 py-2 text-right">初始 / 剩余</th><th className="px-4 py-2">生产 / 到期</th></tr></thead><tbody className="divide-y divide-border">{batches.map(batch => <tr key={batch.id}><td className="px-4 py-3 font-num">{batch.batchNo}</td><td className="px-4 py-3">{batch.kind}<div className="text-micro text-gray3">{batch.source?.reason}</div></td><td className="px-4 py-3 text-right font-num">{batch.initialQty} / {batch.remainingQty}</td><td className="px-4 py-3 font-num text-gray2">{batch.manufactureDate || '—'}<br />{batch.expiryDate || '—'}</td></tr>)}</tbody></table>{batches.length === 0 && <Empty text="暂无批次记录" />}</Panel>
        <Panel title={`有效预占（${reservations.length}）`}><ul className="divide-y divide-border">{reservations.map(row => <li key={row.id} className="flex items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><a className="font-num text-accent" href={`/v2/supply-chain/fulfillment/${row.order.id}`}>{row.order.no}</a><div className="text-micro text-gray3">{row.order.store.name} · 期望 {String(row.order.expectedDate).slice(0, 10)}</div></div><b className="font-num">{row.quantity} {unit}</b></li>)}</ul>{reservations.length === 0 && <Empty text="当前没有有效预占" />}</Panel>
      </section>
      <section className="mt-4"><Panel title={`库存流水（${movements.length}）`}><table className="w-full text-left text-caption"><thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">时间</th><th className="px-4 py-2">类型</th><th className="px-4 py-2 text-right">变化</th><th className="px-4 py-2 text-right">余额</th><th className="px-4 py-2">操作人 / 说明</th></tr></thead><tbody className="divide-y divide-border">{movements.map(row => <tr key={row.id}><td className="px-4 py-3 font-num text-gray2">{new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}</td><td className="px-4 py-3">{TYPE_LABEL[row.type] || row.type}</td><td className={`px-4 py-3 text-right font-num ${row.delta >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{row.delta >= 0 ? '+' : ''}{row.delta}</td><td className="px-4 py-3 text-right font-num">{row.balanceAfter}</td><td className="px-4 py-3">{row.operator || '系统'}<div className="text-micro text-gray3">{row.reason || '—'}</div></td></tr>)}</tbody></table>{movements.length === 0 && <Empty text="暂无库存流水" />}</Panel></section>

      {sheet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !submitting && closeSheet()}>
          <div className="w-full max-w-lg rounded-card bg-white p-5 shadow-xl" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-h2">{sheet === 'adjust' ? '盘点调整' : '报损登记'}</h2>
              <button onClick={() => !submitting && closeSheet()} disabled={submitting} className="px-2 text-h2 text-gray3 disabled:opacity-40">×</button>
            </div>
            <p className="mt-1 text-caption text-gray3">
              {sheet === 'adjust'
                ? `设置盘点后的实际库存数量（库存单位：${unit || '—'}）`
                : `登记报损数量（库存单位：${unit || '—'}）`}
            </p>
            {error && (
              <div className="mt-3 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">
                {error}
              </div>
            )}
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-micro text-gray3">{sheet === 'adjust' ? '盘点后数量' : '报损数量'}（库存单位）</span>
                <input
                  type="number"
                  step="0.01"
                  min={sheet === 'adjust' ? '0' : '0.01'}
                  value={qty}
                  onChange={event => setQty(event.target.value)}
                  placeholder={sheet === 'adjust' ? '盘点后实际库存' : '报损数量'}
                  className="h-11 w-full rounded-cta border border-border px-3"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-micro text-gray3">原因</span>
                <input
                  value={reason}
                  maxLength={120}
                  onChange={event => setReason(event.target.value)}
                  placeholder={sheet === 'adjust' ? '盘点原因（如：月末实物盘点）' : '报损原因（如：蔬菜腐烂）'}
                  className="h-11 w-full rounded-cta border border-border px-3"
                />
              </label>
              <button
                onClick={submit}
                disabled={submitting}
                className="h-11 w-full rounded-cta bg-accent text-button text-white disabled:opacity-40"
              >{submitting ? '正在提交…' : '确认提交'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className="mt-1 font-num text-h1">{value}</div></div> }
function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <div className="overflow-hidden rounded-card border border-border bg-white"><h2 className="border-b border-border px-4 py-3 text-h2">{title}</h2><div className="overflow-auto">{children}</div></div> }
function Empty({ text }: { text: string }) { return <div className="py-12 text-center text-caption text-gray3">{text}</div> }
