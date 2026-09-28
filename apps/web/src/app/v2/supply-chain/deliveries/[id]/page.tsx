'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { Chip } from '@/components/v2'
import { EmptyState, FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { apiDownload, apiFetch } from '@/lib/v2-auth'
import { formatDeliveryStatusLabel, deliveryStatusTone, orderDateTimeText } from '@/lib/supply-order-delivery-pc'

type ProfitLine = {
  acceptedQuantity: string
  shippedQuantity: string
  unitPrice: string
  shippedAmount: string
  settlementQuantity: string
  settlementAmount: string
  costUnitPrice: string | null
  costAmount: string | null
  profit: string | null
}

type DeliveryDetail = {
  id: string
  no: string
  status: string
  createdAt: string
  shippedAt?: string | null
  pickerNameSnapshot?: string | null
  driverNameSnapshot?: string | null
  purchaseOrder?: { id: string; no: string } | null
  store?: { name: string } | null
  supplier?: { name: string } | null
  profitability?: {
    shippedAmount: string
    settlementAmount: string
    costAmount: string | null
    profit: string | null
    warnings: string[]
  } | null
  items: Array<{
    id: string
    productCodeSnapshot?: string | null
    productNameSnapshot?: string | null
    productSpecSnapshot?: string | null
    productUnitSnapshot?: string | null
    product?: { code?: string | null; name?: string | null; spec?: string | null; unit?: string | null }
    profitability?: ProfitLine | null
  }>
}

const money = (value: unknown) => value == null || value === '' || !Number.isFinite(Number(value))
  ? '—'
  : `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function DeliveryProfitDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [delivery, setDelivery] = useState<DeliveryDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    apiFetch<DeliveryDetail>(`/api/deliveries/${encodeURIComponent(id)}`)
      .then(data => { if (alive) setDelivery(data) })
      .catch(reason => { if (alive) setError(String(reason?.message || reason)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, reload])

  const warnings = useMemo(() => delivery?.profitability?.warnings || [], [delivery])

  async function exportDetail() {
    if (exporting || !delivery) return
    setExporting(true)
    setError(null)
    try {
      const { blob, filename } = await apiDownload(`/api/deliveries/${encodeURIComponent(delivery.id)}/export.xlsx`, `配送成本利润明细-${delivery.no}.xlsx`)
      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(href), 5_000)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setExporting(false)
    }
  }

  if (loading && !delivery) return <div className="min-h-screen bg-bg p-5"><SkeletonCard /></div>

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <main className="mx-auto max-w-[1440px] space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
          <div>
            <a href="/v2/supply-chain/deliveries" className="text-caption text-amber-fg">← 返回配送单查询</a>
            <div className="mt-2 flex items-center gap-2">
              <h1 className="text-h1">配送成本利润明细</h1>
              {delivery && <Chip tone={deliveryStatusTone(delivery.status)}>{formatDeliveryStatusLabel(delivery.status)}</Chip>}
            </div>
            <p className="mt-1 text-caption text-gray2">成本只取发货时冻结的总仓出库台账；缺成本时利润显示“—”，不按0计算。</p>
          </div>
          <button onClick={exportDetail} disabled={exporting || !delivery} className="rounded-cta bg-accent px-4 py-2 text-button text-white disabled:opacity-40">
            {exporting ? '正在导出…' : '导出明细'}
          </button>
        </div>

        {error && <FriendlyError message={error} onRetry={() => setReload(value => value + 1)} />}

        {delivery && (
          <>
            <section className="grid gap-3 rounded-card border border-border bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="配送单号" value={delivery.no} />
              <Fact label="关联订货单" value={delivery.purchaseOrder?.no || '—'} />
              <Fact label="门店" value={delivery.store?.name || '—'} />
              <Fact label="供应商" value={delivery.supplier?.name || '—'} />
              <Fact label="创建时间" value={orderDateTimeText(delivery.createdAt)} />
              <Fact label="发货时间" value={orderDateTimeText(delivery.shippedAt)} />
              <Fact label="实际分拣负责人" value={delivery.pickerNameSnapshot || '未记录'} />
              <Fact label="实际配送/司机" value={delivery.driverNameSnapshot || '未记录'} />
              <Fact label="原发货金额" value={money(delivery.profitability?.shippedAmount)} />
              <Fact label="净结算金额" value={money(delivery.profitability?.settlementAmount)} />
              <Fact label="成本金额" value={money(delivery.profitability?.costAmount)} />
              <Fact label="利润" value={money(delivery.profitability?.profit)} />
            </section>

            {warnings.length > 0 && <section className="rounded-card border border-orange-200 bg-orange-50 p-4 text-caption text-orange-900">{warnings.map(warning => <p key={warning}>• {warning}</p>)}</section>}

            {delivery.items.length === 0 ? <EmptyState icon="📦" title="暂无配送商品" hint="请返回配送单查询核对单据" /> : (
              <>
                <section className="hidden overflow-x-auto rounded-card border border-border bg-white md:block">
                  <table className="min-w-[1280px] w-full text-left text-caption">
                    <thead className="bg-bg text-gray2"><tr>{['序号', '商品', '规格', '单位', '接单数量', '发货数量', '发货单价', '发货金额', '净结算金额', '成本单价', '成本金额', '利润'].map(title => <th key={title} className="whitespace-nowrap px-3 py-3">{title}</th>)}</tr></thead>
                    <tbody>{delivery.items.map((item, index) => <DeliveryRow key={item.id} item={item} index={index} />)}</tbody>
                  </table>
                </section>
                <section className="space-y-3 md:hidden">{delivery.items.map((item, index) => <DeliveryCard key={item.id} item={item} index={index} />)}</section>
              </>
            )}

            <div className="flex flex-wrap gap-3">
              {delivery.purchaseOrder?.id && <a href={`/v2/supply-chain/fulfillment/${delivery.purchaseOrder.id}`} className="rounded-cta border border-border bg-white px-4 py-2 text-button">查看订货与配送流程</a>}
              <a href="/v2/supply-chain/finance-reports?report=profit-detail" className="rounded-cta border border-border bg-white px-4 py-2 text-button">前往集团毛利明细表核对</a>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><div className="text-micro text-gray3">{label}</div><div className="mt-1 break-words font-num text-body">{value}</div></div>
}

function itemIdentity(item: DeliveryDetail['items'][number]) {
  return {
    code: item.productCodeSnapshot || item.product?.code || '—',
    name: item.productNameSnapshot || item.product?.name || '—',
    spec: item.productSpecSnapshot || item.product?.spec || '—',
    unit: item.productUnitSnapshot || item.product?.unit || '—',
  }
}

function DeliveryRow({ item, index }: { item: DeliveryDetail['items'][number]; index: number }) {
  const product = itemIdentity(item); const p = item.profitability
  return <tr className="border-t border-border"><td className="px-3 py-3">{index + 1}</td><td className="px-3 py-3"><b>{product.name}</b><div className="text-micro text-gray3">{product.code}</div></td><td className="px-3 py-3">{product.spec}</td><td className="px-3 py-3">{product.unit}</td><td className="px-3 py-3 font-num">{p?.acceptedQuantity ?? '—'}</td><td className="px-3 py-3 font-num">{p?.shippedQuantity ?? '—'}</td><td className="px-3 py-3 font-num">{money(p?.unitPrice)}</td><td className="px-3 py-3 font-num">{money(p?.shippedAmount)}</td><td className="px-3 py-3 font-num">{money(p?.settlementAmount)}</td><td className="px-3 py-3 font-num">{money(p?.costUnitPrice)}</td><td className="px-3 py-3 font-num">{money(p?.costAmount)}</td><td className="px-3 py-3 font-num">{money(p?.profit)}</td></tr>
}

function DeliveryCard({ item, index }: { item: DeliveryDetail['items'][number]; index: number }) {
  const product = itemIdentity(item); const p = item.profitability
  return <article className="rounded-card border border-border bg-white p-4"><div className="flex items-start justify-between gap-3"><div><b>{index + 1}. {product.name}</b><p className="mt-1 text-micro text-gray3">{product.code} · {product.spec} · {product.unit}</p></div><span className="font-num text-button">利润 {money(p?.profit)}</span></div><div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-caption"><Fact label="接单数量" value={p?.acceptedQuantity ?? '—'} /><Fact label="发货数量" value={p?.shippedQuantity ?? '—'} /><Fact label="发货单价" value={money(p?.unitPrice)} /><Fact label="发货金额" value={money(p?.shippedAmount)} /><Fact label="净结算金额" value={money(p?.settlementAmount)} /><Fact label="成本单价" value={money(p?.costUnitPrice)} /><Fact label="成本金额" value={money(p?.costAmount)} /></div></article>
}
