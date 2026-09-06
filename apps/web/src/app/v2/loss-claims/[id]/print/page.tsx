'use client'

import dayjs from 'dayjs'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { supplierLossClaimSettlementHint } from '@/lib/supplier-domain'
import {
  evidenceImagePages,
  evidenceImageSrc,
  inlineEvidenceImages,
  isLossClaimVideo,
  printableEvidenceImages,
} from '@/lib/loss-claim-print'

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

export default function LossClaimPrintPage() {
  const params = useParams<{ id: string }>()
  const [claim, setClaim] = useState<LossClaimDetail | null>(null)
  const [error, setError] = useState('')
  const [completedImages, setCompletedImages] = useState(0)
  const [failedImages, setFailedImages] = useState(0)
  const [saving, setSaving] = useState(false)
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

  const allPrintableImages = (claim?.evidenceImages || []).filter(url => !isLossClaimVideo(url))
  const arrivalDifference = Boolean(claim && !claim.isManual)
  const printableImages = arrivalDifference
    ? printableEvidenceImages(allPrintableImages)
    : allPrintableImages
  const imagePages = arrivalDifference ? evidenceImagePages(allPrintableImages) : []
  const inlineArrivalImages = arrivalDifference ? inlineEvidenceImages(allPrintableImages) : []
  const hiddenImageCount = Math.max(
    0,
    allPrintableImages.length - printableImages.length,
  )
  const imageLoading = completedImages < printableImages.length
  const imageLoadFailed = failedImages > 0

  useEffect(() => {
    setCompletedImages(0)
    setFailedImages(0)
  }, [claim?.id])

  async function savePdf() {
    if (!claim || imageLoading || imageLoadFailed || saving) return
    setSaving(true)
    try {
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import('html2canvas'), import('jspdf'),
      ])
      const element = document.getElementById('loss-claim-print-area')
      if (!element) throw new Error('未找到报损单内容')
      if (!arrivalDifference) {
        const manualPage = element.querySelector<HTMLElement>('.manual-loss-report')
        if (!manualPage) throw new Error('未找到报损单内容')
        const canvas = await html2canvas(manualPage, { scale: 3, backgroundColor: '#fff', useCORS: true })
        const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
        const margin = 8
        const width = 210 - margin * 2
        const height = canvas.height * width / canvas.width
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, margin, width, height)
        const storeName = (claim.store.name || '门店').replace(/[\\/:*?"<>|]/g, '_')
        const date = dayjs(claim.createdAt).format('YYYYMMDD')
        pdf.save(`${storeName}-${date}-报损单.pdf`)
        return
      }
      const brokenImage = Array.from(element.querySelectorAll<HTMLImageElement>('img'))
        .some(image => !image.complete || image.naturalWidth === 0)
      if (brokenImage) throw new Error('图片尚未完整加载，请刷新后重试')
      const pages = Array.from(element.querySelectorAll<HTMLElement>('.pdf-page'))
      if (pages.length === 0) throw new Error('未找到可保存的报损单页面')
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      for (let index = 0; index < pages.length; index += 1) {
        const canvas = await html2canvas(pages[index], { scale: 3, backgroundColor: '#fff', useCORS: true })
        if (index > 0) pdf.addPage('a4', 'portrait')
        const scale = Math.min(210 / canvas.width, 297 / canvas.height)
        const width = canvas.width * scale
        const height = canvas.height * scale
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', (210 - width) / 2, 0, width, height)
      }
      const storeName = (claim.store.name || '门店').replace(/[\\/:*?"<>|]/g, '_')
      const date = dayjs(claim.createdAt).format('YYYYMMDD')
      pdf.save(`${storeName}-${date}-报损单.pdf`)
    } catch (reason: any) {
      alert(`保存 PDF 失败：${reason?.message || reason}`)
    } finally {
      setSaving(false)
    }
  }

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
          disabled={imageLoading || (arrivalDifference && imageLoadFailed)}
          className="px-4 py-2 rounded-cta bg-ink text-white text-button disabled:opacity-50"
        >
          {imageLoading ? `图片加载中 ${completedImages}/${printableImages.length}` : '打印'}
        </button>
        <button
          type="button"
          onClick={savePdf}
          disabled={imageLoading || (arrivalDifference && imageLoadFailed) || saving}
          className="px-4 py-2 rounded-cta bg-white border border-border text-button disabled:opacity-50"
        >
          {saving ? '生成中…' : '保存 PDF'}
        </button>
        <span className="text-micro text-gray2">
          {arrivalDifference && imageLoadFailed
            ? '图片加载失败，请刷新后重试'
            : arrivalDifference
              ? `图片最多显示 4 张${hiddenImageCount > 0 ? `，已省略 ${hiddenImageCount} 张` : ''}`
              : '打印和保存 PDF 已分开'}
        </span>
      </div>

      <div id="loss-claim-print-area" className="space-y-5">
        <article className={`paper pdf-page report-page mx-auto bg-white shadow-sm ${arrivalDifference ? 'arrival-difference-report' : 'manual-loss-report'}`}>
          <header className="doc-header">
            {claim.isManual && <p className="brand">{claim.tenant.name}</p>}
            <h1>{claim.store.name}{claim.isManual ? ' · 内部报损单' : '到货差异单'}</h1>
            {claim.isManual && <p className="subtitle">{KIND_LABEL[claim.kind] || '店内自有损耗'}</p>}
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
            {claim.isManual && (
              <tfoot>
                <tr>
                  <td colSpan={7} className="total-label">合计</td>
                  <td className="number total-amount">¥{money(claim.totalLossAmount)}</td>
                </tr>
              </tfoot>
            )}
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

          {inlineArrivalImages.length > 0 && (
            <section className={`arrival-evidence evidence-count-${inlineArrivalImages.length}`}>
              {inlineArrivalImages.map((url, index) => (
                <figure key={`${url}-${index}`} className="evidence-card">
                  <figcaption>图片凭证 {index + 1} / {printableImages.length}</figcaption>
                  <div className="evidence-frame">
                    <img
                      src={evidenceImageSrc(url)}
                      alt={`报损图片凭证 ${index + 1}`}
                      onLoad={() => setCompletedImages(value => Math.min(printableImages.length, value + 1))}
                      onError={() => {
                        setCompletedImages(value => Math.min(printableImages.length, value + 1))
                        setFailedImages(value => value + 1)
                      }}
                    />
                  </div>
                </figure>
              ))}
            </section>
          )}

          {claim.isManual && (
            <section className="evidence-section">
              <h2>图片凭证（{printableImages.length} 张）</h2>
              {printableImages.length === 0 && <p className="empty">本单未上传图片凭证</p>}
              {printableImages.map((url, index) => (
                <figure key={`${url}-${index}`} className="manual-evidence-card">
                  <figcaption>图片凭证 {index + 1} / {printableImages.length}</figcaption>
                  <img
                    src={url}
                    alt={`报损图片凭证 ${index + 1}`}
                    onLoad={() => setCompletedImages(value => Math.min(printableImages.length, value + 1))}
                    onError={() => setCompletedImages(value => Math.min(printableImages.length, value + 1))}
                  />
                </figure>
              ))}
            </section>
          )}

          {(claim.evidenceImages || []).filter(isLossClaimVideo).map((url, index) => (
            <div key={url} className="video-note">视频凭证 {index + 1}：视频不进入纸质打印，请登录系统查看原文件。</div>
          ))}
          {arrivalDifference && printableImages.length === 0 && <p className="empty">本单未上传图片凭证</p>}

          <footer>
            <span>系统单据：{claim.no}</span>
            <span>打印时间：{dayjs(printedAt).format('YYYY-MM-DD HH:mm:ss')}</span>
          </footer>
        </article>

        {imagePages.map((pageImages, pageIndex) => {
          const imageOffset = inlineArrivalImages.length
            + imagePages.slice(0, pageIndex).reduce((sum, page) => sum + page.length, 0)
          return (
            <article key={pageIndex} className="paper pdf-page evidence-page mx-auto bg-white shadow-sm">
              <header className="evidence-header">
                <h1>{claim.store.name}到货差异单 · 图片凭证</h1>
                <p>报损单号：{claim.no}</p>
              </header>
              <section className={`evidence-grid evidence-count-${pageImages.length}`}>
                {pageImages.map((url, index) => {
                  const imageNumber = imageOffset + index + 1
                  return (
                    <figure key={`${url}-${imageNumber}`} className="evidence-card">
                      <figcaption>图片凭证 {imageNumber} / {printableImages.length}</figcaption>
                      <div className="evidence-frame">
                        <img
                          src={evidenceImageSrc(url)}
                          alt={`报损图片凭证 ${imageNumber}`}
                          onLoad={() => setCompletedImages(value => Math.min(printableImages.length, value + 1))}
                          onError={() => {
                            setCompletedImages(value => Math.min(printableImages.length, value + 1))
                            setFailedImages(value => value + 1)
                          }}
                        />
                      </div>
                    </figure>
                  )
                })}
              </section>
              <footer>
                <span>系统单据：{claim.no}</span>
                <span>图片页 {pageIndex + 1} / {imagePages.length}</span>
              </footer>
            </article>
          )
        })}
      </div>

      <style jsx>{`
        .paper { box-sizing: border-box; width: 210mm; min-height: 297mm; aspect-ratio: 210 / 297; padding: 9mm 13mm 12mm; font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif; }
        .doc-header { text-align: center; border-bottom: 2px solid #111; padding-bottom: 2.5mm; }
        .brand { font-size: 12px; color: #555; letter-spacing: .12em; }
        h1 { font-size: 24px; font-weight: 700; margin: 0; }
        .subtitle { margin-top: 1mm; font-size: 12px; color: #555; }
        .meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.5mm 5mm; margin: 3.5mm 0; font-size: 11px; }
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
        .manual-evidence-card { margin: 0 0 6mm; border: 1px solid #aaa; padding: 3mm; text-align: center; break-inside: avoid; page-break-inside: avoid; }
        .manual-evidence-card figcaption { font-size: 10px; color: #555; text-align: left; margin-bottom: 2mm; }
        .manual-evidence-card img { display: block; max-width: 100%; max-height: 225mm; width: auto; height: auto; margin: 0 auto; object-fit: contain; }
        .empty, .video-note { border: 1px dashed #999; padding: 4mm; color: #555; font-size: 11px; margin-bottom: 3mm; }
        .evidence-page { display: flex; flex-direction: column; }
        .evidence-header { border-bottom: 2px solid #111; padding-bottom: 3mm; text-align: center; }
        .evidence-header h1 { font-size: 20px; }
        .evidence-header p { margin-top: 1mm; color: #555; font-size: 11px; }
        .arrival-evidence, .evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4mm; margin-top: 4mm; align-content: start; }
        .evidence-grid { margin-top: 7mm; }
        .evidence-card { margin: 0; border: 1px solid #aaa; padding: 3mm; text-align: center; break-inside: avoid; page-break-inside: avoid; }
        .evidence-card figcaption { font-size: 10px; color: #555; text-align: left; margin-bottom: 2mm; }
        .evidence-frame { display: flex; width: 100%; aspect-ratio: 3 / 4; align-items: center; justify-content: center; overflow: hidden; background: #fafafa; }
        .evidence-card img { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; }
        .arrival-evidence.evidence-count-1 .evidence-card { width: 100%; justify-self: start; }
        .evidence-grid.evidence-count-1 .evidence-card { width: 100%; justify-self: start; }
        .arrival-evidence.evidence-count-2 .evidence-card,
        .evidence-grid.evidence-count-2 .evidence-card { width: 100%; }
        .arrival-evidence.evidence-count-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3mm; }
        .arrival-evidence.evidence-count-3 .evidence-card { width: 100%; justify-self: center; padding: 2mm; }
        footer { display: flex; justify-content: space-between; border-top: 1px solid #999; margin-top: auto; padding-top: 2mm; font-size: 9px; color: #666; }
        .manual-loss-report { min-height: 297mm; aspect-ratio: auto; padding: 14mm 13mm 12mm; }
        .manual-loss-report .doc-header { padding-bottom: 4mm; }
        .manual-loss-report h1 { margin: 2mm 0 1mm; }
        .manual-loss-report .subtitle { margin-top: 0; }
        .manual-loss-report .meta-grid { margin: 5mm 0; }
        .manual-loss-report footer { margin-top: 6mm; }
        @media screen and (max-width: 850px) {
          .paper { width: 100%; min-height: auto; padding: 20px 14px; }
          .meta-grid { grid-template-columns: 1fr 1fr; }
          .table-section { overflow-x: auto; }
          table { min-width: 760px; }
          .signatures { grid-template-columns: 1fr; gap: 2mm; }
          .arrival-difference-report .table-section { overflow: visible; }
          .arrival-difference-report table { min-width: 0; font-size: 8px; }
          .arrival-difference-report th,
          .arrival-difference-report td { padding: 1.5mm .7mm; }
          .arrival-difference-report .signatures { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2mm; font-size: 9px; }
          .manual-loss-report { min-height: 0; padding: 20px 14px; }
        }
        @page { size: A4 portrait; margin: 0; }
        @media print {
          :global(html), :global(body) { background: #fff !important; margin: 0 !important; }
          .print-shell { padding: 0 !important; background: #fff !important; }
          .print-actions { display: none !important; }
          .paper { width: 210mm; min-height: 297mm; padding: 9mm 12mm 10mm; box-shadow: none !important; }
          .manual-loss-report { padding: 12mm 12mm 10mm; }
          .pdf-page { break-after: page; page-break-after: always; }
          .pdf-page:last-child { break-after: auto; page-break-after: auto; }
          .table-section { overflow: visible !important; }
          table { min-width: 0 !important; }
          thead { display: table-header-group; }
          tr, .notes, .signatures, .evidence-card { break-inside: avoid; page-break-inside: avoid; }
          .manual-loss-report .manual-evidence-card { break-before: auto; }
        }
      `}</style>
    </main>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <p><span style={{ color: '#666' }}>{label}：</span><b>{value}</b></p>
}
