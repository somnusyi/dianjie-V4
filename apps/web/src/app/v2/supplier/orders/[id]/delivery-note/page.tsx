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
  items: { id: string; quantity: string; unitPrice: string; amount: string
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

  useEffect(() => {
    apiFetch<Order>(`/api/orders/${id}`).then(setOrder).catch(e => setError(e.message || '加载失败'))
  }, [id])

  if (error) return <div className="p-8 text-center text-red-fg">{error}</div>
  if (!order) return <div className="p-8 text-center text-gray2">加载中…</div>

  const total = Number(order.totalAmount)
  const itemsCount = order.items.length
  const totalQty = order.items.reduce((s, i) => s + Number(i.quantity), 0)

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
        <span className="flex-1 text-h2">送货单 · {order.no}</span>
        <button onClick={() => window.print()} className="px-4 py-2 bg-ink text-white rounded-cta text-button">
          🖨 打印 / 导出 PDF
        </button>
      </div>

      {/* A4 纸面 */}
      <div className="print-page mx-auto my-6 bg-white p-10 shadow-md text-ink"
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
            {order.items.map((it, i) => (
              <tr key={it.id}>
                <td className="border border-gray3 px-2 py-1.5 text-center">{i + 1}</td>
                <td className="border border-gray3 px-2 py-1.5">{it.product?.name || '-'}</td>
                <td className="border border-gray3 px-2 py-1.5 text-xs">{it.product?.spec || '—'}</td>
                <td className="border border-gray3 px-2 py-1.5 text-center">{it.product?.unit || '—'}</td>
                <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{it.quantity}</td>
                <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{Number(it.unitPrice).toFixed(2)}</td>
                <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{Number(it.amount).toFixed(2)}</td>
              </tr>
            ))}
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
