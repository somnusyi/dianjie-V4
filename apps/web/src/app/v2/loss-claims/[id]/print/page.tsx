'use client'

import dayjs from 'dayjs'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { supplierLossClaimSettlementHint } from '@/lib/supplier-domain'

type LossClaimDetail = {
  id: string
  no: string
  reason?: string | null
  description?: string | null
  isManual: boolean
  kind: 'ARRIVAL_SHORTAGE' | 'ARRIVAL_DAMAGE' | 'INTERNAL_WASTE' | 'LEGACY_UNRESOLVED'
  payableBasis?: 'NET_AT_RECEIPT' | 'GROSS_PENDING_CLAIM' | 'NOT_APPLICABLE' | 'LEGACY_UNKNOWN'
  totalLossAmount: string | number
  evidenceImages: string[]
  status: string
  autoApproved?: boolean
  handlerNote?: string | null
  negotiationNote?: string | null
  resolvedNote?: string | null
  createdAt: string
  handledAt?: string | null
  resolvedAt?: string | null
  tenant: { name: string; logo?: string | null }
  store: { no: string; name: string; address?: string | null; phone?: string | null }
  supplier?: { no: string; name: string; contactName?: string | null; contactPhone?: string | null } | null
  purchaseOrder?: { id: string; no: string; createdAt: string } | null
  deliveryOrder?: { id: string; no: string; shippedAt?: string | null; receivedAt?: string | null } | null
  receipt?: { id: string; no: string; deliveryDate: string; totalAmount: string | number } | null
  createdBy: { name: string; role: string }
  handledBy?: { name: string; role: string } | null
  items: Array<{
    id: string
    orderedQty: string | number
    receivedQty: string | number
    lossQty: string | number
    unitPrice: string | number
    lossAmount: string | number
    product: { code: string; name: string; category: string; unit: string; spec?: string | null }
  }>
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待处理',
  APPROVED: '已同意',
  AUTO_APPROVED: '自动批准',
  REJECTED: '已拒绝',
  NEGOTIATING: '协商中',
  RESOLVED: '已结清',
}

const KIND_LABEL: Record<LossClaimDetail['kind'], string> = {
  ARRIVAL_SHORTAGE: '到货短缺',
  ARRIVAL_DAMAGE: '到货破损 / 品质异常',
  INTERNAL_WASTE: '门店内部报损',
  LEGACY_UNRESOLVED: '历史报损（来源待核）',
}

function money(value: string | number | null | undefined) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function qty(value: string | number | null | undefined) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function isVideo(url: string) {
  return /\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(url)
}

