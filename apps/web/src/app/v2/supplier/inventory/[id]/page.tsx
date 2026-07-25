/**
 * 供应商 · 单 SKU 库存详情
 * - 顶部: 当前库存 + 警戒线 + 价格
 * - 操作: 入库 / 盘点 / 报损
 * - 流水: 时间倒序, 显示类型/数量/余额/操作人/原因
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'
import {
  DEFAULT_WAREHOUSE_NAME,
  withWarehouseBody,
  withWarehouseParam,
} from '@/lib/supplier-default-warehouse'

type Movement = {
  id: string; type: string; delta: number; balanceAfter: number
  reason: string | null; sourceType: string | null; sourceId: string | null
  manufactureDate: string | null; expiryDate: string | null
  createdAt: string
  product: { name: string; code: string; unit: string; spec: string | null }
  operator: string | null
}
type StockItem = {
  id: string; code: string; name: string; spec: string | null; unit: string
  stock: number; minStock: number; price: number; shelfDays: number | null
  physicalStock: number; reservedStock: number; availableStock: number
  statusFlag: 'OUT'|'LOW'|'OK'
  in7d: number; out7d: number; in30d: number; out30d: number
  nearestExpiry: string | null; daysToExpiry: number | null
}
type Reservation = {
  id: string; quantity: number; createdAt: string
  order: { id: string; no: string; status: string; expectedDate: string; store: { id: string; name: string } }
}
type StockBatch = {
  id: string; batchNo: string; kind: 'OPENING'|'INBOUND'|'ADJUSTMENT'|'RETURN'
  initialQty: number; remainingQty: number
  manufactureDate: string | null; expiryDate: string | null; createdAt: string
  source: { type: string; reason: string | null; sourceType: string | null; sourceId: string | null } | null
}

const BATCH_KIND_LABEL: Record<StockBatch['kind'], string> = {
  OPENING: '期初', INBOUND: '入库', ADJUSTMENT: '调整', RETURN: '退回',
}

const TYPE_LABEL: Record<string, string> = {
  INITIAL: '初始库存', INBOUND_MANUAL: '手动入库', INBOUND_EXCEL: 'Excel 入库',
  OUTBOUND_PO: '订单出库', ADJUSTMENT: '盘点调整', LOSS: '报损',
}
const TYPE_TONE: Record<string, 'green'|'red'|'orange'|'gray'> = {
  INITIAL: 'gray', INBOUND_MANUAL: 'green', INBOUND_EXCEL: 'green',
  OUTBOUND_PO: 'red', ADJUSTMENT: 'orange', LOSS: 'red',
}

export default function SkuDetailPage() {
  const params = useParams() as any
  const productId = params.id as string

  const [item, setItem] = useState<StockItem | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [batches, setBatches] = useState<StockBatch[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'adjust'|'loss'|null>(null)
  const [adjustQty, setAdjustQty] = useState('')
  const [adjustReason, setAdjustReason] = useState('')

  function load() {
    apiFetch<{ items: StockItem[]; total: number }>(withWarehouseParam(`/api/supplier/stock?productId=${encodeURIComponent(productId)}&page=1&pageSize=1`))
      .then(res => setItem(res.items[0] || null))
      .catch(e => setError(e.message))
    apiFetch<Movement[]>(withWarehouseParam(`/api/supplier/stock/movements?productId=${productId}`))
      .then(setMovements).catch(() => {})
    apiFetch<Reservation[]>(withWarehouseParam(`/api/supplier/stock/reservations?productId=${productId}`))
      .then(setReservations).catch(() => {})
    apiFetch<StockBatch[]>(withWarehouseParam(`/api/supplier/stock/batches?productId=${encodeURIComponent(productId)}`))
      .then(setBatches).catch(() => {})
  }
  useEffect(() => { load() }, [productId])

  async function doAdjust() {
    setError(null)
    const n = Number(adjustQty)
    if (!Number.isFinite(n) || n < 0) { setError('请输入有效数字'); return }
    if (!adjustReason.trim()) { setError('请填写理由'); return }
    try {
      await apiFetch(withWarehouseParam(`/api/supplier/stock/${sheet}`), {
        method: 'POST',
        body: JSON.stringify(withWarehouseBody(sheet === 'adjust'
          ? { productId, newQty: n, reason: adjustReason.trim() }
          : { productId, qty: n, reason: adjustReason.trim() }
        )),
      })
      setSheet(null); setAdjustQty(''); setAdjustReason('')
      load()
    } catch (e: any) { setError(e.message || '提交失败') }
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-bg p-4">
        <a href="/v2/supplier/inventory" className="text-caption text-gray2">‹ 返回库存</a>
        {error ? <p className="text-red-fg mt-4">{error}</p> : <p className="text-gray3 mt-4">加载中…</p>}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/supplier/inventory" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1 truncate">{item.name}</h1>
        <span className="text-caption text-gray3">{DEFAULT_WAREHOUSE_NAME}</span>
      </header>

      {/* 主卡 */}
      <div className="mx-4 bg-white rounded-card border border-border p-4">
        <div className="text-micro text-gray3 font-num">
          #{item.code}{item.spec ? ` · ${item.spec}` : ''}
          {item.shelfDays != null && <span className="ml-1.5">· 默认保质期 {item.shelfDays} 天</span>}
        </div>
        <div className="flex items-end gap-2 mt-2">
          <span className={`text-h1 font-num text-3xl ${item.statusFlag==='OUT'?'text-red-fg':item.statusFlag==='LOW'?'text-amber-fg':'text-ink'}`}>{item.availableStock}</span>
          <span className="text-body text-gray3 mb-0.5">{item.unit}</span>
          <span className="ml-auto text-caption text-gray2">单价 ¥{item.price}</span>
        </div>
        <div className="text-caption text-gray2 mt-2">
          可用库存 · 物理 {item.physicalStock} - 已占 {item.reservedStock} · 安全库存 {item.minStock} {item.unit} ·
          近 30 日 <span className="text-green-fg">+{item.in30d}</span> / <span className="text-red-fg">-{item.out30d}</span>
        </div>
        {item.nearestExpiry && (
          <div className={`mt-2 px-2 py-1.5 rounded text-caption ${
            item.daysToExpiry !== null && item.daysToExpiry < 0 ? 'bg-red-bg text-red-fg' :
            item.daysToExpiry !== null && item.daysToExpiry <= 7 ? 'bg-amber/10 text-amber-fg' :
            'bg-bg text-gray2'
          }`}>
            ⏱ 最近到期日: <b>{item.nearestExpiry}</b>
            {item.daysToExpiry !== null && (
              item.daysToExpiry < 0 ? ` · 已过期 ${-item.daysToExpiry} 天` :
              ` · 还剩 ${item.daysToExpiry} 天`
            )}
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="px-4 mt-3 grid grid-cols-3 gap-2">
        <a href={`/v2/supplier/inventory/inbound?sku=${item.id}`} className="py-2.5 bg-amber text-white rounded-cta text-button text-center">↓ 入库</a>
        <button onClick={() => { setSheet('adjust'); setAdjustQty(String(item.stock)); setAdjustReason('') }}
          className="py-2.5 bg-white border border-border rounded-cta text-button">⇄ 盘点</button>
        <button onClick={() => { setSheet('loss'); setAdjustQty(''); setAdjustReason('') }}
          className="py-2.5 bg-white border border-border rounded-cta text-button text-red-fg">⊖ 报损</button>
      </div>

      {reservations.length > 0 && (
        <div className="px-4 mt-4">
          <h2 className="text-h2 mb-2">已占订单 ({reservations.length})</h2>
          <ul className="space-y-2">
            {reservations.map(reservation => (
              <li key={reservation.id} className="bg-amber/10 border border-amber/30 rounded-card p-3">
                <a href={`/v2/supplier/orders/${reservation.order.id}`} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-body truncate">{reservation.order.store.name} · #{reservation.order.no}</div>
                    <div className="text-micro text-gray3 mt-0.5">期望到货 {new Date(reservation.order.expectedDate).toLocaleDateString('zh-CN')}</div>
                  </div>
                  <div className="font-num text-h2 text-amber-fg">{reservation.quantity} {item.unit}</div>
                  <span className="text-gray3">›</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-4 mt-5">
        <h2 className="text-h2 mb-2">在库批次 ({batches.length})</h2>
        {batches.length === 0 ? (
          <p className="text-caption text-gray3 text-center py-6 bg-white border border-border rounded-card">当前没有在库批次</p>
        ) : (
          <ul className="space-y-2">
            {batches.map(batch => (
              <li key={batch.id} className="bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2">
                  <Chip tone={batch.kind === 'INBOUND' || batch.kind === 'RETURN' ? 'green' : 'gray'}>
                    {BATCH_KIND_LABEL[batch.kind]}
                  </Chip>
                  <span className="text-caption font-num truncate">{batch.batchNo}</span>
                  <span className="ml-auto text-h2 font-num">{batch.remainingQty} {item.unit}</span>
                </div>
                <div className="text-micro text-gray3 mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  <span>初始 {batch.initialQty}</span>
                  {batch.manufactureDate && <span>生产 {batch.manufactureDate}</span>}
                  {batch.expiryDate && <span className="text-amber-fg">到期 {batch.expiryDate}</span>}
                  <span>入账 {new Date(batch.createdAt).toLocaleDateString('zh-CN')}</span>
                </div>
                {batch.source?.reason && <div className="text-caption text-gray2 mt-1">{batch.source.reason}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 流水 */}
      <div className="px-4 mt-5">
        <h2 className="text-h2 mb-2">流水 ({movements.length})</h2>
        {movements.length === 0 && <p className="text-caption text-gray3 text-center py-6 bg-white border border-border rounded-card">暂无变动记录</p>}
        <ul className="space-y-2">
          {movements.map(m => (
            <li key={m.id} className="bg-white rounded-card border border-border p-3">
              <div className="flex items-center gap-2">
                <Chip tone={TYPE_TONE[m.type]}>{TYPE_LABEL[m.type] || m.type}</Chip>
                <span className={`font-num text-h2 ${m.delta>0?'text-green-fg':'text-red-fg'}`}>{m.delta>0?'+':''}{m.delta}</span>
                <span className="text-caption text-gray3">{m.product.unit}</span>
                <span className="ml-auto text-micro text-gray3 font-num">余 {m.balanceAfter}</span>
              </div>
              <div className="text-micro text-gray3 mt-1 flex items-center gap-2 flex-wrap">
                <span>{new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                {m.operator && <span>· {m.operator}</span>}
                {m.expiryDate && <span className="text-amber-fg">· 到期 {m.expiryDate}</span>}
              </div>
              {m.reason && <div className="text-caption text-gray2 mt-1">{m.reason}</div>}
            </li>
          ))}
        </ul>
      </div>

      {/* 盘点 / 报损 sheet */}
      {sheet && (
        <div className="fixed inset-0 z-50 bg-ink/40 flex items-end" onClick={() => setSheet(null)}>
          <div className="w-full bg-white rounded-t-2xl p-4" onClick={e => e.stopPropagation()}
               style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom))' }}>
            <h2 className="text-h2">{sheet === 'adjust' ? '盘点 — 设置实际库存' : '报损 — 减少库存'}</h2>
            <p className="text-caption text-gray3 mt-1">
              {sheet === 'adjust' ? `当前 ${item.stock} ${item.unit}, 输入实际盘点数字` : '只填减少的数量, 不是新库存'}
            </p>
            <input type="number" step="0.01" min="0" value={adjustQty}
              onChange={e => setAdjustQty(e.target.value)}
              placeholder={sheet === 'adjust' ? '盘点后实际库存' : '报损数量'}
              className="w-full mt-3 bg-bg border border-border rounded p-3 text-h2 font-num" />
            <input value={adjustReason} onChange={e => setAdjustReason(e.target.value)}
              placeholder={sheet === 'adjust' ? '盘点原因 (如: 月末实物盘点)' : '报损原因 (如: 蔬菜腐烂)'}
              maxLength={120}
              className="w-full mt-2 bg-bg border border-border rounded p-2 text-body" />
            {error && <p className="text-red-fg text-caption mt-2">{error}</p>}
            <button onClick={doAdjust}
              className="w-full mt-4 py-3 bg-ink text-white rounded-cta text-button">确认</button>
          </div>
        </div>
      )}
    </div>
  )
}
