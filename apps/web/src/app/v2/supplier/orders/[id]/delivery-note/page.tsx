/**
 * 供应商 · 送货单 (打印 / 导出 PDF)
 *
 * A4 纵向, 自动适配打印, 浏览器自带"另存为 PDF"即可导出.
 * 路由: /v2/supplier/orders/[id]/delivery-note
 *
 * 内容: 抬头(供应商) + 收货方(门店地址) + 订单元数据 + 商品明细表 + 合计大写 + 签字栏
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Order = {
  id: string; no: string; status: string
  totalAmount: string
  expectedDate: string; createdAt: string
  shippedAt: string | null
  shippedNote: string | null
  note: string | null
  store: { id: string; name: string; no: string; address?: string | null
           managerName?: string | null; phone?: string | null }
  supplier: { id: string; name: string; contactName?: string | null; contactPhone?: string | null }
  createdBy: { id: string; name: string }
  shippedBy: { id: string; name: string } | null
  items: { id: string; quantity: string; shippedQty: string | null; unitPrice: string; amount: string
           product?: { name: string; spec: string | null; unit: string; code: string } }[]
}

// 阿拉伯数字 → 中文大写金额 (财务规范)
function num2cn(n: number): string {
  if (!Number.isFinite(n)) return '零元整'
  if (n === 0) return '零元整'
  const fraction = ['角', '分']
  const digit = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const unit = [['元', '万', '亿'], ['', '拾', '佰', '仟']]
  const head = n < 0 ? '负' : ''
  n = Math.abs(n)
  let s = ''
  for (let i = 0; i < fraction.length; i++) {
    s += (digit[Math.floor(n * 10 * Math.pow(10, i)) % 10] + fraction[i]).replace(/零./, '')
  }
  s = s || '整'
  let intPart = Math.floor(n).toString()
  for (let i = 0; i < unit[0].length && intPart.length > 0; i++) {
    let p = ''
    for (let j = 0; j < unit[1].length && intPart.length > 0; j++) {
      p = digit[+intPart.slice(-1)] + unit[1][j] + p
      intPart = intPart.slice(0, -1)
    }
    s = p.replace(/(零.)*零$/, '').replace(/^$/, '零') + unit[0][i] + s
  }
  return head + s.replace(/(零.)*零元/, '元').replace(/(零.)+/g, '零').replace(/^整$/, '零元整')
}

export default function DeliveryNotePrintPage() {
  const params = useParams() as any
  const router = useRouter()
  const id = params.id as string
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [printedAt] = useState(() => new Date())

  const [exporting, setExporting] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)  // data URI 用于 iframe 预览 (本地)
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null)  // blob 用于 Share API / 下载
  const [ossUrl, setOssUrl] = useState<string | null>(null)  // 真 https URL (上传到 OSS 后拿到, ArkWeb / 微信都可用)
  const [uploading, setUploading] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    apiFetch<Order>(`/api/orders/${id}`).then(setOrder).catch(e => setError(e.message || '加载失败'))
    return () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl) }
  }, [id])

  // 真 PDF 下载 — 用 html2canvas + jspdf, 跨平台 (含 WebView / iOS Capacitor / 鸿蒙 ArkWeb)
  async function exportPDF() {
    if (!order || exporting) return
    setExporting(true)
    try {
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import('html2canvas'), import('jspdf')
      ])
      const el = document.getElementById('print-area')
      if (!el) throw new Error('未找到打印区域')
      // scale=1.5 + JPEG 0.7 — 比原来 PNG×2 小 8-10 倍, 仍然清晰可读
      const canvas = await html2canvas(el, { scale: 1.5, backgroundColor: '#fff', useCORS: true })
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      const pageW = 210, pageH = 297, margin = 8
      const imgW = pageW - margin * 2
      const imgH = canvas.height * imgW / canvas.width
      const pageHContent = pageH - margin * 2

      if (imgH <= pageHContent) {
        // 单页 — 直接整张塞 (最常见)
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.7), 'JPEG', margin, margin, imgW, imgH)
      } else {
        // 多页分割 — 每页一片, JPEG 压缩
        let y = 0
        while (y < imgH) {
          if (y > 0) pdf.addPage()
          const srcY = y / imgH * canvas.height
          const remainImgH = Math.min(pageHContent, imgH - y)
          const srcH = remainImgH / imgH * canvas.height
          const pageCanvas = document.createElement('canvas')
          pageCanvas.width = canvas.width
          pageCanvas.height = Math.ceil(srcH)
          const ctx = pageCanvas.getContext('2d')!
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
          ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH)
          pdf.addImage(pageCanvas.toDataURL('image/jpeg', 0.7), 'JPEG', margin, margin, imgW, remainImgH)
          y += pageHContent
        }
      }
      // 生成 blob → 同时存 blob 和 data URL
      const blob = pdf.output('blob') as Blob
      const dataUrl = pdf.output('datauristring') as string
      setPdfBlob(blob)
      setPdfUrl(dataUrl)
      setOssUrl(null); setCopied(false)
      // 同时上传到 OSS 获取真 https URL — ArkWeb / 微信内置浏览器都能用
      void uploadToOss(blob)
    } catch (e: any) {
      alert('导出失败: ' + (e.message || e))
    } finally {
      setExporting(false)
    }
  }
  async function uploadToOss(blob: Blob) {
    if (!order) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', blob, `delivery-note-${order.no}.pdf`)
      const res = await apiFetch<{url: string}>('/api/upload?category=documents', { method: 'POST', body: fd as any })
      setOssUrl(res.url)
    } catch (e: any) {
      // 上传失败不阻塞预览, 用户仍可用 iframe 看
      console.warn('OSS upload failed', e)
    } finally {
      setUploading(false)
    }
  }
  async function copyOssUrl() {
    if (!ossUrl) return
    try {
      await navigator.clipboard.writeText(ossUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 老 WebView 不支持 clipboard API, fallback 用 textarea
      const ta = document.createElement('textarea')
      ta.value = ossUrl
      document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000) }
      finally { document.body.removeChild(ta) }
    }
  }
  // Web Share API — 微信 / iOS Safari / 安卓 Chrome 都支持. 调起系统分享菜单 (存到文件 / 转发微信...)
  async function shareOrDownload() {
    if (!pdfBlob || !order) return
    const file = new File([pdfBlob], `送货单-${order.no}.pdf`, { type: 'application/pdf' })
    // navigator.canShare 检查是否支持文件分享
    const nav = navigator as any
    if (nav.canShare && nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: `送货单 ${order.no}`, text: `送货单 ${order.no}` })
        return
      } catch (e) { /* 用户取消, 走 fallback */ }
    }
    // Fallback 1: a[download] (PC 浏览器 / 安卓 Chrome 行得通)
    const link = document.createElement('a')
    const url = URL.createObjectURL(pdfBlob)
    link.href = url
    link.download = `送货单-${order.no}.pdf`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
  // 同窗口打开 PDF (走 location.href, 比 window.open 更兼容 WebView)
  function openSameTab() {
    if (pdfUrl) window.location.href = pdfUrl
  }
  // 系统浏览器打印 (PC) — 在 WebView 里多半无效, 已不推荐
  function tryPrint() {
    if (typeof window.print === 'function') window.print()
    else alert('当前环境不支持系统打印, 请用「下载 PDF」按钮')
  }

  if (error) return <div className="p-8 text-center text-red-fg">{error}</div>
  if (!order) return <div className="p-8 text-center text-gray2">加载中…</div>

  // 送货单按实际发货量 (shippedQty) 显示, 没填则按 quantity. 合同金额已在 ship 时重算.
  const itemQty = (i: Order['items'][number]) => i.shippedQty != null ? Number(i.shippedQty) : Number(i.quantity)
  const itemAmt = (i: Order['items'][number]) => itemQty(i) * Number(i.unitPrice)
  const total = order.items.reduce((s, i) => s + itemAmt(i), 0)
  const itemsCount = order.items.length
  const totalQty = order.items.reduce((s, i) => s + itemQty(i), 0)
  const hasAdjust = order.items.some(i => i.shippedQty != null && Math.abs(Number(i.shippedQty) - Number(i.quantity)) > 0.0001)

  return (
    <>
      {/* 打印样式 — 纸张 + 隐藏顶栏 */}
      <style jsx global>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          body { background: white !important; }
          .no-print { display: none !important; }
          .print-page { box-shadow: none !important; margin: 0 !important; }
        }
      `}</style>

      {/* 操作栏 — 屏幕显示, 打印隐藏 */}
      <div className="no-print sticky top-0 bg-bg-warm border-b border-border px-4 py-3 flex items-center gap-2 z-10">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <span className="flex-1 text-h2 truncate">送货单 · {order.no}</span>
        <button onClick={exportPDF} disabled={exporting}
                className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {exporting ? '生成中…' : '生成 PDF'}
        </button>
        <button onClick={tryPrint}
                className="px-3 py-2 border border-border rounded-cta text-caption text-gray2"
                title="PC 浏览器可用 · 手机请用生成 PDF">🖨</button>
      </div>

      {/* PDF 生成完毕弹层 — iframe 预览 + 下载链接 + 新窗口打开 */}
      {pdfUrl && order && (
        <div className="no-print fixed inset-0 z-50 bg-ink/70 flex items-center justify-center p-4"
             onClick={() => setPdfUrl(null)}>
          <div className="bg-white rounded-card max-w-3xl w-full max-h-[90vh] flex flex-col"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-border">
              <span className="text-h2">送货单 PDF · {order.no}</span>
              <button onClick={() => setPdfUrl(null)} className="text-gray3 px-2 text-h2">×</button>
            </div>
            <iframe src={pdfUrl} className="flex-1 w-full" title="PDF 预览" />
            <div className="p-3 border-t border-border space-y-2">
              {/* OSS 真链接 — App 内 / 微信 / 任何环境都可用 */}
              {uploading && (
                <div className="text-caption text-gray3">⏳ 正在上传到云端... 上传完才能在 app 里打开</div>
              )}
              {ossUrl && (
                <div className="bg-bg rounded-cta p-2">
                  <div className="text-micro text-gray3 mb-1">PDF 公网链接 (任何浏览器 / 微信 / app 都可打开)</div>
                  <div className="flex items-center gap-2">
                    <input readOnly value={ossUrl}
                           className="flex-1 bg-white border border-border rounded px-2 py-1 text-micro text-gray2 font-mono truncate" />
                    <button onClick={copyOssUrl}
                            className="px-3 py-1 bg-accent text-white rounded-cta text-caption shrink-0">
                      {copied ? '✓ 已复制' : '复制'}
                    </button>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <a href={ossUrl} target="_blank" rel="noopener"
                       className="flex-1 text-center px-3 py-2 bg-ink text-white rounded-cta text-button">
                      📂 在新窗口打开 PDF
                    </a>
                    <a href={ossUrl} download={`送货单-${order.no}.pdf`}
                       className="flex-1 text-center px-3 py-2 border border-border rounded-cta text-button text-gray2">
                      ⬇ 下载到本地
                    </a>
                  </div>
                  <p className="text-micro text-gray3 mt-2">📱 App 内点不开?复制链接发给自己微信,在微信里点链接 → 右上角 ⋯ → 用浏览器打开 → 即可下载/打印</p>
                </div>
              )}
              {/* 本地分享 — PC 浏览器 / iOS / 安卓 Chrome 可用 */}
              {pdfBlob && !ossUrl && !uploading && (
                <button onClick={shareOrDownload}
                        className="w-full px-4 py-2 bg-ink text-white rounded-cta text-button">📤 分享 / 下载</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* A4 纸面 */}
      <div id="print-area" className="print-page mx-auto my-6 bg-white p-10 shadow-md text-ink"
           style={{ width: '210mm', minHeight: '297mm', fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' }}>
        {/* 抬头 */}
        <div className="text-center border-b-2 border-ink pb-3">
          <div className="text-2xl font-bold tracking-widest">{order.supplier.name}</div>
          <div className="text-3xl font-bold mt-2">送 货 单</div>
          <div className="text-xs text-gray2 mt-1">DELIVERY NOTE</div>
        </div>

        {/* 顶部元数据 */}
        <table className="w-full text-sm mt-4 border-collapse">
          <tbody>
            <tr>
              <td className="border border-gray3 px-2 py-1.5 bg-bg w-24">送货单号</td>
              <td className="border border-gray3 px-2 py-1.5 font-mono">{order.no}</td>
              <td className="border border-gray3 px-2 py-1.5 bg-bg w-24">下单日期</td>
              <td className="border border-gray3 px-2 py-1.5">{dayjs(order.createdAt).format('YYYY-MM-DD HH:mm')}</td>
            </tr>
            <tr>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">收货方</td>
              <td className="border border-gray3 px-2 py-1.5" colSpan={3}>{order.store.name}</td>
            </tr>
            {order.store.address && (
              <tr>
                <td className="border border-gray3 px-2 py-1.5 bg-bg">收货地址</td>
                <td className="border border-gray3 px-2 py-1.5" colSpan={3}>{order.store.address}</td>
              </tr>
            )}
            {(order.store.managerName || order.store.phone) && (
              <tr>
                <td className="border border-gray3 px-2 py-1.5 bg-bg">收货方联系人</td>
                <td className="border border-gray3 px-2 py-1.5" colSpan={3}>
                  {order.store.managerName || '—'}{order.store.phone ? ` · ${order.store.phone}` : ''}
                </td>
              </tr>
            )}
            <tr>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">下单人</td>
              <td className="border border-gray3 px-2 py-1.5" colSpan={3}>{order.createdBy?.name || '—'}</td>
            </tr>
            <tr>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">期望到货</td>
              <td className="border border-gray3 px-2 py-1.5">{dayjs(order.expectedDate).format('YYYY-MM-DD')}</td>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">发货时间</td>
              <td className="border border-gray3 px-2 py-1.5">{order.shippedAt ? dayjs(order.shippedAt).format('YYYY-MM-DD HH:mm') : '—'}</td>
            </tr>
            {(order.supplier.contactName || order.supplier.contactPhone) && (
              <tr>
                <td className="border border-gray3 px-2 py-1.5 bg-bg">供应方联系人</td>
                <td className="border border-gray3 px-2 py-1.5" colSpan={3}>
                  {order.supplier.contactName || '—'}{order.supplier.contactPhone ? ` · ${order.supplier.contactPhone}` : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* 商品明细 */}
        <table className="w-full text-sm mt-4 border-collapse">
          <thead>
            <tr className="bg-bg">
              <th className="border border-gray3 px-2 py-1.5 w-10">#</th>
              <th className="border border-gray3 px-2 py-1.5 text-left">品名</th>
              <th className="border border-gray3 px-2 py-1.5 text-left w-32">规格</th>
              <th className="border border-gray3 px-2 py-1.5 w-12">单位</th>
              <th className="border border-gray3 px-2 py-1.5 w-16">数量</th>
              <th className="border border-gray3 px-2 py-1.5 w-20">单价(¥)</th>
              <th className="border border-gray3 px-2 py-1.5 w-24">金额(¥)</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((it, i) => {
              const adj = it.shippedQty != null && Math.abs(Number(it.shippedQty) - Number(it.quantity)) > 0.0001
              return (
                <tr key={it.id}>
                  <td className="border border-gray3 px-2 py-1.5 text-center">{i + 1}</td>
                  <td className="border border-gray3 px-2 py-1.5">{it.product?.name || '-'}</td>
                  <td className="border border-gray3 px-2 py-1.5 text-xs">{it.product?.spec || '—'}</td>
                  <td className="border border-gray3 px-2 py-1.5 text-center">{it.product?.unit || '—'}</td>
                  <td className="border border-gray3 px-2 py-1.5 text-right font-mono">
                    {itemQty(it)}
                    {adj && <span className="text-xs text-gray3 ml-1">(下单 {it.quantity})</span>}
                  </td>
                  <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{Number(it.unitPrice).toFixed(2)}</td>
                  <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{itemAmt(it).toFixed(2)}</td>
                </tr>
              )
            })}
            {/* 合计 */}
            <tr className="bg-bg font-semibold">
              <td colSpan={4} className="border border-gray3 px-2 py-1.5 text-right">合计</td>
              <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{totalQty}</td>
              <td className="border border-gray3 px-2 py-1.5"></td>
              <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{total.toFixed(2)}</td>
            </tr>
            {/* 大写 */}
            <tr>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">大写</td>
              <td colSpan={6} className="border border-gray3 px-2 py-1.5">人民币 {num2cn(total)}</td>
            </tr>
          </tbody>
        </table>

        {/* 调整提示 */}
        {hasAdjust && (
          <div className="mt-3 text-xs text-amber-fg border-l-4 border-amber pl-2">
            ⚠ 本单部分商品按称重 / 库存实际发货量调整, 与原下单量不同 (原合同金额 ¥{Number(order.totalAmount).toFixed(2)})
          </div>
        )}
        {/* 备注 */}
        {(order.note || order.shippedNote) && (
          <div className="mt-4 text-sm">
            {order.note && <div>📝 订单备注: {order.note}</div>}
            {order.shippedNote && <div className="mt-1">📦 发货备注: {order.shippedNote}</div>}
          </div>
        )}

        {/* 签字栏 */}
        <div className="mt-12 grid grid-cols-2 gap-12 text-sm">
          <div>
            <div className="border-b border-ink pb-1 mb-2 h-8" />
            <div className="text-center text-gray2">送货人签字 / 日期</div>
          </div>
          <div>
            <div className="border-b border-ink pb-1 mb-2 h-8" />
            <div className="text-center text-gray2">收货人签字 / 日期</div>
          </div>
        </div>

        {/* 页脚 */}
        <div className="mt-6 pt-2 border-t border-border text-xs text-gray3 flex justify-between">
          <span>共 {itemsCount} 项商品</span>
          <span>打印时间 {dayjs(printedAt).format('YYYY-MM-DD HH:mm')}</span>
          <span>本单一式两联 · 收货方留存一联</span>
        </div>
      </div>
    </>
  )
}
