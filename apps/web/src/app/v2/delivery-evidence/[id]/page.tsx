'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { EmptyState, FriendlyError, SkeletonList } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'

type Evidence = {
  scope: 'SUPPLIER' | 'PRODUCT'
  type: 'BUSINESS_LICENSE' | 'QUARANTINE_CERTIFICATE' | 'INSPECTION_REPORT' | 'SLAUGHTER_CERTIFICATE' | 'PRODUCTION_INSPECTION_REPORT' | 'THIRD_PARTY_TEST_REPORT' | 'PESTICIDE_RESIDUE_REPORT' | 'OTHER_PRODUCT_EVIDENCE'
  version: number
  title: string
  expired: boolean
  archived: boolean
  validFrom?: string | null
  validUntil?: string | null
  fileName: string
  fileUrl?: string | null
  supplierName: string
  actualProducts: Array<{ id: string; code: string; name: string; spec?: string | null }>
  originalAssociations: Array<{ product: { id: string; name: string }; linkedAt: string }>
  backfillAssociations: Array<{ product: { id: string; name: string }; linkedAt: string; reason: string }>
  supplierBusinessDates?: string[]
}
type Response = {
  delivery: { id: string; no: string; status: string }
  items: Evidence[]
  message?: string | null
  tracePolicy: string
  responsibilities: { purchaseOrderCreators: string[]; warehouseInspectors: string[]; sorter: string; deliveryPerson: string; shippingOperator: string; deliveredOperator: string }
}

const TYPE_LABEL: Record<Evidence['type'], string> = {
  BUSINESS_LICENSE: '营业执照',
  QUARANTINE_CERTIFICATE: '检疫证明',
  INSPECTION_REPORT: '检验检测报告',
  SLAUGHTER_CERTIFICATE: '屠宰证',
  PRODUCTION_INSPECTION_REPORT: '生产检验报告',
  THIRD_PARTY_TEST_REPORT: '第三方检测报告',
  PESTICIDE_RESIDUE_REPORT: '蔬菜农残报告',
  OTHER_PRODUCT_EVIDENCE: '其他产品随货资料',
}

function dateLabel(value?: string | null) {
  return value ? value.slice(0, 10) : '—'
}

export default function DeliveryEvidencePage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const deliveryId = String(params.id || '')
  const [data, setData] = useState<Response | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setData(await apiFetch<Response>(`/api/deliveries/${encodeURIComponent(deliveryId)}/evidence-documents`))
    } catch (reason: any) {
      setError(reason?.message || '加载来货证明失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (deliveryId) void load() }, [deliveryId])
  if (loading && !data) return <div className="min-h-screen bg-bg p-5"><SkeletonList count={4} /></div>

  return (
    <div className="min-h-screen bg-bg px-4 py-5">
      <header className="mx-auto max-w-3xl border-b border-border pb-4">
        <button onClick={() => router.back()} className="text-button text-accent">← 返回</button>
        <div className="mt-3 flex items-center gap-2"><Chip tone="green">批次追溯</Chip><span className="text-caption text-gray3">{data?.delivery.no}</span></div>
        <h1 className="mt-2 text-h1">本次配送的来货证明</h1>
        <p className="mt-1 text-caption text-gray2">只展示由本配送单实际出库批次追溯到的上游到货证明，不按供应商名称猜测。</p>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 py-5">
        {error && <FriendlyError message={error} onRetry={load} />}
        {data && <section className="rounded-card border border-border bg-white p-4"><h2 className="text-h2">责任记录</h2><div className="mt-3 grid gap-2 text-caption text-gray2 sm:grid-cols-2"><div>采购下单人：{data.responsibilities.purchaseOrderCreators.join('、')}</div><div>到仓验收人：{data.responsibilities.warehouseInspectors.join('、')}</div><div>分拣人：{data.responsibilities.sorter}</div><div>配送/司机：{data.responsibilities.deliveryPerson}</div><div>发货状态操作人：{data.responsibilities.shippingOperator}</div><div>送达状态操作人：{data.responsibilities.deliveredOperator}</div></div><p className="mt-2 text-micro text-gray3">发货/送达操作人只证明单据事件操作，不冒充实际分拣工或司机；缺失时显示“未记录”。</p></section>}
        {data && data.items.length === 0 && <EmptyState icon="🔎" title={data.message || '暂无可追溯证明'} hint="当前批次可能是历史无批次数据，或上游到货行尚未关联证明；系统不会回退到供应商泛查。" />}
        {data?.items.map((document, index) => (
          <article key={`${document.title}-${document.version}-${index}`} className="rounded-card border border-border bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><b>{document.title}</b><div className="mt-1 text-micro text-gray3">{TYPE_LABEL[document.type]} · 版本 {document.version}</div></div><div className="flex gap-2"><Chip tone={document.scope === 'SUPPLIER' ? 'blue' : 'green'}>{document.scope === 'SUPPLIER' ? '供应商级证照' : '产品随货资料'}</Chip>{document.expired && <Chip tone="red">当前已过期</Chip>}{document.archived && <Chip tone="gray">当前已归档</Chip>}{document.backfillAssociations.length > 0 && <Chip tone="amber">包含事后补录</Chip>}</div></div>
            <div className="mt-3 grid gap-2 text-caption text-gray2 sm:grid-cols-2"><div>上游供应商：{document.supplierName}</div><div>有效期：{dateLabel(document.validFrom)} 至 {dateLabel(document.validUntil)}</div>{document.actualProducts.length ? <div className="sm:col-span-2">本次配送实际追溯商品：{document.actualProducts.map(product => product.name).join('、')}</div> : null}</div>
            {document.originalAssociations.length > 0 && <div className="mt-3 rounded-lg bg-green-bg p-2 text-micro text-green-fg">原始随货关联：{document.originalAssociations.map(item => item.product.name).join('、')}</div>}
            {document.backfillAssociations.length > 0 && <div className="mt-2 rounded-lg bg-amber/10 p-2 text-micro text-amber-fg">过账后补录：{document.backfillAssociations.map(item => `${item.product.name}（${item.reason}）`).join('、')}</div>}
            {document.scope === 'SUPPLIER' && document.supplierBusinessDates?.length ? <div className="mt-2 rounded-lg bg-blue-50 p-2 text-micro text-blue-700">在实际追溯到的到货业务日有效：{document.supplierBusinessDates.join('、')}</div> : null}
            {document.fileUrl && <a href={document.fileUrl} target="_blank" rel="noreferrer" className="mt-4 inline-block rounded-cta border border-accent px-3 py-2 text-button text-accent">查看证明：{document.fileName} ↗</a>}
          </article>
        ))}
        {data && <p className="rounded-card bg-white p-3 text-micro text-gray3">{data.tracePolicy}</p>}
      </main>
    </div>
  )
}
