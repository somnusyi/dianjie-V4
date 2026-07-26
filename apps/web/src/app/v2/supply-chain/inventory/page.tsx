'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type Supplier = { id: string; no: string; name: string }
type StockItem = {
  id: string
  code: string
  name: string
  spec?: string | null
  category?: string | null
  inventoryUnit?: string | null
  unit: string
  stock: number
  reservedStock: number
  availableStock: number
  minStock: number
  statusFlag: 'OK' | 'LOW' | 'OUT'
}
type Summary = {
  inventoryMode: 'NOT_TRACKED' | 'STRICT'
  totalSku: number
  lowStock: number
  outOfStock: number
  totalValue: number
  warehouse?: { id: string; name: string }
}
type Movement = {
  id: string
  type: string
  delta: number
  balanceAfter: number
  reason?: string | null
  createdAt: string
  product?: { name: string; code: string; unit: string }
  operator?: string | null
}

const MOVEMENT_LABEL: Record<string, string> = {
  INITIAL: '期初',
  INBOUND_MANUAL: '手工入库',
  INBOUND_EXCEL: '导入入库',
  OUTBOUND_PO: '订单出库',
  ADJUSTMENT: '盘点调整',
  LOSS: '报损',
}

export default function InternalSupplyChainInventoryPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [items, setItems] = useState<StockItem[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [inboundOpen, setInboundOpen] = useState(false)
  const [productId, setProductId] = useState('')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('采购到货入库')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    apiFetch<Supplier[]>('/api/suppliers?status=ENABLED')
      .then(rows => {
        const list = Array.isArray(rows) ? rows : []
        setSuppliers(list)
        if (list[0]) setSupplierId(list[0].id)
      })
      .catch(reasonValue => setError(String(reasonValue?.message || reasonValue)))
  }, [])

  function load(selectedSupplierId = supplierId) {
    if (!selectedSupplierId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    const supplierQuery = `supplierId=${encodeURIComponent(selectedSupplierId)}`
    Promise.all([
      apiFetch<{ items: StockItem[] }>(`/api/supplier/stock?page=1&pageSize=200&${supplierQuery}`),
      apiFetch<Summary>(`/api/supplier/stock/summary?${supplierQuery}`),
      apiFetch<Movement[]>(`/api/supplier/stock/movements?limit=30&${supplierQuery}`),
    ])
      .then(([stock, stockSummary, stockMovements]) => {
        setItems(stock.items || [])
        setSummary(stockSummary)
        setMovements(stockMovements || [])
      })
      .catch(reasonValue => setError(String(reasonValue?.message || reasonValue)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [supplierId])

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return items
    return items.filter(item =>
      [item.name, item.code, item.spec, item.category]
        .some(value => String(value || '').toLowerCase().includes(term)),
    )
  }, [items, q])

  async function inbound() {
    const amount = Number(qty)
    if (!productId || !Number.isFinite(amount) || amount <= 0) {
      setError('请选择商品并填写大于 0 的入库数量')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await apiFetch(`/api/supplier/stock/inbound?supplierId=${encodeURIComponent(supplierId)}`, {
        method: 'POST',
        body: JSON.stringify({
          source: 'MANUAL',
          reason: reason.trim() || '采购到货入库',
          items: [{ productId, qty: amount }],
        }),
      })
      setInboundOpen(false)
      setProductId('')
      setQty('')
      setNotice('入库成功，库存与流水已同步更新')
      load()
    } catch (reasonValue: any) {
      setError(String(reasonValue?.message || reasonValue))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="green">内部可操作</Chip>
            <span className="text-caption text-gray3">默认仓 · 供应商维度台账</span>
          </div>
          <h1 className="text-h1">仓库库存</h1>
          <p className="mt-1 text-caption text-gray2">当前使用一个默认仓，接口按 warehouseId 保留多仓扩展。</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-micro text-gray3">供应商</span>
            <select
              value={supplierId}
              onChange={event => setSupplierId(event.target.value)}
              className="h-10 min-w-64 rounded-cta border border-border bg-white px-3 text-body"
            >
              {suppliers.map(supplier => (
                <option key={supplier.id} value={supplier.id}>{supplier.no} · {supplier.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-micro text-gray3">商品搜索</span>
            <input
              value={q}
              onChange={event => setQ(event.target.value)}
              placeholder="名称 / 编码 / 分类 / 规格"
              className="h-10 min-w-64 rounded-cta border border-border bg-white px-3 text-body"
            />
          </label>
          <button
            onClick={() => setInboundOpen(true)}
            disabled={!supplierId || summary?.inventoryMode === 'NOT_TRACKED'}
            className="h-10 rounded-cta bg-accent px-4 text-button text-white disabled:opacity-40"
          >+ 手工入库</button>
        </div>
      </header>

      {error && <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {notice && <div className="mt-4 rounded-card border border-green/30 bg-green/10 p-3 text-caption text-green-fg">{notice}</div>}

      <section className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="仓库" value={summary?.warehouse?.name || '默认仓'} />
        <Metric label="SKU" value={String(summary?.totalSku ?? '—')} />
        <Metric label="低库存" value={String(summary?.lowStock ?? '—')} />
        <Metric label="缺货" value={String(summary?.outOfStock ?? '—')} />
        <Metric label="库存金额" value={summary ? `¥${Math.round(summary.totalValue).toLocaleString()}` : '—'} />
      </section>

      {summary?.inventoryMode === 'NOT_TRACKED' && (
        <div className="mb-4 rounded-card border border-amber/30 bg-amber/10 p-4 text-caption text-gray2">
          该供应商库存模式尚未启用；订单履约不扣减其库存，需先完成库存启用与期初导入。
        </div>
      )}

      <section className="grid gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-h2">库存明细</h2>
            <p className="text-micro text-gray3">{loading ? '加载中…' : `${visible.length} 个商品`}</p>
          </div>
          <div className="max-h-[650px] overflow-auto">
            <table className="w-full text-left text-caption">
              <thead className="sticky top-0 bg-bg text-gray3">
                <tr>
                  <th className="px-4 py-3">商品</th><th className="px-4 py-3">分类</th>
                  <th className="px-4 py-3 text-right">物理库存</th><th className="px-4 py-3 text-right">已占用</th>
                  <th className="px-4 py-3 text-right">可用</th><th className="px-4 py-3">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map(item => (
                  <tr key={item.id}>
                    <td className="px-4 py-3"><b>{item.name}</b><div className="text-micro text-gray3">{item.code} · {item.spec || '—'}</div></td>
                    <td className="px-4 py-3 text-gray2">{item.category || '未分类'}</td>
                    <td className="px-4 py-3 text-right font-num">{item.stock} {item.inventoryUnit || item.unit}</td>
                    <td className="px-4 py-3 text-right font-num text-gray2">{item.reservedStock}</td>
                    <td className="px-4 py-3 text-right font-num">{item.availableStock}</td>
                    <td className="px-4 py-3">
                      <Chip tone={item.statusFlag === 'OUT' ? 'red' : item.statusFlag === 'LOW' ? 'orange' : 'green'}>
                        {item.statusFlag === 'OUT' ? '缺货' : item.statusFlag === 'LOW' ? '偏低' : '正常'}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && visible.length === 0 && <div className="py-12 text-center text-caption text-gray3">暂无匹配库存</div>}
          </div>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-h2">最近流水</h2>
            <p className="text-micro text-gray3">最近 30 条 · 操作人可追溯</p>
          </div>
          <ul className="max-h-[650px] divide-y divide-border overflow-auto">
            {movements.map(movement => (
              <li key={movement.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <b className="min-w-0 flex-1 truncate text-body">{movement.product?.name}</b>
                  <span className={`font-num text-button ${movement.delta >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>
                    {movement.delta >= 0 ? '+' : ''}{movement.delta}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 text-micro text-gray3">
                  <span>{MOVEMENT_LABEL[movement.type] || movement.type}</span>
                  <span>余 {movement.balanceAfter}</span>
                  <span>{movement.operator || '系统'}</span>
                  <span>{new Date(movement.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                {movement.reason && <p className="mt-1 text-micro text-gray2">{movement.reason}</p>}
              </li>
            ))}
            {!loading && movements.length === 0 && <li className="py-12 text-center text-caption text-gray3">暂无库存流水</li>}
          </ul>
        </div>
      </section>

      {inboundOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setInboundOpen(false)}>
          <div className="w-full max-w-lg rounded-card bg-white p-5 shadow-xl" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-h2">手工入库</h2>
              <button onClick={() => setInboundOpen(false)} className="px-2 text-h2 text-gray3">×</button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-micro text-gray3">商品</span>
                <select value={productId} onChange={event => setProductId(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3">
                  <option value="">请选择</option>
                  {items.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-micro text-gray3">入库数量（库存单位）</span>
                <input type="number" min="0.01" step="0.01" value={qty} onChange={event => setQty(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" />
              </label>
              <label className="block">
                <span className="mb-1 block text-micro text-gray3">入库说明</span>
                <input value={reason} maxLength={120} onChange={event => setReason(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" />
              </label>
              <button onClick={inbound} disabled={submitting} className="h-11 w-full rounded-cta bg-accent text-button text-white disabled:opacity-40">
                {submitting ? '正在入库…' : '确认入库'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className="mt-1 font-num text-h1">{value}</div></div>
}