export default function LossClaimPrintPage() {
  const params = useParams<{ id: string }>()
  const [claim, setClaim] = useState<LossClaimDetail | null>(null)
  const [error, setError] = useState('')
  const [completedImages, setCompletedImages] = useState(0)
  const printedAt = useMemo(() => new Date(), [])

  useEffect(() => {
    const id = Array.isArray(params.id) ? params.id[0] : params.id
    if (!id) return
    apiFetch<LossClaimDetail>(`/api/loss-claims/${encodeURIComponent(id)}`)
      .then(data => {
        setClaim(data)
        setError('')
      })
      .catch(err => setError(err?.message || '报损单加载失败'))
  }, [params.id])

  const printableImages = (claim?.evidenceImages || []).filter(url => !isVideo(url))
  const imageLoading = completedImages < printableImages.length

  if (error) {
    return (
      <main className="min-h-screen bg-bg p-4 flex items-center justify-center">
        <div className="bg-white rounded-card border border-border p-6 max-w-md w-full text-center">
          <h1 className="text-h2 mb-2">无法打开报损单</h1>
          <p className="text-caption text-red-fg mb-4">{error}</p>
          <button type="button" onClick={() => history.back()} className="px-4 py-2 rounded-cta bg-ink text-white text-button">返回</button>
        </div>
      </main>
    )
  }

  if (!claim) {
    return <main className="min-h-screen bg-bg p-8 text-center text-caption text-gray3">正在生成报损详情…</main>
  }

  return (
    <main className="print-shell min-h-screen bg-[#e9e7e1] py-5 px-3 text-[#111]">
      <div className="print-actions max-w-[210mm] mx-auto mb-3 flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => history.back()} className="px-4 py-2 rounded-cta bg-white border border-border text-button">返回</button>
        <button
          type="button"
          onClick={() => window.print()}
          disabled={imageLoading}
          className="px-4 py-2 rounded-cta bg-ink text-white text-button disabled:opacity-50"
        >
          {imageLoading ? `图片加载中 ${completedImages}/${printableImages.length}` : '打印 / 保存 PDF'}
        </button>
        <span className="text-micro text-gray2">建议使用 A4 纵向；手机端可在系统打印中选择“保存为 PDF”</span>
      </div>

      <article className="paper mx-auto bg-white shadow-sm">
        <header className="doc-header">
          <p className="brand">{claim.tenant.name}</p>
          <h1>{claim.store.name} · {claim.isManual ? '内部报损单' : '到货差异单'}</h1>
          <p className="subtitle">{KIND_LABEL[claim.kind] || (claim.isManual ? '店内自有损耗' : '供应商到货差异')}</p>
        </header>

        <section className="meta-grid">
          <Info label="报损单号" value={claim.no} />
          <Info label="单据状态" value={STATUS_LABEL[claim.status] || claim.status} />
          <Info label="制单日期" value={dayjs(claim.createdAt).format('YYYY-MM-DD HH:mm:ss')} />
          <Info label="门店编码" value={claim.store.no} />
          <Info label="关联订货单" value={claim.purchaseOrder?.no || '—'} />
          <Info label="关联配送单" value={claim.deliveryOrder?.no || '—'} />
          <Info label="关联收货单" value={claim.receipt?.no || '—'} />
          <Info label="应付处理口径" value={supplierLossClaimSettlementHint(claim.payableBasis)} />
          <Info label="责任供应商" value={claim.supplier ? `${claim.supplier.name}（${claim.supplier.no}）` : '店内自负'} />
          <Info label="制单人" value={claim.createdBy.name || '—'} />
          <Info label="审核/处理人" value={claim.handledBy?.name || (claim.autoApproved ? '系统自动' : '—')} />
          <Info label="处理时间" value={claim.handledAt ? dayjs(claim.handledAt).format('YYYY-MM-DD HH:mm:ss') : '—'} />
        </section>

        <section className="table-section">
          <table>
            <thead>
              <tr>
                <th className="seq">序号</th>
                <th>商品编码</th>
                <th>商品名称 / 规格</th>
                <th>分类</th>
                {!claim.isManual && <th>应到</th>}
                {!claim.isManual && <th>实收</th>}
                <th>{claim.isManual ? '报损数量' : '差异数量'}</th>
                <th>单位</th>
                <th>单价</th>
                <th>金额</th>
              </tr>
            </thead>
            <tbody>
              {claim.items.map((item, index) => (
                <tr key={item.id}>
                  <td className="center">{index + 1}</td>
                  <td>{item.product.code}</td>
                  <td><b>{item.product.name}</b>{item.product.spec ? <small>{item.product.spec}</small> : null}</td>
                  <td>{item.product.category || '—'}</td>
                  {!claim.isManual && <td className="number">{qty(item.orderedQty)}</td>}
                  {!claim.isManual && <td className="number">{qty(item.receivedQty)}</td>}
                  <td className="number"><b>{qty(item.lossQty)}</b></td>
                  <td className="center">{item.product.unit}</td>
                  <td className="number">¥{money(item.unitPrice)}</td>
                  <td className="number"><b>¥{money(item.lossAmount)}</b></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={claim.isManual ? 7 : 9} className="total-label">合计</td>
                <td className="number total-amount">¥{money(claim.totalLossAmount)}</td>
              </tr>
            </tfoot>
          </table>
        </section>

        <section className="notes">
          <p><b>报损原因：</b>{claim.reason || '未单独填写'}</p>
          <p><b>情况说明：</b>{claim.description || '—'}</p>
          {claim.handlerNote && <p><b>处理意见：</b>{claim.handlerNote}</p>}
          {claim.negotiationNote && <p><b>协商记录：</b>{claim.negotiationNote}</p>}
          {claim.resolvedNote && <p><b>结案说明：</b>{claim.resolvedNote}</p>}
        </section>

        <section className="signatures">
          <span>制单人：{claim.createdBy.name || '—'}</span>
          <span>审核/处理人：{claim.handledBy?.name || (claim.autoApproved ? '系统自动' : '____________')}</span>
          <span>门店确认：____________</span>
        </section>

        <section className="evidence-section">
          <h2>图片凭证（{printableImages.length} 张）</h2>
          {printableImages.length === 0 && <p className="empty">本单未上传图片凭证</p>}
          {printableImages.map((url, index) => (
            <figure key={`${url}-${index}`} className="evidence-card">
              <figcaption>图片凭证 {index + 1} / {printableImages.length}</figcaption>
              <img
                src={url}
                alt={`报损图片凭证 ${index + 1}`}
                onLoad={() => setCompletedImages(value => Math.min(printableImages.length, value + 1))}
                onError={() => setCompletedImages(value => Math.min(printableImages.length, value + 1))}
              />
            </figure>
          ))}
          {(claim.evidenceImages || []).filter(isVideo).map((url, index) => (
            <div key={url} className="video-note">视频凭证 {index + 1}：视频不进入纸质打印，请登录系统查看原文件。</div>
          ))}
        </section>

        <footer>
          <span>系统单据：{claim.no}</span>
          <span>打印时间：{dayjs(printedAt).format('YYYY-MM-DD HH:mm:ss')}</span>
        </footer>
      </article>

      <style jsx>{`
        .paper { width: 210mm; min-height: 297mm; padding: 14mm 13mm 12mm; font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; }
        .doc-header { text-align: center; border-bottom: 2px solid #111; padding-bottom: 4mm; }
        .brand { font-size: 12px; color: #555; letter-spacing: .12em; }
        h1 { font-size: 24px; font-weight: 700; margin: 2mm 0 1mm; }
        .subtitle { font-size: 12px; color: #555; }
        .meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.5mm 5mm; margin: 5mm 0; font-size: 11px; }
        .table-section { margin-top: 4mm; }
        table { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; }
        th, td { border: 1px solid #333; padding: 2mm 1.3mm; vertical-align: middle; word-break: break-word; }
        th { background: #f1f1f1; font-weight: 700; text-align: center; }
        th.seq { width: 9mm; }
        td small { display: block; color: #555; margin-top: 1mm; font-size: 9px; }
        .center { text-align: center; }
        .number { text-align: right; font-variant-numeric: tabular-nums; }
        .total-label { text-align: right; font-weight: 700; }
        .total-amount { font-size: 12px; }
        .notes { margin-top: 5mm; border: 1px solid #777; padding: 3mm; font-size: 11px; line-height: 1.7; break-inside: avoid; }
        .signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; margin: 7mm 0 5mm; font-size: 11px; break-inside: avoid; }
        .evidence-section { margin-top: 5mm; }
        .evidence-section h2 { font-size: 15px; border-bottom: 1px solid #333; padding-bottom: 2mm; margin-bottom: 4mm; }
        .empty, .video-note { border: 1px dashed #999; padding: 4mm; color: #555; font-size: 11px; margin-bottom: 3mm; }
        .evidence-card { margin: 0 0 6mm; border: 1px solid #aaa; padding: 3mm; text-align: center; break-inside: avoid; page-break-inside: avoid; }
        .evidence-card figcaption { font-size: 10px; color: #555; text-align: left; margin-bottom: 2mm; }
        .evidence-card img { display: block; max-width: 100%; max-height: 225mm; width: auto; height: auto; margin: 0 auto; object-fit: contain; }
        footer { display: flex; justify-content: space-between; border-top: 1px solid #999; margin-top: 6mm; padding-top: 2mm; font-size: 9px; color: #666; }
        @media screen and (max-width: 850px) {
          .paper { width: 100%; min-height: 0; padding: 20px 14px; }
          .meta-grid { grid-template-columns: 1fr 1fr; }
          .table-section { overflow-x: auto; }
          table { min-width: 760px; }
          .signatures { grid-template-columns: 1fr; gap: 2mm; }
        }
        @page { size: A4 portrait; margin: 0; }
        @media print {
          :global(html), :global(body) { background: #fff !important; margin: 0 !important; }
          .print-shell { padding: 0 !important; background: #fff !important; }
          .print-actions { display: none !important; }
          .paper { width: 210mm; min-height: 297mm; padding: 12mm 12mm 10mm; box-shadow: none !important; }
          .table-section { overflow: visible !important; }
          table { min-width: 0 !important; }
          thead { display: table-header-group; }
          tr, .notes, .signatures, .evidence-card { break-inside: avoid; page-break-inside: avoid; }
          .evidence-card { break-before: auto; }
        }
      `}</style>
    </main>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <p><span style={{ color: '#666' }}>{label}：</span><b>{value}</b></p>
}
